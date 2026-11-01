import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forge } from "./forge";

const TOKEN = "s3cret-token";
const dir = mkdtempSync(join(tmpdir(), "factory-forge-"));
const argv = join(dir, "argv");
const environment = join(dir, "env");
const shim = (name: string, body: string) => {
	writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
	chmodSync(join(dir, name), 0o755);
};
shim("python3", `echo "forge.example owner repo ${TOKEN}"`);
shim("git", `printf '%s\\n' "$@" > ${argv}\nenv > ${environment}`);

test("a push gives git the token through its environment config only", async () => {
	const path = process.env.PATH;
	process.env.PATH = `${dir}:${path}`;
	try {
		await forge().push(dir, "abc123", "maestro-tm/i7");
	} finally {
		process.env.PATH = path;
	}
	const basic = Buffer.from(`${TOKEN}:`).toString("base64");
	const args = readFileSync(argv, "utf8");
	expect(args).toBe(
		"push\nhttps://forge.example/owner/repo.git\n+abc123:refs/heads/maestro-tm/i7\n",
	);
	const holders = readFileSync(environment, "utf8")
		.split("\n")
		.filter((line) => line.includes(basic) || line.includes(TOKEN));
	expect(holders).toEqual([`GIT_CONFIG_VALUE_0=Authorization: Basic ${basic}`]);
});

test.each([
	["already armed", "Pull request is already scheduled to auto merge", true],
	["refused otherwise", "merge failed because of conflict", false],
])(
	"arming a PR the forge answers 409 as %s throws only when not armed",
	async (_, refusal, passes) => {
		const refusing = mkdtempSync(join(tmpdir(), "factory-forge-"));
		writeFileSync(
			join(refusing, "python3"),
			`#!/bin/sh\necho '409 from POST /pulls/30/merge: {"message":"${refusal}"}' >&2\nexit 1\n`,
		);
		chmodSync(join(refusing, "python3"), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${refusing}:${path}`;
		try {
			const armed = forge().arm(30);
			if (passes) await armed;
			else await expect(armed).rejects.toThrow(refusal);
		} finally {
			process.env.PATH = path;
		}
	},
);
