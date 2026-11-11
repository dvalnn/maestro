import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Composed } from "@maestro/core/config";
import type { Host } from "@maestro/core/host";
import { claudeHarness } from "@maestro/harness-claude";
import { piHarness } from "@maestro/harness-pi";
import {
	type AgentRuntime,
	agentRuntimes,
	agentTable,
	HOST_NAME,
	repoHost,
} from "@maestro/host-repo";
import {
	type AgentEnvironment,
	type HarnessRequest,
	isObject,
	OUTBOX,
	placeholder,
	placeholderOutputs,
	type StubStep,
	stubHarness,
} from "@maestro/host-repo/harness";
import type { Plan } from "@maestro/ir";
import { failure, parseDuration, table } from "./output";
import type { Session } from "./session";

const STUB_DELAY = "MAESTRO_STUB_DELAY";
const STUB_ENVIRONMENT = "MAESTRO_STUB_ENVIRONMENT";

const STUB_OUTPUTS = "MAESTRO_STUB_OUTPUTS";
const VERDICT_FILE = "verdict";
const EVENTS_FILE = "events.jsonl";
const FIELD_EXTENSION = ".json";

const STUB_REPORT = { summary: "stub" };
const STUB_REPLY = { report: STUB_REPORT };
const STUB_VERDICT = { outcome: "ok", report: STUB_REPORT };

/** The scripted file `file` for `req`'s agent: under its instance id, else its node id, else none. */
function scripted(dir: string, req: HarnessRequest, file: string) {
	const instance = req.instance ?? "";
	const nodeId = instance.replace(/\[[^\]]*\]/g, "");
	for (const id of [instance, nodeId]) {
		if (!id) continue;
		const path = join(dir, id, file);
		if (existsSync(path) && statSync(path).isFile())
			return { path, text: readFileSync(path, "utf8") };
	}
	return undefined;
}

/** The value of reply field `name` of `req`: its scripted `<name>.json` in `dir` parsed, else the placeholder of `schema`. */
function fieldValue(
	dir: string | undefined,
	req: HarnessRequest,
	name: string,
	schema: unknown,
) {
	const file = `${name}${FIELD_EXTENSION}`;
	const clash = req.outputs.find((o) => o.file === file);
	if (clash)
		throw failure(
			`reply field '${name}' and output '${clash.file}' both script '${file}'`,
			`Rename the field or the output`,
		);
	const found = dir ? scripted(dir, req, file) : undefined;
	if (!found) return placeholder(schema);
	try {
		return JSON.parse(found.text);
	} catch {
		throw failure(
			`${STUB_OUTPUTS} file '${found.path}' is not JSON`,
			"Write the field's value as JSON",
		);
	}
}

/** `envelope` with each typed field `req` declares, scripted in `dir` or else a placeholder, as reply text. */
const withFields = (
	envelope: object,
	req: HarnessRequest,
	dir: string | undefined,
) =>
	JSON.stringify({
		...envelope,
		...Object.fromEntries(
			Object.entries(req.reply ?? {}).map(([name, schema]) => [
				name,
				fieldValue(dir, req, name, schema),
			]),
		),
	});

/** The outputs of `req` taken from `dir` where it holds them, else the placeholder. */
function scriptedOutputs(dir: string, req: HarnessRequest): StubStep[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory())
		throw failure(
			`${STUB_OUTPUTS} names '${dir}', which is not a directory`,
			`Create it, or unset ${STUB_OUTPUTS}`,
		);
	return placeholderOutputs(req).map((step, i) => {
		const file = req.outputs[i]?.file ?? "";
		const found = scripted(dir, req, file);
		return found === undefined
			? step
			: { write: `${OUTBOX}/${file}`, content: found.text };
	});
}

