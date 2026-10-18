import {
	boundOf,
	type Diagnostic,
	type Expansion,
	firstDuplicate,
	formatExpansion,
	formatInstance,
	type GraphIndex,
	type GroupNode,
	type Ir,
	isGroup,
	itemKey,
	type Plan,
} from "@maestro/ir";
import type { ExpansionOf } from "./bounds";

/** A group instance's expansion, with the item each iteration it lists delivers. */
type Expanded = { expansion: Expansion; items: readonly unknown[] };

type Expanding = {
	graph: GraphIndex;
	expanded: Map<string, Map<string, Expanded>>;
	diagnostics: Diagnostic[];
	limit: ((expansionOf: ExpansionOf) => Diagnostic[]) | undefined;
};

/** A value compose knows. */
type Known = { value: unknown };

const error = (
	code: string,
	node: string,
	message: string,
	hint: string,
): Diagnostic => ({ code, severity: "error", node, message, hint });

const expandedAt = (s: Expanding, group: string, keys: readonly string[]) =>
	s.expanded.get(group)?.get(formatExpansion(keys));

/** The key lists of the instances under `groups`, outermost first, through the iterations compose lists. */
function instances(s: Expanding, groups: readonly string[]): string[][] {
	let paths: string[][] = [[]];
	for (const group of groups)
		paths = paths.flatMap((keys) => {
			const e = expandedAt(s, group, keys)?.expansion;
			return e && "keys" in e ? e.keys.map((k) => [...keys, k]) : [];
		});
	return paths;
}

/** The value of `from` for the instance of `group` at `keys`, when it is an inner port of an enclosing group. */
function innerValue(
	s: Expanding,
	group: GroupNode,
	from: { node: string; port?: string },
	keys: readonly string[],
): Known | undefined {
	const depth = s.graph.groupsOf(group.id).indexOf(from.node);
	if (depth < 0) return undefined;
	const outer = expandedAt(s, from.node, keys.slice(0, depth));
	const e = outer?.expansion;
	const i = e && "keys" in e ? e.keys.indexOf(keys[depth] ?? "") : -1;
	if (!outer || i < 0) return undefined;
	if (from.port === "index") return { value: i };
	return from.port === "item" ? { value: outer.items[i] } : undefined;
}

/** A group instance's `items`: a literal, or an enclosing group's item. */
function itemsOf(
	s: Expanding,
	group: GroupNode,
	keys: readonly string[],
): unknown[] | undefined {
	if (group.kind === "loop") return undefined;
	const edge = s.graph
		.edgesInto(group.id)
		.find((e) => e.kind === "data" && e.to.port === "items");
	const items =
		group.items ??
		group.literals?.items ??
		(edge && innerValue(s, group, edge.from, keys)?.value);
	return Array.isArray(items) ? items : undefined;
}

/** Whether every guard of a group instance is known true: one fed by a node result is not known (architecture 7). */
const starts = (s: Expanding, group: GroupNode, keys: readonly string[]) =>
	s.graph
		.edgesInto(group.id)
		.every(
			(e) =>
				e.kind !== "control" ||
				e.from.port === undefined ||
				innerValue(s, group, e.from, keys)?.value === true,
		);

/** A parMap's item keys (D-18), or the `SCOPE.key` error of two items keyed alike. */
function mapKeys(
	group: GroupNode,
	name: string,
	items: readonly unknown[],
): string[] | Diagnostic {
	const keys = items.map(itemKey);
	const dup = firstDuplicate(keys);
	if (!dup) return keys;
	return error(
		"SCOPE.key",
		group.id,
		`parMap '${name}' gives items ${dup.first} and ${dup.second} the same key '${dup.key}'`,
		`Give parMap '${group.id}' a key function, or make its items distinct`,
	);
}

/**
 * How a group instance expands:
 * - a `parMap` over a plain list into one instance per item, counted when a key function names them, as that is called
 *   only at perform (ADR 0009);
 * - a `map` or `fold` over a plain list into one instance per index;
 * - anything else, or a group with a guard compose does not know true, stays a region of up to its bound (CORE-05).
 */
function expansionOf(
	s: Expanding,
	group: GroupNode,
	keys: readonly string[],
): Expanded {
	const bound = boundOf(group.cardinality);
	const region = { expansion: { upTo: bound }, items: [] };
	const items = starts(s, group, keys) ? itemsOf(s, group, keys) : undefined;
	if (!items) return region;
	const name = formatInstance(
		{ node: group.id, expansion: formatExpansion(keys) },
		s.graph.groupsOf(group.id),
	);
	if (items.length > bound) {
		s.diagnostics.push(
			error(
				"BOUND.items",
				group.id,
				`${group.kind} '${name}' has ${items.length} items, over its bound of ${bound}`,
				`Raise the bound of '${group.id}' to ${items.length} or more`,
			),
		);
		return region;
	}
	if (group.kind === "map" || group.kind === "fold")
		return { expansion: { keys: items.map((_, i) => String(i)) }, items };
	if (group.kind !== "parMap") return region;
	if (group.key) return { expansion: { exact: items.length }, items: [] };
	const named = mapKeys(group, name, items);
	if (Array.isArray(named)) return { expansion: { keys: named }, items };
	s.diagnostics.push(named);
	return region;
}

/** The cap errors of the bounds so far, where a group instance not yet reached has no iterations. */
function overCap(s: Expanding): Diagnostic[] {
	const sofar: ExpansionOf = (group, path) =>
		s.expanded.get(group.id)?.get(path)?.expansion ?? { keys: [] };
	return s.limit?.(sofar) ?? [];
}

/** Expands each instance of `groups`, enclosing groups first, until a cap is passed. */
function walk(s: Expanding, groups: readonly GroupNode[]) {
	for (const group of groups)
		for (const keys of instances(s, s.graph.groupsOf(group.id))) {
			const at = s.expanded.get(group.id) ?? new Map<string, Expanded>();
			s.expanded.set(
				group.id,
				at.set(formatExpansion(keys), expansionOf(s, group, keys)),
			);
			const over = overCap(s);
			s.diagnostics.push(...over);
			if (over.length) return;
		}
}

/**
 * Expands each group instance whose items are plain values: literals, or an enclosing group's items (CORE-07,
 * architecture 4). No author code is called. With `limit`, the cap errors of the bounds so far are checked after each
 * group instance, and expansion stops at the first.
 */
export function expand(
	ir: Ir,
	graph: GraphIndex,
	limit?: (expansionOf: ExpansionOf) => Diagnostic[],
): Pick<Plan, "expansion" | "diagnostics"> {
	const s: Expanding = { graph, expanded: new Map(), diagnostics: [], limit };
	const depth = (id: string) => graph.groupsOf(id).length;
	walk(
		s,
		ir.nodes.filter(isGroup).toSorted((a, b) => depth(a.id) - depth(b.id)),
	);
	const expansion = Object.fromEntries(
		[...s.expanded].map(([id, at]) => [
			id,
			Object.fromEntries([...at].map(([path, e]) => [path, e.expansion])),
		]),
	);
	return { expansion, diagnostics: s.diagnostics };
}
