#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isatty } from "node:tty";
import { main } from "./cli";
import { builtinHosts } from "./hosts";

/** Synchronous writes: `process.exit` drops what an async write to a slow pipe has not yet flushed. */
const STDOUT_FD = 1;
const STDERR_FD = 2;
/** The size taken for a terminal that reports none. */
const UNSIZED_TERMINAL = { columns: 80, rows: 24 };

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

process.exit(
	await main(process.argv.slice(2), {
		hosts: builtinHosts(process.env),
		cwd: process.cwd(),
		env: process.env,
		stdout: (line) => writeSync(STDOUT_FD, `${line}\n`),
		stderr: (line) => writeSync(STDERR_FD, `${line}\n`),
		confirm: process.stdin.isTTY ? confirm : undefined,
		// Reading `process.stdout` makes the descriptor non-blocking, which loses writes to a slow pipe.
		terminal: isatty(STDOUT_FD)
			? () => ({
					columns: process.stdout.columns || UNSIZED_TERMINAL.columns,
					rows: process.stdout.rows || UNSIZED_TERMINAL.rows,
				})
			: undefined,
	}),
);
