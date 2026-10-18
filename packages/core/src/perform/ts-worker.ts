import { join } from "node:path";
import {
	type CodeContext,
	IR_VERSION,
	messageOf,
	type NodeInstance,
	type Ports,
	type Rejection,
	TS_RUNTIME,
	type WorkerRef,
} from "@maestro/ir";
import type { Inputs, LoadCode, NodeResult, Outputs } from "../node";
import {
	instanceKey,
	isOutputs,
	isRecord,
	type Loaded,
	loadFunction,
} from "../shared";
import type { PortCheck } from "./execute";

/** What a worker announces before its first invocation. */
type Handshake = { runtime: string; version: string; irVersion: string };

/** One code node instance to settle, as plain data so it can cross a process boundary. */
export type Invocation = {
	instance: NodeInstance;
	worker: WorkerRef;
	/** The node's input ports, which `inputs` are checked against. */
	in?: Ports;
	inputs: Inputs;
	/**
	 * `CodeContext` without `path`, which the worker derives from `artifacts`, the area's absolute path, and without
	 * `log`, which is `invoke`'s.
	 */
	context: Omit<CodeContext, "path" | "log"> & { artifacts: string };
};

/** Executes the code nodes of one runtime (sdk-spec 13.2). It gets each function through `LoadCode`. */
export interface Worker {
	readonly handshake: Handshake;
	/** `log` takes the instance's log lines, which core stores in the record, until `invoke` settles. */
	invoke(
		invocation: Invocation,
		log: (line: string) => void,
	): Promise<NodeResult>;
	/** Stops the instance's invocation, whose `invoke` then replies promptly. Timeouts cancel through this too. */
	cancel(instance: NodeInstance): Promise<void>;
}

const CANCELLED: NodeResult = { outcome: "failed", reason: "cancelled" };

/**
 * The in-process worker of the `ts` runtime (CORE-14). It settles each invocation through `invokeCode`, with the
 * function `loadCode` resolves (ADR 0008). `cancel` settles the invocation `failed` at once and abandons the function,
 * which an in-process worker cannot stop. A line the function logs once its invocation has settled is dropped.
 */
export function tsWorker(loadCode: LoadCode, check: PortCheck): Worker {
	const cancels = new Map<string, () => void>();
	return {
		handshake: {
			runtime: TS_RUNTIME,
			version: Bun.version,
			irVersion: IR_VERSION,
		},
		async invoke(invocation, log) {
			const id = instanceKey(invocation.instance);
			const cancelled = new Promise<NodeResult>((settle) => {
				cancels.set(id, () => settle(CANCELLED));
			});
			let settled = false;
			const live = (line: string) => {
				if (!settled) log(line);
			};
			try {
				return await Promise.race([
					call(loadCode, check, invocation, live),
					cancelled,
				]);
			} catch (error) {
				return { outcome: "failed", reason: messageOf(error) };
			} finally {
				settled = true;
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
	check: PortCheck,
	{ worker, in: ports, inputs, context }: Invocation,
	log: (line: string) => void,
): Promise<NodeResult> {
	const fn = await loadFunction(loadCode, worker);
	const { artifacts, ...rest } = context;
	const ctx: CodeContext = {
		...rest,
		path: (ref) => join(artifacts, ref.path),
		log,
	};
	return invokeCode(fn, { in: ports, inputs, context: ctx }, check);
}

const REJECTION_FIELDS: ReadonlySet<string> = new Set([
	"outcome",
	"reason",
	"outputs",
]);

const isRejection = (value: unknown): value is Rejection<Outputs> =>
	isRecord(value) &&
	value.outcome === "rejected" &&
	typeof value.reason === "string" &&
	Object.keys(value).every((field) => REJECTION_FIELDS.has(field)) &&
	(value.outputs === undefined || isOutputs(value.outputs));

/** Parses what a code function returned (ADR 0008). */
function nodeResultOf(returned: unknown): NodeResult {
	if (isOutputs(returned)) return { outcome: "ok", outputs: returned };
	if (isRejection(returned)) {
		const { reason, outputs } = returned;
		return { outcome: "rejected", reason, ...(outputs && { outputs }) };
	}
	return { outcome: "failed", reason: misshapen(returned) };
}

/** Why `returned` is neither outputs nor a `Rejection`, with the fix last. */
function misshapen(returned: unknown): string {
	if (!isRecord(returned))
		return `the function returned ${shapeOf(returned)}, not outputs. Return an object keyed by output port`;
	if (
		returned.outcome === "rejected" &&
		returned.outputs !== undefined &&
		!isOutputs(returned.outputs)
	)
		return `the function rejected with ${shapeOf(returned.outputs)} as outputs. Pass reject(reason, outputs) an object keyed by output port`;
	return "the function returned 'outcome' or 'reason' beside its outputs. Return reject(reason, outputs) to reject";
}

const shapeOf = (value: unknown) => {
	if (Array.isArray(value)) return "a list";
	return isRecord(value)
		? "an object with 'outcome' or 'reason'"
		: String(value);
};

/** `value` with every object in it frozen, in place. */
function frozen<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	for (const field of Object.values(value)) frozen(field);
	return Object.freeze(value);
}

/**
 * Settles one call of a code function (ADR 0008): `inputs` are checked against `in`, `fn` is called with
 * `context.env` frozen, and its return is parsed. A throw settles `failed` with its message, and its stack goes to
 * `context.log`.
 */
export async function invokeCode(
	fn: Loaded,
	call: { in?: Ports; inputs: Inputs; context: CodeContext },
	check: PortCheck,
): Promise<NodeResult> {
	const mismatch = check(call.in, call.inputs, "input");
	if (mismatch) return { outcome: "failed", reason: mismatch };
	frozen(call.context.env);
	try {
		return nodeResultOf(await fn(call.inputs, call.context));
	} catch (error) {
		const stack = error instanceof Error ? error.stack : undefined;
		for (const line of stack?.split("\n") ?? []) call.context.log(line);
		return { outcome: "failed", reason: messageOf(error) };
	}
}
