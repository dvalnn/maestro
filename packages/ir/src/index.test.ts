import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import fanoutFaninLoop from "../fixtures/fanout-fanin-loop.json";
import guards from "../fixtures/guards-and-escalation.json";
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
	for (const d of result.diagnostics) {
		expect(d.severity).toBe("error");
		expect(d.hint).not.toBe("");
	}
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
			severity: "error",
			path: "/nodes/0",
			message: "has unexpected property 'onFail'",
			hint: "Remove 'onFail' from /nodes/0, or correct its spelling",
			node: minimal.nodes[0]?.id,
		},
	]);
});

test("schema diagnostics skip noise from the branch that failed", () => {
	const diagnostics = rejects(minimal, (ir) => delete ir.nodes[0].worker);
	expect(diagnostics.map((d) => d.message)).toEqual([
		"is missing required property 'worker'",
	]);
});

test.each<[string, Mutation, string, string, string]>([
	[
		"enum lists the allowed values",
		(ir) => (ir.nodes[0].kind = "loop"),
		"/nodes/0/kind",
		'must be one of "code", "assert", "map", "seq", "repeat"',
		'Set /nodes/0/kind to one of "code", "assert", "map", "seq", "repeat"',
	],
	[
		"const names the required value",
		(ir) => (ir.result = { rule: "x" }),
		"/result/rule",
		'must be "default"',
		'Set /result/rule to "default"',
	],
	[
		"oneOf says no allowed shape matched",
		(ir) => (ir.result = { rule: "x" }),
		"/result",
		"must match exactly one of the allowed shapes",
		"Change /result to match ir.schema.json, which packages/ir/README.md describes",
	],
	[
		"anyOf says no allowed shape matched",
		(ir) => (ir.nodes[0].kind = "loop"),
		"/nodes/0/kind",
		"must match at least one of the allowed shapes",
		"Change /nodes/0/kind to match ir.schema.json, which packages/ir/README.md describes",
	],
	[
		"pattern names the pattern",
		(ir) => (ir.nodes[0].id = "a//b"),
		"/nodes/0/id",
		"must match the pattern '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$'",
		"Change /nodes/0/id to match '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$'",
	],
	[
		"type names the expected type",
		(ir) => (ir.nodes[0].label = 3),
		"/nodes/0/label",
		"must be of type string",
		"Set /nodes/0/label to a string",
	],
])(
	"schema diagnostics say in plain words: %s",
	(_, mutate, path, message, hint) => {
		expect(rejects(minimal, mutate)).toContainEqual(
			expect.objectContaining({ code: "IR.schema", path, message, hint }),
		);
	},
);

test.each<[string, Mutation, [string, string][]]>([
	[
		"an extra property on the worker",
		(ir) => (ir.nodes[0].worker.foo = 1),
		[["/nodes/0/worker", "has unexpected property 'foo'"]],
	],
	[
		"an extra property on the node and a bad codeHash",
		(ir) => {
			ir.nodes[0].foo = 1;
			ir.nodes[0].worker.codeHash = "sha256:0000";
		},
		[
			[
				"/nodes/0/worker/codeHash",
				"must match the pattern '^sha256:[0-9a-f]{64}$'",
			],
		],
	],
])(
	"schema diagnostics drop unexpected-property noise above an error: %s",
	(_, mutate, expected) => {
		expect(rejects(minimal, mutate).map((d) => [d.path, d.message])).toEqual(
			expected,
		);
	},
);

const SHA = `sha256:${"ab".repeat(32)}`;
const STDLIB = "maestro:stdlib";

const workerSites = [
	["a code node", minimal, "nodes/0/worker"],
	["a group key", guards, "nodes/1/key"],
] as const;

const setWorker =
	(site: string, module: string, codeHash: string): Mutation =>
	(ir) =>
		Object.assign(
			site.split("/").reduce((o, k) => o[k], ir),
			{ module, codeHash },
		);

