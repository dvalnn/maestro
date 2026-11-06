import {
	type Cardinality,
	type DataEdge,
	type Expansion,
	formatInstance,
	type GraphIndex,
	type GroupNode,
	type IrEdge,
	type IrNode,
	indexGraph,
	isGroup,
	type Plan,
	type Severity,
} from "@maestro/ir";
import { label, START, STOP } from "./mermaid";

export { flow } from "./flow";

/** Longest value or key list a text form shows before it cuts with an ellipsis. */
const MAX_SHOWN = 40;

const SEVERITIES: readonly Severity[] = ["error", "warning"];

const cut = (s: string) =>
	s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN - 1)}…` : s;

const amount = (c: Cardinality) =>
	"exact" in c ? `${c.exact}` : `up to ${c.upTo}`;

const counted = (n: number | string, noun: string) =>
	`${n} ${noun}${n === 1 || n === "1" ? "" : "s"}`;

const shownExpansion = (e: Expansion) =>
	"keys" in e ? cut(e.keys.join(", ")) : amount(e);

/** `n`'s expansion `e` as shown: a loop's region by its steps, `0 to N` when it tests first, else `1 to N`. */
const expansionOf = (n: IrNode, e: Expansion) =>
	n.kind === "loop" && "upTo" in e
		? `${n.test.at === "start" ? 0 : 1} to ${e.upTo}`
		: shownExpansion(e);

/** The plan in one line: node instances, each host count, then its diagnostics counted by severity. */
export function summary(plan: Plan): string {
	const { bounds, diagnostics } = plan;
	const parts = [
		counted(amount(bounds.instances), "node instance"),
		...Object.entries(bounds.counts).map(([name, c]) => `${amount(c)} ${name}`),
		...SEVERITIES.flatMap((s) => {
			const n = diagnostics.filter((d) => d.severity === s).length;
			return n ? [counted(n, s)] : [];
		}),
	];
	return `${plan.ir.composition.id}: ${parts.join(", ")}`;
}

const instance = (graph: GraphIndex, node: string, path: string) =>
	formatInstance({ node, expansion: path }, graph.groupsOf(node));

/** Aligns rows of cells into columns two spaces apart, each line indented by two. */
function table(rows: readonly string[][]): string[] {
	const widths = rows.reduce<number[]>(
		(w, row) => row.map((cell, i) => Math.max(w[i] ?? 0, cell.length)),
		[],
	);
	return rows.map((row) =>
		`  ${row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ")}`.trimEnd(),
	);
}

/** Each node's instance count, then a line per expanded group instance. */
function nodeLines(plan: Plan, graph: GraphIndex): string[] {
	const heads = table(
		plan.ir.nodes.map((n) => {
			const count = plan.bounds.nodes[n.id];
			return [n.id, n.kind, count ? amount(count) : ""];
		}),
	);
	return plan.ir.nodes.flatMap((n, i) => [
		heads[i] ?? "",
		...Object.entries(plan.expansion[n.id] ?? {}).map(
			([path, e]) =>
				`    ${instance(graph, n.id, path)} expands to ${expansionOf(n, e)}`,
		),
	]);
}

/** The plan in full: each node with its kind, instance count and expansions, then its bounds. */
export function listing(plan: Plan): string {
	const graph = indexGraph(plan.ir);
	const { bounds } = plan;
	return [
		summary(plan),
		"nodes:",
		...nodeLines(plan, graph),
		"bounds:",
		...table([
			["instances", amount(bounds.instances)],
			...Object.entries(bounds.counts).map(([name, c]) => [name, amount(c)]),
		]),
	].join("\n");
}

/** A group header's label: its kind, then its expansion alone for one path or `<path>: <expansion>` per path. */
function groupLabel(plan: Plan, g: GroupNode): string {
	const paths = Object.entries(plan.expansion[g.id] ?? {});
	const [only] = paths;
	const facts =
		paths.length === 1 && only
			? [expansionOf(g, only[1])]
			: paths.length
				? paths.map(([path, e]) => `${path}: ${expansionOf(g, e)}`)
				: [expansionOf(g, g.cardinality)];
	return label(g.kind, ...facts);
}

/** A code node's kind line: the worker export only when it is not the node's own name. */
const worked = (kind: string, name: string, exported: string) =>
	exported === name ? kind : `${kind} ${exported}`;

/** The shape of a body or top-level node `n`, labelled `name`. */
function shape(n: Exclude<IrNode, GroupNode>, name: string): string {
	if (n.kind === "assert") return `{${label(name, "assert")}}`;
	if (n.kind !== "code") return `([${label(name, n.kind)}])`;
	if (n.fanin)
		return `[/${label(name, worked("fan-in", name, n.worker.export))}/]`;
	return `[${label(name, worked("code", name, n.worker.export))}]`;
}

