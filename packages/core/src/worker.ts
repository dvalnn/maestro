import type {
	ArtifactRef,
	CodeContext,
	Rejection,
	WorkerRef,
} from "@maestro/ir";

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

/** Resolves a worker reference to its function (ADR 0008). The loader supplies it. */
export type LoadCode = (ref: WorkerRef) => Promise<CodeFunction>;

/** What a worker announces before its first invocation. */
export type Handshake = { runtime: string; version: string; irVersion: string };

/** One code node instance to settle, as plain data so it can cross a process boundary. */
export type Invocation = {
	instance: NodeInstance;
	worker: WorkerRef;
	inputs: Inputs;
	/** `CodeContext` without `path`, which the worker derives from `artifacts`, the area's absolute path. */
	context: Omit<CodeContext, "path"> & { artifacts: string };
};

/** How a node instance settled, as its worker or host reports it. A throw is `failed`, its message the reason. */
export type Settlement =
	| { outcome: "ok"; outputs: Outputs }
	| { outcome: "rejected" | "failed"; reason: string; outputs?: Outputs };

/** Executes the code nodes of one runtime (sdk-spec 13.2). It gets each function through `LoadCode`. */
export interface Worker {
	readonly handshake: Handshake;
	/** `log` takes the instance's log lines, which core stores in the record. */
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
