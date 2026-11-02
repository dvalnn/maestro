import {
	type CodeNode,
	type DataEdge,
	type GraphIndex,
	type GroupNode,
	type IrEdge,
	type IrNode,
	indexGraph,
	isGroup,
	type Plan,
	STDLIB_MODULE,
} from "@maestro/ir";
import { type Entry, lastSegment, shapeOf } from "./layout";
import { escaped, label, START, STOP } from "./mermaid";

/** A drawn edge: `guard` is a control edge on a port, `collect` the barrier before a fan-in, `plain` any other. */
type Edge = {
	from: string;
	to: string;
	kind: "plain" | "guard" | "collect";
	label?: string;
};

/** The authored shape of a plan: each entry by id, with its parent's id, `""` at the top, and its Mermaid id. */
type Flow = {
	plan: Plan;
	graph: GraphIndex;
	tree: Entry[];
	entries: Map<string, Entry>;
	parent: Map<string, string>;
	ids: Map<string, string>;
};

function flowOf(plan: Plan): Flow {
	const graph = indexGraph(plan.ir);
	const tree = shapeOf(plan.ir, graph);
	const entries = new Map<string, Entry>();
	const parent = new Map<string, string>();
	const walk = (level: readonly Entry[], up: string) => {
		for (const e of level) {
			entries.set(e.id, e);
			parent.set(e.id, up);
			walk(e.children, e.id);
		}
	};
	walk(tree, "");
	const ids = new Map([...entries.keys()].map((id, i) => [id, `n${i}`]));
	return { plan, graph, tree, entries, parent, ids };
}

/** The ids from the top-level entry down to `id`. */
const chain = (f: Flow, id: string): string[] =>
	id ? [...chain(f, f.parent.get(id) ?? ""), id] : [];

const stdlib = (f: Flow, id: string): CodeNode | undefined => {
	const n = f.graph.nodes.get(id);
	return n?.kind === "code" && n.worker.module === STDLIB_MODULE
		? n
		: undefined;
};

const isHelper = (f: Flow, id: string) => stdlib(f, id) !== undefined;

/** The keys of `table` whose entry is `true`. */
const truthy = (table: unknown) =>
	Object.entries(typeof table === "object" && table !== null ? table : {})
		.filter(([, v]) => v === true)
		.map(([k]) => k);

/** What port `port` of `id` holds, read through the stdlib helpers that compute it: `get`, `not` and `lookup`. */
function condition(f: Flow, id: string, port: string): string {
	const n = stdlib(f, id);
	if (!n) return port;
	const pred = f.plan.ir.edges.find(
		(e): e is DataEdge => e.kind === "data" && e.to.node === id,
	)?.from;
	const inner = pred ? condition(f, pred.node, pred.port) : "";
	const literals = n.literals ?? {};
	switch (n.worker.export) {
		case "get":
			return [inner, `${literals.path}`].filter(Boolean).join(".");
		case "not":
			return `not ${inner}`;
		case "lookup":
			return `${inner} is ${truthy(literals.table).join(" or ")}`;
		default:
			return inner;
	}
}

function drawn(f: Flow, e: IrEdge): Edge {
	const ends = { from: e.from.node, to: e.to.node };
	if (e.kind === "collect") return { ...ends, kind: "collect" };
	if (e.kind === "control" && e.from.port !== undefined)
		return {
			...ends,
			kind: "guard",
			label: condition(f, e.from.node, e.from.port),
		};
	return { ...ends, kind: "plain" };
}

/** `edges` with each stdlib helper taken out, each edge into one joined to each edge out, as the out-edge is drawn. */
function contract(f: Flow, edges: readonly Edge[]): Edge[] {
	let left = [...edges];
	for (const h of f.plan.ir.nodes.map((n) => n.id)) {
		if (!isHelper(f, h)) continue;
		const ins = left.filter((e) => e.to === h);
		const outs = left.filter((e) => e.from === h);
		const through = ins.flatMap((i) =>
			outs.map((o) => ({ ...o, from: i.from })),
		);
		left = [...left.filter((e) => e.from !== h && e.to !== h), ...through];
	}
	return left;
}

