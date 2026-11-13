import { describe, expect, test } from "bun:test";
import {
	type IrEdge,
	type IrNode,
	type Plan,
	type PortRef,
	STDLIB_MODULE,
} from "@maestro/ir";
import { flow } from "./index";

const worker = (module: string, exported: string) => ({
	runtime: "ts",
	module,
	export: exported,
	codeHash: "sha256:0",
});

const code = (id: string): IrNode => ({
	id,
	kind: "code",
	worker: worker("m.ts", id.slice(id.lastIndexOf("/") + 1)),
});

const agent = (id: string): IrNode => ({ id, kind: "h.agent" });

const helper = (
	id: string,
	exported: string,
	literals?: Record<string, unknown>,
): IrNode => ({
	id,
	kind: "code",
	worker: worker(STDLIB_MODULE, exported),
	...(literals ? { literals } : {}),
});

const data = (from: string, to: string, port = "value"): IrEdge => ({
	kind: "data",
	from: { node: from, port },
	to: { node: to, port },
});

const guard = (from: string, port: string, to: string): IrEdge => ({
	kind: "control",
	from: { node: from, port },
	to: { node: to },
});

const collect = (from: string, to: string): IrEdge => ({
	kind: "collect",
	from: { node: from, port: "value" },
	to: { node: to, port: "results" },
});

const body = (id: string, member: string) => ({
	id,
	inner: {},
	members: { value: member },
	cardinality: { exact: 1 },
});

const items = (kind: "parMap" | "map", id: string, member: string): IrNode => ({
	...body(id, member),
	kind,
	onError: "stop",
});

const loop = (id: string, upTo: number, test: PortRef): IrNode => ({
	...body(id, test.node),
	kind: "loop",
	cardinality: { upTo },
	test: { at: "end", port: test },
});

const planOf = (
	nodes: IrNode[],
	edges: IrEdge[],
	result: string,
	expansion: Plan["expansion"] = {},
): Plan => ({
	ir: {
		irVersion: "1.2",
		composition: { id: "c", version: "0.1.0", pack: "p" },
		emitter: { name: "hand", version: "1" },
		scopes: [],
		nodes,
		edges,
		result: { node: result },
	},
	expansion,
	bounds: { instances: { exact: 1 }, nodes: {}, counts: {} },
	diagnostics: [],
});

const lines = (plan: Plan) => flow(plan).split("\n");

