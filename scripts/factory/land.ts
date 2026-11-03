import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Account } from "./forge";

/** How much of a failed command's output a landing error keeps. */
const OUTPUT_TAIL = 2000;

/** A restacked commit, or the conflicts that kept it from restacking. */
export type Restacked = { commit: string } | { conflict: string };

/** The jj workspace a slice lands or restacks in (factory.md, Rules: Landing, Blockers). */
export type Landing = {
	/**
	 * Creates workspace `name` at `dir` on revision `base` as fetched from `origin`, colocated with git, in place of any
	 * a failed landing left there.
	 */
	open(dir: string, name: string, base: string): Promise<void>;
	/** Describes the change of the workspace at `dir` as `message`, and returns its commit id. */
	describe(dir: string, message: string): Promise<string>;
	/** Folds the change of the workspace at `dir` into its parent, described as `message`, and returns its commit id. */
	squash(dir: string, message: string): Promise<string>;
	/** Copies the commits of revset `revisions`, descriptions and all, onto revision `onto` in the workspace at `dir`. */
	restack(dir: string, revisions: string, onto: string): Promise<Restacked>;
	/** Forgets workspace `name` and removes `dir`. */
	close(dir: string, name: string): Promise<void>;
};

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
		open: async (dir, name, base) => {
			await forget(name);
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dirname(dir), { recursive: true });
			await run(repo, ["jj", "git", "fetch"]);
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
			await run(dir, ["jj", ...as, "squash", "-m", message]);
			return claim(dir, "@-");
		},
		restack: async (dir, revisions, onto) => {
			await run(dir, ["jj", ...as, "new", onto]);
			await run(dir, [
				"jj",
				...as,
				"duplicate",
				revisions,
				"--insert-before",
				"@",
			]);
			// A duplicate keeps its author and is not signed; metaedit rewrites each as the account's, signed.
			await run(dir, [
				"jj",
				...as,
				"metaedit",
				"--update-author",
				"-r",
				`${onto}..@-`,
			]);
			const [copy = "", conflict] = (
				await run(dir, [
					"jj",
					"log",
					"-r",
					"@-",
					"--no-graph",
					"-T",
					'commit_id ++ " " ++ conflict',
				])
			)
				.trim()
				.split(" ");
			if (conflict !== "true") return { commit: copy };
			const paths = await run(dir, ["jj", "resolve", "--list", "-r", "@-"]);
			return { conflict: paths.trim() };
		},
		close: async (dir, name) => {
			await forget(name);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
