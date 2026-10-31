import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "../scripts/pack";

export const scratch = mkdtempSync(join(tmpdir(), "maestro-"));
export const root = join(import.meta.dir, "..");

/** The classics pack's directory, once it is packed. */
export const classics = pack(
	join(root, "packs/classics"),
	join(scratch, "classics"),
);

/** What one CLI run printed, and its exit code. */
export type Ran = { code: number; out: string; err: string };

/** Runs the CLI on `args` with `env`, its data under `data`. */
export async function call(
	args: string[],
	data = mkdtempSync(join(scratch, "data-")),
	env: Record<string, string> = {},
): Promise<Ran> {
	const run = Bun.spawn(
		[process.execPath, join(root, "packages/cli/src/maestro.ts"), ...args],
		{
			cwd: root,
			env: {
				PATH: process.env.PATH,
				XDG_DATA_HOME: data,
				XDG_CONFIG_HOME: join(scratch, "config"),
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [out, err] = await Promise.all([
		new Response(run.stdout).text(),
		new Response(run.stderr).text(),
	]);
	return { code: await run.exited, out, err };
}

/**
 * Runs the CLI as `call` does, and returns its stdout.
 * @throws Error holding its stderr when it exits non-zero.
 */
export async function maestro(
	args: string[],
	data?: string,
	env?: Record<string, string>,
): Promise<string> {
	const { code, out, err } = await call(args, data, env);
	if (code !== 0) throw new Error(`maestro ${args[0]} exited ${code}:\n${err}`);
	return out;
}

/** A new git repo on branch `main` holding one commit, as a stub perform's target. */
export function targetRepo(): string {
	const target = mkdtempSync(join(scratch, "target-"));
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", target, ...args], {
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	git("init", "-q", "-b", "main");
	writeFileSync(join(target, "a.ts"), "a\n");
	git("add", ".");
	git("commit", "-qm", "init");
	return target;
}

/** A `MAESTRO_STUB_OUTPUTS` directory holding each value of `scripted` at its path: a string as it is, else as JSON. */
export function stubOutputs(scripted: Record<string, unknown>): string {
	const outputs = mkdtempSync(join(scratch, "outputs-"));
	for (const [path, value] of Object.entries(scripted)) {
		mkdirSync(join(outputs, path, ".."), { recursive: true });
		writeFileSync(
			join(outputs, path),
			typeof value === "string" ? value : JSON.stringify(value),
		);
	}
	return outputs;
}

/** The `-c` flags that run each profile of `profiles` on the stub harness. */
export const stubbed = (profiles: string[]) =>
	profiles.flatMap((p) => ["-c", `profiles.${p}.runtime.harness=stub`]);
