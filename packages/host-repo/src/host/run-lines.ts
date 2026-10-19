import { type Bind, bubblewrap } from "../sandbox/index";
import type { CheckSpec } from "./config";
import type { Live } from "./live";

/** A check's usage error. */
export const USAGE_EXIT = 3;
/** The exit a line that runs past its timeout counts as, as `timeout(1)` gives. */
const TIMEOUT_EXIT = 124;
/** The shell's exit for a command it cannot find. */
const NOT_FOUND_EXIT = 127;
/** The exit of a line that was sent SIGKILL: out of memory, `kill -9`, a hard timeout kill. */
const KILLED_EXIT = 137;
/** Exits that mean the lines could not run, rather than that they found a fault; any other non-zero exit is a fault. */
export const FAILED_EXITS = [
	USAGE_EXIT,
	TIMEOUT_EXIT,
	NOT_FOUND_EXIT,
	KILLED_EXIT,
];
/** How many trailing lines of a line's output are shown where a log is not. */
export const TAIL_LINES = 40;

export type Verdict = {
	outcome: "ok" | "rejected" | "failed";
	reason?: string;
};

/** How a line ended: its exit code, or the signal that killed it. */
type Ended = { code: number } | { signal: string };

/** Where lines run: the lane at `dir` and the binds beside it, and the log their output goes to. */
export type Sandboxed = {
	dir: string;
	readOnly: Bind[];
	writable: Bind[];
	live: Live;
	log: string[];
};

/** A line that ended: its 1-based number, its text, how it ended and its output. */
type LineEnd = {
	line: number;
	run: string;
	ended: string;
	output: string[];
};

/** Binds of `paths`, each at its own path. */
export const pathBinds = (...paths: string[][]): Bind[] =>
	[...new Set(paths.flat())].map((src) => ({ src }));

/** Runs `line` of `spec` in the lane until `deadline`, an epoch millisecond, or without limit, logging its output. */
async function runLine(
	s: Sandboxed,
	spec: CheckSpec,
	line: string,
	deadline: number | undefined,
): Promise<Ended> {
	const proc = bubblewrap.start({
		lane: s.dir,
		argv: ["sh", "-c", line],
		env: spec.env,
		readOnly: [...s.readOnly, ...pathBinds(spec.readOnly)],
		writable: [...s.writable, ...pathBinds(spec.writable)],
	});
	s.live.stop = () => proc.kill();
	let late = false;
	const timer =
		deadline === undefined
			? undefined
			: setTimeout(
					() => {
						late = true;
						proc.kill().catch(() => {});
					},
					Math.max(0, deadline - Date.now()),
				);
	try {
		for await (const out of proc.stdout) s.log.push(out);
		const exit = await proc.exited;
		if (exit.stderr) s.log.push(exit.stderr.trimEnd());
		if (late) return { code: TIMEOUT_EXIT };
		return exit.code === null
			? { signal: String(exit.signal) }
			: { code: exit.code };
	} finally {
		clearTimeout(timer);
	}
}

const how = (ended: Ended) =>
	"code" in ended
		? `exited ${ended.code}`
		: `was killed by signal ${ended.signal}`;

/** Whether a line that ended so means the lines could not run. */
const couldNotRun = (ended: Ended) =>
	!("code" in ended) || FAILED_EXITS.includes(ended.code);

/**
 * Runs the lines of `spec` in order under its one timeout, the first that does not exit 0 stopping them, and calls
 * `onEnd` as each ends. A reason starts with `label`, as `<label> line 2 exited 1`.
 */
export async function runLines(
	s: Sandboxed,
	label: string,
	spec: CheckSpec,
	onEnd: (end: LineEnd) => void = () => {},
): Promise<Verdict> {
	const deadline =
		spec.timeout === undefined ? undefined : Date.now() + spec.timeout;
	for (const [i, line] of spec.lines.entries()) {
		if (s.live.cancelled) return { outcome: "failed", reason: "cancelled" };
		s.log.push(`$ ${line}`);
		const from = s.log.length;
		const ended = await runLine(s, spec, line, deadline);
		onEnd({
			line: i + 1,
			run: line,
			ended: how(ended),
			output: s.log.slice(from),
		});
		const what = `${label} line ${i + 1} ${how(ended)}`;
		s.log.push(`[${what}]`);
		if ("code" in ended && ended.code === 0) continue;
		const failed = couldNotRun(ended) || s.live.cancelled;
		return { outcome: failed ? "failed" : "rejected", reason: what };
	}
	return { outcome: "ok" };
}
