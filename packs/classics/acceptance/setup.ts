// Makes a toy target and a maestro workspace for one task in a new setup dir:
//   bun setup.ts <t1|t2> <setup dir> --harness <harness> --model <model>
import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isTaskName, TASKS, type TaskName } from "./tasks";

/** The exit codes of the acceptance scripts, as diff(1) has them. */
export const EXIT = { ok: 0, mismatch: 1, trouble: 2 } as const;
/** The branch each target is cut on. */
export const BASE = "main";
/** The profile of each of the pack's seats. */
export const PROFILES = [
	"scout",
	"planner",
	"builder",
	"lens",
	"skeptic",
	"consolidator",
].map((seat) => `classics/${seat}`);

type Runtime = { harness: string; model: string };

/** Each profile of the pack run on `runtime`, as the config's `profiles`. */
export const profilesOn = (runtime: Runtime) =>
	Object.fromEntries(PROFILES.map((name) => [name, { runtime }]));

const GREETER = join(import.meta.dir, "greeter");
const PACK = resolve(import.meta.dir, "../dist");

/** A fixed identity and clock, so every target's commit has the same id. */
const GIT_ENV = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "maestro",
	GIT_AUTHOR_EMAIL: "maestro@localhost",
	GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
	GIT_COMMITTER_NAME: "maestro",
	GIT_COMMITTER_EMAIL: "maestro@localhost",
	GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

/** The stdout of `git <args>` in `cwd`. @throws Error naming the command when it fails. */
export function git(cwd: string, ...args: string[]): string {
	const run = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
	if (run.exitCode !== 0)
		throw new Error(`git ${args.join(" ")} in ${cwd}: ${run.stderr}`);
	return run.stdout.toString();
}

/** The target's refs and `HEAD`, as `refs.txt` records them. */
export const refsOf = (target: string) =>
	`${git(target, "for-each-ref")}HEAD ${git(target, "rev-parse", "HEAD")}`;

type Made = {
	/** The target repository. */
	target: string;
	/** The `perform` line that runs the task in the workspace. */
	line: string;
};

/**
 * Makes the task's target in `<dir>/target` with one commit on `BASE`, records its refs in `<dir>/refs.txt`, and
 * writes the workspace config `<dir>/.maestro/config.yaml` with the pack, the target and the builder's runtime.
 */
export async function setup(
	name: TaskName,
	dir: string,
	runtime: Runtime,
): Promise<Made> {
	const task = TASKS[name];
	const target = join(dir, "target");
	await cp(GREETER, target, { recursive: true, verbatimSymlinks: true });
	git(target, "init", "-q", "-b", BASE);
	git(target, "add", ".");
	git(target, "commit", "-q", "-m", "greeter");
	await Bun.write(join(dir, "refs.txt"), refsOf(target));
	await mkdir(join(dir, ".maestro"), { recursive: true });
	const config = {
		packs: [PACK],
		target: { repo: target, base: BASE, checks: task.checks },
		profiles: { "classics/builder": { runtime } },
	};
	// JSON is YAML.
	await Bun.write(
		join(dir, ".maestro/config.yaml"),
		`${JSON.stringify(config, null, 2)}\n`,
	);
	const line = `cd ${dir} && maestro perform classics.build_then_repair --request '${task.request}' --max-repairs ${task.maxRepairs}`;
	return { target, line };
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: { harness: { type: "string" }, model: { type: "string" } },
		allowPositionals: true,
	});
	const [name, dir] = positionals;
	const { harness, model } = values;
	if (
		positionals.length !== 2 ||
		name === undefined ||
		!isTaskName(name) ||
		dir === undefined ||
		!harness ||
		!model
	) {
		console.error(
			"usage: bun setup.ts <t1|t2> <setup dir> --harness <harness> --model <model>",
		);
		process.exit(EXIT.trouble);
	}
	try {
		console.log((await setup(name, resolve(dir), { harness, model })).line);
	} catch (error) {
		console.error(
			`cannot set up ${dir}: ${error instanceof Error ? error.message : String(error)}\nPass a new or empty setup dir`,
		);
		process.exit(EXIT.trouble);
	}
}
