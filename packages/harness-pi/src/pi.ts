import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
	observedOf,
	PROFILE_TOKEN,
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

/** The `session.version` of pi's JSON header this adapter reads. */
const SESSION_VERSION = 3;
const AGENT_DIR_VAR = "PI_CODING_AGENT_DIR";
const PI_BIN = "pi";
/** The levels pi's `--thinking` documents. */
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const AUTH_FILE = "auth.json";
/**
 * The agent dir maestro owns under the session dir, as `PI_CODING_AGENT_DIR`, so nothing of the user's pi dir but
 * `auth.json` reaches pi: no `SYSTEM.md`, `APPEND_SYSTEM.md`, `settings.json` or `models.json`. It holds `auth.json`, a
 * link to the user's, bound read-write in the sandbox so a token refresh writes through, and under a `compact` policy
 * maestro's own `settings.json`. Without a user `auth.json` pi starts and reports no key. Its own `auth.json.lock`
 * keeps concurrent agents and the user's pi from locking each other on a refresh; a lost write means logging in again.
 */
const SESSION_AGENT = "agent";
/** The fields of a provider entry in pi's `auth.json` that hold a credential: an API key, an OAuth token pair. */
const CREDENTIAL_FIELDS = ["key", "access", "refresh"];
const FAILED_STOPS = new Set(["error", "aborted"]);

/** Events that carry nothing the adapter reports. */
const IGNORED = new Set([
	"agent_start",
	"agent_end",
	"message_start",
	"message_update",
	"turn_start",
	"turn_end",
	"tool_execution_update",
]);

const CONTEXT_SUPPORT: ContextSupport = {
	compactions: true,
	compact: true,
};

const SETTINGS_FILE = "settings.json";

/**
 * The owned agent dir's settings under `context`, given the model's `window`: under `compact`, pi's compaction on with
 * the reserve that starts it at `at`, as pi compacts past its window less `reserveTokens` (pi docs/compaction.md).
 * None otherwise, and when `at` is not below `window`, so pi keeps its defaults.
 */
function settingsOf(
	context: ContextPolicy | undefined,
	window: number | undefined,
): JsonObject | undefined {
	if (
		context?.strategy !== "compact" ||
		window === undefined ||
		context.at >= window
	)
		return undefined;
	return { compaction: { enabled: true, reserveTokens: window - context.at } };
}

/** A `compact` policy pi cannot take: its compaction point needs the model's window. */
function compactProblems(
	context: ContextPolicy | undefined,
	window: number | undefined,
	model: string,
): RuntimeProblem[] {
	if (context?.strategy !== "compact" || window !== undefined) return [];
	return [
		{
			field: "context.strategy",
			reason: `pi compacts at a reserve below the model's window, and no window is known for model '${model}'`,
			fix: `Run maestro agent probe ${PROFILE_TOKEN}, or use strategy handoff`,
		},
	];
}

/** A compaction pi finished: neither aborted nor failed. */
const compactionEvents = (e: JsonObject): HarnessEvent[] =>
	e.aborted === true || e.errorMessage !== undefined
		? []
		: [{ kind: "compaction" }];

/** pi usage keys and the metric each is summed into. */
const USAGE_METRICS = {
	input: METRIC.tokensIn,
	output: METRIC.tokensOut,
	cacheRead: METRIC.tokensCacheRead,
	cacheWrite: METRIC.tokensCacheWrite,
	reasoning: METRIC.tokensReasoning,
} as const;

export type PiOptions = {
	/** The pi executable. Defaults to `pi` on PATH, looked through a mise shim. */
	bin?: string;
	/** The user's pi config dir, of which pi reads and writes `auth.json` alone. Defaults to `~/.pi/agent`. */
	agentDir?: string;
};

function assistantEvents(message: JsonObject): HarnessEvent[] {
	const usage = isObject(message.usage) ? message.usage : {};
	const metrics: Metrics = {};
	for (const [key, metric] of Object.entries(USAGE_METRICS))
		metrics[metric] = finite(usage[key]);
	const parts = Array.isArray(message.content) ? message.content : [];
	const text = parts
		.filter((p) => isObject(p) && p.type === "text")
		.map((p) => String(p.text))
		.join("");
	const thinking = parts.flatMap((p): HarnessEvent[] =>
		isObject(p) && p.type === "thinking" && p.thinking
			? [{ kind: "thinking", text: String(p.thinking) }]
			: [],
	);
	const events: HarnessEvent[] = [
		{ kind: "usage", metrics },
		{
			kind: "context",
			used:
				finite(usage.input) +
				finite(usage.cacheRead) +
				finite(usage.cacheWrite),
		},
		...thinking,
		{ kind: "text", text },
	];
	const stop = String(message.stopReason);
	if (FAILED_STOPS.has(stop)) {
		const reason = String(message.errorMessage ?? `pi stopped with ${stop}`);
		events.push({
			kind: "fault",
			reason,
			...(stop === "error" &&
				isTransient(undefined, reason) && { transient: true }),
		});
	}
	return events;
}