describe.each(workerSites)("a worker reference on %s", (_, base, site) => {
	test.each([
		["a content hash", "w.ts", SHA],
		["a stdlib version", STDLIB, `${STDLIB}@1.2.3`],
		["a stdlib pre-release and build", STDLIB, `${STDLIB}@1.0.0-rc.1+b.5`],
	])("accepts %s", (_n, module, hash) => {
		const ir: Parameters<Mutation>[0] = structuredClone(base);
		setWorker(site, module, hash)(ir);
		expect(parseIr(ir)).toEqual({ ok: true, ir });
	});

	test.each([
		["a placeholder", "w.ts", "sha256:0000"],
		["uppercase hex", "w.ts", `sha256:${"AB".repeat(32)}`],
		["a missing prefix", "w.ts", "ab".repeat(32)],
		["a stdlib hash on another module", "w.ts", `${STDLIB}@1.2.3`],
		["a content hash on the stdlib module", STDLIB, SHA],
		["a non-semver stdlib version", STDLIB, `${STDLIB}@1.2`],
		["a leading-zero stdlib version", STDLIB, `${STDLIB}@01.2.3`],
	])("rejects %s", (_n, module, hash) => {
		const diagnostics = rejects(base, setWorker(site, module, hash));
		expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
			["IR.schema", `/${site}/codeHash`],
		]);
	});
});

const node = (ir: { nodes: { id: string }[] }, id: string) =>
	ir.nodes.find((n) => n.id === id) as never as Record<string, unknown>;

test.each<[string, Mutation, string, string, string, string]>([
	[
		"a duplicate id",
		(ir) => ir.scopes.push({ id: "pick", composition: "x", ports: {} }),
		"SCOPE.duplicate",
		"/scopes/1",
		"id 'pick' is used more than once",
		"Rename one of the entries with id 'pick' so each node and scope id is unique",
	],
	[
		"an unknown parent",
		(ir) => (node(ir, "pick").parent = "nowhere"),
		"IR.ref",
		"/nodes/2",
		"parent 'nowhere' is not a scope or a group node",
		"Declare 'nowhere' as a scope or as a map, seq or repeat node, or fix parent of 'pick'",
	],
	[
		"a parent that is not a group",
		(ir) => (node(ir, "refine/loop/done").parent = "pick"),
		"IR.ref",
		"/nodes/5",
		"parent 'pick' is not a scope or a group node",
		"Declare 'pick' as a scope or as a map, seq or repeat node, or fix parent of 'refine/loop/done'",
	],
	[
		"an edge from an unknown node",
		(ir) => (ir.edges[2].from.node = "ghost"),
		"IR.ref",
		"/edges/2",
		"edge refers to node 'ghost', which does not exist",
		"Declare node 'ghost' in nodes, or fix the edge",
	],
	[
		"an edge into an undeclared port",
		(ir) => (ir.edges[2].to.port = "txt"),
		"IR.ref",
		"/edges/2",
		"node 'refine/loop' has no input port 'txt'",
		"Declare 'txt' in in of node 'refine/loop', or fix the edge",
	],
	[
		"an edge from an undeclared port",
		(ir) => (ir.edges[2].from.port = "txt"),
		"IR.ref",
		"/edges/2",
		"node 'pick' has no output port 'txt'",
		"Declare 'txt' in out of node 'pick', or fix the edge",
	],
	[
		"a literal for an undeclared port",
		(ir) => (node(ir, "pick").literals = { mode: "first" }),
		"IR.ref",
		"/nodes/2",
		"node 'pick' has no input port 'mode'",
		"Declare 'mode' in in of node 'pick', or remove its literal",
	],
	[
		"a result rule naming an unknown node",
		(ir) => (ir.result = { rule: "node", node: "ghost" }),
		"IR.ref",
		"/result",
		"node 'ghost' does not exist",
		'Set result.node to a node declared in nodes, or use { "rule": "default" }',
	],
	[
		"a parent cycle",
		(ir) => (ir.scopes[0].parent = "refine/loop"),
		"IR.graph",
		"/scopes/0",
		"the parent chain of 'refine' loops back to it",
		"Remove or change parent on one id in the chain of 'refine'",
	],
	[
		"an unfed input port",
		(ir) => ir.edges.splice(2, 1),
		"IR.graph",
		"/nodes/3",
		"input port 'text' of node 'refine/loop' is not fed",
		"Feed port 'text' of node 'refine/loop' with an edge or a literal",
	],
	[
		"an input port fed twice",
		(ir) => (node(ir, "pick").literals = { drafts: [] }),
		"IR.graph",
		"/nodes/2",
		"input port 'drafts' of node 'pick' is fed more than once",
		"Feed port 'drafts' of node 'pick' with one edge or one literal, not several",
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
		"Pass the value out through an out port of group 'topics'",
	],
	[
		"an inner port read outside the body",
		(ir) => (ir.edges[2].from = { node: "topics", port: "item" }),
		"IR.ref",
		"/edges/2",
		"node 'topics' has no output port 'item'",
		"Declare 'item' in out of node 'topics', or fix the edge",
	],
	[
		"a collect edge that does not start at map results",
		(ir) => (ir.edges[2].kind = "collect"),
		"IR.graph",
		"/edges/2",
		"collect edge from 'pick' must start at a map node's 'results' port",
		"Start the edge at the 'results' port of a map node, or make it a data edge",
	],
	[
		"map results leaving through a data edge",
		(ir) => (ir.edges[1].kind = "data"),
		"IR.graph",
		"/edges/1",
		"results of map 'topics' must leave it through a collect edge",
		'Set the edge kind to "collect"',
	],
	[
		"a member outside the group body",
		(ir) => (node(ir, "topics").members = { result: "pick" }),
		"IR.graph",
		"/nodes/0",
		"member 'pick' is not in the body of group 'topics'",
		"Set parent of 'pick' to 'topics', or fix the member of the group",
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
		"Keep exactly one entry in members of 'refine/loop'",
	],
	[
		"a stop condition outside the group body",
		(ir) => (node(ir, "refine/loop").until = { node: "pick", port: "text" }),
		"IR.graph",
		"/nodes/3",
		"until 'pick' is not in the body of group 'refine/loop'",
		"Set parent of 'pick' to 'refine/loop', or fix the until of the group",
	],
	[
		"map ports other than item and results",
		(ir) =>
			((node(ir, "topics").out as object as Record<string, object>).extra = {}),
		"IR.graph",
		"/nodes/0",
		"map 'topics' must declare out ports [results], got [extra, results]",
		"Declare exactly the out ports [results] on 'topics'",
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
		"Declare exactly the inner ports [index, notes, text] on 'refine/loop'",
	],
	[
		"literal items with an items port",
		(ir) => (node(ir, "topics").in = { items: {} }),
		"IR.graph",
		"/nodes/0",
		"map 'topics' must declare in ports [], got [items]",
		"Declare exactly the in ports [] on 'topics'",
	],
	[
		"an exact cardinality that disagrees with the items",
		(ir) => (node(ir, "topics").cardinality = { exact: 2 }),
		"IR.graph",
		"/nodes/0",
		"map 'topics' must declare cardinality { exact: 3 }",
		"Set cardinality of 'topics' to { exact: 3 }",
	],
	[
		"an exact cardinality on a loop",
		(ir) => (node(ir, "refine/loop").cardinality = { exact: 2 }),
		"IR.graph",
		"/nodes/3",
		"repeat 'refine/loop' must declare cardinality { upTo: N }",
		"Set cardinality of 'refine/loop' to { upTo: N }",
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
		"Remove one of the edges in the cycle",
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
		"Remove one of the edges in the cycle",
	],
	[
		"a result node inside a group body",
		(ir) => (ir.result = { rule: "node", node: "topics/draft" }),
		"IR.graph",
		"/result",
		"result node 'topics/draft' is inside a group body",
		"Point result.node at a node outside every group body, such as its group 'topics'",
	],
])("the graph check rejects %s", (_, mutate, code, path, message, hint) => {
	expect(rejects(fanoutFaninLoop, mutate)).toContainEqual(
		expect.objectContaining({ code, path, message, hint }),
	);
});

