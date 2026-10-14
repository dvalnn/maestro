import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import fanoutFaninLoop from "../fixtures/fanout-fanin-loop.json";
import minimal from "../fixtures/minimal.json";
import { IR_VERSION, irSchema, parseIr } from "./index";

const fixturesDir = `${import.meta.dir}/../fixtures`;

test.each(readdirSync(fixturesDir).filter((f) => f.endsWith(".json")))(
	"golden fixture %s is accepted",
	async (file) => {
		const ir = await Bun.file(`${fixturesDir}/${file}`).json();
		expect(parseIr(ir)).toEqual({ ok: true, ir });
	},
);

// biome-ignore lint/suspicious/noExplicitAny: mutations deliberately break the IR's types
type Mutation = (ir: any) => void;

function rejects(base: object, mutate: Mutation) {
	const ir = structuredClone(base);
	mutate(ir);
	const result = parseIr(ir);
	if (result.ok) throw new Error("expected the IR to be rejected");
	return result.diagnostics;
}

test.each<[string, Mutation, string]>([
	[
		"a code node without a worker",
		(ir) => delete ir.nodes[0].worker,
		"/nodes/0",
	],
	[
		"an unknown node kind",
		(ir) => (ir.nodes[0].kind = "loop"),
		"/nodes/0/kind",
	],
	[
		"a core field on the wrong kind",
		(ir) => (ir.nodes[0].onFail = "failed"),
		"/nodes/0",
	],
	["an unknown top-level field", (ir) => (ir.extra = 1), "/"],
	[
		"no example input set",
		(ir) => (ir.params.examples = []),
		"/params/examples",
	],
	[
		"a group with no members",
		(ir) =>
			(ir.nodes[0] = {
				id: "g",
				kind: "map",
				label: "g",
				inner: {},
				members: {},
				cardinality: { upTo: 1 },
				onError: "settle",
			}),
		"/nodes/0/members",
	],
	["a bad node id", (ir) => (ir.nodes[0].id = "a//b"), "/nodes/0/id"],
	[
		"an unknown edge kind",
		(ir) =>
			ir.edges.push({
				kind: "state",
				from: { node: "greet" },
				to: { node: "greet" },
			}),
		"/edges/0/kind",
	],
	[
		"a guard edge that tolerates",
		(ir) =>
			ir.edges.push({
				kind: "control",
				from: { node: "greet", port: "ok" },
				to: { node: "greet" },
				tolerate: "rejected",
			}),
		"/edges/0",
	],
])("the shape check rejects %s", (_, mutate, path) => {
	const diagnostics = rejects(minimal, mutate);
	expect(diagnostics.every((d) => d.code === "IR.schema")).toBe(true);
	expect(diagnostics.map((d) => d.path)).toContain(path);
});

test("schema diagnostics name the offending property", () => {
	const diagnostics = rejects(minimal, (ir) => (ir.nodes[0].onFail = "failed"));
	expect(diagnostics).toEqual([
		{
			code: "IR.schema",
			path: "/nodes/0",
			message: "must NOT have property 'onFail'",
		},
	]);
});

test("schema diagnostics skip noise from the branch that failed", () => {
	const diagnostics = rejects(minimal, (ir) => delete ir.nodes[0].worker);
	expect(diagnostics.map((d) => d.message)).toEqual([
		"must have required property 'worker'",
	]);
});

const node = (ir: { nodes: { id: string }[] }, id: string) =>
	ir.nodes.find((n) => n.id === id) as never as Record<string, unknown>;

