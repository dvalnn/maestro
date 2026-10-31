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
		await forge().push(dir, "abc123", "factory/i7");
	} finally {
		process.env.PATH = path;
	}
	const basic = Buffer.from(`${TOKEN}:`).toString("base64");
	const args = readFileSync(argv, "utf8");
	expect(args).toBe(
		"push\nhttps://forge.example/owner/repo.git\n+abc123:refs/heads/factory/i7\n",
	);
	const holders = readFileSync(environment, "utf8")
		.split("\n")
		.filter((line) => line.includes(basic) || line.includes(TOKEN));
	expect(holders).toEqual([`GIT_CONFIG_VALUE_0=Authorization: Basic ${basic}`]);
});
