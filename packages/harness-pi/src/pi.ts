import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	type Harness,
	type HarnessEvent,
	type HarnessRequest,
	IDENTITY,
	type Metrics,
	SESSION_DIR,
	type SubprocessAdapter,
	subprocessHarness,
} from "@maestro/host-repo/harness";
import type { SandboxBackend } from "@maestro/host-repo/sandbox";

/** The `session.version` of pi's JSON header this adapter reads. */
const SESSION_VERSION = 3;
const AGENT_DIR_VAR = "PI_CODING_AGENT_DIR";
const PI_BIN = "pi";
const FAILED_STOPS = new Set(["error", "aborted"]);

/** Events that carry nothing the adapter reports. */
const IGNORED = new Set([
	"agent_start",
	"agent_end",
	"message_start",
	"message_update",
	"turn_end",
	"tool_execution_update",
	"tool_execution_end",
]);

/** pi usage keys and the metric each is summed into. */
const USAGE_METRICS = {
	input: "tokens_in",
	output: "tokens_out",
	cacheRead: "tokens_cache_read",
	cacheWrite: "tokens_cache_write",
	reasoning: "tokens_reasoning",
} as const;

export type PiOptions = {
	/** The pi executable. Defaults to `pi` on PATH, looked through a mise shim. */
	bin?: string;
	/** pi's config dir, bound read-write. Defaults to `~/.pi/agent`. */
	agentDir?: string;
};

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function number(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function assistantEvents(message: Json): HarnessEvent[] {
	const usage = isObject(message.usage) ? message.usage : {};
	const metrics: Metrics = {};
	for (const [key, metric] of Object.entries(USAGE_METRICS))
		metrics[metric] = number(usage[key]);
	const parts = Array.isArray(message.content) ? message.content : [];
	const text = parts
		.filter((p) => isObject(p) && p.type === "text")
		.map((p) => String(p.text))
		.join("");
	const events: HarnessEvent[] = [
		{ kind: "usage", metrics },
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

function sessionEvents(e: Json): HarnessEvent[] {
	if (e.version === SESSION_VERSION) return [];
	return [
		{
			kind: "fault",
			reason: `pi reports session version ${String(e.version)}, expected ${SESSION_VERSION}. Pin pi to the version this maestro supports`,
		},
	];
}

function eventsOf(e: Json): HarnessEvent[] {
	switch (e.type) {
		case "session":
			return sessionEvents(e);
		case "turn_start":
			return [{ kind: "turn" }];
		case "tool_execution_start":
			return [{ kind: "tool", name: String(e.toolName) }];
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
function parser(): (line: string) => HarnessEvent[] {
	let first = true;
	return (line) => {
		let e: unknown;
		try {
			e = JSON.parse(line);
		} catch {
			return [];
		}
		if (!isObject(e)) return [];
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

/** The real pi executable: a version-manager shim resolves to the manager, so it is asked where pi lives. */
function resolveBin(bin: string | undefined): string {
	const found = bin ?? Bun.which(PI_BIN);
	if (!found)
		throw new Error("pi is not on PATH. Install pi or pass its path as `bin`");
	const real = realpathSync(found);
	if (bin || basename(real) === PI_BIN) return real;
	const asked = Bun.spawnSync(["mise", "which", PI_BIN])
		.stdout.toString()
		.trim();
	return asked ? realpathSync(asked) : real;
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

/** pi, run as a sandboxed subprocess (ADR 0001). */
export function piHarness(
	options: PiOptions = {},
	backend?: SandboxBackend,
): Harness {
	const agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
	const adapter: SubprocessAdapter = {
		name: "pi",
		spec(req) {
			if (!existsSync(agentDir))
				throw new Error(
					`pi config dir does not exist: ${agentDir}. Run pi once and log in`,
				);
			const bin = resolveBin(options.bin);
			return {
				argv: piArgv(bin, req),
				stdin: req.prompt,
				env: { [AGENT_DIR_VAR]: agentDir },
				readOnly: [{ src: dirname(bin) }],
				writable: [{ src: agentDir }],
			};
		},
		parser,
	};
	return subprocessHarness(adapter, backend);
}