/** The events of `req`'s agent: one per line of the `events.jsonl` file of `dir` for it, each taking `delayMs`. */
function scriptedEvents(
	dir: string | undefined,
	req: HarnessRequest,
	delayMs: number | undefined,
): StubStep[] {
	const text = dir ? scripted(dir, req, EVENTS_FILE)?.text : undefined;
	return (text ?? "")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			let emit: unknown;
			try {
				emit = JSON.parse(line);
			} catch {}
			if (!isObject(emit))
				throw failure(
					`${STUB_OUTPUTS} file '${EVENTS_FILE}' holds '${line}', not a JSON object`,
					"Write one JSON object per line",
				);
			return { emit, delayMs };
		});
}

/** The reply text of a verdict agent: the `verdict` file of `dir` for `req`, else `ok`. */
function scriptedVerdict(dir: string | undefined, req: HarnessRequest) {
	const text = dir ? scripted(dir, req, VERDICT_FILE)?.text.trim() : undefined;
	if (text === undefined || text === "ok") return STUB_VERDICT;
	const reason = /^rejected\s+(\S[\s\S]*)$/.exec(text)?.[1];
	if (reason === undefined)
		throw failure(
			`${STUB_OUTPUTS} file '${VERDICT_FILE}' holds '${text}', not 'ok' or 'rejected <reason>'`,
			`Write it as 'ok' or 'rejected <reason>'`,
		);
	return { outcome: "rejected", reason, report: STUB_REPORT };
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
		throw failure(
			`${STUB_ENVIRONMENT} holds '${text}', not a JSON object`,
			`Set it to an object such as '{"mcp":["github"]}', or unset it`,
		);
	return { emit: { type: "environment", ...own, ...over } };
}

/**
 * The harnesses the CLI ships, their credentials read from `env`. The `stub` harness reports its environment, writes a
 * placeholder for each declared output, then replies an `ok` envelope, taking `MAESTRO_STUB_DELAY` per agent turn; a
 * stub turn fails when it is not a duration. With `MAESTRO_STUB_OUTPUTS=<dir>` it takes outputs and a verdict from
 * `<dir>/<instance id>/` or `<dir>/<node id>/`, each reply field from its `<field>.json` there, and the events of its
 * `events.jsonl` before them, and with `MAESTRO_STUB_ENVIRONMENT=<json>` the parts it reports loaded and the model's
 * `window`.
 */
export const builtinHarnesses = (env: Record<string, string | undefined>) => [
	piHarness({ agentDir: env.PI_CODING_AGENT_DIR || undefined }),
	claudeHarness({ token: env.CLAUDE_CODE_OAUTH_TOKEN }),
	{
		...stubHarness((req) => {
			const delay = env[STUB_DELAY];
			const delayMs = delay ? parseDuration(STUB_DELAY, delay) : undefined;
			const outputs = env[STUB_OUTPUTS] || undefined;
			return [
				stubEnvironment(env[STUB_ENVIRONMENT]),
				...scriptedEvents(outputs, req, delayMs),
				...(outputs ? scriptedOutputs(outputs, req) : placeholderOutputs(req)),
				{
					emit: {
						type: "text",
						text: withFields(
							req.verdict ? scriptedVerdict(outputs, req) : STUB_REPLY,
							req,
							outputs,
						),
					},
					delayMs,
				},
			];
		}),
		environment: STUB_DECLARED,
	},
];

/** The hosts the CLI ships, on `builtinHarnesses(env)`. */
export const builtinHosts = (
	env: Record<string, string | undefined>,
): Host[] => [repoHost({ harnesses: builtinHarnesses(env) })];

/** What each agent node of `plan` will run: its profile and the runtime that resolves to. */
export async function agentsOf(
	session: Session,
	config: Composed,
	plan: Plan,
): Promise<AgentRuntime[]> {
	const host = session.deps.hosts.find((h) => h.name === HOST_NAME);
	return host ? agentRuntimes(plan.ir, config, host, session.config.roots) : [];
}

/** The `agents:` block: the table the host gives, indented. */
export function agentLines(agents: readonly AgentRuntime[]): string {
	return `agents:\n${table(agentTable(agents)).replace(/^/gm, "  ")}`;
}