test.each<[string, Mutation, string, string, string]>([
	[
		"a duplicate id",
		(ir) => ir.scopes.push({ id: "pick", composition: "x", ports: {} }),
		"SCOPE.duplicate",
		"/scopes/1",
		"id 'pick' is used more than once",
	],
	[
		"an unknown parent",
		(ir) => (node(ir, "pick").parent = "nowhere"),
		"IR.ref",
		"/nodes/2",
		"parent 'nowhere' is not a scope or a group node",
	],
	[
		"a parent that is not a group",
		(ir) => (node(ir, "refine/loop/done").parent = "pick"),
		"IR.ref",
		"/nodes/5",
		"parent 'pick' is not a scope or a group node",
	],
	[
		"an edge from an unknown node",
		(ir) => (ir.edges[2].from.node = "ghost"),
		"IR.ref",
		"/edges/2",
		"edge refers to node 'ghost', which does not exist",
	],
	[
		"an edge into an undeclared port",
		(ir) => (ir.edges[2].to.port = "txt"),
		"IR.ref",
		"/edges/2",
		"node 'refine/loop' has no input port 'txt'",
	],
	[
		"an edge from an undeclared port",
		(ir) => (ir.edges[2].from.port = "txt"),
		"IR.ref",
		"/edges/2",
		"node 'pick' has no output port 'txt'",
	],
	[
		"a literal for an undeclared port",
		(ir) => (node(ir, "pick").literals = { mode: "first" }),
		"IR.ref",
		"/nodes/2",
		"node 'pick' has no input port 'mode'",
	],
	[
		"a result rule naming an unknown node",
		(ir) => (ir.result = { rule: "node", node: "ghost" }),
		"IR.ref",
		"/result",
		"node 'ghost' does not exist",
	],
	[
		"a parent cycle",
		(ir) => (ir.scopes[0].parent = "refine/loop"),
		"IR.graph",
		"/scopes/0",
		"the parent chain of 'refine' loops back to it",
	],
	[
		"an unfed input port",
		(ir) => ir.edges.splice(2, 1),
		"IR.graph",
		"/nodes/3",
		"input port 'text' of node 'refine/loop' is not fed",
	],
	[
		"an input port fed twice",
		(ir) => (node(ir, "pick").literals = { drafts: [] }),
		"IR.graph",
		"/nodes/2",
		"input port 'drafts' of node 'pick' is fed more than once",
	],
	[
		"an edge leaving a group body",
		(ir) =>
			(ir.edges[1] = {
				kind: "data",
				from: { node: "topics/draft", port: "text" },
				to: ir.edges[1].to,
			}),
		"IR.graph",
		"/edges/1",
		"edge from 'topics/draft' leaves the body of group 'topics'",
	],
	[
		"an inner port read outside the body",
		(ir) => (ir.edges[2].from = { node: "topics", port: "item" }),
		"IR.ref",
		"/edges/2",
		"node 'topics' has no output port 'item'",
	],
	[
		"a collect edge that does not start at map results",
		(ir) => (ir.edges[2].kind = "collect"),
		"IR.graph",
		"/edges/2",
		"collect edge from 'pick' must start at a map node's 'results' port",
	],
	[
		"map results leaving through a data edge",
		(ir) => (ir.edges[1].kind = "data"),
		"IR.graph",
		"/edges/1",
		"results of map 'topics' must leave it through a collect edge",
	],
	[
		"a member outside the group body",
		(ir) => (node(ir, "topics").members = { result: "pick" }),
		"IR.graph",
		"/nodes/0",
		"member 'pick' is not in the body of group 'topics'",
	],
	[
		"a repeat with two members",
		(ir) =>
			(node(ir, "refine/loop").members = {
				a: "refine/loop/step",
				b: "refine/loop/done",
			}),
		"IR.graph",
		"/nodes/3",
		"repeat 'refine/loop' must have exactly one member in IR 1.0, got 2",
	],
	[
		"a stop condition outside the group body",
		(ir) => (node(ir, "refine/loop").until = { node: "pick", port: "text" }),
		"IR.graph",
		"/nodes/3",
		"until 'pick' is not in the body of group 'refine/loop'",
	],
	[
		"map ports other than item and results",
		(ir) =>
			((node(ir, "topics").out as object as Record<string, object>).extra = {}),
		"IR.graph",
		"/nodes/0",
		"map 'topics' must declare out ports [results], got [extra, results]",
	],
	[
		"repeat state ports that do not mirror the member",
		(ir) =>
			((
				node(ir, "refine/loop/step").out as object as Record<string, object>
			).notes = {}),
		"IR.graph",
		"/nodes/3",
		"repeat 'refine/loop' must declare inner ports [index, notes, text], got [index, text]",
	],
	[
		"literal items with an items port",
		(ir) => (node(ir, "topics").in = { items: {} }),
		"IR.graph",
		"/nodes/0",
		"map 'topics' must declare in ports [], got [items]",
	],
	[
		"an exact cardinality that disagrees with the items",
		(ir) => (node(ir, "topics").cardinality = { exact: 2 }),
		"IR.graph",
		"/nodes/0",
		"map 'topics' must declare cardinality { exact: 3 }",
	],
	[
		"an exact cardinality on a loop",
		(ir) => (node(ir, "refine/loop").cardinality = { exact: 2 }),
		"IR.graph",
		"/nodes/3",
		"repeat 'refine/loop' must declare cardinality { upTo: N }",
	],
	[
		"a cycle",
		(ir) =>
			ir.edges.push({
				kind: "control",
				from: { node: "refine/loop" },
				to: { node: "pick" },
			}),
		"IR.graph",
		"/edges",
		"edges form a cycle: pick -> refine/loop -> pick",
	],
	[
		"a cycle through a group body",
		(ir) =>
			ir.edges.push({
				kind: "control",
				from: { node: "pick" },
				to: { node: "topics/draft" },
			}),
		"IR.graph",
		"/edges",
		"edges form a cycle: topics -> pick -> topics",
	],
	[
		"a result node inside a group body",
		(ir) => (ir.result = { rule: "node", node: "topics/draft" }),
		"IR.graph",
		"/result",
		"result node 'topics/draft' is inside a group body",
	],
])("the graph check rejects %s", (_, mutate, code, path, message) => {
	expect(rejects(fanoutFaninLoop, mutate)).toContainEqual({
		code,
		path,
		message,
	});
});

