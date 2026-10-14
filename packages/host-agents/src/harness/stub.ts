import { bubblewrap, type SandboxBackend } from "../sandbox/index";
import { type SubprocessAdapter, subprocessHarness } from "./subprocess";
import type { Harness, HarnessEvent } from "./types";

/** Emitted objects are written as JSON lines on stdout, like a real harness's event stream. */
export type StubStep =
	| { emit: Record<string, unknown>; delayMs?: number }
	/** `write` is a lane-relative path. */
	| { write: string; content: string }
	| { hang: true };

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function script(steps: StubStep[]) {
	const sh = [
		// stdin to a file outside the lane (the lane is the changeset), then report what arrived
		"cat > /tmp/prompt",
		`printf '{"type":"prompt","bytes":%s,"sha256":"%s"}\\n' "$(wc -c < /tmp/prompt)" "$(sha256sum < /tmp/prompt | cut -d' ' -f1)"`,
	];
	for (const s of steps) {
		if ("emit" in s) {
			sh.push(`printf '%s\\n' ${q(JSON.stringify(s.emit))}`);
			if (s.delayMs) sh.push(`sleep ${s.delayMs / 1000}`);
		} else if ("write" in s) {
			const path = q(`/lane/${s.write}`);
			sh.push(
				`mkdir -p "$(dirname ${path})"`,
				`printf '%s' ${q(s.content)} > ${path}`,
			);
		} else sh.push("sleep 300");
	}
	return sh.join("\n");
}

function parse(line: string): HarnessEvent | undefined {
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
 * Replays `steps` inside the real sandbox. The prompt is read from stdin and reported as a `prompt` event carrying its
 * byte count and sha256.
 */
export function stubHarness(
	steps: StubStep[],
	backend?: SandboxBackend,
): Harness {
	const adapter: SubprocessAdapter = {
		name: "stub",
		spec: (req) => ({ argv: ["sh", "-c", script(steps)], stdin: req.prompt }),
		parse,
	};
	return subprocessHarness(adapter, backend ?? bubblewrap);
}
