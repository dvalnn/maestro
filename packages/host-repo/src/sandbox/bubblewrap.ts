import { readdirSync, readFileSync } from "node:fs";
import { bwrapArgs, mountPlan } from "./plan";
import type { ExitStatus, SandboxBackend, SandboxedProcess } from "./types";

const ID_VAR = "MAESTRO_SANDBOX_ID";
const STDERR_TAIL = 64 * 1024;
/** Values shorter than this are not masked, so a short credential cannot garble the output it appears in. */
const MIN_MASKED_LENGTH = 8;
/** How long a kill waits for the sandbox's processes to go. */
const KILL_WAIT_MS = 2500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Live processes whose environment carries the run id: bwrap, its init and every descendant, whatever their pgid. */
export function runProcesses(id: string): number[] {
	const pids: number[] = [];
	for (const p of readdirSync("/proc")) {
		if (!/^\d+$/.test(p) || +p === process.pid) continue;
		try {
			if (
				!readFileSync(`/proc/${p}/environ`, "latin1").includes(
					`${ID_VAR}=${id}`,
				)
			)
				continue;
			const state = readFileSync(`/proc/${p}/stat`, "utf8").match(
				/\) (\S)/,
			)?.[1];
			if (state !== "Z") pids.push(+p);
		} catch {} // exited while scanning, or not ours
	}
	return pids;
}

function killQuietly(pid: number) {
	try {
		process.kill(pid, "SIGKILL");
	} catch {} // exited since it was listed
}

function redactor(values: readonly string[]) {
	const needles = new Set<string>();
	for (const v of values) {
		if (v.length < MIN_MASKED_LENGTH) continue;
		needles.add(v);
		needles.add(JSON.stringify(v).slice(1, -1)); // the form it takes inside a JSON string
	}
	return (s: string) =>
		[...needles].reduce((acc, n) => acc.replaceAll(n, "[redacted]"), s);
}

async function* lines(
	stream: ReadableStream<Uint8Array>,
	redact: (s: string) => string,
) {
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of stream) {
		buf += decoder.decode(chunk, { stream: true });
		let i = buf.indexOf("\n");
		while (i >= 0) {
			yield redact(buf.slice(0, i).replace(/\r$/, ""));
			buf = buf.slice(i + 1);
			i = buf.indexOf("\n");
		}
	}
	buf += decoder.decode();
	if (buf) yield redact(buf);
}

export const bubblewrap: SandboxBackend = {
	start(spec) {
		const bwrap = Bun.which("bwrap");
		if (!bwrap)
			throw new Error("bubblewrap (bwrap) is not on PATH. Install bubblewrap");
		const args = bwrapArgs(mountPlan(spec), spec.argv); // validates the mount policy before anything runs

		const id = crypto.randomUUID();
		const redact = redactor([
			...Object.values(spec.secrets ?? {}),
			...(spec.masked ?? []),
		]);
		// bwrap is spawned with exactly this environment and passes it on. No --clearenv/--setenv, so values never
		// reach argv.
		const env = {
			PATH: "/usr/bin:/bin",
			HOME: "/tmp",
			...spec.env,
			...spec.secrets,
			[ID_VAR]: id,
		};
		const child = Bun.spawn([bwrap, ...args], {
			stdin: spec.stdin === undefined ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		if (spec.stdin !== undefined) {
			const sink = child.stdin as import("bun").FileSink;
			sink.write(spec.stdin);
			// Always close stdin, or the agent waits for more input. EPIPE means bwrap died early; the exit status reports that.
			Promise.resolve(sink.end()).catch(() => {});
		}

		let stderr = "";
		const drained = (async () => {
			for await (const c of child.stderr)
				stderr = (stderr + new TextDecoder().decode(c)).slice(-STDERR_TAIL);
		})();
		const exited: Promise<ExitStatus> = (async () => {
			await child.exited;
			await drained;
			return {
				code: child.exitCode,
				signal: child.signalCode,
				stderr: redact(stderr),
			};
		})();

		const proc: SandboxedProcess = {
			id,
			stdout: lines(child.stdout, redact),
			exited,
			async kill() {
				child.kill("SIGKILL"); // --die-with-parent reaps the pid namespace, and with it the tree
				// A kill during bwrap's startup lands before die-with-parent is set, so what survives is killed by id.
				const end = performance.now() + KILL_WAIT_MS;
				let left = runProcesses(id);
				while (left.length && performance.now() < end) {
					for (const pid of left) killQuietly(pid);
					await sleep(50);
					left = runProcesses(id);
				}
				if (left.length)
					throw new Error(
						`sandbox processes survived the kill, pids ${left.join(", ")}`,
					);
				await exited;
			},
		};
		return proc;
	},
};
