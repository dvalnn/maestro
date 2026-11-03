import type { Deps, Pager } from "./command";
import type { Environment } from "./config";

/** The pager when `PAGER` is unset. `-F` quits when the output fits a screen, `-R` keeps color, `-X` leaves it shown. */
const DEFAULT_PAGER = "less -FRX";
/** What `LESS` is for a pager that reads it, when the user set none. */
const DEFAULT_LESS = "FRX";
/** The `TERM` of a terminal that cannot drive a pager. */
const DUMB_TERM = "dumb";
/** What a shell exits with when it finds no such command. */
const SHELL_NOT_FOUND = 127;
/** A `PAGER` that pages nothing, as git takes it. */
const NO_PAGER = "cat";

/** The shell command of the pager `env` names, `PAGER` as git runs it; `undefined` when paging is off: `PAGER` is empty or `cat`. */
export function pagerCommand(env: Environment): string | undefined {
	const command = (env.PAGER ?? DEFAULT_PAGER).trim();
	return command === "" || command === NO_PAGER ? undefined : command;
}

const ignore = () => {};

/**
 * Starts `command` as a pager under `sh -c`, its stdin a pipe and its other streams the terminal's. While it runs
 * Ctrl-C is ignored here, so the pager takes it and the terminal is left as the pager leaves it.
 * @throws Error when the shell cannot be started.
 */
export function startPager(
	command: string,
	env: Readonly<Record<string, string>>,
): Pager {
	const child = Bun.spawn(["sh", "-c", command], {
		env,
		stdin: "pipe",
		stdout: "inherit",
		stderr: "inherit",
	});
	process.on("SIGINT", ignore);
	return {
		write(bytes) {
			try {
				child.stdin.write(bytes);
			} catch {
				// The reader quit before the end, as `q` does: what is left is dropped.
			}
		},
		async close() {
			try {
				await child.stdin.end();
			} catch {
				// Closed already, as above.
			}
			const code = await child.exited;
			process.off("SIGINT", ignore);
			return code;
		},
	};
}

const defined = (env: Environment) =>
	Object.fromEntries(
		Object.entries(env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);

/**
 * Runs `run` with deps whose stdout goes to the user's pager when `wanted`, stdout is a terminal and `TERM` is set and
 * not `dumb`, else with `deps` as they are. The pager starts at the first write, so a command that prints nothing opens
 * none, and it is closed and waited for when `run` ends. When it cannot start, or the shell finds it missing, the
 * output goes to `deps.stdout` as it is.
 */
export async function withPager<T>(
	deps: Deps,
	wanted: boolean,
	run: (deps: Deps) => Promise<T> | T,
): Promise<T> {
	const { startPager: start, env } = deps;
	const command =
		wanted && deps.terminal && env.TERM && env.TERM !== DUMB_TERM
			? pagerCommand(env)
			: undefined;
	if (!command || !start) return run(deps);
	let pager: Pager | undefined;
	let failed = false;
	const sent: Uint8Array[] = [];
	const write = (bytes: Uint8Array, direct: () => void) => {
		if (!pager && !failed) {
			try {
				pager = start(command, { LESS: DEFAULT_LESS, ...defined(env) });
			} catch {
				failed = true;
			}
		}
		if (pager) {
			sent.push(bytes);
			pager.write(bytes);
		} else direct();
	};
	try {
		return await run({
			...deps,
			stdout: (line) =>
				write(Buffer.from(`${line}\n`), () => deps.stdout(line)),
			stdoutBytes: (bytes) => write(bytes, () => deps.stdoutBytes(bytes)),
		});
	} finally {
		if ((await pager?.close()) === SHELL_NOT_FOUND) {
			deps.stderr(
				`PAGER=${command}: command not found\nSet PAGER to a pager that is installed, or empty to turn paging off`,
			);
			for (const bytes of sent) deps.stdoutBytes(bytes);
		}
	}
}
