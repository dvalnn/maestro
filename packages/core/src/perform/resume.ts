import {
	ARTIFACT_TYPES,
	type AssertNode,
	type CodeNode,
	canonicalJson,
	findMarked,
	type HostNode,
	type Ir,
	type WorkerRef,
} from "@maestro/ir";
import { instanceKey, isRecord } from "../shared";
import type { Inputs, Outputs } from "../worker";
import type { InstanceRecord } from "./record";

/** The `codeHash` of the code a worker reference names as it is now (ADR 0008). */
export type CodeHash = (ref: WorkerRef) => Promise<string>;

/** What a resume may reuse of a recorded `ok` instance. */
export type Kept = { key: string; outputs: Outputs };

/** `ir` with the `codeHash` of each code node and each `map` key function replaced by its current one. */
export async function withCurrentHashes(
	ir: Ir,
	codeHash: CodeHash,
): Promise<Ir> {
	const current = async (ref: WorkerRef): Promise<WorkerRef> => ({
		...ref,
		codeHash: await codeHash(ref),
	});
	const nodes = await Promise.all(
		ir.nodes.map(async (node) => {
			if (node.kind === "code")
				return { ...node, worker: await current(node.worker) };
			if (node.kind === "map" && node.key)
				return { ...node, key: await current(node.key) };
			return node;
		}),
	);
	return { ...ir, nodes };
}

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

/**
 * The resume key of a leaf instance (architecture 7): a SHA-256 over its node as the IR holds it and its input
 * values, with each input artifact standing for its content hash and object keys in order.
 */
export function resumeKey(
	node: CodeNode | HostNode | AssertNode,
	inputs: Inputs,
): string {
	const hashes = new Map<unknown, unknown>();
	for (const [port, schema] of Object.entries(node.in ?? {}))
		for (const { type, value } of findMarked(schema, inputs[port]))
			if (ARTIFACT_TYPES.has(type) && isRecord(value))
				hashes.set(value, value.contentHash);
	const text = canonicalJson({ node, inputs }, (value) =>
		hashes.has(value) ? hashes.get(value) : value,
	);
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}
