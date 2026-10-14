import { readdirSync, readFileSync } from "node:fs";
import { bwrapArgs, mountPlan } from "./plan";
import type { ExitStatus, SandboxBackend, SandboxedProcess } from "./types";

const ID_VAR = "MAESTRO_SANDBOX_ID";
const STDERR_TAIL = 64 * 1024;
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

function redactor(secrets: Record<string, string> = {}) {
	const needles = new Set<string>();
	for (const v of Object.values(secrets)) {
		if (!v) continue;
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
		const redact = redactor(spec.secrets);
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
			// always close it, or the agent waits for more input. EPIPE if bwrap died early: exit status tells
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
				await exited;
				const end = performance.now() + 2500;
				let left = runProcesses(id);
				while (left.length && performance.now() < end) {
					await sleep(50);
					left = runProcesses(id);
				}
				if (left.length)
					throw new Error(
						`sandbox processes survived the kill, pids ${left.join(", ")}`,
					);
			},
		};
		return proc;
	},
};