const keyOf = (e: Edge) => `${e.from}\0${e.to}\0${e.kind}\0${e.label ?? ""}`;

/** `e` between the entries at the level where its ends are siblings, or none between a container and its own body. */
function lifted(f: Flow, e: Edge): Edge | undefined {
	const [a, b] = [chain(f, e.from), chain(f, e.to)];
	if (a.includes(e.to) || b.includes(e.from)) return undefined;
	const k = a.findIndex((id, i) => id !== b[i]);
	return { ...e, from: a[k] ?? e.from, to: b[k] ?? e.to };
}

/** Whether `to` is reached from `from` along `edges` but `skip`. */
function reaches(
	edges: readonly Edge[],
	from: string,
	to: string,
	skip: Edge,
): boolean {
	const seen = new Set<string>();
	const stack = edges
		.filter((e) => e.from === from && e !== skip)
		.map((e) => e.to);
	for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
		if (n === to) return true;
		if (seen.has(n)) continue;
		seen.add(n);
		stack.push(...edges.filter((e) => e.from === n).map((e) => e.to));
	}
	return false;
}

/**
 * The edges as drawn: helpers contracted, each lifted to siblings, then each plain edge another path reaches past
 * dropped, a guard or collect edge on the same pair included.
 */
function edgesOf(f: Flow): Edge[] {
	const unique = new Map<string, Edge>();
	for (const e of contract(
		f,
		f.plan.ir.edges.map((e) => drawn(f, e)),
	)) {
		const up = lifted(f, e);
		if (up) unique.set(keyOf(up), up);
	}
	const all = [...unique.values()];
	return all.filter(
		(e) => e.kind !== "plain" || !reaches(all, e.from, e.to, e),
	);
}

/** The ids two or more non-guard edges leave (`forks`) or enter (`joins`). */
function bars(edges: readonly Edge[]) {
	const parallel = edges.filter((e) => e.kind !== "guard");
	const crowded = (end: "from" | "to") => {
		const counts = Map.groupBy(parallel, (e) => e[end]);
		return new Set(
			[...counts].filter(([, es]) => es.length >= 2).map(([id]) => id),
		);
	};
	return { forks: crowded("from"), joins: crowded("to") };
}

type Bars = ReturnType<typeof bars>;

/** A group's size: `≤N rounds` for a loop, else `×N`, `×N..M` across its paths, or `≤N` when any is unknown. */
function size(plan: Plan, g: GroupNode): string {
	const found = Object.values(plan.expansion[g.id] ?? {});
	const sizes = (found.length ? found : [g.cardinality]).map((e) =>
		"keys" in e
			? { n: e.keys.length, up: false }
			: "exact" in e
				? { n: e.exact, up: false }
				: { n: e.upTo, up: true },
	);
	const hi = Math.max(...sizes.map((s) => s.n));
	const lo = Math.min(...sizes.map((s) => s.n));
	if (g.kind === "loop") return `≤${hi} rounds`;
	if (sizes.some((s) => s.up)) return `≤${hi}`;
	return lo === hi ? `×${hi}` : `×${lo}..${hi}`;
}

/** A subgraph's title: a scope's name, or a group's name, kind and size, the name left out when it is the kind. */
function title(plan: Plan, e: Entry): string {
	const name = lastSegment(e.id);
	if (!isGroup(e.node)) return name;
	const kind = `${e.node.kind} ${size(plan, e.node)}`;
	return name === e.node.kind ? kind : `${name} · ${kind}`;
}

const kindTag = (n: IrNode) => n.kind.slice(n.kind.lastIndexOf(".") + 1);

function nodeLine(id: string, n: IrNode, name: string): string {
	const text = `"${escaped(name)}<br/><small>${escaped(kindTag(n))}</small>"`;
	return n.kind === "assert" ? `${id}{${text}}` : `${id}[${text}]`;
}

