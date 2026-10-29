import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "@maestro/core/host";
import {
	declared as claudeDeclared,
	claudeHarness,
} from "@maestro/harness-claude";
import { declared as piDeclared, piHarness } from "@maestro/harness-pi";
import { repoHost } from "@maestro/host-repo";
import {
	type AgentEnvironment,
	type HarnessRequest,
	OUTBOX,
	placeholderOutputs,
	type StubStep,
	stubHarness,
} from "@maestro/host-repo/harness";
import { parseDuration, usageError } from "./output";

const STUB_DELAY = "MAESTRO_STUB_DELAY";
const STUB_ENVIRONMENT = "MAESTRO_STUB_ENVIRONMENT";

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

/** The stub loads nothing: it runs a shell script. */
const STUB_DECLARED: AgentEnvironment = {
	tools: [],
	subagents: false,
	skills: [],
	mcp: [],
	hooks: [],
	contextFiles: [],
	compaction: "harness",
};

/** The stub's startup report: what it declares, each part laid over by the JSON object `MAESTRO_STUB_ENVIRONMENT` holds. */
function stubEnvironment(text: string | undefined): StubStep {
	const { skills, mcp, hooks, contextFiles } = STUB_DECLARED;
	const own = { tools: [], subagents: [], skills, mcp, hooks, contextFiles };
	let over: unknown;
	try {
		over = text ? JSON.parse(text) : {};
	} catch {
		over = undefined;
	}
	if (typeof over !== "object" || over === null || Array.isArray(over))
		throw usageError(
			`${STUB_ENVIRONMENT} holds '${text}', not a JSON object`,
			`Set it to an object such as '{"mcp":["github"]}', or unset it`,
		);
	return { emit: { type: "environment", ...own, ...over } };
}

/** The shipped harnesses with a clean baseline, each with the agent environment it launches with. */
const baselined = (env: Record<string, string | undefined>) => [
	{
		harness: piHarness({ agentDir: env.PI_CODING_AGENT_DIR || undefined }),
		declared: piDeclared,
	},
	{
		harness: claudeHarness({ token: env.CLAUDE_CODE_OAUTH_TOKEN }),
		declared: claudeDeclared,
	},
];

/** The agent environment each shipped harness launches with, by harness name. */
export const DECLARED: ReadonlyMap<string, AgentEnvironment> = new Map([
	...baselined({}).map(({ harness, declared }): [string, AgentEnvironment] => [
		harness.name,
		declared,
	]),
	["stub", STUB_DECLARED],
]);

/**
 * The harnesses the CLI ships, their credentials read from `env`. The `stub` harness reports its environment, writes a
 * placeholder for each declared output, then replies an `ok` envelope, taking `MAESTRO_STUB_DELAY` per agent turn; a
 * stub turn fails when it is not a duration. With `MAESTRO_STUB_OUTPUTS=<dir>` it takes outputs and a verdict from
 * `<dir>/<instance id>/` or `<dir>/<node id>/`, and with `MAESTRO_STUB_ENVIRONMENT=<json>` the parts it reports loaded.
 */
export const builtinHarnesses = (env: Record<string, string | undefined>) => [
	...baselined(env).map(({ harness }) => harness),
	stubHarness((req) => {
		const delay = env[STUB_DELAY];
		const delayMs = delay ? parseDuration(STUB_DELAY, delay) : undefined;
		const outputs = env[STUB_OUTPUTS] || undefined;
		return [
			stubEnvironment(env[STUB_ENVIRONMENT]),
			...(outputs ? scriptedOutputs(outputs, req) : placeholderOutputs(req)),
			{
				emit: {
					type: "text",
					text: req.verdict ? scriptedVerdict(outputs, req) : STUB_REPLY,
				},
				delayMs,
			},
		];
	}),
];

/** The hosts the CLI ships, on `builtinHarnesses(env)`. */
export const builtinHosts = (
	env: Record<string, string | undefined>,
): Host[] => [repoHost({ harnesses: builtinHarnesses(env) })];
