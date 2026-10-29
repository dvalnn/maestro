import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "@maestro/core/host";
import { claudeHarness } from "@maestro/harness-claude";
import { piHarness } from "@maestro/harness-pi";
import { repoHost } from "@maestro/host-repo";
import {
	type HarnessRequest,
	OUTBOX,
	placeholderOutputs,
	type StubStep,
	stubHarness,
} from "@maestro/host-repo/harness";
import { parseDuration, usageError } from "./output";

const STUB_DELAY = "MAESTRO_STUB_DELAY";

const STUB_OUTPUTS = "MAESTRO_STUB_OUTPUTS";
const VERDICT_FILE = "verdict";

const STUB_REPORT = { summary: "stub" };
const STUB_REPLY = JSON.stringify({ report: STUB_REPORT });
const STUB_VERDICT = JSON.stringify({ outcome: "ok", report: STUB_REPORT });

/** The scripted file `file` for `req`'s agent: under its instance id, else its node id, else none. */
function scripted(dir: string, req: HarnessRequest, file: string) {
	const instance = req.instance ?? "";
	const nodeId = instance.replace(/\[[^\]]*\]/g, "");
	for (const id of [instance, nodeId]) {
		if (!id) continue;
		const path = join(dir, id, file);
		if (existsSync(path) && statSync(path).isFile())
			return readFileSync(path, "utf8");
	}
	return undefined;
}

/** The outputs of `req` taken from `dir` where it holds them, else the placeholder. */
function scriptedOutputs(dir: string, req: HarnessRequest): StubStep[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory())
		throw usageError(
			`${STUB_OUTPUTS} names '${dir}', which is not a directory`,
			`Create it, or unset ${STUB_OUTPUTS}`,
		);
	return placeholderOutputs(req).map((step, i) => {
		const file = req.outputs[i]?.file ?? "";
		const content = scripted(dir, req, file);
		return content === undefined
			? step
			: { write: `${OUTBOX}/${file}`, content };
	});
}

/** The reply text of a verdict agent: the `verdict` file of `dir` for `req`, else `ok`. */
function scriptedVerdict(dir: string | undefined, req: HarnessRequest) {
	const text = dir ? scripted(dir, req, VERDICT_FILE)?.trim() : undefined;
	if (text === undefined || text === "ok") return STUB_VERDICT;
	const reason = /^rejected\s+(\S[\s\S]*)$/.exec(text)?.[1];
	if (reason === undefined)
		throw usageError(
			`${STUB_OUTPUTS} file '${VERDICT_FILE}' holds '${text}', not 'ok' or 'rejected <reason>'`,
			`Write it as 'ok' or 'rejected <reason>'`,
		);
	return JSON.stringify({ outcome: "rejected", reason, report: STUB_REPORT });
}

/**
 * The hosts the CLI ships, their credentials read from `env`. The `stub` harness writes a placeholder for each declared output, then replies an `ok` envelope, taking `MAESTRO_STUB_DELAY` per agent turn; a stub turn fails when it is not a duration. With `MAESTRO_STUB_OUTPUTS=<dir>` it takes outputs and a verdict from `<dir>/<instance id>/` or `<dir>/<node id>/`.
 */
export const builtinHosts = (
	env: Record<string, string | undefined>,
): Host[] => {
	return [
		repoHost({
			harnesses: [
				piHarness(),
				claudeHarness({ token: env.CLAUDE_CODE_OAUTH_TOKEN }),
				stubHarness((req) => {
					const delay = env[STUB_DELAY];
					const delayMs = delay ? parseDuration(STUB_DELAY, delay) : undefined;
					const outputs = env[STUB_OUTPUTS] || undefined;
					return [
						...(outputs
							? scriptedOutputs(outputs, req)
							: placeholderOutputs(req)),
						{
							emit: {
								type: "text",
								text: req.verdict ? scriptedVerdict(outputs, req) : STUB_REPLY,
							},
							delayMs,
						},
					];
				}),
			],
		}),
	];
};
