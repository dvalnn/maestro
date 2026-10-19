import {
	type GraphIndex,
	type Ir,
	type IrNode,
	indexGraph,
	isGroup,
	type NodeInstance,
	parseExpansion,
} from "@maestro/ir";

/**
 * One line of a layout: a heading, a scope's name or a loop's `round <n>`, or an IR node with one of its instances,
 * absent when the node never ran.
 */
export type Item<T> =
	| { type: "heading"; depth: number; text: string; round: boolean }
	| {
			type: "row";
			depth: number;
			node: IrNode;
			name: string;
			instance?: T;
	  };

/** An IR node, or a scope, which has no node, with what sits inside it. */
type Entry = { id: string; node?: IrNode; children: Entry[] };

const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/** The entries of `ir` nested by their nearest enclosing scope or group, each level in IR order. */
function treeOf(ir: Ir, graph: GraphIndex): Entry[] {
	const roots: Entry[] = [];
	const entries = new Map<string, Entry>();
	const attach = (id: string): Entry => {
		const known = entries.get(id);
		if (known) return known;
		const entry: Entry = { id, node: graph.nodes.get(id), children: [] };
		entries.set(id, entry);
		const container = graph
			.ancestors(id)
			.find((a) => graph.scopes.has(a) || isGroup(graph.nodes.get(a)));
		(container === undefined ? roots : attach(container).children).push(entry);
		return entry;
	};
	for (const node of ir.nodes) attach(node.id);
	return roots;
}

const within = (instance: NodeInstance, expansion: string) =>
	instance.expansion.startsWith(expansion);

/**
 * `instances` laid out as the IR nests them: a scope as a heading over its members, a group's members under it, and a
 * loop's members by round, each round's in node order. A node with no instance, in a round or at all, gives one row without it.
 */
export function layout<T extends NodeInstance>(
	ir: Ir,
	instances: readonly T[],
): Item<T>[] {
	const graph = indexGraph(ir);
	const byNode = Map.groupBy(instances, (s) => s.node);

	const nameOf = (id: string, expansion = "") => {
		const keys = parseExpansion(expansion) ?? [];
		const shown = graph
			.groupsOf(id)
			.map((group, i) =>
				graph.nodes.get(group)?.kind === "loop" || keys[i] === undefined
					? ""
					: `[${keys[i]}]`,
			);
		return lastSegment(id) + shown.join("");
	};

	const rounds = (entry: Entry, expansion: string): string[] => {
		const level = parseExpansion(expansion)?.length ?? 0;
		const keys = new Set<string>();
		for (const s of instances)
			if (s.node.startsWith(`${entry.id}/`) && within(s, expansion))
				keys.add(parseExpansion(s.expansion)?.[level] ?? "");
		return [...keys].sort((a, b) => Number(a) - Number(b));
	};

	/** The members of `entry` at `depth`, those of one `expansion`. */
	const members = (entry: Entry, depth: number, expansion: string) => {
		const keys = entry.node?.kind === "loop" ? rounds(entry, expansion) : [];
		if (keys.length === 0)
			return entry.children.flatMap((c) => lay(c, depth, expansion));
		return keys.flatMap((key): Item<T>[] => {
			const round = `${expansion}[${key}]`;
			return [
				{
					type: "heading",
					depth: depth - 1,
					text: `round ${key}`,
					round: true,
				},
				...entry.children.flatMap((c) => lay(c, depth, round)),
			];
		});
	};

	function lay(entry: Entry, depth: number, expansion: string): Item<T>[] {
		const { node } = entry;
		if (!node)
			return [
				{
					type: "heading",
					depth,
					text: lastSegment(entry.id),
					round: false,
				},
				...members(entry, depth + 1, expansion),
			];
		const own = (byNode.get(node.id) ?? []).filter((s) => within(s, expansion));
		if (own.length === 0)
			return [
				{ type: "row", depth, node, name: nameOf(node.id) },
				...members(entry, depth + 1, expansion),
			];
		return own.flatMap((instance): Item<T>[] => [
			{
				type: "row",
				depth,
				node,
				name: nameOf(node.id, instance.expansion),
				instance,
			},
			...members(entry, depth + 1, instance.expansion),
		]);
	}

	return treeOf(ir, graph).flatMap((e) => lay(e, 0, ""));
}

/** `instances` in the order `layout` lists them. */
export const arranged = <T extends NodeInstance>(
	ir: Ir,
	instances: readonly T[],
): T[] =>
	layout(ir, instances).flatMap((item) =>
		item.type === "row" && item.instance ? [item.instance] : [],
	);
