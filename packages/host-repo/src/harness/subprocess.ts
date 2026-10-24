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
	/**
	 * A fresh parser per run, so it may keep state. It takes each stdout line that is a JSON object and returns the
	 * events it carries: none for noise. Other lines never reach it.
	 */
	parser(): (event: JsonObject) => HarnessEvent[];
}

/** A JSON object, as a harness prints one per stdout line. */
export type JsonObject = Record<string, unknown>;

export const isObject = (v: unknown): v is JsonObject =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The UTF-8 length of a tool result's content as text: a string as is, text blocks joined, anything else as JSON. Only
 * the size leaves, never the text.
 */
export function resultBytes(content: unknown): number {
	const blocks = Array.isArray(content) ? content : [];
	const text =
		typeof content === "string"
			? content
			: blocks.length > 0 &&
					blocks.every((b) => isObject(b) && b.type === "text")
				? blocks.map((b) => String(b.text)).join("")
				: JSON.stringify(content);
	return Buffer.byteLength(text ?? "", "utf8");
}

/** `v` when it is a finite number, else 0. */
export const finite = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) ? v : 0;

/** Whether HTTP status `status` is one a provider error may pass with: a timeout, rate limit or server error. */
const transientStatus = (status: number) =>
	status === 408 || status === 429 || (status >= 500 && status <= 599);

const TRANSIENT_TEXT = /overloaded|rate.?limit|timed?[ -]?out/i;
const LEADING_STATUS = /^(?:API Error:?\s*)?(\d{3})\b/i;

/** Whether a provider error with API status `status`, if known, and message `text` may pass. */
export function isTransient(status: unknown, text: string): boolean {
	const stated = typeof status === "number" ? status : undefined;
	const leading = Number(LEADING_STATUS.exec(text.trim())?.[1]);
	return (
		(stated !== undefined && transientStatus(stated)) ||
		transientStatus(leading) ||
		TRANSIENT_TEXT.test(text)
	);
}

function objectOf(line: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
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
	transient?: boolean;
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
	else if (e.kind === "fault" && tally.fault === undefined) {
		tally.fault = e.reason;
		tally.transient = e.transient;
	}
}

/**
 * Folds `e` into `tally` and enqueues it, except a usage event that reports nothing or a blank text. Kills `proc` on a
 * fault.
 */
async function forward(
	proc: SandboxedProcess,
	e: HarnessEvent,
	emit: ReadableStreamDefaultController<HarnessEvent>,
	tally: Tally,
) {
	fold(tally, e);
	const empty =
		(e.kind === "usage" && Object.values(e.metrics).every((v) => v === 0)) ||
		(e.kind === "text" && !e.text.trim());
	if (!empty) ignoreClosed(() => emit.enqueue(e));
	if (e.kind === "fault") await proc.kill().catch(() => {});
}

/** Forwards parsed events and folds them into `tally`. Returns why reading stopped early, if it did. */
async function pump(
	proc: SandboxedProcess,
	parse: (line: string) => HarnessEvent[],
	emit: ReadableStreamDefaultController<HarnessEvent>,
	tally: Tally,
): Promise<string | undefined> {
	try {
		for await (const line of proc.stdout) {
			for (const e of parse(line)) await forward(proc, e, emit, tally);
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
	const fail = (reason: string, transient = false): HarnessResult => ({
		outcome: "failed",
		reason,
		reply,
		metrics,
		...(transient && { transient }),
	});
	const failure = tally.fault ?? error;
	if (failure)
		return fail(failure, tally.fault !== undefined && tally.transient);
	if (exit.code !== 0) {
		const how =
			exit.code === null
				? `killed by ${exit.signal}`
				: `exited with code ${exit.code}`;
		return fail(
			`${how}: ${exit.stderr.trim().split("\n").slice(-5).join(" | ")}`,
		);
	}
	if (!tally.settled) return fail("harness ended without settling", true);
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
			const parse = adapter.parser();
			const pumped = pump(
				proc,
				(line) => {
					const event = objectOf(line);
					return event ? parse(event) : [];
				},
				emit,
				tally,
			);

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
