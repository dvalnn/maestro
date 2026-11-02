import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	INTAKE,
	type Node,
	STATES,
	TRANSITIONS,
	type Transition,
} from "./transitions";

const DOC = resolve(import.meta.dir, "../../docs/agents/factory.md");
/** The state diagrams; the tick's own flowcharts are top-down. */
const STATE_DIAGRAM = /```mermaid\nflowchart LR\n([\s\S]*?)```/g;
const ENDPOINT = String.raw`(\w+)(\(\(\s*\)\)|\(\[[^\]]*\]\)|\[[^\]]*\])?`;
const SHAPE = /[()[\]"]/g;
const NODE = new RegExp(ENDPOINT, "g");
const EDGE = new RegExp(
	String.raw`^\s*${ENDPOINT}\s*(-->|-\.->|==>)\|"?([^|"]*)"?\|\s*${ENDPOINT}`,
);
const ACTORS = /\[([^\]]+)\]/g;
const FOOTNOTE = /[¹²³⁴⁵]|\[\^\w+\]|`/g;
const ANY: Node[] = [...STATES, "new", "closed"];
/** A thick edge is the owner's move. */
const OWNER_EDGE = "==>";

/** The label's states: `intake` is the intake state, a blank label an issue not yet filed. */
function statesOf(label: string): Node[] {
	const name = label.replace(FOOTNOTE, "").trim();
	if (name === "") return ["new"];
	if (name === "intake") return [...INTAKE];
	return name.split(/,\s*/) as Node[];
}

/** An edge of a diagram: its possible ends and the actors it names. */
type Edge = { line: string; from: Node[]; to: Node[]; actors: string[] };

function edgesOf(diagram: string): Edge[] {
	const labels = new Map<string, string>();
	for (const [, id = "", shape] of diagram.matchAll(NODE))
		if (shape !== undefined) labels.set(id, shape.replace(SHAPE, ""));
	return diagram.split("\n").flatMap((line) => {
		const m = EDGE.exec(line);
		if (!m) return [];
		const [, from = "", , arrow, label = "", to = ""] = m;
		const named = [...label.matchAll(ACTORS)].flatMap(([, a = ""]) =>
			a.split(/,\s*/),
		);
		const actors = named.length || arrow !== OWNER_EDGE ? named : ["owner"];
		return [
			{
				line: line.trim(),
				from: statesOf(labels.get(from) ?? from),
				to: statesOf(labels.get(to) ?? to),
				actors,
			},
		];
	});
}

const covers = (table: readonly Transition[], edge: Edge) =>
	(edge.actors.length ? edge.actors : [undefined]).every((actor) =>
		table.some(
			(t) =>
				edge.from.includes(t.from) &&
				edge.to.includes(t.to) &&
				(actor === undefined || t.actor === actor),
		),
	);

/** Each move the label reference table states, as an edge: a `Moved in by` actor, or a `Next` state. */
function referenceEdges(doc: string): Edge[] {
	const rows = doc
		.split("\n")
		.filter((l) => /^\| `[a-z-]+` /.test(l))
		.map((l) => l.split("|").map((c) => c.replace(FOOTNOTE, "").trim()));
	return rows.flatMap(([, state = "", , movedBy = "", next = ""]) => {
		const self = statesOf(state);
		return [
			...movedBy.split(/,\s*/).map((actor) => ({
				line: state,
				from: ANY,
				to: self,
				actors: [actor],
			})),
			...next
				.split(/,\s*/)
				.map((n) => ({ line: state, from: self, to: statesOf(n), actors: [] })),
		];
	});
}

const shown = (t: Transition, e: Edge) =>
	e.from.includes(t.from) &&
	e.to.includes(t.to) &&
	(!e.actors.length || e.actors.includes(t.actor));

/** The diagram edges and label reference moves of `doc` that `table` lacks, then the rows of `table` `doc` lacks. */
function drift(doc: string, table: readonly Transition[]): string[] {
	const edges = [
		...[...doc.matchAll(STATE_DIAGRAM)].flatMap(([, d = ""]) => edgesOf(d)),
		...referenceEdges(doc),
	];
	return [
		...edges
			.filter((e) => !covers(table, e))
			.map(
				(e) =>
					`${e.line}: ${e.from === ANY ? "any" : e.from} -> ${e.to} [${e.actors}]`,
			),
		...table
			.filter((t) => !edges.some((e) => shown(t, e)))
			.map((t) => `table: ${t.from} -> ${t.to} [${t.actor}]`),
	];
}

const APPROVE = '    NA -->|"[owner] approve"| RA\n';
const EXTRA_EDGE = '    RA -->|"[owner] drop"| IR\n';
const cases: [string, (doc: string) => string, Transition[], string[]][] = [
	["matches factory.md", (doc) => doc, [], []],
	[
		"drifts on a diagram edge the table lacks",
		(doc) => doc.replace(APPROVE, `${APPROVE}${EXTRA_EDGE}`),
		[],
		['RA -->|"[owner] drop"| IR: ready-for-agent -> in-review [owner]'],
	],
	[
		"drifts on a table row no diagram or reference shows",
		(doc) => doc,
		[
			{
				from: "wontfix",
				to: "in-review",
				actor: "slice",
				event: "x",
			},
		],
		["table: wontfix -> in-review [slice]"],
	],
];

test.each(cases)("the transition table %s", async (_, edit, extra, found) => {
	const doc = edit(await Bun.file(DOC).text());
	expect(drift(doc, [...TRANSITIONS, ...extra])).toEqual(found);
});
