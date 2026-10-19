import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	finite,
	type Harness,
	type HarnessEvent,
	type HarnessRequest,
	IDENTITY,
	isObject,
	type JsonObject,
	METRIC,
	type Metrics,
	resolveBin,
	SESSION_DIR,
	type SubprocessAdapter,
	subprocessHarness,
} from "@maestro/host-repo/harness";
import type { SandboxBackend } from "@maestro/host-repo/sandbox";

/** The `session.version` of pi's JSON header this adapter reads. */
const SESSION_VERSION = 3;
const AGENT_DIR_VAR = "PI_CODING_AGENT_DIR";
const PI_BIN = "pi";
const AUTH_FILE = "auth.json";
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
	"tool_execution_end",
]);

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
	/** pi's config dir, bound read-write. Defaults to `~/.pi/agent`. */
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
		...thinking,
		{ kind: "text", text },
	];
	const stop = String(message.stopReason);
	if (FAILED_STOPS.has(stop))
		events.push({
			kind: "fault",
			reason: String(message.errorMessage ?? `pi stopped with ${stop}`),
		});
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

function eventsOf(e: JsonObject): HarnessEvent[] {
	switch (e.type) {
		case "session":
			return sessionEvents(e);
		case "tool_execution_start":
			return [{ kind: "tool", name: String(e.toolName), input: e.args }];
		case "message_end":
			return isObject(e.message) && e.message.role === "assistant"
				? assistantEvents(e.message)
				: [];
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

/** What pi would otherwise discover on its own, none of which maestro manages. */
const UNMANAGED_OFF = [
	"--no-skills",
	"--no-extensions",
	"--no-prompt-templates",
	"--no-context-files",
];

/** The pi argv for a request. The prompt travels on stdin, the identity in a file pi appends to its system prompt. */
function piArgv(bin: string, req: HarnessRequest): string[] {
	const { model, thinking } = req.role;
	return [
		bin,
		"-p",
		"--mode",
		"json",
		...UNMANAGED_OFF,
		...(req.identity ? ["--append-system-prompt", IDENTITY] : []),
		"--session-dir",
		SESSION_DIR,
		"--session-id",
		req.session.id,
		"--model",
		model,
		...(thinking ? ["--thinking", thinking] : []),
	];
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

/** pi, run as a sandboxed subprocess (ADR 0001). */
export function piHarness(
	options: PiOptions = {},
	backend?: SandboxBackend,
): Harness {
	const agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
	let bin: string | undefined;
	const adapter: SubprocessAdapter = {
		name: "pi",
		spec(req) {
			if (!existsSync(agentDir))
				throw new Error(
					`pi config dir does not exist: ${agentDir}. Run pi once and log in`,
				);
			bin ??= resolveBin(PI_BIN, options.bin);
			return {
				argv: piArgv(bin, req),
				stdin: req.prompt,
				env: { [AGENT_DIR_VAR]: agentDir },
				masked: credentials(agentDir),
				readOnly: [{ src: dirname(bin) }],
				writable: [{ src: agentDir }],
			};
		},
		parser,
	};
	return subprocessHarness(adapter, backend);
}