function sessionEvents(e: JsonObject): HarnessEvent[] {
	if (e.version === SESSION_VERSION) return [];
	return [
		{
			kind: "fault",
			reason: `pi reports session version ${String(e.version)}, expected ${SESSION_VERSION}. Pin pi to the version this maestro supports`,
		},
	];
}

function toolEvent(e: JsonObject): HarnessEvent {
	return {
		kind: "tool",
		name: String(e.toolName),
		input: e.args,
		...(typeof e.toolCallId === "string" && { id: e.toolCallId }),
	};
}

function resultEvent(e: JsonObject): HarnessEvent {
	return {
		kind: "tool_result",
		...(typeof e.toolCallId === "string" && { id: e.toolCallId }),
		bytes: resultBytes(isObject(e.result) ? e.result.content : e.result),
		error: e.isError === true,
	};
}

/** The `customType` of the session entry the reporter extension appends. */
const ENVIRONMENT_ENTRY = "maestro-environment";
const REPORTER_FILE = "maestro-environment.js";
/** Where the sandbox sees the reporter extension, bound read-only. */
const REPORTER_PATH = `/${REPORTER_FILE}`;

/**
 * A pi extension that, at the first run's start, appends what pi loaded and the model's window as a custom entry, which
 * `--mode json` streams as `entry_appended`. `skills` follows pi's prompt-customizer example, `window` its
 * border-status-editor example; `contextFiles` is read only when pi gives it.
 */
const REPORTER = `const names = (list, key) =>
	Array.isArray(list) ? list.map((x) => (typeof x === "string" ? x : x?.[key])) : undefined;
export default function (pi) {
	let reported = false;
	pi.on("before_agent_start", (event, ctx) => {
		if (reported) return;
		reported = true;
		const options = event.systemPromptOptions ?? {};
		pi.appendEntry(${JSON.stringify(ENVIRONMENT_ENTRY)}, {
			tools: pi.getActiveTools(),
			skills: names(options.skills, "name"),
			contextFiles: names(options.contextFiles, "path"),
			window: ctx.model?.contextWindow,
		});
	});
}
`;

/** The environment and window the reporter extension's entry carries; any other entry is no event. */
function entryEvents(e: JsonObject): HarnessEvent[] {
	const entry = isObject(e.entry) ? e.entry : {};
	if (entry.type !== "custom" || entry.customType !== ENVIRONMENT_ENTRY)
		return [];
	const data = isObject(entry.data) ? entry.data : {};
	return [
		{ kind: "environment", ...observedOf(data) },
		...windowEvents(data.window),
	];
}

function eventsOf(e: JsonObject): HarnessEvent[] {
	switch (e.type) {
		case "entry_appended":
			return entryEvents(e);
		case "session":
			return sessionEvents(e);
		case "tool_execution_start":
			return [toolEvent(e)];
		case "tool_execution_end":
			return [resultEvent(e)];
		case "message_end":
			return isObject(e.message) && e.message.role === "assistant"
				? assistantEvents(e.message)
				: [];
		case "compaction_end":
			return compactionEvents(e);
		case "agent_settled":
			return e.aborted === true
				? [{ kind: "fault", reason: "pi settled aborted" }]
				: [{ kind: "settled" }];
		default:
			return IGNORED.has(String(e.type)) ? [] : [{ kind: "raw", data: e }];
	}
}

/**
 * Maps pi `--mode json` lines to events. The first event must be the session header. Unknown types and keys pass
 * through or are dropped, never fail.
 */
function parser(): (e: JsonObject) => HarnessEvent[] {
	let first = true;
	return (e) => {
		if (first && e.type !== "session") {
			first = false;
			return [
				{
					kind: "fault",
					reason: `pi's first event is "${String(e.type)}", expected "session". Check the pi version`,
				},
			];
		}
		first = false;
		return eventsOf(e);
	};
}

/** Extensions bring pi's subagents and hooks, if any. */
const NO_EXTENSIONS = ["--no-extensions"];

/** pi's default tools today, named so a release's new defaults never reach an agent. */
const TOOLS = ["read", "bash", "edit", "write"];

/** The tools pi loads, and the parts of its environment maestro does not manage, each switched off. */
const BASELINE = baselineOf({
	tools: { declared: TOOLS, argv: ["--tools", TOOLS.join(",")] },
	subagents: { declared: false, argv: NO_EXTENSIONS },
	skills: { declared: [], argv: ["--no-skills"] },
	mcp: { declared: [], argv: ["--no-mcp"] },
	hooks: { declared: [], argv: NO_EXTENSIONS },
	contextFiles: { declared: [], argv: ["--no-context-files"] },
});

