import { join } from "node:path";
import { type CodeContext, IR_VERSION, type Rejection } from "@maestro/ir";
import {
	type Invocation,
	type LoadCode,
	type NodeInstance,
	type Outputs,
	pureContext,
	type Settlement,
	type Worker,
} from "../worker";

/** The runtime name of the in-process worker. */
export const TS_RUNTIME = "ts";

const CANCELLED: Settlement = { outcome: "failed", reason: "cancelled" };
/** The fields of a `Rejection`: `outcome` and `reason`. */
const REJECTION_FIELDS = 2;

export const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** A node instance as one string, for use as a map key. */
export const instanceKey = ({ node, expansion }: NodeInstance) =>
	`${node}\0${expansion}`;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** An object without `outcome` or `reason`, so it never reads as a `Rejection` (ADR 0008). */
export const isOutputs = (value: unknown): value is Outputs =>
	isRecord(value) &&
	!Object.hasOwn(value, "outcome") &&
	!Object.hasOwn(value, "reason");

/**
 * The in-process worker of the `ts` runtime (CORE-14). It calls the function `loadCode` resolves with a `CodeContext`
 * whose `concert` and `clock` throw for an instance `isPure` names (ADR 0008). A thrown error settles `failed` with
 * its message, and its stack goes to the log. `cancel` settles the invocation `failed` at once and abandons the
 * function, which an in-process worker cannot stop.
 */
export function tsWorker(
	loadCode: LoadCode,
	isPure: (instance: NodeInstance) => boolean,
): Worker {
	const cancels = new Map<string, () => void>();
	return {
		handshake: {
			runtime: TS_RUNTIME,
			version: Bun.version,
			irVersion: IR_VERSION,
		},
		async invoke(invocation, log) {
			const id = instanceKey(invocation.instance);
			const cancelled = new Promise<Settlement>((settle) => {
				cancels.set(id, () => settle(CANCELLED));
			});
			try {
				return await Promise.race([
					call(loadCode, invocation, isPure(invocation.instance)),
					cancelled,
				]);
			} catch (error) {
				const stack = error instanceof Error ? error.stack : undefined;
				for (const line of stack?.split("\n") ?? []) log(line);
				return { outcome: "failed", reason: messageOf(error) };
			} finally {
				cancels.delete(id);
			}
		},
		async cancel(instance) {
			cancels.get(instanceKey(instance))?.();
		},
	};
}

async function call(
	loadCode: LoadCode,
	{ worker, inputs, context }: Invocation,
	pure: boolean,
): Promise<Settlement> {
	const fn = await loadCode(worker);
	const { artifacts, ...rest } = context;
	const full: CodeContext = {
		...rest,
		path: (ref) => join(artifacts, ref.path),
	};
	const returned: unknown = await fn(inputs, pure ? pureContext(full) : full);
	return settlementOf(returned);
}

const isRejection = (value: unknown): value is Rejection =>
	isRecord(value) &&
	value.outcome === "rejected" &&
	typeof value.reason === "string" &&
	Object.keys(value).length === REJECTION_FIELDS;

/** Parses what a code function returned (ADR 0008). */
function settlementOf(returned: unknown): Settlement {
	if (isOutputs(returned)) return { outcome: "ok", outputs: returned };
	if (isRejection(returned))
		return { outcome: "rejected", reason: returned.reason };
	const reason = isRecord(returned)
		? "the function returned 'outcome' or 'reason' beside its outputs. Return reject(reason) to reject"
		: `the function returned ${Array.isArray(returned) ? "a list" : String(returned)}, not outputs. Return an object keyed by output port`;
	return { outcome: "failed", reason };
}
