import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
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
	resolveBin,
	resultBytes,
	SESSION_DIR,
	type SubprocessAdapter,
	subprocessHarness,
	thinkingProblems,
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

/** What claude would otherwise load on its own, none of which maestro manages. */
const UNMANAGED_OFF = [
	"--setting-sources",
	"",
	"--settings",
	JSON.stringify({ disableAllHooks: true }),
	"--strict-mcp-config",
	"--disable-slash-commands",
	"--no-chrome",
];

/** Tells claude it already runs inside bubblewrap, which it requires to accept `bypassPermissions` as root. */
const UNMANAGED_OFF_ENV = {
	CLAUDE_CODE_BUBBLEWRAP: "1",
	CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
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

/**
 * One run's final line. `is_error` also rides on `subtype: "success"`, so both are checked. Its text is dropped when it
 * repeats the last assistant text.
 */
function resultEvents(
	e: JsonObject,
	authFailed: boolean,
	counted: Metrics,
	lastText: string | undefined,
): HarnessEvent[] {
	const failed = e.is_error === true || e.subtype !== "success";
	const reply = typeof e.result === "string" ? e.result : "";
	const reason = reply || `claude ended with ${String(e.subtype)}`;
	return [
		{ kind: "usage", metrics: growth(resultMetrics(e), counted) },
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
 * block, so its usage is counted once per message id, as growth. The closing `result` line adds what the messages
 * missed: subagents, side models and streamed output tokens. A run that ends without one reports the messages'
 * usage alone, which undercounts output. Unknown types pass through as raw, never fail.
 */
function parser(): (e: JsonObject) => HarnessEvent[] {
	const seen = new Map<string, Metrics>();
	const counted: Metrics = {};
	let authFailed = false;
	let lastText: string | undefined;
	const countUsage = (message: JsonObject): Metrics => {
		const id = String(message.id);
		const now = sumUsage(
			isObject(message.usage) ? [message.usage] : [],
			USAGE_METRICS,
		);
		const added = growth(now, seen.get(id) ?? {});
		seen.set(id, now);
		for (const [k, v] of Object.entries(added))
			counted[k] = (counted[k] ?? 0) + v;
		return added;
	};
	const assistantEvents = (message: JsonObject): HarnessEvent[] => {
		const blocks = Array.isArray(message.content) ? message.content : [];
		const events = blocks.flatMap(blockEvent);
		for (const e of events) if (e.kind === "text") lastText = e.text;
		return [{ kind: "usage", metrics: countUsage(message) }, ...events];
	};
	const eventsOf = (e: JsonObject): HarnessEvent[] => {
		switch (e.type) {
			case "assistant":
				authFailed ||= e.error === AUTH_FAILED;
				return isObject(e.message) ? assistantEvents(e.message) : [];
			case "result":
				return resultEvents(e, authFailed, counted, lastText);
			case "user":
				return userEvents(e.message);
			case "system":
				return e.subtype === "init" ? [] : [{ kind: "raw", data: e }];
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
					...UNMANAGED_OFF_ENV,
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
		runtimeProblems: (runtime) =>
			thinkingProblems(adapter.name, EFFORTS, runtime),
	};
}
