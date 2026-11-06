import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	baselineOf,
	type ContextPolicy,
	type ContextSupport,
	contextProblems,
	finite,
	type Harness,
	type HarnessEvent,
	type HarnessRequest,
	INSTRUCTIONS,
	isObject,
	isTransient,
	type JsonObject,
	METRIC,
	type Metrics,
	type RuntimeProblem,
	resolveBin,
	resultBytes,
	SESSION_DIR,
	type SubprocessAdapter,
	subprocessHarness,
	thinkingProblems,
	windowEvents,
} from "@maestro/host-repo/harness";
import type { SandboxBackend } from "@maestro/host-repo/sandbox";

const CLAUDE_BIN = "claude";
/** The levels claude's `--effort` documents, which a runtime's `thinking` passes as. */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CONFIG_DIR_VAR = "CLAUDE_CONFIG_DIR";
const TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";
const TOKEN_HINT = `Run \`claude setup-token\`, then set ${TOKEN_VAR} in your shell profile or in .env`;
/** The `error` a claude assistant message carries when the login was refused. */
const AUTH_FAILED = "authentication_failed";
/** Per-session config dir under the session dir, so transcripts and settings are the session's own. */
const SESSION_CONFIG = "claude";

/** The subagent tool's names in a `system/init` tool list, which 2.1.318 gives by its former name `Task`. */
const SUBAGENT_TOOLS = ["Agent", "Task"];

/** The built-in tools an agent gets, named so a release's new default tools never reach it. */
const TOOLS = ["Bash", "Read", "Write", "Edit"];
const TOOLS_ARGV = ["--tools", TOOLS.join(",")];

/**
 * The tools claude loads, and the parts of its environment maestro does not manage, each switched off. `--bare` would
 * drop more but also drops OAuth, which the token needs.
 */
const BASELINE = baselineOf({
	tools: { declared: TOOLS, argv: TOOLS_ARGV },
	subagents: { declared: false, argv: TOOLS_ARGV },
	skills: { declared: [], argv: ["--disable-slash-commands"] },
	mcp: { declared: [], argv: ["--strict-mcp-config"] },
	hooks: {
		declared: [],
		argv: [
			"--setting-sources",
			"",
			"--settings",
			JSON.stringify({ disableAllHooks: true }),
		],
	},
	contextFiles: {
		declared: [],
		argv: [],
		env: {
			CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
			CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
		},
	},
});

/** The environment claude launches with. */
export const declared = BASELINE.declared;

/** What else claude would otherwise load on its own, none of which maestro manages. */
const UNMANAGED_OFF = ["--no-chrome"];