/** The innermost scope or group whose body holds `id`, by id prefix. */
const container = (containers: readonly string[], id: string) =>
	containers
		.filter((c) => id.startsWith(`${c}/`))
		.sort((a, b) => b.length - a.length)[0];

const portPair = (e: DataEdge) =>
	e.from.port === e.to.port
		? `${e.from.port}`
		: `${e.from.port} to ${e.to.port}`;

/** An edge as drawn: a `data` edge carries the ports of every `data` edge between its pair of nodes. */
type Merged = { edge: IrEdge; ports: string[] };

/** The edges with each `data` edge after the first between a pair of nodes folded into it, as its list of ports. */
function mergeData(edges: readonly IrEdge[]): Merged[] {
	const merged = new Map<string, Merged>();
	for (const [i, e] of edges.entries()) {
		const key = e.kind === "data" ? `${e.from.node}\0${e.to.node}` : `${i}`;
		const ports = e.kind === "data" ? [portPair(e)] : [];
		const hit = merged.get(key);
		if (hit) hit.ports.push(...ports);
		else merged.set(key, { edge: e, ports });
	}
	return [...merged.values()];
}

function edgeLine(
	from: string,
	to: string,
	{ edge: e, ports }: Merged,
): string {
	if (e.kind === "collect") return `${from} ==>|${label("collect")}| ${to}`;
	if (e.kind === "data") return `${from} -->|${label(ports.join(", "))}| ${to}`;
	if (e.from.port !== undefined)
		return `${from} -.->|${label(`when ${e.from.port}, else skip`)}| ${to}`;
	const after = e.tolerate ? `after, tolerates ${e.tolerate}` : "after";
	return `${from} -.->|${label(after)}| ${to}`;
}

/** The ids that occur at least twice in `names`, in the order their second occurrence appears. */
function repeated(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const twice = new Set<string>();
	for (const name of names) (seen.has(name) ? twice : seen).add(name);
	return [...twice];
}

/** The Mermaid ids a node is drawn with: the node itself and the fork and join bars beside it. */
type Names = ReadonlyMap<string, { node: string; fork: string; join: string }>;

const barDeclaration = (id: string | undefined, shape: "fork" | "join") =>
	`${id}@{ shape: ${shape}, label: " " }`;

/**
 * The nodes that get a fork bar (two or more outgoing edges) and a join bar (two or more incoming), by id.
 * Data edges are walked before the others, so a node a guard or ordering edge makes crowded is declared last.
 */
function crowds(edges: readonly Merged[]) {
	const walk = [
		...edges.filter((m) => m.edge.kind === "data"),
		...edges.filter((m) => m.edge.kind !== "data"),
	];
	return {
		forks: repeated(walk.map((m) => m.edge.from.node)),
		joins: repeated(walk.map((m) => m.edge.to.node)),
	};
}

/** An edge from an enclosing group into its body reads an inner port: it orders nothing before or after the body. */
const isInner = (graph: GraphIndex, { edge }: Merged) =>
	graph.groupsOf(edge.to.node).includes(edge.from.node);

/** The ids with a fork or join bar, and the edges: each fork bar fed before its first edge, each join bar drained after its last. */
function wire(graph: GraphIndex, names: Names, edges: readonly Merged[]) {
	const counted = edges.filter((m) => !isInner(graph, m));
	const { forks, joins } = crowds(counted);
	const node = (id: string) => `${names.get(id)?.node}`;
	const feed = (m: Merged) => {
		const from = m.edge.from.node;
		const first = counted.find((c) => c.edge.from.node === from) === m;
		return forks.includes(from) && first
			? [`${node(from)} --> ${names.get(from)?.fork}`]
			: [];
	};
	const drain = (m: Merged) => {
		const to = m.edge.to.node;
		const last = counted.findLast((c) => c.edge.to.node === to) === m;
		return joins.includes(to) && last
			? [`${names.get(to)?.join} --> ${node(to)}`]
			: [];
	};
	const lines = edges.flatMap((m) => {
		const [from, to] = [m.edge.from.node, m.edge.to.node];
		const live = counted.includes(m);
		const source =
			live && forks.includes(from) ? names.get(from)?.fork : node(from);
		const target = live && joins.includes(to) ? names.get(to)?.join : node(to);
		return [...feed(m), edgeLine(`${source}`, `${target}`, m), ...drain(m)];
	});
	return { forks, joins, lines };
}

const carried = (n: GroupNode) =>
	n.kind === "fold"
		? [n.members.step]
		: n.kind === "loop"
			? Object.values(n.members)
			: [];

/** The body node a group's `test` or `cond` reads, when it has one. */
const tested = (n: GroupNode) =>
	n.kind === "loop"
		? n.test.port.node
		: n.kind === "find" || n.kind === "parFind"
			? n.cond.node
			: undefined;

/**
 * The dashed edges that tie a group's body to its header, one per member or tested node: the labels `next` for the
 * member the next iteration starts from and `test` for the node its condition reads, joined, or none for another member.
 */