describe("flow", () => {
	test("contracts a stdlib chain and labels its guard with the condition it computes", () => {
		const plan = planOf(
			[
				agent("triager"),
				helper("verdict", "get", { path: "verdict" }),
				helper("planned", "lookup", { table: { plan: true, skip: false } }),
				agent("planner"),
			],
			[
				data("triager", "verdict", "ruling"),
				data("verdict", "planned", "key"),
				guard("planned", "value", "planner"),
			],
			"planner",
		);
		expect(flow(plan)).toBe(
			[
				"flowchart TD",
				"  start((start))",
				'  n0["triager<br/><small>agent</small>"]',
				'  n3["planner<br/><small>agent</small>"]',
				"  stop(((end)))",
				'  n0 -.->|"ruling.verdict is plan"| n3',
				"  start --> n0",
				"  n3 --> stop",
			].join("\n"),
		);
	});

	test("labels a guard through `not` and a guard on a node's own port", () => {
		const plan = planOf(
			[
				agent("lens"),
				helper("clean", "get", { path: "clean" }),
				helper("dirty", "not"),
				agent("skeptic"),
				code("trace"),
				code("result"),
			],
			[
				data("lens", "clean", "findings"),
				data("clean", "dirty"),
				guard("dirty", "value", "skeptic"),
				guard("trace", "ok", "result"),
			],
			"result",
		);
		expect(lines(plan)).toContain('  n0 -.->|"not findings.clean"| n3');
		expect(lines(plan)).toContain('  n4 -.->|"ok"| n5');
	});

	test("lifts an edge into a group's body to the group, and drops the group's edges to its own body", () => {
		const plan = planOf(
			[code("plan"), items("map", "each", "each/work"), code("each/work")],
			[data("plan", "each/work", "spec"), data("each", "each/work", "item")],
			"each",
		);
		const drawn = lines(plan);
		expect(drawn).toContain("  n0 --> n1");
		expect(drawn).toContain('  subgraph n1["each · map ×1"]');
		expect(drawn.filter((l) => l.includes("--> n2"))).toEqual([]);
		expect(drawn).toContain("  n1 --> stop");
	});

	test("drops a transitive plain edge and keeps a guard and a collect edge on a reducible pair", () => {
		const plan = planOf(
			[code("a"), code("b"), code("c"), code("d")],
			[
				data("a", "b"),
				data("b", "c"),
				data("a", "c"),
				data("c", "d"),
				guard("b", "go", "d"),
				collect("b", "d"),
				data("b", "d"),
			],
			"d",
		);
		const edges = lines(plan).filter((l) => /-->|==>|---|-\.->/.test(l));
		expect(edges).toEqual([
			"  n0 --> n1",
			"  n1 --- fn1",
			"  fn1 --> n2",
			"  n2 --> jn3",
			"  jn3 --> n3",
			'  n1 -.->|"go"| n3',
			"  fn1 ==> jn3",
			"  start --> n0",
			"  n3 --> stop",
		]);
	});

	test("puts bars on two plain out-edges and none on two guards", () => {
		const barred = planOf(
			[code("a"), code("b"), code("c")],
			[data("a", "b"), data("a", "c")],
			"b",
		);
		expect(lines(barred)).toContain('  fn0@{ shape: fork, label: " " }');
		expect(lines(barred)).toContain("  fn0 --> n2");
		const guarded = planOf(
			[code("a"), code("b"), code("c")],
			[guard("a", "yes", "b"), guard("a", "no", "c")],
			"b",
		);
		expect(flow(guarded)).not.toContain("shape: fork");
		expect(lines(guarded)).toContain('  n0 -.->|"no"| n2');
	});

	test("draws a loop's back edge with its test and a parMap's count in its title", () => {
		const plan = planOf(
			[
				items("parMap", "scouts", "scouts/scout"),
				agent("scouts/scout"),
				loop("fixes", 2, { node: "fixes/again", port: "value" }),
				agent("fixes/fix"),
				code("fixes/check"),
				helper("fixes/ok", "get", { path: "ok" }),
				helper("fixes/again", "not"),
			],
			[
				data("scouts", "fixes/fix"),
				data("fixes/fix", "fixes/check"),
				data("fixes/check", "fixes/ok", "verdict"),
				data("fixes/ok", "fixes/again"),
			],
			"fixes",
			{ scouts: { "": { keys: ["a", "b", "c"] } } },
		);
		const drawn = lines(plan);
		expect(drawn).toContain('  subgraph n0["scouts · parMap ×3"]');
		expect(drawn).toContain('  subgraph n2["fixes · loop ≤2 rounds"]');
		expect(drawn).toContain('  n4 -.->|"next while not verdict.ok"| n3');
		expect(drawn).toContain("  start --> n0");
		expect(drawn).toContain("  n2 --> stop");
	});

	test("draws an assert as a decision and drops a group's name when it is its kind", () => {
		const plan = planOf(
			[
				loop("loop", 3, { node: "loop/gate", port: "again" }),
				{ id: "loop/gate", kind: "assert", message: "m", onFail: "rejected" },
			],
			[],
			"loop",
		);
		const drawn = lines(plan);
		expect(drawn).toContain('  subgraph n0["loop ≤3 rounds"]');
		expect(drawn).toContain('    n1{"gate<br/><small>assert</small>"}');
		expect(drawn).toContain('  n1 -.->|"next while again"| n1');
	});

	test("finds helpers by the stdlib module: another stdlib export is contracted with its label passed through, a pack's `get` stays", () => {
		const plan = planOf(
			[
				agent("lens"),
				helper("lens_json_findings", "readJson"),
				helper("clean", "get", { path: "clean" }),
				code("own/get"),
				agent("skeptic"),
			],
			[
				data("lens", "lens_json_findings", "file"),
				data("lens_json_findings", "clean"),
				data("clean", "own/get"),
				guard("own/get", "value", "skeptic"),
				guard("clean", "value", "skeptic"),
			],
			"skeptic",
		);
		const drawn = lines(plan);
		expect(drawn).toContain('  n3["get<br/><small>code</small>"]');
		expect(drawn).toContain('  n0 -.->|"file.clean"| n4');
		expect(drawn).toContain('  n3 -.->|"value"| n4');
		expect(flow(plan)).not.toContain("readJson");
	});

	test("draws a fold's back edge as `next`, and none for a map, find or parMap", () => {
		const step = (id: string) => [code(`${id}/a`), code(`${id}/b`)];
		const chain = (id: string) => data(`${id}/a`, `${id}/b`);
		const plan = planOf(
			[
				{
					...body("acc", "acc/b"),
					kind: "fold",
					members: { first: "acc/a", step: "acc/b" },
					first: ["acc/a"],
				},
				...step("acc"),
				items("map", "each", "each/b"),
				...step("each"),
				items("parMap", "par", "par/b"),
				...step("par"),
				{
					...body("seek", "seek/b"),
					kind: "find",
					cond: { node: "seek/b", port: "ok" },
				},
				...step("seek"),
			],
			[chain("acc"), chain("each"), chain("par"), chain("seek")],
			"acc",
		);
		const back = lines(plan).filter((l) => l.includes("-.->"));
		expect(back).toEqual(['  n2 -.->|"next"| n1']);
	});
});
