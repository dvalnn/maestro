import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import fanoutFaninLoop from "../fixtures/fanout-fanin-loop.json";
import guards from "../fixtures/guards-and-escalation.json";
import minimal from "../fixtures/minimal.json";
import { IR_VERSION, irSchema, MAX_TIMEOUT, parseIr } from "./index";

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
		(ir) => (ir.nodes[0].kind = "repeat"),
		"/nodes/0/kind",
	],
	[
		"a core field on the wrong kind",
		(ir) => (ir.nodes[0].onFail = "failed"),
		"/nodes/0",
	],
	["an unknown top-level field", (ir) => (ir.extra = 1), "/"],
	[
		"a result rule",
		(ir) => (ir.result = { rule: "node", node: "greet" }),
		"/result",
	],
	["a params block", (ir) => (ir.params = { schema: {}, examples: [{}] }), "/"],
	["a code node's purity", (ir) => (ir.nodes[0].pure = true), "/nodes/0"],
	[
		"a group with no members",
		(ir) =>
			(ir.nodes[0] = {
				id: "g",
				kind: "parMap",
				inner: {},
				members: {},
				cardinality: { upTo: 1 },
				onError: "continue",
			}),
		"/nodes/0/members",
	],
	["a bad node id", (ir) => (ir.nodes[0].id = "a//b"), "/nodes/0/id"],
	["a timeout of 0", (ir) => (ir.nodes[0].timeout = 0), "/nodes/0/timeout"],
	[
		"a fractional timeout",
		(ir) => (ir.nodes[0].timeout = 1.5),
		"/nodes/0/timeout",
	],
	[
		"a timeout past the longest timer",
		(ir) => (ir.nodes[0].timeout = MAX_TIMEOUT + 1),
		"/nodes/0/timeout",
	],
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
		(ir) => (ir.nodes[0].kind = "repeat"),
		"/nodes/0/kind",
		'must be one of "code", "assert", "parMap", "map", "find", "parFind", "fold", "loop"',
		'Set /nodes/0/kind to one of "code", "assert", "parMap", "map", "find", "parFind", "fold", "loop"',
	],
	[
		"const names the required value",
		(ir) =>
			(ir.edges = [
				{
					kind: "control",
					from: { node: "greet" },
					to: { node: "greet" },
					tolerate: "x",
				},
			]),
		"/edges/0/tolerate",
		'must be "rejected"',
		'Set /edges/0/tolerate to "rejected"',
	],
	[
		"oneOf says no allowed shape matched",
		(ir) => {
			ir.nodes[0].kind = "parMap";
			ir.nodes[0].cardinality = { exact: 1, upTo: 1 };
		},
		"/nodes/0/cardinality",
		"must match exactly one of the allowed shapes",
		"Change /nodes/0/cardinality to match ir.schema.json, which packages/ir/README.md describes",
	],
	[
		"anyOf says no allowed shape matched",
		(ir) => (ir.nodes[0].kind = "repeat"),
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
		(ir) => (ir.nodes[0].id = 3),
		"/nodes/0/id",
		"must be of type string",
		"Set /nodes/0/id to a string",
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
		(ir) => ir.scopes.push({ id: "best", composition: "x", ports: {} }),
		"SCOPE.duplicate",
		"/scopes/1",
		"id 'best' is used more than once",
		"Rename one of the entries with id 'best' so each node and scope id is unique",
	],
	[
		"a scope under an undeclared id",
		(ir) => ir.scopes.push({ id: "nowhere/s", composition: "x", ports: {} }),
		"IR.graph",
		"/scopes/1",
		"id 'nowhere/s' sits under 'nowhere', which is not a scope or a group node",
		"Declare 'nowhere' as a scope or a group node, or move 'nowhere/s' out of it",
	],
	[
		"a node under a node that is not a group",
		(ir) => ir.nodes.push({ id: "best/extra", kind: "fake.task" }),
		"IR.graph",
		"/nodes/8",
		"id 'best/extra' sits under 'best', which is not a scope or a group node",
		"Declare 'best' as a scope or a group node, or move 'best/extra' out of it",
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
		"node 'text' has no output port 'txt'",
		"Declare 'txt' in out of node 'text', or fix the edge",
	],
	[
		"a literal for an undeclared port",
		(ir) => (node(ir, "best").literals = { mode: "first" }),
		"IR.ref",
		"/nodes/2",
		"node 'best' has no input port 'mode'",
		"Declare 'mode' in in of node 'best', or remove its literal",
	],
	[
		"a result naming an unknown node",
		(ir) => (ir.result = { node: "ghost" }),
		"IR.ref",
		"/result",
		"node 'ghost' does not exist",
		"Set result.node to a node declared in nodes",
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
		(ir) => (node(ir, "best").literals = { results: [] }),
		"IR.graph",
		"/nodes/2",
		"input port 'results' of node 'best' is fed more than once",
		"Feed port 'results' of node 'best' with one edge or one literal, not several",
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
		"a collect edge that does not start at parMap results",
		(ir) => (ir.edges[2].kind = "collect"),
		"IR.graph",
		"/edges/2",
		"collect edge from 'text' must start at a parMap or map node's 'results' port",
		"Start the edge at the 'results' port of a parMap or map node, or make it a data edge",
	],
	[
		"parMap results leaving through a data edge",
		(ir) => (ir.edges[1].kind = "data"),
		"IR.graph",
		"/edges/1",
		"results of parMap 'topics' must leave it through a collect edge",
		'Set the edge kind to "collect"',
	],
	[
		"a member outside the group body",
		(ir) => (node(ir, "topics").members = { result: "best" }),
		"IR.graph",
		"/nodes/0",
		"member 'best' is not in the body of group 'topics'",
		"Give 'best' an id directly under 'topics/', or fix the member of the group",
	],
	[
		"a loop with two members",
		(ir) =>
			(node(ir, "refine/loop").members = {
				a: "refine/loop/step",
				b: "refine/loop/done",
			}),
		"IR.graph",
		"/nodes/3",
		`loop 'refine/loop' must have exactly one member in IR ${IR_VERSION}, got 2`,
		"Keep exactly one entry in members of 'refine/loop'",
	],
	[
		"a test outside the group body",
		(ir) =>
			(node(ir, "refine/loop").test = {
				at: "end",
				port: { node: "best", port: "value" },
			}),
		"IR.graph",
		"/nodes/3",
		"test 'best' is not in the body of group 'refine/loop'",
		"Give 'best' an id directly under 'refine/loop/', or fix the test of the group",
	],
	[
		"a test on a port that is not a boolean",
		(ir) =>
			(node(ir, "refine/loop").test = {
				at: "end",
				port: { node: "refine/loop/step", port: "text" },
			}),
		"IR.graph",
		"/nodes/3",
		"test 'refine/loop/step.text' of group 'refine/loop' is not a boolean port",
		"Point test of 'refine/loop' at a port whose schema has type boolean",
	],
	[
		"a test at end on a state port",
		(ir) =>
			(node(ir, "refine/loop").test = {
				at: "end",
				port: { node: "refine/loop", port: "ok" },
			}),
		"IR.graph",
		"/nodes/3",
		"test 'refine/loop.ok' of loop 'refine/loop' reads the loop state, but a test at end reads a body node",
		`Point test of 'refine/loop' at a body node, or set test.at to "start"`,
	],
	[
		"a test at start on a state port that is not a boolean",
		(ir) =>
			(node(ir, "refine/loop").test = {
				at: "start",
				port: { node: "refine/loop", port: "index" },
			}),
		"IR.graph",
		"/nodes/3",
		"test 'refine/loop.index' of group 'refine/loop' is not a boolean port",
		"Point test of 'refine/loop' at a port whose schema has type boolean",
	],
	[
		"a test at start that reads the member through another body node",
		(ir) => (ir.edges[4].from.node = "refine/loop/step"),
		"IR.graph",
		"/nodes/3",
		"test 'refine/loop/more' of loop 'refine/loop' reads its member 'refine/loop/step', but a test at start reads only the loop state",
		`Feed 'refine/loop/more' from the inner ports of 'refine/loop', or set test.at to "end"`,
	],
	[
		"a test at start that reads the member through a nested group",
		(ir) => {
			const text = { type: "string" };
			ir.nodes.push(
				{
					id: "refine/loop/inner",
					kind: "loop",
					cardinality: { upTo: 1 },
					in: { text },
					inner: {
						ok: { type: "boolean" },
						reason: text,
						index: { type: "integer" },
						text,
					},
					out: { text },
					members: { result: "refine/loop/inner/s" },
					test: {
						at: "end",
						port: { node: "refine/loop/inner/s", port: "ok" },
					},
				},
				{
					id: "refine/loop/inner/s",
					kind: "fake.task",
					in: { prompt: text },
					out: { text },
				},
			);
			ir.edges.push(
				{
					kind: "data",
					from: { node: "refine/loop", port: "text" },
					to: { node: "refine/loop/inner", port: "text" },
				},
				{
					kind: "data",
					from: { node: "refine/loop/step", port: "text" },
					to: { node: "refine/loop/inner/s", port: "prompt" },
				},
			);
			ir.edges[5].from = { node: "refine/loop/inner", port: "ok" };
		},
		"IR.graph",
		"/nodes/3",
		"test 'refine/loop/more' of loop 'refine/loop' reads its member 'refine/loop/step', but a test at start reads only the loop state",
		`Feed 'refine/loop/more' from the inner ports of 'refine/loop', or set test.at to "end"`,
	],
	[
		"parMap ports other than item and results",
		(ir) =>
			((node(ir, "topics").out as object as Record<string, object>).extra = {}),
		"IR.graph",
		"/nodes/0",
		"parMap 'topics' must declare out ports [results], got [extra, results]",
		"Declare exactly the out ports [results] on 'topics'",
	],
	[
		"loop state ports that do not mirror the member",
		(ir) =>
			((
				node(ir, "refine/loop/step").out as object as Record<string, object>
			).notes = {}),
		"IR.graph",
		"/nodes/3",
		"loop 'refine/loop' must declare inner ports [index, notes, ok, reason, text], got [index, ok, reason, text]",
		"Declare exactly the inner ports [index, notes, ok, reason, text] on 'refine/loop'",
	],
	[
		"literal items with an items port",
		(ir) => (node(ir, "topics").in = { items: {} }),
		"IR.graph",
		"/nodes/0",
		"parMap 'topics' must declare in ports [], got [items]",
		"Declare exactly the in ports [] on 'topics'",
	],
	[
		"an exact cardinality that disagrees with the items",
		(ir) => (node(ir, "topics").cardinality = { exact: 2 }),
		"IR.graph",
		"/nodes/0",
		"parMap 'topics' must declare cardinality { exact: 3 }",
		"Set cardinality of 'topics' to { exact: 3 }",
	],
	[
		"an exact cardinality on a loop",
		(ir) => (node(ir, "refine/loop").cardinality = { exact: 2 }),
		"IR.graph",
		"/nodes/3",
		"loop 'refine/loop' must declare cardinality { upTo: N }",
		"Set cardinality of 'refine/loop' to { upTo: N }",
	],
	[
		"a cycle",
		(ir) =>
			ir.edges.push({
				kind: "control",
				from: { node: "refine/loop" },
				to: { node: "best" },
			}),
		"IR.graph",
		"/edges",
		"edges form a cycle: best -> text -> refine/loop -> best",
		"Remove one of the edges in the cycle",
	],
	[
		"a cycle through a group body",
		(ir) =>
			ir.edges.push({
				kind: "control",
				from: { node: "best" },
				to: { node: "topics/draft" },
			}),
		"IR.graph",
		"/edges",
		"edges form a cycle: topics -> best -> topics",
		"Remove one of the edges in the cycle",
	],
	[
		"a result node inside a group body",
		(ir) => (ir.result = { node: "topics/draft" }),
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
		(ir) => (ir.nodes[0].kind = "repeat"),
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
		(ir) => ir.scopes.push({ id: "best/s", composition: "x", ports: {} }),
		"/scopes/1",
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
			"IR version 1.7 is newer than this maestro reads (1.1). It was emitted by a newer SDK, for example one bundled in a pack",
		);
		expect(result.diagnostics[0]?.hint).toBe(
			"Upgrade maestro to a version that reads IR 1.7, or re-emit the IR with an SDK that targets IR 1.1",
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

test("a code node may carry a timeout of whole milliseconds", () => {
	for (const timeout of [1, MAX_TIMEOUT]) {
		const node = { ...minimal.nodes[0], timeout };
		expect(parseIr({ ...minimal, nodes: [node] }).ok).toBe(true);
	}
});

test("the schema accepts exactly the versions this reader reads, 1.0 among them", () => {
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
			"fan-out: parMap topics, exactly 3 members, each result=topics/draft",
			"loop: refine/loop, up to 2 iterations, each result=refine/loop/step, tested at start on refine/loop/more.value, tolerating rejected",
			"fan-in: topics.results -> best.results (reducer)",
			"order: topics -> best -> text -> refine/loop",
			"",
		].join("\n"),
	);
});

