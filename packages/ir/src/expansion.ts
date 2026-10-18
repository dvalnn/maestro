import type { ArtifactRef } from "./artifact-ref";

const KEY_CHARS = "A-Za-z0-9_.-";
const KEY = new RegExp(`^[${KEY_CHARS}]*$`);
const NOT_KEY = new RegExp(`[^${KEY_CHARS}]`, "gu");
const BRACKETED = new RegExp(`\\[([${KEY_CHARS}]*)\\]`, "g");

/** The pattern of an expansion path: one `[key]` per enclosing group, outermost first, empty outside groups. */
export const EXPANSION_PATTERN = `^(?:\\[[${KEY_CHARS}]*\\])*$`;
const EXPANSION = new RegExp(EXPANSION_PATTERN);

const PRIMITIVES = new Set(["string", "number", "boolean"]);

/**
 * A `parMap` or `parFind` item's key (D-18): a primitive item's value, any other item's index, with each character
 * outside `[A-Za-z0-9_.-]` turned to `_`. Items with equal keys are duplicates, so `3` and `"3"` collide.
 */
export function itemKey(item: unknown, index: number): string {
	const raw =
		item === null || PRIMITIVES.has(typeof item) ? String(item) : String(index);
	return raw.replace(NOT_KEY, "_");
}

/** The first key of `keys` that an earlier one equals, with both indexes, or `undefined` when all are distinct. */
export function firstDuplicate(
	keys: readonly string[],
): { key: string; first: number; second: number } | undefined {
	const seen = new Map<string, number>();
	for (const [second, key] of keys.entries()) {
		const first = seen.get(key);
		if (first !== undefined) return { key, first, second };
		seen.set(key, second);
	}
	return undefined;
}

/**
 * The expansion path of `keys`, outermost first: a `parMap` or `parFind` item's `itemKey`, or another group's iteration
 * index.
 * @throws when a key holds a character outside `[A-Za-z0-9_.-]`.
 */
export function formatExpansion(keys: readonly string[]): string {
	const bad = keys.find((k) => !KEY.test(k));
	if (bad !== undefined)
		throw new Error(`expansion key '${bad}' is not sanitized`);
	return keys.map((k) => `[${k}]`).join("");
}

/** The keys of `expansion`, outermost first, or `undefined` when it is not an expansion path. */
export function parseExpansion(expansion: string): string[] | undefined {
	if (!EXPANSION.test(expansion)) return undefined;
	return [...expansion.matchAll(BRACKETED)].map((m) => m[1] ?? "");
}

/**
 * A node instance merged into one name, each key right after its group's id within the node id
 * (`lens[risk]/skeptic`), where `groups` are the node's enclosing groups, outermost first.
 * @throws when the expansion is not a path with one key per group.
 */
export function formatInstance(
	{ node, expansion }: NonNullable<ArtifactRef["producer"]>,
	groups: readonly string[],
): string {
	const keys = parseExpansion(expansion);
	if (keys?.length !== groups.length)
		throw new Error(
			`expansion '${expansion}' of '${node}' does not have one key per group (${groups.length})`,
		);
	let shown = "";
	let at = 0;
	for (const [i, group] of groups.entries()) {
		shown += `${node.slice(at, group.length)}[${keys[i]}]`;
		at = group.length;
	}
	return shown + node.slice(at);
}
