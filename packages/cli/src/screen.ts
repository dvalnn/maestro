import { constants } from "node:os";
import { messageOf } from "@maestro/ir";
import type { Screen } from "./command";
import { EXIT, SIGNAL_EXIT_BASE } from "./output";

/** What a `Screen` drives: the terminal's input, a write to it, and the process it runs in. */
export type Tty = {
	stdin: {
		setRawMode(raw: boolean): unknown;
		on(event: "data", listener: (chunk: Buffer) => void): unknown;
		off(event: "data", listener: (chunk: Buffer) => void): unknown;
		resume(): unknown;
		pause(): unknown;
	};
	/** Writes `text` to the terminal as it is. */
	write(text: string): void;
	process: {
		pid: number;
		on(event: string, listener: (error: Error) => void): unknown;
		off(event: string, listener: (error: Error) => void): unknown;
		kill(pid: number, signal: string): unknown;
		exit(code: number): void;
	};
	/** Prints a line on stderr. */
	stderr(line: string): void;
};

const ESC = "\u001b";
/** The alternate screen with the cursor hidden, and back. */
const TAKE_SCREEN = `${ESC}[?1049h${ESC}[?25l`;
const GIVE_SCREEN = `${ESC}[?25h${ESC}[?1049l`;
const HOME = `${ESC}[H`;
const ERASE_LINE = `${ESC}[K`;
const ERASE_BELOW = `${ESC}[J`;
/** Ctrl-Z, which raw mode delivers as input instead of a stop. */
const SUSPEND_KEY = "\u001a";
/** The signals that end a process taking the screen, which gives it back first. */
const ENDING = ["SIGTERM", "SIGHUP", "SIGINT"] as const;

/** Runs `step`, ignoring what it throws. */
function quietly(step: () => unknown): void {
	try {
		step();
	} catch {
		// The terminal may be gone, after a hang-up: giving it back must not stop the process ending.
	}
}

/**
 * The terminal of `tty` as a `Screen`. While taken, Ctrl-Z or `SIGTSTP` gives it back and stops the process, and
 * `SIGCONT` then takes it again; a resize redraws; `SIGTERM`, `SIGHUP` and `SIGINT` give it back and exit with 128 plus the
 * signal's number; an uncaught error gives it back and exits 1; the process exiting gives it back.
 */
export function fullScreen({ stdin, write, process, stderr }: Tty): Screen {
	let onKey: ((chunk: string) => void) | undefined;
	let taken = false;
	const redraw = () => onKey?.("");
	const give = () => {
		if (!taken) return;
		quietly(() => stdin.setRawMode(false));
		quietly(() => stdin.off("data", input));
		quietly(() => stdin.pause());
		quietly(() => write(GIVE_SCREEN));
		taken = false;
	};
	const suspend = () => {
		give();
		process.kill(process.pid, "SIGSTOP");
	};
	function input(chunk: Buffer) {
		const text = chunk.toString("utf8");
		if (text.includes(SUSPEND_KEY)) suspend();
		else onKey?.(text);
	}
	const take = () => {
		if (taken) return;
		taken = true;
		try {
			write(TAKE_SCREEN);
			stdin.setRawMode(true);
			stdin.on("data", input);
			stdin.resume();
		} catch (error) {
			give();
			throw error;
		}
	};
	const resumed = () => {
		// A hang-up sends `SIGCONT` too, to a terminal that is gone: only a stopped screen redraws.
		if (taken) return;
		take();
		redraw();
	};
	const crashed = (error: Error) => {
		leave();
		stderr(messageOf(error));
		process.exit(EXIT.failed);
	};
	const handlers: [event: string, listener: (error: Error) => void][] = [
		...ENDING.map((signal): [string, () => void] => [
			signal,
			() => {
				leave();
				process.exit(SIGNAL_EXIT_BASE + constants.signals[signal]);
			},
		]),
		["SIGTSTP", suspend],
		["SIGCONT", resumed],
		["SIGWINCH", redraw],
		["uncaughtException", crashed],
		["exit", leave],
	];
	function leave() {
		give();
		onKey = undefined;
		for (const [event, listener] of handlers) process.off(event, listener);
	}
	return {
		enter(keys) {
			onKey = keys;
			for (const [event, listener] of handlers) process.on(event, listener);
			take();
		},
		draw(lines) {
			if (!taken) return;
			const body = lines.map((l) => `${l}${ERASE_LINE}`).join("\r\n");
			write(`${HOME}${body}${ERASE_BELOW}`);
		},
		leave,
	};
}