/** Tells claude it already runs inside bubblewrap, which it requires to accept `bypassPermissions` as root. */
const UNMANAGED_OFF_ENV = {
	CLAUDE_CODE_BUBBLEWRAP: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

/** Turns claude's own compaction off, so a handoff resets the session first. */
const COMPACTION_OFF_ENV = { DISABLE_AUTO_COMPACT: "1" };

const CONTEXT_SUPPORT: ContextSupport = {
	compactions: true,
	compact: true,
};

/** The metric each key of a message's or a result's `usage` is summed into. */
const USAGE_METRICS = {
	input_tokens: METRIC.tokensIn,
	output_tokens: METRIC.tokensOut,
	cache_read_input_tokens: METRIC.tokensCacheRead,
	cache_creation_input_tokens: METRIC.tokensCacheWrite,
} as const;

/** The same, for each model's entry in a result's `modelUsage`. */
const MODEL_USAGE_METRICS = {
	inputTokens: METRIC.tokensIn,
	outputTokens: METRIC.tokensOut,
	cacheReadInputTokens: METRIC.tokensCacheRead,
	cacheCreationInputTokens: METRIC.tokensCacheWrite,
} as const;

export type ClaudeOptions = {
	/** The claude executable. Defaults to `claude` on PATH, looked through a mise shim. */
	bin?: string;
	/** A `claude setup-token` token, passed to claude as a masked secret. Without one, a run fails before it starts. */
	token?: string;
};

function sumUsage(
	entries: JsonObject[],
	keys: Record<string, string>,
): Metrics {
	const metrics: Metrics = {};
	for (const [key, metric] of Object.entries(keys)) {
		metrics[metric] = entries.reduce((n, u) => n + finite(u[key]), 0);
	}
	return metrics;
}

/**
 * A result's totals: the sum over `modelUsage`, which also counts subagents and side models, else its `usage`.
 */
function resultMetrics(e: JsonObject): Metrics {
	const models = isObject(e.modelUsage)
		? Object.values(e.modelUsage).filter(isObject)
		: [];
	return models.length
		? sumUsage(models, MODEL_USAGE_METRICS)
		: sumUsage(isObject(e.usage) ? [e.usage] : [], USAGE_METRICS);
}

/** What `now` adds to `before`, never negative. */
function growth(now: Metrics, before: Metrics): Metrics {
	const out: Metrics = {};
	for (const [k, v] of Object.entries(now))
		out[k] = Math.max(0, v - (before[k] ?? 0));
	return out;
}

function resultEvent(block: JsonObject): HarnessEvent[] {
	if (block.type !== "tool_result") return [];
	return [
		{
			kind: "tool_result",
			...(typeof block.tool_use_id === "string" && { id: block.tool_use_id }),
			bytes: resultBytes(block.content),
			error: block.is_error === true,
		},
	];
}

function userEvents(message: unknown): HarnessEvent[] {
	const blocks =
		isObject(message) && Array.isArray(message.content) ? message.content : [];
	return blocks.filter(isObject).flatMap(resultEvent);
}

function blockEvent(block: unknown): HarnessEvent[] {
	if (!isObject(block)) return [];
	if (block.type === "text")
		return [{ kind: "text", text: String(block.text) }];
	if (block.type === "tool_use")
		return [
			{
				kind: "tool",
				name: String(block.name),
				input: block.input,
				...(typeof block.id === "string" && { id: block.id }),
			},
		];
	if (block.type === "thinking" && block.thinking)
		return [{ kind: "thinking", text: String(block.thinking) }];
	return [];
}

/** A model call's prompt size from its usage, the input that missed the cache and the cache read and written. */
const contextEvent = (usage: Metrics): HarnessEvent => ({
	kind: "context",
	used:
		(usage[METRIC.tokensIn] ?? 0) +
		(usage[METRIC.tokensCacheRead] ?? 0) +
		(usage[METRIC.tokensCacheWrite] ?? 0),
});

/** The names in a list of names or of objects with a `name`; any other entry is left out. */
const namesOf = (v: unknown): string[] | undefined =>
	Array.isArray(v)
		? v.flatMap((x) => {
				const name = isObject(x) ? x.name : x;
				return typeof name === "string" ? [name] : [];
			})
		: undefined;

/** What a `system/init` line reports: tools, the subagent tools among them, skills and slash commands, MCP servers. */
function environmentEvent(e: JsonObject): HarnessEvent {
	const tools = namesOf(e.tools);
	const skills = namesOf(e.skills);
	const commands = namesOf(e.slash_commands);
	const mcp = namesOf(e.mcp_servers);
	return {
		kind: "environment",
		...(typeof e.claude_code_version === "string" && {
			version: e.claude_code_version,
		}),
		...(typeof e.model === "string" && { model: e.model }),
		...(tools && {
			tools,
			subagents: tools.filter((t) => SUBAGENT_TOOLS.includes(t)),
		}),
		...((skills || commands) && {
			skills: [...new Set([...(skills ?? []), ...(commands ?? [])])],
		}),
		...(mcp && { mcp }),
	};
}

function systemEvents(e: JsonObject): HarnessEvent[] {
	if (e.subtype === "init") return [environmentEvent(e)];
	if (e.subtype === "compact_boundary") return [{ kind: "compaction" }];
	return [{ kind: "raw", data: e }];
}

/**
 * The window a result's `modelUsage` gives the run's `model`, as `system/init` named it, or the one model it lists when
 * none is named after it. A result is the only place claude reports a window, so a probe runs one short turn.
 */
function resultWindow(
	e: JsonObject,
	model: string | undefined,
): HarnessEvent[] {
	const usage = isObject(e.modelUsage) ? e.modelUsage : {};
	const models = Object.values(usage);
	const entry =
		model !== undefined && isObject(usage[model])
			? usage[model]
			: models.length === 1
				? models[0]
				: undefined;
	return windowEvents(isObject(entry) ? entry.contextWindow : undefined);
}

/** What a run's final line reports, after what the run's messages reported. */
type Ran = {
	authFailed: boolean;
	counted: Metrics;
	lastText?: string;
	/** The model `system/init` named. */
	model?: string;
};

/**
 * One run's final line. `is_error` also rides on `subtype: "success"`, so both are checked. Its text is dropped when it
 * repeats the last assistant text.
 */
function resultEvents(
	e: JsonObject,
	{ authFailed, counted, lastText, model }: Ran,
): HarnessEvent[] {
	const failed = e.is_error === true || e.subtype !== "success";
	const reply = typeof e.result === "string" ? e.result : "";
	const reason = reply || `claude ended with ${String(e.subtype)}`;
	return [
		{ kind: "usage", metrics: growth(resultMetrics(e), counted) },
		...resultWindow(e, model),
		...(reply === lastText ? [] : [{ kind: "text" as const, text: reply }]),
		failed
			? {
					kind: "fault",
					reason: authFailed ? `${reason}. ${TOKEN_HINT}` : reason,
					...(!authFailed &&
						isTransient(e.api_error_status, reply) && { transient: true }),
				}
			: { kind: "settled" },
	];
}

/**
 * Maps `claude -p --output-format stream-json` lines to events. An assistant message is repeated once per content
 * block, so its usage is counted once per message id, as growth, and its prompt size reported once. The closing
 * `result` line adds what the messages missed: subagents, side models and streamed output tokens, and the model's
 * window. A run that ends without one reports the messages' usage alone, which undercounts output. Unknown types pass
 * through as raw, never fail.
 */
function parser(): (e: JsonObject) => HarnessEvent[] {
	const seen = new Map<string, Metrics>();
	const counted: Metrics = {};
	const ran: Ran = { authFailed: false, counted };
	const countUsage = (message: JsonObject): HarnessEvent[] => {
		const id = String(message.id);
		const now = sumUsage(
			isObject(message.usage) ? [message.usage] : [],
			USAGE_METRICS,
		);
		const first = !seen.has(id);
		const added = growth(now, seen.get(id) ?? {});
		seen.set(id, now);
		for (const [k, v] of Object.entries(added))
			counted[k] = (counted[k] ?? 0) + v;
		return [
			{ kind: "usage", metrics: added },
			...(first ? [contextEvent(now)] : []),
		];
	};
	const assistantEvents = (message: JsonObject): HarnessEvent[] => {
		const blocks = Array.isArray(message.content) ? message.content : [];
		const events = blocks.flatMap(blockEvent);
		for (const e of events) if (e.kind === "text") ran.lastText = e.text;
		return [...countUsage(message), ...events];
	};
	const eventsOf = (e: JsonObject): HarnessEvent[] => {
		switch (e.type) {
			case "assistant":
				ran.authFailed ||= e.error === AUTH_FAILED;
				return isObject(e.message) ? assistantEvents(e.message) : [];
			case "result":
				return resultEvents(e, ran);
			case "user":
				return userEvents(e.message);
			case "system":
				if (e.subtype === "init" && typeof e.model === "string")
					ran.model = e.model;
				return systemEvents(e);
			default:
				return [{ kind: "raw", data: e }];
		}
	};
	return eventsOf;
}

/** Whether the session's config dir already holds a transcript of `session.id`. */
function hasTranscript(session: HarnessRequest["session"]): boolean {
	const transcripts = new Bun.Glob(`projects/*/${session.id}.jsonl`);
	return (
		transcripts.scanSync({ cwd: join(session.dir, SESSION_CONFIG) }).next()
			.done === false
	);
}

/**
 * The claude argv for a request. The prompt travels on stdin, the instructions in a file claude appends to its system
 * prompt. The sandbox is the confinement, so claude's own permission prompts are off. The system prompt is not
 * snapshotted, or a resumed session would keep its first instructions.
 */
function claudeArgv(
	bin: string,
	req: HarnessRequest,
	resuming: boolean,
): string[] {
	const { model, thinking } = req.runtime;
	return [
		bin,
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		...BASELINE.argv,
		...UNMANAGED_OFF,
		"--permission-mode",
		"bypassPermissions",
		"--system-prompt-snapshot",
		"off",
		...(req.instructions ? ["--append-system-prompt-file", INSTRUCTIONS] : []),
		resuming ? "--resume" : "--session-id",
		req.session.id,
		"--model",
		model,
		...(thinking ? ["--effort", thinking] : []),
		...compactionWindow(req.context),
	];
}

/** The `--autocompact` window claude takes, in tokens. */
const AUTOCOMPACT_MIN = 100_000;
const AUTOCOMPACT_MAX = 1_000_000;

/** Under `compact`, `at` as claude's compaction window, which pre-flight keeps in range. */
const compactionWindow = (context: ContextPolicy | undefined): string[] =>
	context?.strategy === "compact" ? ["--autocompact", String(context.at)] : [];

/** A `compact` window claude would not take. */
function windowProblems(context: ContextPolicy | undefined): RuntimeProblem[] {
	if (context?.strategy !== "compact") return [];
	const tokens = context.at;
	if (tokens >= AUTOCOMPACT_MIN && tokens <= AUTOCOMPACT_MAX) return [];
	return [
		{
			field: "context.at",
			reason: `claude takes at ${tokens} outside its compaction window of ${AUTOCOMPACT_MIN} to ${AUTOCOMPACT_MAX} tokens`,
			fix: `Set at between ${AUTOCOMPACT_MIN} and ${AUTOCOMPACT_MAX}, or use strategy handoff`,
		},
	];
}

/** Claude Code, run as a sandboxed subprocess (ADR 0001). */
export function claudeHarness(
	options: ClaudeOptions = {},
	backend?: SandboxBackend,
): Harness {
	let bin: string | undefined;
	const adapter: SubprocessAdapter = {
		name: "claude",
		spec(req) {
			const { token } = options;
			if (!token) throw new Error(`${TOKEN_VAR} is not set. ${TOKEN_HINT}`);
			bin ??= resolveBin(CLAUDE_BIN, options.bin);
			mkdirSync(join(req.session.dir, SESSION_CONFIG), { recursive: true });
			const resuming = hasTranscript(req.session);
			return {
				argv: claudeArgv(bin, req, resuming),
				stdin: req.prompt,
				env: {
					...BASELINE.env,
					...UNMANAGED_OFF_ENV,
					...(req.context?.strategy === "handoff" && COMPACTION_OFF_ENV),
					[CONFIG_DIR_VAR]: join(SESSION_DIR, SESSION_CONFIG),
				},
				secrets: { [TOKEN_VAR]: token },
				readOnly: [{ src: dirname(bin) }],
			};
		},
		parser,
	};
	return {
		...subprocessHarness(adapter, backend),
		runtimeProblems: (runtime, context) => [
			...thinkingProblems(adapter.name, EFFORTS, runtime),
			...contextProblems(adapter.name, CONTEXT_SUPPORT, context),
			...windowProblems(context),
		],
	};
}
