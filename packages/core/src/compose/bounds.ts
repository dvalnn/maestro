import {
	boundOf,
	type Cardinality,
	type Diagnostic,
	type Expansion,
	formatExpansion,
	type GraphIndex,
	type GroupNode,
	type HostNode,
	type Ir,
	type IrNode,
	isGroup,
	type PlanBounds,
} from "@maestro/ir";
import type { Bounds } from "../host";
import type { HostKind } from "../shared";

/** The expansion of a group instance, by its expansion path. */
export type ExpansionOf = (group: GroupNode, path: string) => Expansion;

/** Every group instance a region of up to its bound, which gives the IR's own bounds. */
export const unexpanded: ExpansionOf = (group) => ({
	upTo: boundOf(group.cardinality),
});

/** A count that is exact, or an upper bound. */
type Tally = { n: number; exact: boolean };

/** The name of the cap on the node-instance total. */
const INSTANCES = "instances";

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const product = (xs: readonly number[]) => xs.reduce((a, b) => a * b, 1);

const cardinality = ({ n, exact }: Tally): Cardinality =>
	exact ? { exact: n } : { upTo: n };

const tally = (c: Cardinality): Tally =>
	"exact" in c ? { n: c.exact, exact: true } : { n: c.upTo, exact: false };

const isHostNode = (n: IrNode): n is HostNode => n.kind.includes(".");

/**
 * The instances under `groups` below the group instance at `keys`. A region counts up to every bound left, and an
 * iteration count up to every bound below it.
 */
function countFrom(
	groups: GroupNode[],
	keys: string[],
	expansionOf: ExpansionOf,
): Tally {
	const group = groups[keys.length];
	if (!group) return { n: 1, exact: true };
	const e = expansionOf(group, formatExpansion(keys));
	const below = (depth: number) =>
		groups.slice(depth).map((g) => boundOf(g.cardinality));
	if ("upTo" in e) return { n: product(below(keys.length)), exact: false };
	if ("exact" in e) {
		const rest = below(keys.length + 1);
		return { n: e.exact * product(rest), exact: rest.length === 0 };
	}
	const parts = e.keys.map((k) => countFrom(groups, [...keys, k], expansionOf));
	return {
		n: sum(parts.map((p) => p.n)),
		exact: group.kind === "parMap" && parts.every((p) => p.exact),
	};
}

function hostCounts(
	ir: Ir,
	nodes: Readonly<Record<string, Cardinality>>,
	lookup: (kind: string) => HostKind | undefined,
): Record<string, Cardinality> {
	const counts = new Map<string, Tally>();
	for (const node of ir.nodes.filter(isHostNode)) {
		const host = lookup(node.kind)?.host;
		const instances = tally(nodes[node.id] ?? { exact: 0 });
		for (const [name, n] of Object.entries(host?.bounds(node) ?? {})) {
			const sofar = counts.get(name) ?? { n: 0, exact: true };
			counts.set(name, {
				n: sofar.n + n * instances.n,
				exact: sofar.exact && instances.exact,
			});
		}
	}
	return Object.fromEntries(
		[...counts].map(([name, t]) => [name, cardinality(t)]),
	);
}

/**
 * The plan's bounds (D-23): node instances per node and in total, and each host's named counts summed over instances.
 */
export function boundsOf(
	ir: Ir,
	graph: GraphIndex,
	expansionOf: ExpansionOf,
	lookup: (kind: string) => HostKind | undefined,
): PlanBounds {
	const groups = (id: string) =>
		graph
			.groupsOf(id)
			.map((g) => graph.nodes.get(g))
			.filter(isGroup);
	const tallies = ir.nodes.map((n) => countFrom(groups(n.id), [], expansionOf));
	const nodes = Object.fromEntries(
		ir.nodes.map((n, i) => [
			n.id,
			cardinality(tallies[i] ?? tally({ exact: 0 })),
		]),
	);
	return {
		instances: cardinality({
			n: sum(tallies.map((x) => x.n)),
			exact: tallies.every((x) => x.exact),
		}),
		nodes,
		counts: hostCounts(ir, nodes, lookup),
	};
}

/** A `BOUND.cap` error for each total of `bounds` over its cap in `caps`, saying the total `reach`es it. */
export function capErrors(
	bounds: PlanBounds,
	caps: Bounds,
	reach = "may reach",
): Diagnostic[] {
	const totals = [
		[INSTANCES, bounds.instances] as const,
		...Object.entries(bounds.counts),
	];
	return totals.flatMap(([name, c]) => {
		const cap = caps[name];
		const { n } = tally(c);
		if (cap === undefined || n <= cap) return [];
		return [
			{
				code: "BOUND.cap",
				severity: "error",
				message: `'${name}' ${reach} ${n}, over its cap of ${cap}`,
				hint: `Lower the group bounds or params that size the plan, or raise the cap on '${name}'`,
			},
		];
	});
}
