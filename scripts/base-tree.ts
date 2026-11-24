import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs `command` in `cwd`; a failure throws with the command's output, unless it `mayFail`. */
export function run(cwd: string, command: string[], env = {}, mayFail = false) {
	const ran = Bun.spawnSync(command, { cwd, env: { ...process.env, ...env } });
	if (ran.exitCode !== 0 && !mayFail)
		throw new Error(ran.stderr.toString() || ran.stdout.toString());
	return ran.stdout.toString();
}

/**
 * Calls `use` with a temporary git repository of one commit holding revision `base` of the repository at the working
 * directory, its dependencies installed, and removes it after.
 */
export async function withBaseTree<T>(
	base: string,
	use: (tree: string) => Promise<T>,
) {
	const tree = await mkdtemp(join(tmpdir(), "maestro-base-"));
	try {
		// An archive and no worktree: a sandboxed lane's git directory is read-only.
		const archive = join(tree, "base.tar");
		run(process.cwd(), ["git", "archive", "-o", archive, base]);
		run(tree, ["tar", "-xf", archive]);
		await rm(archive);
		// Tests of this repository run git in their tree, so the base tree is a repository of one commit.
		run(tree, ["git", "init", "-q"]);
		run(tree, ["git", "add", "-A"]);
		run(tree, [
			"git",
			"-c",
			"user.name=maestro",
			"-c",
			"user.email=maestro@localhost",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-q",
			"-m",
			"base",
		]);
		run(tree, ["bun", "install", "--frozen-lockfile"]);
		return await use(tree);
	} finally {
		await rm(tree, { recursive: true, force: true });
	}
}
