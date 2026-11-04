import { stripVTControlCharacters } from "node:util";
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

/** The variable that names a lane's base to every line run in it. */
const LANE_BASE_ENV = "MAESTRO_LANE_BASE";

/** The variable that names a check's writable output directory to every line. */
export const CHECK_OUTPUT_ENV = "MAESTRO_CHECK_OUTPUT";

/**
 * The environment a line of `spec` runs with: its own `env`, then the lane's `base` and the check's `output`
 * directory when it has one, which a config cannot override.
 */
export const checkEnv = (spec: CheckSpec, base: string, output?: string) => ({
	...spec.env,
	[LANE_BASE_ENV]: base,
	...(output !== undefined && { [CHECK_OUTPUT_ENV]: output }),
});

/**
 * Where lines run: the lane at `dir`, cut from `base`, their PATH, the binds and overlays beside it, and
 * the log their output goes to.
 */
export type Sandboxed = {
	dir: string;
	base: string;
	path: string;
	readOnly: Bind[];
	writable: Bind[];
	/** Host directories seen through a layer whose writes die with the sandbox. */
	overlays: Bind[];
	/** The writable directory a check's lines are told in `MAESTRO_CHECK_OUTPUT`, when it has one. */
	output?: string;
	live: Live;
	log: string[];
};

/** A line of `of` that started: its 1-based number and its text. */
type LineStart = { line: number; of: number; run: string };

/** A line that ended: how it ended and its output. */
type LineEnd = LineStart & { ended: string; output: string[] };

/** What `runLines` reports as each line starts and ends. */
type LineHooks = {
	start?: (start: LineStart) => void;
	end?: (end: LineEnd) => void;
};

/** The most code points of an output line a reason carries. */
const REASON_LINE_MAX = 200;
/** A control character, which a reason cannot carry. */
const CONTROL = /\p{Cc}/gu;

/**
 * The last line of `output` that is not blank, without its terminal escape sequences, and its other control
 * characters turned to spaces.
 */
export const lastLine = (output: readonly string[]) =>
	output
		.flatMap((chunk) => chunk.split("\n"))
		.map((l) => stripVTControlCharacters(l).replace(CONTROL, " ").trim())
		.findLast(Boolean);

/** `what`, then the last non-blank line of `output` when there is one. */
function reasonOf(what: string, output: readonly string[]): string {
	const last = lastLine(output);
	return last === undefined
		? what
		: `${what}: ${[...last].slice(0, REASON_LINE_MAX).join("")}`;
}

/** The last `TAIL_LINES` lines of `output`. */
export const tailOf = (output: readonly string[]) =>
	output.join("\n").split("\n").slice(-TAIL_LINES).join("\n");

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
		// Stderr joins stdout, so the output keeps the order it arrived in.
		argv: ["sh", "-c", `exec 2>&1; ${line}`],
		env: { PATH: s.path, ...checkEnv(spec, s.base, s.output) },
		readOnly: [...s.readOnly, ...pathBinds(spec.readOnly)],
		writable: [...s.writable, ...pathBinds(spec.writable)],
		overlays: s.overlays,
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
 * `hooks` as each starts and ends. A reason starts with `label`, as `<label> line 2 exited 1`, and ends with the last
 * non-blank line of the failing line's output, as `: <line>`, when it has one.
 */
export async function runLines(
	s: Sandboxed,
	label: string,
	spec: CheckSpec,
	hooks: LineHooks = {},
): Promise<Verdict> {
	const deadline =
		spec.timeout === undefined ? undefined : Date.now() + spec.timeout;
	for (const [i, line] of spec.lines.entries()) {
		if (s.live.cancelled) return { outcome: "failed", reason: "cancelled" };
		s.log.push(`$ ${line}`);
		const from = s.log.length;
		const start = { line: i + 1, of: spec.lines.length, run: line };
		hooks.start?.(start);
		const ended = await runLine(s, spec, line, deadline);
		const output = s.log.slice(from);
		hooks.end?.({ ...start, ended: how(ended), output });
		const what = `${label} line ${i + 1} ${how(ended)}`;
		s.log.push(`[${what}]`);
		if ("code" in ended && ended.code === 0) continue;
		const failed = couldNotRun(ended) || s.live.cancelled;
		return {
			outcome: failed ? "failed" : "rejected",
			reason: reasonOf(what, output),
		};
	}
	return { outcome: "ok" };
}
