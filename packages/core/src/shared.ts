import type { WorkerRef } from "@maestro/ir";
import type { LoadCode, NodeInstance, Outputs } from "./worker";

export const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A node instance as one string, for use as a map key. */
export const instanceKey = ({ node, expansion }: NodeInstance) =>
	`${node}\0${expansion}`;

/** An object without `outcome` or `reason`, so it never reads as a `Rejection` (ADR 0008). */
export const isOutputs = (value: unknown): value is Outputs =>
	isRecord(value) &&
	!Object.hasOwn(value, "outcome") &&
	!Object.hasOwn(value, "reason");

/** A loaded function as core calls it: with a code node's inputs and context, or with a map item. */
export type Loaded = (...args: unknown[]) => unknown;

const isFunction = (value: unknown): value is Loaded =>
	typeof value === "function";

/**
 * The function `ref` names, through `loadCode`.
 * @throws Error when `loadCode` fails, or what it resolves is not a function.
 */
export async function loadFunction(
	loadCode: LoadCode,
	ref: WorkerRef,
): Promise<Loaded> {
	const fn: unknown = await loadCode(ref);
	if (!isFunction(fn))
		throw new Error(`'${ref.export}' in '${ref.module}' is not a function`);
	return fn;
}
