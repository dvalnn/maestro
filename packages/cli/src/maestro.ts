#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isatty } from "node:tty";
import { messageOf } from "@maestro/ir";
import { main } from "./cli";
import { loadDotenv } from "./config";
import { builtinHosts } from "./hosts";
import { EXIT } from "./output";
import { startPager } from "./pager";
import { fullScreen } from "./screen";
import { selfOf } from "./session";

const STDIN_FD = 0;
/** Synchronous writes: `process.exit` drops what an async write to a slow pipe has not yet flushed. */
const STDOUT_FD = 1;
const STDERR_FD = 2;
/** The size taken for a terminal that reports none. */
const UNSIZED_TERMINAL = { columns: 80, rows: 24 };

const PAUSE = new Int32Array(new SharedArrayBuffer(4));
/** How long a full pipe is waited on before the write is retried. */
const FULL_PIPE_WAIT_MS = 1;

/**
 * Writes every byte of `data` to `fd`, waiting synchronously while a non-blocking pipe is full. A reader that has gone
 * away ends the process quietly, as it does a Unix filter.
 */
function emit(fd: number, data: string | Uint8Array): void {
	let rest = typeof data === "string" ? Buffer.from(data) : data;
	try {
		while (rest.length > 0) {
			try {
				rest = rest.subarray(writeSync(fd, rest));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
				Atomics.wait(PAUSE, 0, 0, FULL_PIPE_WAIT_MS);
			}
		}
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
	emit(STDERR_FD, `${messageOf(error)}\n`);
	process.exit(EXIT.failed);
}

process.exit(
	await main(process.argv.slice(2), {
		hosts: builtinHosts(process.env),
		cwd: process.cwd(),
		env: process.env,
		stdout: (line) => emit(STDOUT_FD, `${line}\n`),
		stdoutBytes: (bytes) => emit(STDOUT_FD, bytes),
		stderr: (line) => emit(STDERR_FD, `${line}\n`),
		confirm: process.stdin.isTTY ? confirm : undefined,
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
						write: (text) => emit(STDOUT_FD, text),
						process,
						stderr: (line) => emit(STDERR_FD, `${line}\n`),
					})
				: undefined,
		startPager,
		self: selfOf(),
	}),
);