describe("a fold", () => {
	const text = { type: "string" };
	const fold = {
		irVersion: IR_VERSION,
		composition: { id: "merge", version: "0.1.0", pack: "fixtures" },
		emitter: { name: "hand", version: "1" },
		scopes: [],
		nodes: [
			{
				id: "fold",
				kind: "fold",
				items: ["a", "b"],
				cardinality: { upTo: 2 },
				inner: {
					item: text,
					index: { type: "integer" },
					ok: { type: "boolean" },
					reason: text,
					text,
				},
				out: { text },
				members: { first: "fold/first/seed", step: "fold/step/add" },
				first: ["fold/first/seed"],
			},
			{
				id: "fold/first/seed",
				kind: "fake.task",
				in: { prompt: text },
				out: { text },
			},
			{
				id: "fold/step/add",
				kind: "fake.task",
				in: { prompt: text, acc: text },
				out: { text },
			},
		],
		edges: [
			{
				kind: "data",
				from: { node: "fold", port: "item" },
				to: { node: "fold/first/seed", port: "prompt" },
			},
			{
				kind: "data",
				from: { node: "fold", port: "item" },
				to: { node: "fold/step/add", port: "prompt" },
			},
			{
				kind: "data",
				from: { node: "fold", port: "text" },
				to: { node: "fold/step/add", port: "acc" },
			},
		],
		result: { node: "fold" },
	};

	test("is accepted with a first and a step member", () => {
		expect(parseIr(fold).ok).toBe(true);
	});

	test.each<[string, Mutation, string]>([
		[
			"a step member",
			(ir) => delete ir.nodes[0].members.step,
			"/nodes/0/members",
		],
		["its first phase", (ir) => delete ir.nodes[0].first, "/nodes/0"],
	])("without %s fails the shape check", (_, mutate, at) => {
		const diagnostics = rejects(fold, mutate);
		expect(diagnostics.map((d) => [d.code, d.path])).toContainEqual([
			"IR.schema",
			at,
		]);
	});

	test.each<[string, Mutation, string, string]>([
		[
			"a first phase that reads the accumulator",
			(ir) => (ir.edges[0].from.port = "text"),
			"'fold/first/seed' reads 'fold.text', but the first phase of fold 'fold' has no accumulator",
			"Feed 'fold/first/seed' from the item, or move it to the step of 'fold'",
		],
		[
			"a step that reads the first phase",
			(ir) => (ir.edges[2].from = { node: "fold/first/seed", port: "text" }),
			"'fold/step/add' of fold 'fold' reads 'fold/first/seed' of its first phase, which takes a different item",
			"Build the step of 'fold' from the accumulator and the item alone",
		],
		[
			"a first phase that lists the step",
			(ir) => ir.nodes[0].first.push("fold/step/add"),
			"first of fold 'fold' must list its member 'fold/first/seed' and not its member 'fold/step/add'",
			"List in first of 'fold' the body nodes made from the first item",
		],
		[
			"members whose out ports differ",
			(ir) => (ir.nodes[1].out = { text, notes: text }),
			"members of fold 'fold' must declare the same out ports, got first [notes, text] and step [text]",
			"Give 'fold/first/seed' and 'fold/step/add' the same out ports",
		],
	])("rejects %s", (_, mutate, message, hint) => {
		expect(rejects(fold, mutate)).toContainEqual(
			expect.objectContaining({
				code: "IR.graph",
				path: "/nodes/0",
				message,
				hint,
			}),
		);
	});
});

test.each(["find", "parFind"])(
	"a %s without cond fails the shape check",
	(kind) => {
		const diagnostics = rejects(guards, (ir) => {
			ir.nodes[4].kind = kind;
			delete ir.nodes[4].cond;
		});
		expect(diagnostics.map((d) => [d.code, d.path])).toContainEqual([
			"IR.schema",
			"/nodes/4",
		]);
	},
);
