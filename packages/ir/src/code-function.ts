import type { ArtifactRef } from "./artifact-ref";

/** What core gives every node instance it starts. */
export type Context = {
	/** The concert id. */
	concert: string;
	/** Milliseconds since the Unix epoch, fixed when the instance starts. A node reads time only from here. */
	clock: number;
	/** The absolute path of an artifact in the concert's artifact area. */
	path(ref: ArtifactRef): string;
	/**
	 * The absolute path of the instance's own scratch directory. Core deletes it once it has moved the outputs, and a code
	 * instance that settles `failed` keeps it.
	 */
	scratch: string;
};

/** Facts a host offers code nodes, as JSON. */
export type Facts = Readonly<Record<string, unknown>>;

/** The `runtime` of a worker ref whose function executes in core's own TypeScript worker. */
export const TS_RUNTIME = "ts";

/** A code function's context: core's, plus each host's facts keyed by host name. */
export type CodeContext = Context & {
	env: Readonly<Record<string, Facts>>;
	/** Aborts when the instance is cancelled or times out. One signal per invocation. */
	signal: AbortSignal;
	/** Records `line` as a `log` event on the instance. */
	log(line: string): void;
};

/**
 * A code function's negative verdict, as `reject` builds it. `outputs`, when given, are the node's full outputs,
 * checked against its `out` like an `ok` node's. They sit in their own field, so a rejection never reads as outputs
 * (ADR 0008).
 */
export type Rejection<O = Readonly<Record<string, unknown>>> = {
	outcome: "rejected";
	reason: string;
	outputs?: O;
};

export const reject = <O = never>(
	reason: string,
	outputs?: O,
): Rejection<O> => ({
	outcome: "rejected",
	reason,
	...(outputs !== undefined && { outputs }),
});
