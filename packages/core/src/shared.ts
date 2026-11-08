import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { NodeInstance, WorkerRef } from "@maestro/ir";
import type { Host, NodeKind } from "./host";
import type { LoadCode, Outputs } from "./node";

/** The hex SHA-256 of `data`. */
export const sha256Hex = (data: string | Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(data).digest("hex");

/**
 * Every entry under the directory `dir`, at any depth, each with its `parentPath`. A link is an entry of its own and is
 * never walked into, unlike a recursive `readdir`, which in Bun follows links.
 */
export async function walk(dir: string): Promise<Dirent[]> {
	const found = await readdir(dir, { withFileTypes: true });
	const nested = await Promise.all(
		found.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [])),
	);
	return [...found, ...nested.flat()];
}

/** `path` with the home directory `home` at its start shown as `~`. */
export const tildeOf = (path: string, home: string | undefined) =>
	home && (path === home || path.startsWith(`${home}/`))
		? `~${path.slice(home.length)}`
		: path;

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

/** A loaded function as core calls it: with a code node's inputs and context, or with a `parMap` or `parFind` item. */
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

export type HostKind = { host: Host; kind: NodeKind };

/**
 * Indexes the kinds of `hosts` by name, so a node's `kind` resolves to its host and kind.
 * @throws Error when two hosts register one kind name.
 */
export function kindLookup(
	hosts: readonly Host[],
): (name: string) => HostKind | undefined {
	const kinds = new Map<string, HostKind>();
	for (const host of hosts)
		for (const kind of host.kinds) {
			const other = kinds.get(kind.name)?.host.name;
			if (other !== undefined)
				throw new Error(
					`node kind '${kind.name}' is registered twice, by host '${other}' and by host '${host.name}'\nLoad only one host that registers '${kind.name}'`,
				);
			kinds.set(kind.name, { host, kind });
		}
	return (name) => kinds.get(name);
}
