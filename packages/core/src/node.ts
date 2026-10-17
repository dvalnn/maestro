import type { CodeContext, Rejection, WorkerRef } from "@maestro/ir";

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
export type CodeEntry = (
	inputs: Inputs,
	context: CodeContext,
) => Outputs | Rejection | Promise<Outputs | Rejection>;

/** A map's key function, which names its members (ADR 0008). */
export type KeyFunction = (item: unknown) => unknown;

/** Resolves a worker reference to the function it names (ADR 0008). The loader supplies it. */
export type LoadCode = (ref: WorkerRef) => Promise<CodeEntry | KeyFunction>;

/** How a node instance ended, as its worker or host reports it. A throw is `failed`, its message the reason. */
export type NodeResult =
	| { outcome: "ok"; outputs: Outputs }
	| { outcome: "rejected" | "failed"; reason: string; outputs?: Outputs };
