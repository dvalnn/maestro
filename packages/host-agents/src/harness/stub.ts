import { bubblewrap, type SandboxBackend } from "../sandbox/index";
import { type SubprocessAdapter, subprocessHarness } from "./subprocess";
import type { Harness, HarnessEvent } from "./types";

/** Emitted objects are written as JSON lines on stdout, like a real harness's event stream. */
export type StubStep =
	| { emit: Record<string, unknown>; delayMs?: number }
	/** `write` is a lane-relative path, or absolute (`OUTBOX`, `SESSION_DIR`). */
	| { write: string; content: string }
	/** Never settles. */
	| { hang: true };

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function shell(s: StubStep): string[] {
	if ("hang" in s) return ["sleep 300"];
	if ("emit" in s)
		return [
			`printf '%s\\n' ${q(JSON.stringify(s.emit))}`,
			...(s.delayMs ? [`sleep ${s.delayMs / 1000}`] : []),
		];
	const path = q(s.write.startsWith("/") ? s.write : `/lane/${s.write}`);
	return [
		`mkdir -p "$(dirname ${path})"`,
		`printf '%s' ${q(s.content)} > ${path}`,
	];
}

function script(steps: StubStep[]) {
	return [
		// stdin to a file outside the lane (the lane is the changeset), then report what arrived
		"cat > /tmp/prompt",
		`printf '{"type":"prompt","bytes":%s,"sha256":"%s"}\\n' "$(wc -c < /tmp/prompt)" "$(sha256sum < /tmp/prompt | cut -d' ' -f1)"`,
		...steps.flatMap(shell),
		`printf '{"type":"settled"}\\n'`,
	].join("\n");
}

function parse(line: string): HarnessEvent[] {
	const e = parseLine(line);
	return e ? [e] : [];
}

function parseLine(line: string): HarnessEvent | undefined {
	let e: Record<string, unknown>;
	try {
		e = JSON.parse(line);
	} catch {
		return undefined;
	}
	switch (e.type) {
		case "turn":
			return { kind: "turn" };
		case "text":
			return { kind: "text", text: String(e.text) };
		case "tool":
			return { kind: "tool", name: String(e.name) };
		case "settled":
			return { kind: "settled" };
		case "fault":
			return { kind: "fault", reason: String(e.reason) };
		case "usage":
			return {
				kind: "usage",
				metrics: {
					tokens_in: Number(e.tokens_in ?? 0),
					tokens_out: Number(e.tokens_out ?? 0),
				},
			};
		default:
			return { kind: "raw", data: e };
	}
}

/**
 * Replays `steps` inside the real sandbox, then emits `{"type":"settled"}`. The prompt is read from stdin and reported as a `prompt` event carrying its
 * byte count and sha256.
 */
export function stubHarness(
	steps: StubStep[],
	backend?: SandboxBackend,
): Harness {
	const adapter: SubprocessAdapter = {
		name: "stub",
		spec: (req) => ({ argv: ["sh", "-c", script(steps)], stdin: req.prompt }),
		parser: () => parse,
	};
	return subprocessHarness(adapter, backend ?? bubblewrap);
}
