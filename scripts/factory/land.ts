import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Account } from "./forge";

/** How much of a failed command's output a landing error keeps. */
const OUTPUT_TAIL = 2000;

/** The jj workspace a slice lands in (factory.md, Rules, Landing and PRs). */
export type Landing = {
	/** Brings the commits `origin` gained since the last fetch into the repository. */
	fetch(): Promise<void>;
	/** Each of `paths` whose content differs between commits `from` and `to`. */
	changed(
		from: string,
		to: string,
		paths: readonly string[],
	): Promise<string[]>;
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
	 * The commit `revision` names in the repository.
	 * @throws Error when it names none or more than one.
	 */
	commit(revision: string): Promise<string>;
	/**
	 * A jj workspace of the repository at the commit `revision` names, at `root/<commit>`, with its dependencies
	 * installed, and returns its directory. It reuses the tree there, installs again to heal a half install, rebuilds a
	 * directory that is no workspace and removes every other tree under `root`, so at most one is on disk.
	 * @throws Error when `revision` names no single commit, or the workspace or its install fails.
	 */
	tree(revision: string, root: string): Promise<string>;
};

/** The jj fileset naming exactly the file at root-relative `path`. */
const rootFile = (path: string) => `root-file:${JSON.stringify(path)}`;

/**
 * The stdout of `command` in `cwd`.
 * @throws Error with the tail of its output when it exits non-zero.
 */
async function run(cwd: string, command: string[]) {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(
			`${command.join(" ")} exited ${code}:\n${`${out}${err}`.trim().slice(-OUTPUT_TAIL)}`,
		);
	return out;
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
		throw new Error(`${revision} names ${commits.length} commits, not one`);
	return commit;
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
	const open = async (dir: string, name: string, base: string) => {
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
	};
	const close = async (dir: string, name: string) => {
		await forget(name);
		rmSync(dir, { recursive: true, force: true });
	};
	/** The name of the workspace of the tree of `commit`. */
	const treeName = (commit: string) => `tree-${commit.slice(0, 12)}`;
	return {
		fetch: async () => {
			await run(repo, ["jj", "git", "fetch", "--remote", "origin"]);
		},
		changed: async (from, to, paths) =>
			paths.length
				? (
						await run(repo, [
							"jj",
							"diff",
							"--from",
							from,
							"--to",
							to,
							"--name-only",
							...paths.map(rootFile),
						])
					)
						.split("\n")
						.filter(Boolean)
				: [],
		open,
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
		close,
		commit: (revision) => commitOf(repo, revision),
		tree: async (revision, root) => {
			const commit = await commitOf(repo, revision);
			const dir = join(root, commit);
			mkdirSync(root, { recursive: true });
			for (const other of readdirSync(root).filter((n) => n !== commit))
				await close(join(root, other), treeName(other));
			if (!existsSync(join(dir, ".jj")))
				await open(dir, treeName(commit), commit);
			await run(dir, ["bun", "install", "--frozen-lockfile"]);
			return dir;
		},
	};
}
