import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
	bubblewrap,
	type ExitStatus,
	type SandboxBackend,
	type SandboxedProcess,
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

export interface SubprocessAdapter {
	readonly name: string;
	/** The driver supplies `lane` and appends the request's `readOnly` binds. */
	spec(req: HarnessRequest): Omit<SandboxSpec, "lane">;
	/** Returns undefined to drop a line (non-JSON noise). */
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

function addUsage(metrics: Metrics, usage: Metrics) {
	for (const [k, v] of Object.entries(usage))
		metrics[k] = (metrics[k] ?? 0) + v;
}

/** Forwards parsed events and sums usage into `metrics`. Returns why reading stopped early, if it did. */
async function pump(
	proc: SandboxedProcess,
	parse: SubprocessAdapter["parse"],
	emit: ReadableStreamDefaultController<HarnessEvent>,
	metrics: Metrics,
): Promise<string | undefined> {
	try {
		for await (const line of proc.stdout) {
			const e = parse(line);
			if (!e) continue;
			if (e.kind === "usage") addUsage(metrics, e.metrics);
			emit.enqueue(e);
		}
	} catch (err) {
		await proc.kill().catch(() => {});
		return `cannot read harness output: ${err instanceof Error ? err.message : err}`;
	} finally {
		emit.close();
	}
}

/** `error` is why the run failed before its exit status counts, if it did. */
function settle(
	req: HarnessRequest,
	exit: ExitStatus,
	metrics: Metrics,
	error: string | undefined,
): HarnessResult {
	const fail = (reason: string): HarnessResult => ({
		outcome: "failed",
		reason,
		outputs: {},
		metrics,
	});
	if (error) return fail(error);
	if (exit.code !== 0) {
		const how =
			exit.code === null
				? `killed by ${exit.signal}`
				: `exited with code ${exit.code}`;
		return fail(
			`${how}: ${exit.stderr.trim().split("\n").slice(-5).join(" | ")}`,
		);
	}
	const { outputs, missing } = collect(req.lane, req.outputs ?? []);
	if (missing.length)
		return fail(`declared outputs not written: ${missing.join(", ")}`);
	return { outcome: "ok", outputs, metrics };
}

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
			const pumped = pump(proc, adapter.parse, emit, metrics);

			const result = (async () => {
				const exit = await proc.exited;
				const pumpError = await pumped;
				settled = true;
				return settle(
					req,
					exit,
					metrics,
					pumpError ?? (cancelled ? "cancelled" : undefined),
				);
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