const bodyLinks = (plan: Plan, ids: ReadonlyMap<string, string>) =>
	plan.ir.nodes.filter(isGroup).flatMap((n) => {
		const back = carried(n);
		const test = tested(n);
		const nodes = new Set([
			...back,
			...Object.values(n.members),
			...(test === undefined ? [] : [test]),
		]);
		return [...nodes].map((m) => {
			const text = [
				...(back.includes(m) ? ["next"] : []),
				...(m === test ? ["test"] : []),
			].join(", ");
			return `${ids.get(m)} -.->${text ? `|${label(text)}|` : ""} ${ids.get(n.id)}`;
		});
	});

/** The top-level nodes no edge from outside orders after something: none enters the node or its body. */
const roots = (plan: Plan, graph: GraphIndex) =>
	plan.ir.nodes.filter((n) => {
		const within = (id: string) => id === n.id || id.startsWith(`${n.id}/`);
		return (
			graph.groupsOf(n.id).length === 0 &&
			!plan.ir.edges.some((e) => within(e.to.node) && !within(e.from.node))
		);
	});

type Diagram = {
	plan: Plan;
	graph: GraphIndex;
	ids: ReadonlyMap<string, string>;
	names: Names;
	forks: readonly string[];
	joins: readonly string[];
	scopes: readonly string[];
	containers: readonly string[];
};

/** The Mermaid lines of what lies directly in `parent`, or at the top when it is `undefined`: subgraphs, nodes, then the bars beside them. */
function body(d: Diagram, parent: string | undefined, depth: number): string[] {
	const pad = "  ".repeat(depth);
	const inside = (id: string) => container(d.containers, id) === parent;
	const subgraphs = d.containers.filter(inside).flatMap((c) => {
		const header = d.graph.nodes.get(c);
		const name = d.scopes.includes(c)
			? `s${d.scopes.indexOf(c)}`
			: `g${d.ids.get(c)}`;
		return [
			`${pad}subgraph ${name}[${label(parent === undefined ? c : c.slice(parent.length + 1))}]`,
			...(header && isGroup(header)
				? [`${pad}  ${d.ids.get(c)}[[${groupLabel(d.plan, header)}]]`]
				: []),
			...body(d, c, depth + 1),
			`${pad}end`,
		];
	});
	const nodes = d.plan.ir.nodes.flatMap((n) => {
		if (isGroup(n) || !inside(n.id)) return [];
		const name = parent === undefined ? n.id : n.id.slice(parent.length + 1);
		return [`${pad}${d.ids.get(n.id)}${shape(n, name)}`];
	});
	return [...subgraphs, ...nodes, ...bars(d, parent, pad)];
}

/** The declarations of the bars of the nodes drawn directly in `parent`: a group's header is drawn in its own subgraph. */
function bars(d: Diagram, parent: string | undefined, pad: string): string[] {
	const home = (id: string) => {
		const n = d.graph.nodes.get(id);
		return n && isGroup(n) ? id : container(d.containers, id);
	};
	return [
		...d.forks
			.filter((id) => home(id) === parent)
			.map((id) => [d.names.get(id)?.fork, "fork"] as const),
		...d.joins
			.filter((id) => home(id) === parent)
			.map((id) => [d.names.get(id)?.join, "join"] as const),
	].map(([id, shape]) => `${pad}${barDeclaration(id, shape)}`);
}

/**
 * A static Mermaid flowchart of the plan, with start and end markers and dashed edges tying each group's body to its
 * header.
 * The README's "Drawing rules" section holds the drawing rules.
 */
export function render(plan: Plan): string {
	const names: Names = new Map(
		plan.ir.nodes.map((n, i) => [
			n.id,
			{ node: `n${i}`, fork: `f${i}`, join: `j${i}` },
		]),
	);
	const ids = new Map([...names].map(([id, n]) => [id, n.node]));
	const scopes = plan.ir.scopes.map((s) => s.id);
	const groups = plan.ir.nodes.filter(isGroup).map((g) => g.id);
	const graph = indexGraph(plan.ir);
	const { forks, joins, lines } = wire(graph, names, mergeData(plan.ir.edges));
	const d = {
		plan,
		graph,
		ids,
		names,
		forks,
		joins,
		scopes,
		containers: [...scopes, ...groups],
	};
	const starts = roots(plan, graph).map(
		(n) => `  ${START} --> ${ids.get(n.id)}`,
	);
	return [
		"flowchart TD",
		`  ${START}((start))`,
		`  ${STOP}(((end)))`,
		...body(d, undefined, 1),
		...starts,
		...lines.map((l) => `  ${l}`),
		...bodyLinks(plan, ids).map((l) => `  ${l}`),
		`  ${ids.get(plan.ir.result.node)} --> ${STOP}`,
	].join("\n");
}
