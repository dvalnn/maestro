#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { piHarness } from "@maestro/harness-pi";
import { repoHost } from "@maestro/host-repo";
import { main } from "./cli";

/** Synchronous writes: `process.exit` drops what an async write to a slow pipe has not yet flushed. */
const STDOUT_FD = 1;
const STDERR_FD = 2;

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
		hosts: [repoHost({ harnesses: [piHarness()] })],
		cwd: process.cwd(),
		env: process.env,
		stdout: (line) => writeSync(STDOUT_FD, `${line}\n`),
		stderr: (line) => writeSync(STDERR_FD, `${line}\n`),
		confirm: process.stdin.isTTY ? confirm : undefined,
	}),
);
