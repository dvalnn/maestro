import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Account } from "./forge";

/** How much of a failed command's output a landing error keeps. */
const OUTPUT_TAIL = 2000;

/** The directory the tick performs compositions from. */
const COMPOSITIONS = ".maestro";

/** The `.maestro/` tree of one commit, exported for the tick to perform from. */
export type Export = {
	/** The commit the tree is exported at. */
	commit: string;
	/** The directory holding the exported `.maestro/`, beside a link to the checkout's `node_modules`. */
	dir: string;
	/** Whether the checkout's `.maestro/` differs from the exported tree. */
	differs: boolean;
};

/** The jj workspace a slice lands in (factory.md, Rules, Landing and PRs). */
export type Landing = {
	/** Brings the commits `origin` gained since the last fetch into the repository. */
	fetch(): Promise<void>;
	/**
	 * Creates workspace `name` at `dir` on revision `base`, colocated with git, in place of any a failed landing left
	 * there.
	 */
	open(dir: string, name: string, base: string): Promise<void>;
	/** Describes the change of the workspace at `dir` as `message`, and returns its commit id. */
	describe(dir: string, message: string): Promise<string>;
	/** Folds the change of the workspace at `dir` into its parent, described as `message`, and returns its commit id. */
	squash(dir: string, message: string): Promise<string>;
	/** Forgets workspace `name` and removes `dir`. */
	close(dir: string, name: string): Promise<void>;
	/**
	 * Exports the `.maestro/` tree at the commit `revision` names into `root/<commit>`, once per commit: a later call
	 * for the same commit reuses it.
	 * @throws Error when `revision` names no single commit, or the commit has no `.maestro/` tree.
	 */
	export(revision: string, root: string): Promise<Export>;
};

/**
 * The stdout of `command` in `cwd` as bytes.
 * @throws Error with the tail of its output when it exits non-zero.
 */
async function bytes(cwd: string, command: string[]) {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).bytes(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(
			`${command.join(" ")} exited ${code}:\n${`${new TextDecoder().decode(out)}${err}`.trim().slice(-OUTPUT_TAIL)}`,
		);
	return out;
}

/**
 * The stdout of `command` in `cwd`.
 * @throws Error with the tail of its output when it exits non-zero.
 */
const run = async (cwd: string, command: string[]) =>
	new TextDecoder().decode(await bytes(cwd, command));

/** The jj fileset naming exactly the file at root-relative `path`. */
const rootFile = (path: string) => `root-file:${JSON.stringify(path)}`;

/**
 * Writes the `.maestro/` tree of `commit` in the repository at `repo` into a fresh directory under `root`, beside a
 * link to `repo`'s `node_modules` so its package imports resolve, and returns that directory.
 * @throws Error when `commit` has no `.maestro/` tree.
 */
