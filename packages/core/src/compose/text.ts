import {
	type Cardinality,
	type DataEdge,
	formatInstance,
	type GraphIndex,
	type GroupNode,
	type IrEdge,
	type IrNode,
	indexGraph,
	isGroup,
} from "@maestro/ir";
import type { Expansion, Plan } from "./index";

/** Longest value or key list a text form shows before it cuts with an ellipsis. */
const MAX_SHOWN = 40;

const cut = (s: string) =>
	s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN - 1)}…` : s;

const amount = (c: Cardinality) =>
	"exact" in c ? `${c.exact}` : `up to ${c.upTo}`;

const counted = (n: number | string, noun: string) =>
	`${n} ${noun}${n === 1 || n === "1" ? "" : "s"}`;

const shownExpansion = (e: Expansion) =>
	"keys" in e ? cut(e.keys.join(", ")) : amount(e);

/** The plan in one line: node instances, each host count and any warnings. */
export function summary(plan: Plan): string {
	const { bounds, diagnostics } = plan;
	const parts = [
		counted(amount(bounds.instances), "node instance"),
		...Object.entries(bounds.counts).map(([name, c]) => `${amount(c)} ${name}`),
		...(diagnostics.length ? [counted(diagnostics.length, "warning")] : []),
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
				`    ${instance(graph, n.id, path)} expands to ${shownExpansion(e)}`,
		),
	]);
}

/** The plan in full: each node with its kind, instance count and expansions, then bounds and warnings. */
export function listing(plan: Plan): string {
	const graph = indexGraph(plan.ir);
	const { bounds } = plan;
	const lines = [
		summary(plan),
		"nodes:",
		...nodeLines(plan, graph),
		"bounds:",
		...table([
			["instances", amount(bounds.instances)],
			...Object.entries(bounds.counts).map(([name, c]) => [name, amount(c)]),
		]),
	];
	if (plan.diagnostics.length)
		lines.push(
			"warnings:",
			...table(plan.diagnostics.map((d) => [d.code, d.message])),
		);
	return lines.join("\n");
}

/** Mermaid ids of the start and end markers. `end` is a Mermaid keyword, so it cannot name a node. */
const START = "start";
const STOP = "stop";

/** A Mermaid label: quoted, with the characters Mermaid reads as markup or entities escaped. */
const label = (...lines: string[]) =>
	`"${lines
		.map((l) =>
			l
				.replaceAll("#", "#35;")
				.replaceAll('"', "#quot;")
				.replaceAll("<", "#lt;")
				.replaceAll(">", "#gt;"),
		)
		.join("<br/>")}"`;

/** A group header's label: its kind, then its expansion alone for one path or `<path>: <expansion>` per path. */
function groupLabel(plan: Plan, g: GroupNode): string {
	const paths = Object.entries(plan.expansion[g.id] ?? {});
	const [only] = paths;
	const facts =
		paths.length === 1 && only
			? [shownExpansion(only[1])]
			: paths.length
				? paths.map(([path, e]) => `${path}: ${shownExpansion(e)}`)
				: [amount(g.cardinality)];
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

/** The edges with each `data` edge after the first between a pair of nodes folded into it, as its list of ports. */
function mergeData(edges: readonly IrEdge[]) {
	const merged = new Map<string, { edge: IrEdge; ports: string[] }>();
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
	ids: ReadonlyMap<string, string>,
	{ edge: e, ports }: { edge: IrEdge; ports: string[] },
): string {
	const [from, to] = [ids.get(e.from.node), ids.get(e.to.node)];
	if (e.kind === "collect") return `${from} ==>|${label("collect")}| ${to}`;
	if (e.kind === "data") return `${from} -->|${label(ports.join(", "))}| ${to}`;
	if (e.from.port !== undefined)
		return `${from} -.->|${label(`when ${e.from.port}`)}| ${to}`;
	const after = e.tolerate ? `after, tolerates ${e.tolerate}` : "after";
	return `${from} -.->|${label(after)}| ${to}`;
}

/** A dashed `next` edge from each repeat's body result to its header: the state the next iteration starts from. */
const loopBacks = (plan: Plan, ids: ReadonlyMap<string, string>) =>
	plan.ir.nodes.flatMap((n) =>
		n.kind === "repeat"
			? Object.values(n.members).map(
					(m) => `${ids.get(m)} -.->|${label("next")}| ${ids.get(n.id)}`,
				)
			: [],
	);

type Diagram = {
	plan: Plan;
	graph: GraphIndex;
	ids: ReadonlyMap<string, string>;
	scopes: readonly string[];
	containers: readonly string[];
};

/** The Mermaid lines of what lies directly in `parent`, or at the top when it is `undefined`: subgraphs, then nodes. */
function body(d: Diagram, parent: string | undefined, depth: number): string[] {
	const pad = "  ".repeat(depth);
	const inside = (id: string) => container(d.containers, id) === parent;
	const subgraphs = d.containers.filter(inside).flatMap((c) => {
		const header = d.graph.nodes.get(c);
		const name = d.scopes.includes(c)
			? `s${d.scopes.indexOf(c)}`
			: `g${d.ids.get(c)}`;
		return [
			`${pad}subgraph ${name}[${label(c)}]`,
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
	return [...subgraphs, ...nodes];
}

/**
 * A static Mermaid flowchart of the plan, with start and end markers and a `next` edge closing each repeat.
 * The README's "Text forms" section holds the drawing rules.
 */
export function render(plan: Plan): string {
	const ids = new Map(plan.ir.nodes.map((n, i) => [n.id, `n${i}`]));
	const scopes = plan.ir.scopes.map((s) => s.id);
	const groups = plan.ir.nodes.filter(isGroup).map((g) => g.id);
	const graph = indexGraph(plan.ir);
	const d = { plan, graph, ids, scopes, containers: [...scopes, ...groups] };
	const starts = plan.ir.nodes
		.filter(
			(n) =>
				graph.edgesInto(n.id).length === 0 && graph.groupsOf(n.id).length === 0,
		)
		.map((n) => `  ${START} --> ${ids.get(n.id)}`);
	return [
		"flowchart TD",
		`  ${START}((start))`,
		`  ${STOP}(((end)))`,
		...body(d, undefined, 1),
		...starts,
		...mergeData(plan.ir.edges).map((m) => `  ${edgeLine(ids, m)}`),
		...loopBacks(plan, ids).map((l) => `  ${l}`),
		`  ${ids.get(plan.ir.result.node)} --> ${STOP}`,
	].join("\n");
}
