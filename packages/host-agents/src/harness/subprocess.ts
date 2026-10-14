import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
	bubblewrap,
	type SandboxBackend,
	type SandboxSpec,
} from "../sandbox/index";
import type {
	Harness,
	HarnessEvent,
	HarnessRequest,
	HarnessResult,
	HarnessRun,
	Metrics,
} from "./types";

/** What differs per harness: how to launch it, and how to read one line of its JSON event stream. */
export interface SubprocessAdapter {
	readonly name: string;
	/** The process to run. The lane and the node's read-only binds are added by the driver. */
	spec(req: HarnessRequest): Omit<SandboxSpec, "lane">;
	/** One stdout line to an event, or undefined to drop it (non-JSON noise). */
	parse(line: string): HarnessEvent | undefined;
}

function collect(lane: string, paths: string[]) {
	const outputs: Record<string, Uint8Array> = {};
	const missing: string[] = [];
	const root = realpathSync(lane);
	for (const rel of paths) {
		try {
			// The agent controls the lane, so a declared output may be a symlink to a host file: only regular
			// files whose real path stays inside the lane are read.
			const path = resolve(root, rel);
			if (!lstatSync(path).isFile()) throw new Error("not a regular file");
			if (!realpathSync(path).startsWith(`${root}/`))
				throw new Error("outside lane");
			outputs[rel] = readFileSync(path);
		} catch {
			missing.push(rel);
		}
	}
	return { outputs, missing };
}

/** Runs an adapter's process in the sandbox: streams events, sums usage, collects outputs, supports cancel. */
export function subprocessHarness(
	adapter: SubprocessAdapter,
	backend: SandboxBackend = bubblewrap,
): Harness {
	return {
		name: adapter.name,
		run(req): HarnessRun {
			const spec = adapter.spec(req);
			const proc = backend.start({
				...spec,
				lane: req.lane,
				readOnly: [...(spec.readOnly ?? []), ...(req.readOnly ?? [])],
			});
			let emit!: ReadableStreamDefaultController<HarnessEvent>;
			const events = new ReadableStream<HarnessEvent>({
				start: (c) => {
					emit = c;
				},
			});
			const metrics: Metrics = {};
			let cancelled = false;
			let settled = false;
			let pumpError: string | undefined;

			const pump = (async () => {
				try {
					for await (const line of proc.stdout) {
						const e = adapter.parse(line);
						if (!e) continue;
						if (e.kind === "usage")
							for (const [k, v] of Object.entries(e.metrics))
								metrics[k] = (metrics[k] ?? 0) + v;
						emit.enqueue(e);
					}
				} catch (err) {
					pumpError = `adapter parse failed: ${err}`;
					await proc.kill().catch(() => {});
				} finally {
					emit.close();
				}
			})();

			const result: Promise<HarnessResult> = (async () => {
				const exit = await proc.exited;
				await pump;
				const fail = (reason: string): HarnessResult => ({
					outcome: "failed",
					reason,
					outputs: {},
					metrics,
				});
				settled = true;
				if (pumpError) return fail(pumpError);
				if (cancelled) return fail("cancelled");
				if (exit.code !== 0) {
					return fail(
						`exit ${exit.code ?? exit.signal}: ${exit.stderr.trim().split("\n").slice(-5).join(" | ")}`,
					);
				}
				const { outputs, missing } = collect(req.lane, req.outputs ?? []);
				if (missing.length)
					return fail(`declared outputs not written: ${missing.join(", ")}`);
				return { outcome: "ok", outputs, metrics };
			})();

			return {
				events,
				result,
				async cancel() {
					if (settled) return;
					cancelled = true;
					await proc.kill();
				},
			};
		},
	};
}
