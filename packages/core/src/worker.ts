import type {
	ArtifactRef,
	CodeContext,
	Ports,
	Rejection,
	WorkerRef,
} from "@maestro/ir";
import type { PortCheck } from "./ports";
import { isOutputs, isRecord, type Loaded, messageOf } from "./shared";

/** A node id and its expansion path (architecture 7), in ir's format (`formatExpansion`). */
export type NodeInstance = NonNullable<ArtifactRef["producer"]>;

/** Input values by port name, literals included. An artifact arrives as its `ArtifactRef` (ADR 0007). */
export type Inputs = Readonly<Record<string, unknown>>;

/**
 * Output values by port name, as JSON. Where an artifact marker reaches (`findMarked`), the value is either:
 * - the absolute path of a file or directory the node wrote, which core moves into the concert's artifact area and
 *   hashes when the node finishes (ADR 0007), or
 * - an `ArtifactRef` passed on.
 *
 * No port is named `outcome` or `reason`, so outputs never read as a `Rejection` (ADR 0008).
 */
export type Outputs = Readonly<Record<string, unknown>> & {
	readonly outcome?: never;
	readonly reason?: never;
};

/** The function a code node names, erased to its one shape (ADR 0008). A throw settles the instance `failed`. */
export type CodeFunction = (
	inputs: Inputs,
	context: CodeContext,
) => Outputs | Rejection | Promise<Outputs | Rejection>;

/** A map's key function, which names its members (ADR 0008). */
export type KeyFunction = (item: unknown) => unknown;

/** Resolves a worker reference to the function it names (ADR 0008). The loader supplies it. */
export type LoadCode = (ref: WorkerRef) => Promise<CodeFunction | KeyFunction>;

/** What a worker announces before its first invocation. */
export type Handshake = { runtime: string; version: string; irVersion: string };

/** One code node instance to settle, as plain data so it can cross a process boundary. */
export type Invocation = {
	instance: NodeInstance;
	worker: WorkerRef;
	/** The node's input ports, which `inputs` are checked against. */
	in?: Ports;
	inputs: Inputs;
	/** The node is pure, so its context throws on `concert` and `clock`. */
	pure: boolean;
	/**
	 * `CodeContext` without `path`, which the worker derives from `artifacts`, the area's absolute path, and without
	 * `log`, which is `invoke`'s.
	 */
	context: Omit<CodeContext, "path" | "log"> & { artifacts: string };
};

/** How a node instance settled, as its worker or host reports it. A throw is `failed`, its message the reason. */
export type Settlement =
	| { outcome: "ok"; outputs: Outputs }
	| { outcome: "rejected" | "failed"; reason: string; outputs?: Outputs };

/** Executes the code nodes of one runtime (sdk-spec 13.2). It gets each function through `LoadCode`. */
export interface Worker {
	readonly handshake: Handshake;
	/** `log` takes the instance's log lines, which core stores in the record, until `invoke` settles. */
	invoke(
		invocation: Invocation,
		log: (line: string) => void,
	): Promise<Settlement>;
	/** Stops the instance's invocation, whose `invoke` then replies promptly. Timeouts cancel through this too. */
	cancel(instance: NodeInstance): Promise<void>;
}

const impure = (field: "concert" | "clock") => ({
	enumerable: true,
	get(): never {
		throw new Error(
			`a pure node cannot read ctx.${field}. Mark the node pure: false to read it`,
		);
	},
});

/** `context` for a pure node: reading `concert` or `clock` throws, as a cached or folded result would freeze it. */
export function pureContext(context: CodeContext): CodeContext {
	return Object.defineProperties(
		{ ...context },
		{ concert: impure("concert"), clock: impure("clock") },
	);
}

/** The fields of a `Rejection`: `outcome` and `reason`. */
const REJECTION_FIELDS = 2;

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
): Promise<Settlement> {
	const mismatch = check(call.in, call.inputs, "input");
	if (mismatch) return { outcome: "failed", reason: mismatch };
	frozen(call.context.env);
	try {
		return settlementOf(await fn(call.inputs, call.context));
	} catch (error) {
		const stack = error instanceof Error ? error.stack : undefined;
		for (const line of stack?.split("\n") ?? []) call.context.log(line);
		return { outcome: "failed", reason: messageOf(error) };
	}
}
