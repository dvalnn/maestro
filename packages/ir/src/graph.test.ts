import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
	type GraphIndex,
	type Ir,
	indexGraph,
	outputValue,
	parseIr,
} from "./index";

const fixturesDir = `${import.meta.dir}/../fixtures`;
const fixtureFiles = readdirSync(fixturesDir).filter((f) =>
	f.endsWith(".json"),
);

async function fixture(name: string): Promise<[Ir, GraphIndex]> {
	const parsed = parseIr(await Bun.file(`${fixturesDir}/${name}`).json());
	if (!parsed.ok) throw new Error(`${name} is not valid IR`);
	return [parsed.ir, indexGraph(parsed.ir)];
}

const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);
const sorted = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).toSorted();

test.each(fixtureFiles)(
	"%s: every node sits in exactly one body or at the top level",
	async (file) => {
		const [ir, index] = await fixture(file);
		const topLevel = ir.nodes.filter((n) => index.groupsOf(n.id).length === 0);
		const inBodies = [...index.nodes.values()]
			.filter(
				(n) => n.kind === "map" || n.kind === "seq" || n.kind === "repeat",
			)
			.flatMap((g) => index.body(g.id));
		expect(ids([...topLevel, ...inBodies]).toSorted()).toEqual(
			ids(ir.nodes).toSorted(),
		);
	},
);

test.each(fixtureFiles)(
	"%s: every edge is indexed from its source and into its target",
	async (file) => {
		const [ir, index] = await fixture(file);
		for (const n of ir.nodes) expect(index.nodes.get(n.id)).toBe(n);
		const from = ir.nodes.flatMap((n) => index.edgesFrom(n.id));
		const into = ir.nodes.flatMap((n) => index.edgesInto(n.id));
		expect(sorted(from)).toEqual(sorted(ir.edges));
		expect(sorted(into)).toEqual(sorted(ir.edges));
	},
);

test("ancestors include scopes, and enclosing groups leave them out", async () => {
	const [, index] = await fixture("fanout-fanin-loop.json");
	expect(index.parent("refine/loop/step")).toBe("refine/loop");
	expect(index.parent("refine/loop")).toBe("refine");
	expect(index.scopes.get("refine")?.composition).toBeString();
	expect(index.ancestors("refine/loop/step")).toEqual([
		"refine/loop",
		"refine",
	]);
	expect(index.groupsOf("refine/loop/step")).toEqual(["refine/loop"]);
	expect(index.groupsOf("refine/loop")).toEqual([]);
});

test("a nested group's body is its own, not its enclosing group's", async () => {
	const [, index] = await fixture("nested-groups.json");
	expect(index.groupsOf("angles/polish/step")).toEqual([
		"angles",
		"angles/polish",
	]);
	expect(ids(index.body("angles"))).toEqual([
		"angles/draft",
		"angles/polish",
		"angles/critique",
	]);
	expect(ids(index.body("angles/polish"))).toEqual(["angles/polish/step"]);
	expect(index.body("tally")).toEqual([]);
});

test("edges into and out of a node, every kind included", async () => {
	const [, index] = await fixture("guards-and-escalation.json");
	expect(index.edgesInto("summary")).toEqual([
		{
			kind: "data",
			from: { node: "escalate", port: "text" },
			to: { node: "summary", port: "text" },
		},
		{
			kind: "control",
			from: { node: "gate" },
			to: { node: "summary" },
			tolerate: "rejected",
		},
	]);
	expect(index.edgesFrom("escalate").map((e) => e.to.node)).toEqual([
		"escalate/try",
		"gate",
		"gate",
		"summary",
	]);
});

test("an unknown id resolves to nothing", async () => {
	const [, index] = await fixture("minimal.json");
	expect(index.nodes.get("ghost")).toBeUndefined();
	expect(index.parent("ghost")).toBeUndefined();
	expect(index.ancestors("ghost")).toEqual([]);
	expect(index.groupsOf("ghost")).toEqual([]);
	expect(index.body("ghost")).toEqual([]);
	expect(index.edgesInto("ghost")).toEqual([]);
	expect(index.edgesFrom("ghost")).toEqual([]);
});

test.each<[{ outcome: "ok" | "rejected"; reason?: string }, string, unknown]>([
	[{ outcome: "ok" }, "outcome", "ok"],
	[{ outcome: "ok" }, "ok", true],
	[{ outcome: "ok", reason: "stale" }, "reason", undefined],
	[{ outcome: "ok" }, "text", "a"],
	[{ outcome: "rejected", reason: "no" }, "ok", false],
	[{ outcome: "rejected", reason: "no" }, "reason", "no"],
])("outputValue of %j at '%s' is %j", (settled, port, value) => {
	expect(outputValue(settled, { text: "a" }, port)).toEqual(value);
});
