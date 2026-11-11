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

test("a described commit carries the account as author and committer, unsigned without a key", async () => {
	const { dir } = repository();
	const lands = landing(dir, account);
	const described = await lands.describe(dir, "feat: x");
	expect(who(dir, described)).toBe(`${WHO}|unsigned`);
});

test("a squash folds the change into its parent, even a pushed branch head, described anew and the account's", async () => {
	const { dir, top } = repository();
	const remote = mkdtempSync(join(tmpdir(), "factory-remote-"));
	Bun.spawnSync(["git", "init", "--bare", "-q", remote]);
	jj(dir, "git", "remote", "add", "origin", remote);
	jj(dir, "bookmark", "create", "pr", "-r", "@-");
	jj(dir, "git", "push", "--bookmark", "pr");
	jj(dir, "bookmark", "untrack", "pr@origin");
	jj(dir, "bookmark", "forget", "pr");
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

test("with a signing key set, a described commit is signed", async () => {
	const { dir } = repository();
	const lands = landing(dir, account, keyFile());
	const described = await lands.describe(dir, "feat: x");
	expect(who(dir, described)).toBe(`${WHO}|signed`);
});

test("a signing key at a missing path is refused by name", () => {
	expect(() => landing("/repo", account, "/nope/key")).toThrow(
		/MAESTRO_TM_SIGNING_KEY.*\/nope\/key/s,
	);
});

test("a fetch brings the commits origin gained into the repository", async () => {
	const origin = mkdtempSync(join(tmpdir(), "factory-origin-"));
	jj(origin, "git", "init");
	writeFileSync(join(origin, "a"), "a\n");
	jj(origin, "commit", "-m", "base");
	jj(origin, "bookmark", "create", "main", "-r", "@-");
	const dir = mkdtempSync(join(tmpdir(), "factory-clone-"));
	jj(dir, "git", "clone", origin, dir);
	const lands = landing(dir, account);
	writeFileSync(join(origin, "b"), "b\n");
	jj(origin, "commit", "-m", "merged");
	jj(origin, "bookmark", "set", "main", "-r", "@-");
	const tip = jj(origin, "log", "-r", "main", "--no-graph", "-T", "commit_id");
	expect(() => jj(dir, "log", "-r", tip)).toThrow();
	await lands.fetch();
	expect(jj(dir, "log", "-r", tip, "--no-graph", "-T", "commit_id")).toBe(tip);
});
