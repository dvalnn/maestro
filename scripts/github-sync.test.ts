import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "github-sync.sh");
const CONTRIBUTOR = "Contributor <contributor@example.com>";
const env = {
	...process.env,
	JJ_USER: "Owner",
	JJ_EMAIL: "owner@example.com",
	JJ_CONFIG: "",
};

const run = (cwd: string, ...command: string[]) =>
	Bun.spawnSync(command, { cwd, env });

const jj = (cwd: string, ...args: string[]) => {
	const ran = run(cwd, "jj", ...args);
	if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
	return ran.stdout.toString().trim();
};

const sync = (cwd: string, ...args: string[]) =>
	run(cwd, "bash", SCRIPT, ...args);

const id = (cwd: string, revision: string) =>
	jj(cwd, "log", "--no-graph", "-r", revision, "-T", "commit_id");

/** A commit on `@` adding a file named `subject`, by `author` when given. */
function commit(cwd: string, subject: string, author?: string) {
	writeFileSync(join(cwd, subject), `${subject}\n`);
	jj(cwd, "commit", "-m", subject);
	if (author) jj(cwd, "metaedit", "-r", "@-", "--author", author);
}

/** Moves `main` to `@-` and pushes it to origin. */
function land(cwd: string) {
	jj(cwd, "bookmark", "set", "main", "-r", "@-");
	jj(cwd, "git", "push", "--remote", "origin", "-b", "main");
}

/** A contributor's commit merged onto GitHub's `next`, with `@` back on `main`. */
function merge(cwd: string, subject: string) {
	jj(cwd, "new", "next@github");
	commit(cwd, subject, CONTRIBUTOR);
	jj(cwd, "bookmark", "set", "next", "-r", "@-");
	jj(cwd, "bookmark", "track", "next@github");
	jj(cwd, "git", "push", "--remote", "github", "-b", "next");
	jj(cwd, "bookmark", "forget", "next");
	jj(cwd, "new", "main");
}

/** The commit next@github points at, empty unless it is untracked and no local `next` is left. */
const untrackedNext = (cwd: string) =>
	id(
		cwd,
		'untracked_remote_bookmarks(exact:"next", exact:"github") ~ present(bookmarks(exact:"next"))',
	);

/** A jj repository with bare `origin` and `github` remotes, `main` holding `base` pushed to origin, `next` synced. */
function repository() {
	const root = mkdtempSync(join(tmpdir(), "github-sync-"));
	const work = join(root, "work");
	jj(root, "git", "init", "work");
	for (const remote of ["origin", "github"]) {
		run(root, "git", "init", "-q", "--bare", `${remote}.git`);
		jj(work, "git", "remote", "add", remote, join(root, `${remote}.git`));
	}
	commit(work, "base");
	jj(work, "bookmark", "create", "main", "-r", "@-");
	jj(work, "bookmark", "track", "main@origin");
	jj(work, "git", "push", "--remote", "origin", "-b", "main");
	expect(sync(work).exitCode).toBe(0);
	return { root, work };
}

test("next follows main@origin, back to an older revision too, and stays untracked", () => {
	const { work } = repository();
	expect(untrackedNext(work)).toBe(id(work, "main@origin"));
	commit(work, "older");
	land(work);
	commit(work, "newer", CONTRIBUTOR);
	land(work);
	expect(sync(work).exitCode).toBe(0);
	expect(untrackedNext(work)).toBe(id(work, "main@origin"));
	expect(sync(work, "main@origin-").exitCode).toBe(0);
	expect(untrackedNext(work)).toBe(id(work, "main@origin-"));
}, 30_000);

test("a GitHub merge not landed blocks the sync until its copy lands, and the original is abandoned", () => {
	const { work } = repository();
	merge(work, "contribution");
	const refused = sync(work);
	expect(refused.exitCode).toBe(1);
	expect(refused.stderr.toString()).toContain("contribution");
	expect(refused.stderr.toString()).toContain(
		"next@github has commits not landed on main@origin",
	);
	jj(work, "duplicate", "-r", "next@github", "-o", "main");
	jj(
		work,
		"bookmark",
		"set",
		"main",
		"-r",
		'subject(exact:"contribution") & main+ ~ next@github',
	);
	jj(work, "git", "push", "--remote", "origin", "-b", "main");
	expect(sync(work).exitCode).toBe(0);
	expect(untrackedNext(work)).toBe(id(work, "main@origin"));
	expect(id(work, 'subject(exact:"contribution")')).toBe(
		id(work, "main@origin"),
	);
}, 30_000);

test("--landed syncs over a GitHub merge whose copy landed reworked", () => {
	const { work } = repository();
	merge(work, "contribution");
	commit(work, "contribution reworked");
	land(work);
	expect(sync(work).exitCode).toBe(1);
	expect(sync(work, "--landed").exitCode).toBe(0);
	expect(untrackedNext(work)).toBe(id(work, "main@origin"));
}, 30_000);

test("a failed push leaves next@github untracked where it was", () => {
	const { root, work } = repository();
	const synced = id(work, "main@origin");
	commit(work, "unpushed");
	land(work);
	const hook = join(root, "github.git", "hooks", "pre-receive");
	writeFileSync(hook, "#!/bin/sh\nexit 1\n");
	chmodSync(hook, 0o755);
	expect(sync(work).exitCode).not.toBe(0);
	expect(untrackedNext(work)).toBe(synced);
}, 30_000);
