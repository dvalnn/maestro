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
import { IDENTITY, OUTBOX, SESSION_DIR } from "./types";

export interface SubprocessAdapter {
	readonly name: string;
	/**
	 * The driver supplies `lane`, appends the request's `readOnly` and `writable` binds, binds its `identity` read-only
	 * at `IDENTITY` and its `outbox` and `session.dir` read-write at `OUTBOX` and `SESSION_DIR`, and lays the spec's
	 * `env` over the request's.
	 */
	spec(req: HarnessRequest): Omit<SandboxSpec, "lane">;
	/** A fresh line parser per run, so it may keep state. It returns the events a stdout line carries: none for noise. */
	parser(): (line: string) => HarnessEvent[];
}

function addUsage(metrics: Metrics, usage: Metrics) {
	for (const [k, v] of Object.entries(usage))
		metrics[k] = (metrics[k] ?? 0) + v;
}

type Tally = {
	metrics: Metrics;
	reply: string;
	settled: boolean;
	fault?: string;
};

/** A consumer that stops iterating `events` closes the stream, and the run carries on without it. */
function ignoreClosed(f: () => void) {
	try {
		f();
	} catch {}
}

function fold(tally: Tally, e: HarnessEvent) {
	if (e.kind === "usage") addUsage(tally.metrics, e.metrics);
	else if (e.kind === "text") tally.reply = e.text;
	else if (e.kind === "settled") tally.settled = true;
	else if (e.kind === "fault") tally.fault ??= e.reason;
}

/** Forwards parsed events and folds them into `tally`. Returns why reading stopped early, if it did. */
async function pump(
	proc: SandboxedProcess,
	parse: ReturnType<SubprocessAdapter["parser"]>,
	emit: ReadableStreamDefaultController<HarnessEvent>,
	tally: Tally,
): Promise<string | undefined> {
	try {
		for await (const line of proc.stdout) {
			for (const e of parse(line)) {
				fold(tally, e);
				ignoreClosed(() => emit.enqueue(e));
				if (e.kind === "fault") await proc.kill().catch(() => {});
			}
		}
	} catch (err) {
		await proc.kill().catch(() => {});
		return `cannot read harness output: ${err instanceof Error ? err.message : err}`;
	} finally {
		ignoreClosed(() => emit.close());
	}
}

/** `error` is why the run failed before its exit status counts, if it did. */
function settle(
	exit: ExitStatus,
	tally: Tally,
	error: string | undefined,
): HarnessResult {
	const { metrics, reply } = tally;
	const fail = (reason: string): HarnessResult => ({
		outcome: "failed",
		reason,
		reply,
		metrics,
	});
	const failure = tally.fault ?? error;
	if (failure) return fail(failure);
	if (exit.code !== 0) {
		const how =
			exit.code === null
				? `killed by ${exit.signal}`
				: `exited with code ${exit.code}`;
		return fail(
			`${how}: ${exit.stderr.trim().split("\n").slice(-5).join(" | ")}`,
		);
	}
	if (!tally.settled) return fail("harness ended without settling");
	return { outcome: "ok", reply, metrics };
}

export function subprocessHarness(
	adapter: SubprocessAdapter,
	backend: SandboxBackend = bubblewrap,
): Harness {
	return {
		name: adapter.name,
		run(req): HarnessRun {
			const spec = adapter.spec(req);
			const identity = req.identity
				? [{ src: req.identity, dst: IDENTITY }]
				: [];
			const proc = backend.start({
				...spec,
				lane: req.lane,
				env: { ...req.env, ...spec.env },
				readOnly: [
					...(spec.readOnly ?? []),
					...(req.readOnly ?? []),
					...identity,
				],
				writable: [
					...(spec.writable ?? []),
					...(req.writable ?? []),
					{ src: req.outbox, dst: OUTBOX },
					{ src: req.session.dir, dst: SESSION_DIR },
				],
			});
			let emit!: ReadableStreamDefaultController<HarnessEvent>;
			const events = new ReadableStream<HarnessEvent>({
				start: (c) => {
					emit = c;
				},
			});
			const tally: Tally = { metrics: {}, reply: "", settled: false };
			let cancelled = false;
			let settled = false;
			const pumped = pump(proc, adapter.parser(), emit, tally);

			const result = (async () => {
				const exit = await proc.exited;
				const pumpError = await pumped;
				settled = true;
				return settle(
					exit,
					tally,
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
