#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { main } from "./cli";

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
		hosts: [],
		cwd: process.cwd(),
		env: process.env,
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
		confirm: process.stdin.isTTY ? confirm : undefined,
	}),
);