/** The lines of `level` at `depth`: nodes and subgraphs, each followed by its bars. */
function entryLines(
	f: Flow,
	b: Bars,
	level: readonly Entry[],
	depth: number,
): string[] {
	const pad = "  ".repeat(depth);
	return level.flatMap((e) => {
		if (isHelper(f, e.id)) return [];
		const id = `${f.ids.get(e.id)}`;
		const own =
			e.node && !isGroup(e.node)
				? [`${pad}${nodeLine(id, e.node, lastSegment(e.id))}`]
				: [
						`${pad}subgraph ${id}[${label(title(f.plan, e))}]`,
						...entryLines(f, b, e.children, depth + 1),
						`${pad}end`,
					];
		return [
			...own,
			...(b.forks.has(e.id)
				? [`${pad}f${id}@{ shape: fork, label: " " }`]
				: []),
			...(b.joins.has(e.id)
				? [`${pad}j${id}@{ shape: join, label: " " }`]
				: []),
		];
	});
}

const arrow = (e: Edge) =>
	e.kind === "guard"
		? `-.->|${label(e.label ?? "")}|`
		: e.kind === "collect"
			? "==>"
			: "-->";

/** The ends `e` is drawn between: a non-guard edge leaves its source's fork bar and enters its target's join bar. */
function barEnds(f: Flow, b: Bars, e: Edge) {
	const barred = e.kind !== "guard";
	const from = `${f.ids.get(e.from)}`;
	const to = `${f.ids.get(e.to)}`;
	return {
		from,
		to,
		source: barred && b.forks.has(e.from) ? `f${from}` : from,
		target: barred && b.joins.has(e.to) ? `j${to}` : to,
	};
}

/** The edge lines through the bars: each fork fed before its first edge, each join drained after its first. */
function edgeLines(f: Flow, b: Bars, edges: readonly Edge[]): string[] {
	return edges.flatMap((e, i) => {
		const { from, to, source, target } = barEnds(f, b, e);
		const first = (end: "from" | "to") =>
			edges.findIndex((o) => o.kind !== "guard" && o[end] === e[end]) === i;
		return [
			...(source !== from && first("from") ? [`  ${from} --- ${source}`] : []),
			`  ${source} ${arrow(e)} ${target}`,
			...(target !== to && first("to") ? [`  ${target} --> ${to}`] : []),
		];
	});
}

/** A loop's or fold's dashed back edge, from its body's last sink to its first root; a loop's carries its test. */
function backEdge(f: Flow, edges: readonly Edge[], g: GroupNode): string[] {
	if (g.kind !== "loop" && g.kind !== "fold") return [];
	const body = (f.entries.get(g.id)?.children ?? [])
		.map((c) => c.id)
		.filter((id) => !isHelper(f, id));
	const inBody = edges.filter(
		(e) => body.includes(e.from) && body.includes(e.to),
	);
	const root = body.find((id) => !inBody.some((e) => e.to === id));
	const sink = body.findLast((id) => !inBody.some((e) => e.from === id));
	if (root === undefined || sink === undefined) return [];
	const text =
		g.kind === "loop"
			? `next while ${condition(f, g.test.port.node, g.test.port.port)}`
			: "next";
	return [`  ${f.ids.get(sink)} -.->|${label(text)}| ${f.ids.get(root)}`];
}

/** `start` to each top-level entry no edge enters, and the result's top-level entry to `end`. */
function ends(f: Flow, edges: readonly Edge[]): string[] {
	const tops = f.tree
		.map((e) => e.id)
		.filter((id) => !isHelper(f, id) && !edges.some((e) => e.to === id));
	const result = chain(f, f.plan.ir.result.node)[0] ?? "";
	return [
		...tops.map((id) => `  ${START} --> ${f.ids.get(id)}`),
		`  ${f.ids.get(result)} --> ${STOP}`,
	];
}

/**
 * A Mermaid flowchart of the plan's authored flow, the steps in the order they were written rather than every data
 * path. The README's "Flow drawing rules" section holds the drawing rules.
 */
export function flow(plan: Plan): string {
	const f = flowOf(plan);
	const edges = edgesOf(f);
	const b = bars(edges);
	return [
		"flowchart TD",
		`  ${START}((start))`,
		...entryLines(f, b, f.tree, 1),
		`  ${STOP}(((end)))`,
		...edgeLines(f, b, edges),
		...plan.ir.nodes.filter(isGroup).flatMap((g) => backEdge(f, edges, g)),
		...ends(f, edges),
	].join("\n");
}
