import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

/**
 * A jj repository whose `main` holds a package with one local dependency, its lockfile and `.maestro/slice.ts`, and the
 * commit of `main`.
 */
function treeRepository() {
	const dir = mkdtempSync(join(tmpdir(), "factory-tree-"));
	jj(dir, "git", "init");
	mkdirSync(join(dir, "dep"));
	writeFileSync(
		join(dir, "dep/package.json"),
		'{"name":"dep","version":"1.0.0"}\n',
	);
	writeFileSync(
		join(dir, "package.json"),
		'{"name":"t","private":true,"dependencies":{"dep":"file:./dep"}}\n',
	);
	writeFileSync(join(dir, ".gitignore"), "node_modules\n");
	const installed = Bun.spawnSync(["bun", "install"], { cwd: dir });
	if (installed.exitCode !== 0) throw new Error(installed.stderr.toString());
	rmSync(join(dir, "node_modules"), { recursive: true });
	mkdirSync(join(dir, ".maestro"));
	writeFileSync(join(dir, ".maestro/slice.ts"), "export default 1;\n");
	jj(dir, "commit", "-m", "graph");
	jj(dir, "bookmark", "create", "main", "-r", "@-");
	writeFileSync(join(dir, ".maestro/slice.ts"), "export default 2;\n");
	jj(dir, "commit", "-m", "next");
	const at = (revision: string) =>
		jj(dir, "log", "-r", revision, "--no-graph", "-T", "commit_id");
	return { dir, main: at("main"), next: at("@-") };
}

test("a tree is a workspace of its commit with its dependencies installed, reused, and the only one kept", async () => {
	const { dir, main, next } = treeRepository();
	const root = join(mkdtempSync(join(tmpdir(), "factory-trees-")), "trees");
	const lands = landing(dir, account);
	const first = await lands.tree("main", root);
	expect(first).toBe(join(root, main));
	expect(readFileSync(join(first, ".maestro/slice.ts"), "utf8")).toBe(
		"export default 1;\n",
	);
	expect(existsSync(join(first, "node_modules/dep/package.json"))).toBe(true);
	writeFileSync(join(first, "kept"), "k\n");
	expect(await lands.tree(main, root)).toBe(first);
	expect(existsSync(join(first, "kept"))).toBe(true);
	const second = await lands.tree(next, root);
	expect(readdirSync(root)).toEqual([next]);
	expect(readFileSync(join(second, ".maestro/slice.ts"), "utf8")).toBe(
		"export default 2;\n",
	);
	expect(jj(dir, "workspace", "list")).not.toContain(
		`tree-${main.slice(0, 12)}`,
	);
});

test("a tree directory that is no workspace is rebuilt, and a revision naming no single commit is refused", async () => {
	const { dir, main } = treeRepository();
	const root = join(mkdtempSync(join(tmpdir(), "factory-trees-")), "trees");
	mkdirSync(join(root, main), { recursive: true });
	writeFileSync(join(root, main, "half"), "h\n");
	const lands = landing(dir, account);
	const tree = await lands.tree(main, root);
	expect(existsSync(join(tree, "half"))).toBe(false);
	expect(existsSync(join(tree, ".maestro/slice.ts"))).toBe(true);
	await expect(lands.tree("main | @", root)).rejects.toThrow("not one");
});