const withVersion = (irVersion: unknown) => ({ ...minimal, irVersion });

test("an unknown major version is rejected with a clear error", () => {
	expect(parseIr(withVersion("2.0"))).toEqual({
		ok: false,
		diagnostics: [
			{
				code: "IR.version",
				path: "/irVersion",
				message:
					"IR version 2.0 has major version 2, and this reader supports major version 1 only",
				hint: "Re-emit the IR with an emitter that targets IR 1.x, or use a maestro that reads IR 2.x",
			},
		],
	});
});

test("a newer minor version than the reader knows is rejected", () => {
	const result = parseIr(withVersion("1.7"));
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.diagnostics[0]?.code).toBe("IR.version");
		expect(result.diagnostics[0]?.message).toBe(
			"IR version 1.7 is newer than this maestro reads (1.0). It was emitted by a newer SDK, for example one bundled in a pack",
		);
		expect(result.diagnostics[0]?.hint).toBe(
			"Upgrade maestro to a version that reads IR 1.7, or re-emit the IR with an SDK that targets IR 1.0",
		);
	}
});

test.each([[undefined], ["1"], [1], ["v1.0"]])(
	"a missing or malformed version %p is rejected before the shape is checked",
	(irVersion) => {
		const result = parseIr({ irVersion, nodes: "not even close" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diagnostics.map((d) => d.code)).toEqual(["IR.version"]);
		}
	},
);

test("the schema accepts exactly the versions this reader reads", () => {
	// The schema pins accepted versions, so it and IR_VERSION are bumped together.
	expect(irSchema.properties.irVersion.enum.at(-1)).toBe(IR_VERSION);
	expect(parseIr(withVersion("1.0")).ok).toBe(true);
});

test("an independent reader with no maestro code parses the fan-out, fan-in and loop IR", () => {
	// Acceptance evidence: a missing python3 must fail this test, never skip it.
	const python = Bun.which("python3");
	if (!python)
		throw new Error("python3 is required for the independent reader test");
	const reader = Bun.spawnSync([
		python,
		"-I",
		`${import.meta.dir}/../test/read_ir.py`,
		`${fixturesDir}/fanout-fanin-loop.json`,
	]);
	expect(reader.stderr.toString()).toBe("");
	expect(reader.stdout.toString()).toBe(
		[
			"fan-out: map topics, exactly 3 members, each result=topics/draft",
			"loop: repeat refine/loop, up to 2 iterations, each result=refine/loop/step, until refine/loop/done.value, tolerating rejected",
			"fan-in: topics.results -> pick.drafts (reducer)",
			"order: topics -> pick -> refine/loop",
			"",
		].join("\n"),
	);
});
