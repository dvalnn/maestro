import {
	type Cardinality,
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

function groupLabel(plan: Plan, graph: GraphIndex, g: GroupNode): string {
	const count = amount(g.cardinality);
	const expanded = Object.entries(plan.expansion[g.id] ?? {}).map(
		([path, e]) => `${instance(graph, g.id, path)}: ${shownExpansion(e)}`,
	);
	return label(`${g.kind} ${g.id}`, count, ...expanded);
}

function shape(plan: Plan, graph: GraphIndex, n: IrNode): string {
	if (isGroup(n)) return `[[${groupLabel(plan, graph, n)}]]`;
	if (n.kind === "assert") return `{${label(n.id, "assert")}}`;
	if (n.kind !== "code") return `([${label(n.id, n.kind)}])`;
	if (n.fanin) return `[/${label(n.id, `fan-in ${n.worker.export}`)}/]`;
	return `[${label(n.id, `code ${n.worker.export}`)}]`;
}

/** The innermost scope or group whose body holds `id`, by id prefix. */
const container = (containers: readonly string[], id: string) =>
	containers
		.filter((c) => id.startsWith(`${c}/`))
		.sort((a, b) => b.length - a.length)[0];

function edgeLine(ids: ReadonlyMap<string, string>, e: IrEdge): string {
	const [from, to] = [ids.get(e.from.node), ids.get(e.to.node)];
	if (e.kind === "collect") return `${from} ==>|${label("collect")}| ${to}`;
	if (e.kind === "data")
		return `${from} -->|${label(`${e.from.port} to ${e.to.port}`)}| ${to}`;
	if (e.from.port !== undefined)
		return `${from} -.->|${label(`when ${e.from.port}`)}| ${to}`;
	const after = e.tolerate ? `after, tolerates ${e.tolerate}` : "after";
	return `${from} -.->|${label(after)}| ${to}`;
}

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
			...(header
				? [`${pad}  ${d.ids.get(c)}${shape(d.plan, d.graph, header)}`]
				: []),
			...body(d, c, depth + 1),
			`${pad}end`,
		];
	});
	const nodes = d.plan.ir.nodes
		.filter((n) => !isGroup(n) && inside(n.id))
		.map((n) => `${pad}${d.ids.get(n.id)}${shape(d.plan, d.graph, n)}`);
	return [...subgraphs, ...nodes];
}

/**
 * A static Mermaid flowchart (architecture 11): one shape per node kind, scopes and groups as subgraphs, `data` edges
 * solid, `control` edges dashed, `collect` edges thick into their fan-in reducer, and each group's cardinality,
 * expansion in its label.
 */
export function render(plan: Plan): string {
	const ids = new Map(plan.ir.nodes.map((n, i) => [n.id, `n${i}`]));
	const scopes = plan.ir.scopes.map((s) => s.id);
	const groups = plan.ir.nodes.filter(isGroup).map((g) => g.id);
	const d = {
		plan,
		graph: indexGraph(plan.ir),
		ids,
		scopes,
		containers: [...scopes, ...groups],
	};
	return [
		"flowchart TD",
		...body(d, undefined, 1),
		...plan.ir.edges.map((e) => `  ${edgeLine(ids, e)}`),
	].join("\n");
}
