import {
	ARTIFACT_TYPES,
	canonicalJson,
	findMarked,
	type GroupNode,
	type IrNode,
} from "@maestro/ir";
import type { Inputs, Outputs } from "../node";
import { instanceKey, isRecord, sha256Hex } from "../shared";
import type { InstanceRecord } from "./record";

/** What a resume may reuse of a recorded `ok` instance. */
export type Kept = { key: string; outputs: Outputs };

/** The `ok` instances in `instances` that carry a key, by `instanceKey`. */
export function keptOf(
	instances: readonly InstanceRecord[],
): Map<string, Kept> {
	const kept = new Map<string, Kept>();
	for (const i of instances)
		if (i.status === "ok" && i.key !== undefined && i.outputs !== undefined)
			kept.set(instanceKey(i), { key: i.key, outputs: i.outputs });
	return kept;
}

/** A node that is not a group: it executes, or settles, as one instance. */
export type Leaf = Exclude<IrNode, GroupNode>;

/**
 * The resume key of a leaf instance (architecture 7): a SHA-256 over its node as the IR holds it and its input
 * values, with each input artifact standing for its content hash and object keys in order.
 */
export function resumeKey(node: Leaf, inputs: Inputs): string {
	const hashes = new Map<unknown, unknown>();
	for (const [port, schema] of Object.entries(node.in ?? {}))
		for (const { type, value } of findMarked(schema, inputs[port]))
			if (ARTIFACT_TYPES.has(type) && isRecord(value))
				hashes.set(value, value.contentHash);
	const text = canonicalJson({ node, inputs }, (value) =>
		hashes.has(value) ? hashes.get(value) : value,
	);
	return sha256Hex(text);
}