/** The environment pi launches with. */
export const declared = BASELINE.declared;

/** What else pi would otherwise discover or ask, none of which maestro manages. */
const UNMANAGED_OFF = ["--no-prompt-templates", "--no-approve"];

/**
 * The pi argv for a request. The prompt travels on stdin, the instructions in a file pi appends to its system prompt.
 * pi loads an explicit `--extension` under `--no-extensions` (pi docs/cli.md), which is how the reporter loads.
 */
function piArgv(bin: string, req: HarnessRequest): string[] {
	const { model, thinking } = req.runtime;
	return [
		bin,
		"-p",
		"--mode",
		"json",
		...BASELINE.argv,
		"--extension",
		REPORTER_PATH,
		...UNMANAGED_OFF,
		...(req.instructions ? ["--append-system-prompt", INSTRUCTIONS] : []),
		"--session-dir",
		SESSION_DIR,
		"--session-id",
		req.session.id,
		"--model",
		model,
		...(thinking ? ["--thinking", thinking] : []),
	];
}

/** Writes the reporter extension to a fresh host dir, removed when the process exits, and returns its path. */
function stageReporter(): string {
	const dir = mkdtempSync(join(tmpdir(), "maestro-pi-"));
	process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, REPORTER_FILE);
	writeFileSync(path, REPORTER, { flag: "wx" });
	return path;
}

/** The credential values in `<agentDir>/auth.json`: none when the file is missing, unreadable or not a JSON object. */
function credentials(agentDir: string): string[] {
	let auth: unknown;
	try {
		auth = JSON.parse(readFileSync(join(agentDir, AUTH_FILE), "utf8"));
	} catch {
		return [];
	}
	return Object.values(isObject(auth) ? auth : {})
		.filter(isObject)
		.flatMap((entry) => CREDENTIAL_FIELDS.map((field) => entry[field]))
		.filter((v): v is string => typeof v === "string" && v !== "");
}

/**
 * Rebuilds `<owned>` from nothing, so a link the sandboxed agent planted in its place is unlinked, not followed, and
 * fills it: `settings.json` when `settings` is given, and `auth.json` as a link to `auth`, left absent when `auth` is
 * missing. Returns whether it linked. pi writes `auth.json` in place, so a refresh writes through the link.
 */
function ownedDir(
	owned: string,
	auth: string,
	settings: JsonObject | undefined,
): boolean {
	rmSync(owned, { recursive: true, force: true });
	mkdirSync(owned);
	if (settings)
		writeFileSync(join(owned, SETTINGS_FILE), JSON.stringify(settings), {
			flag: "wx",
		});
	if (!existsSync(auth)) return false;
	symlinkSync(auth, join(owned, AUTH_FILE));
	return true;
}

/** `path` with a leading `~` or `~/` taken as the home dir, as pi does, made absolute. */
function expandHome(path: string): string {
	const home = homedir();
	if (path === "~") return home;
	return resolve(path.startsWith("~/") ? join(home, path.slice(2)) : path);
}

/** pi, run as a sandboxed subprocess (ADR 0001). */
export function piHarness(
	options: PiOptions = {},
	backend?: SandboxBackend,
): Harness {
	const agentDir = expandHome(
		options.agentDir ?? join(homedir(), ".pi", "agent"),
	);
	const auth = join(agentDir, AUTH_FILE);
	let bin: string | undefined;
	let reporter: string | undefined;
	const adapter: SubprocessAdapter = {
		name: "pi",
		spec(req) {
			if (!existsSync(agentDir))
				throw new Error(
					`pi config dir does not exist: ${agentDir}. Run pi once and log in`,
				);
			bin ??= resolveBin(PI_BIN, options.bin);
			reporter ??= stageReporter();
			const owned = join(req.session.dir, SESSION_AGENT);
			const linked = ownedDir(owned, auth, settingsOf(req.context, req.window));
			return {
				argv: piArgv(bin, req),
				stdin: req.prompt,
				env: { [AGENT_DIR_VAR]: join(SESSION_DIR, SESSION_AGENT) },
				masked: credentials(owned),
				readOnly: [
					{ src: dirname(bin) },
					{ src: reporter, dst: REPORTER_PATH },
				],
				writable: linked ? [{ src: auth }] : [],
			};
		},
		parser,
	};
	return {
		...subprocessHarness(adapter, backend),
		environment: declared,
		runtimeProblems: (runtime, context, window) => [
			...thinkingProblems(adapter.name, THINKING_LEVELS, runtime),
			...contextProblems(adapter.name, CONTEXT_SUPPORT, context),
			...compactProblems(context, window, runtime.model),
		],
	};
}
