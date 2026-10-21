#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isatty } from "node:tty";
import { messageOf } from "@maestro/ir";
import { main } from "./cli";
import { loadDotenv } from "./config";
import { builtinHosts } from "./hosts";
import { EXIT } from "./output";
import { fullScreen } from "./screen";

const STDIN_FD = 0;
/** Synchronous writes: `process.exit` drops what an async write to a slow pipe has not yet flushed. */
const STDOUT_FD = 1;
const STDERR_FD = 2;
/** The size taken for a terminal that reports none. */
const UNSIZED_TERMINAL = { columns: 80, rows: 24 };

/** Writes `line` to `fd`. A reader that has gone away ends the process quietly, as it does a Unix filter. */
function emit(fd: number, line: string): void {
	try {
		writeSync(fd, `${line}\n`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
		process.exit(EXIT.ok);
	}
}

/** Asks `question` on the terminal, and whether the answer starts with `y`. */
async function confirm(question: string): Promise<boolean> {
	const lines = createInterface({
		input: process.stdin,
		output: process.stderr,
	});
	try {
		return /^y/i.test(await lines.question(`${question} [y/N] `));
	} finally {
		lines.close();
	}
}

// The release binary is built not to autoload a `.env` from the cwd; a run through `bun` still does.
try {
	loadDotenv(process.env);
} catch (error) {
	emit(STDERR_FD, messageOf(error));
	process.exit(EXIT.failed);
}

process.exit(
	await main(process.argv.slice(2), {
		hosts: builtinHosts(process.env),
		cwd: process.cwd(),
		env: process.env,
		stdout: (line) => emit(STDOUT_FD, line),
		stderr: (line) => emit(STDERR_FD, line),
		confirm: process.stdin.isTTY ? confirm : undefined,
		// Reading `process.stdout` or `process.stderr` makes its descriptor non-blocking, which loses writes to a slow
		// pipe.
		terminal: isatty(STDOUT_FD)
			? () => ({
					columns: process.stdout.columns || UNSIZED_TERMINAL.columns,
					rows: process.stdout.rows || UNSIZED_TERMINAL.rows,
				})
			: undefined,
		stderrTerminal: isatty(STDERR_FD)
			? () => ({
					columns: process.stderr.columns || UNSIZED_TERMINAL.columns,
				})
			: undefined,
		screen:
			isatty(STDIN_FD) && isatty(STDOUT_FD)
				? fullScreen({
						stdin: process.stdin,
						write: (text) => writeSync(STDOUT_FD, text),
						process,
						stderr: (line) => emit(STDERR_FD, line),
					})
				: undefined,
	}),
);