async function exportTree(repo: string, commit: string, root: string) {
	const listed = await run(repo, [
		"jj",
		"file",
		"list",
		"-r",
		commit,
		`root:${JSON.stringify(COMPOSITIONS)}`,
	]);
	const files = listed.split("\n").filter(Boolean);
	if (!files.length) throw new Error(`${commit} has no ${COMPOSITIONS}/ tree`);
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, `.${commit}-`));
	try {
		for (const file of files) {
			const path = join(dir, file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				await bytes(repo, ["jj", "file", "show", "-r", commit, rootFile(file)]),
			);
		}
		symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
		return dir;
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

/**
 * The jj config that leaves a pushed branch rewritable, which jj's default protects as an untracked remote bookmark:
 * a revision squashes into the PR head it was cut at.
 */
const REWRITABLE = 'revset-aliases."immutable_heads()"="trunk() | tags()"';

/** The environment variable naming the SSH key that signs the commits the tick makes. */
export const SIGNING_KEY = "MAESTRO_TM_SIGNING_KEY";

/**
 * The jj config that makes `account` author and committer of what jj writes, and signs it with the SSH key at
 * `signingKey` when there is one. It rides each command's `--config`, so no jj config file changes.
 */
function identity(account: Account, signingKey?: string) {
	const settings = [
		`user.name=${JSON.stringify(account.name)}`,
		`user.email=${JSON.stringify(account.email)}`,
		...(signingKey
			? [
					'signing.behavior="own"',
					'signing.backend="ssh"',
					`signing.key=${JSON.stringify(signingKey)}`,
				]
			: []),
	];
	return settings.flatMap((setting) => ["--config", setting]);
}

/**
 * The commit `revision` names in the repository at `repo`.
 * @throws Error when it names none or more than one.
 */
async function commitOf(repo: string, revision: string) {
	const commits = (
		await run(repo, [
			"jj",
			"log",
			"-r",
			revision,
			"--no-graph",
			"-T",
			'commit_id ++ "\\n"',
		])
	)
		.split("\n")
		.filter(Boolean);
	const [commit] = commits;
	if (!commit || commits.length > 1)
		throw new Error(
			`${revision} names ${commits.length} commits, not one, to export ${COMPOSITIONS}/ at`,
		);
	return commit;
}

/** The export of `commit`'s `.maestro/` tree at `root/<commit>`, made when it is not there yet. */
async function kept(repo: string, commit: string, root: string) {
	const dir = join(root, commit);
	if (existsSync(join(dir, COMPOSITIONS))) return dir;
	const made = await exportTree(repo, commit, root);
	try {
		renameSync(made, dir);
	} catch (error) {
		rmSync(made, { recursive: true, force: true });
		if (!existsSync(join(dir, COMPOSITIONS))) throw error;
	}
	return dir;
}

/**
 * Landing workspaces of the jj repository at `repo`, whose commits `account` authors and, given `signingKey`, signs.
 * @throws Error naming `MAESTRO_TM_SIGNING_KEY` and the path when `signingKey` is a file that does not exist.
 */
export function landing(
	repo: string,
	account: Account,
	signingKey?: string,
): Landing {
	if (signingKey && !existsSync(signingKey))
		throw new Error(
			`${SIGNING_KEY} names no file: ${signingKey}\nPoint it at the SSH key, or unset it to leave commits unsigned`,
		);
	const as = identity(account, signingKey);
	const forget = (name: string) =>
		run(repo, ["jj", "workspace", "forget", name]);
	/** Makes the account author of `revision` in the workspace at `dir`, and returns its commit id. */
	const claim = async (dir: string, revision: string) => {
		await run(dir, [
			"jj",
			...as,
			"metaedit",
			"--update-author",
			"-r",
			revision,
		]);
		return (
			await run(dir, [
				"jj",
				"log",
				"-r",
				revision,
				"--no-graph",
				"-T",
				"commit_id",
			])
		).trim();
	};
	return {
		fetch: async () => {
			await run(repo, ["jj", "git", "fetch", "--remote", "origin"]);
		},
		open: async (dir, name, base) => {
			await forget(name);
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dirname(dir), { recursive: true });
			await run(repo, [
				"jj",
				"workspace",
				"add",
				"--colocate",
				"--name",
				name,
				"-r",
				base,
				dir,
			]);
		},
		describe: async (dir, message) => {
			await run(dir, ["jj", ...as, "describe", "-m", message]);
			return claim(dir, "@");
		},
		squash: async (dir, message) => {
			await run(dir, [
				"jj",
				"--config",
				REWRITABLE,
				...as,
				"squash",
				"-m",
				message,
			]);
			return claim(dir, "@-");
		},
		close: async (dir, name) => {
			await forget(name);
			rmSync(dir, { recursive: true, force: true });
		},
		export: async (revision, root) => {
			const commit = await commitOf(repo, revision);
			const dir = await kept(repo, commit, root);
			const diff = await run(repo, [
				"jj",
				"diff",
				"--summary",
				"--from",
				commit,
				"--to",
				"@",
				`root:${JSON.stringify(COMPOSITIONS)}`,
			]);
			return { commit, dir, differs: diff.trim() !== "" };
		},
	};
}
