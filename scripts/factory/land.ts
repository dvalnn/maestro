import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

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
	/** Copies `revision` alone, description and all, onto revision `onto` in the workspace at `dir`. */
	restack(dir: string, revision: string, onto: string): Promise<Restacked>;
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

/** Landing workspaces of the jj repository at `repo`. */
export function landing(repo: string): Landing {
	const forget = (name: string) =>
		run(repo, ["jj", "workspace", "forget", name]);
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
			await run(dir, ["jj", "describe", "-m", message]);
			return (
				await run(dir, [
					"jj",
					"log",
					"-r",
					"@",
					"--no-graph",
					"-T",
					"commit_id",
				])
			).trim();
		},
		restack: async (dir, revision, onto) => {
			await run(dir, ["jj", "new", onto]);
			await run(dir, ["jj", "duplicate", revision, "--insert-before", "@"]);
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
