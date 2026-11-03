import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "./forge";
import { landing } from "./land";

const account: Account = {
	login: "maestro-tm",
	name: "Tour Manager",
	email: "tm@forge.example",
};
const owner = {
	JJ_USER: "Owner",
	JJ_EMAIL: "owner@example.com",
	JJ_CONFIG: "",
};

const jj = (cwd: string, ...args: string[]) => {
	const run = Bun.spawnSync(["jj", ...args], {
		cwd,
		env: { ...process.env, ...owner },
	});
	if (run.exitCode !== 0) throw new Error(run.stderr.toString());
	return run.stdout.toString().trim();
};

/** A jj repository whose commits `feat` and, on it, `top` are an owner's, with `main` beneath them. */
function repository() {
	const dir = mkdtempSync(join(tmpdir(), "factory-land-"));
	jj(dir, "git", "init");
	writeFileSync(join(dir, "a"), "a\n");
	jj(dir, "commit", "-m", "base");
	jj(dir, "bookmark", "create", "main", "-r", "@-");
	writeFileSync(join(dir, "b"), "b\n");
	jj(dir, "commit", "-m", "feat");
	writeFileSync(join(dir, "c"), "c\n");
	jj(dir, "commit", "-m", "fix");
	const top = jj(dir, "log", "-r", "@-", "--no-graph", "-T", "commit_id");
	return { dir, top };
}

const who = (dir: string, revision: string) =>
	jj(
		dir,
		"log",
		"-r",
		revision,
		"--no-graph",
		"-T",
		'author.name() ++ "|" ++ author.email() ++ "|" ++ committer.name() ++ "|" ++ committer.email() ++ "|" ++ if(signature, "signed", "unsigned")',
	);
const WHO = "Tour Manager|tm@forge.example|Tour Manager|tm@forge.example";

/** An SSH key pair at a fresh path. */
function keyFile() {
	const path = join(mkdtempSync(join(tmpdir(), "factory-key-")), "key");
	const made = Bun.spawnSync(["ssh-keygen", "-q", "-N", "", "-f", path]);
	if (made.exitCode !== 0) throw new Error(made.stderr.toString());
	return path;
}

test("a described and a restacked commit carry the account as author and committer, unsigned without a key", async () => {
	const { dir, top } = repository();
	const lands = landing(dir, account);
	const described = await lands.describe(dir, "feat: x");
	expect(who(dir, described)).toBe(`${WHO}|unsigned`);
	const restacked = await lands.restack(dir, `main..${top}`, "main");
	if (!("commit" in restacked)) throw new Error("conflict");
	expect(who(dir, "main..@-")).toBe(`${WHO}|unsigned`.repeat(2));
	expect(who(dir, top)).toStartWith("Owner|owner@example.com|Owner");
});

test("a squash folds the change into its parent, described anew and the account's", async () => {
	const { dir, top } = repository();
	writeFileSync(join(dir, "d"), "d\n");
	const squashed = await landing(dir, account).squash(dir, "feat: y");
	expect(
		jj(
			dir,
			"log",
			"-r",
			"main..@-",
			"--no-graph",
			"-T",
			'description.first_line() ++ "\n"',
		),
	).toBe("feat: y\nfeat");
	expect(jj(dir, "file", "list", "-r", squashed)).toBe("a\nb\nc\nd");
	expect(who(dir, squashed)).toBe(`${WHO}|unsigned`);
	expect(squashed).not.toBe(top);
});

test("with a signing key set, described and restacked commits are signed", async () => {
	const { dir, top } = repository();
	const lands = landing(dir, account, keyFile());
	const described = await lands.describe(dir, "feat: x");
	expect(who(dir, described)).toBe(`${WHO}|signed`);
	const restacked = await lands.restack(dir, `main..${top}`, "main");
	if (!("commit" in restacked)) throw new Error("conflict");
	expect(who(dir, "main..@-")).toBe(`${WHO}|signed`.repeat(2));
});

test("a signing key at a missing path is refused by name", () => {
	expect(() => landing("/repo", account, "/nope/key")).toThrow(
		/MAESTRO_TM_SIGNING_KEY.*\/nope\/key/s,
	);
});