test.each<[string, object, Mutation, string, string | undefined]>([
	[
		"a schema error inside a node",
		minimal,
		(ir) => (ir.nodes[0].kind = "loop"),
		"/nodes/0/kind",
		minimal.nodes[0]?.id,
	],
	[
		"a schema error on a node's unreadable id",
		minimal,
		(ir) => (ir.nodes[0].id = 3),
		"/nodes/0/id",
		undefined,
	],
	[
		"a graph error on a node",
		fanoutFaninLoop,
		(ir) => ir.edges.splice(2, 1),
		"/nodes/3",
		"refine/loop",
	],
	[
		"a graph error on a scope",
		fanoutFaninLoop,
		(ir) => (ir.scopes[0].parent = "refine/loop"),
		"/scopes/0",
		undefined,
	],
])(
	"a diagnostic names the node its path points into: %s",
	(_, base, mutate, path, node) => {
		const found = rejects(base, mutate).filter((d) => d.path === path);
		expect(found).not.toEqual([]);
		for (const d of found) expect(d.node).toBe(node);
	},
);

const withVersion = (irVersion: unknown) => ({ ...minimal, irVersion });

test("an unknown major version is rejected with a clear error", () => {
	expect(parseIr(withVersion("2.0"))).toEqual({
		ok: false,
		diagnostics: [
			{
				code: "IR.version",
				severity: "error",
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
