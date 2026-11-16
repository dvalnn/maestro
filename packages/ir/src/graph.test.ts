import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
	formatExpansion,
	type GraphIndex,
	type Ir,
	indexGraph,
	isGroup,
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
			.filter(isGroup)
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
	[{ outcome: "ok" }, "outcome", undefined],
	[{ outcome: "ok" }, "ok", true],
	[{ outcome: "ok", reason: "stale" }, "reason", undefined],
	[{ outcome: "ok" }, "text", "a"],
	[{ outcome: "rejected", reason: "no" }, "ok", false],
	[{ outcome: "rejected", reason: "no" }, "reason", "no"],
])("outputValue of %j at '%s' is %j", (settled, port, value) => {
	expect(outputValue(settled, { text: "a" }, port)).toEqual(value);
});

test("the pack is the root composition's, for a node inside a subcomposition's scope too", async () => {
	const [ir, index] = await fixture("fanout-fanin-loop.json");
	expect(index.pack).toBe("fixtures");
	expect(index.compositionOf("refine/loop/step")).not.toBe(ir.composition.id);
});

test("instanceName keys each enclosing group of a nested instance", async () => {
	const [, index] = await fixture("nested-groups.json");
	expect(
		index.instanceName({
			node: "angles/polish/step",
			expansion: "[risk][2]",
		}),
	).toBe("angles[risk]/polish[2]/step");
});

test("instanceName leaves a node outside every group unkeyed", async () => {
	const [, index] = await fixture("nested-groups.json");
	expect(index.instanceName({ node: "angles", expansion: "" })).toBe("angles");
	expect(index.instanceName({ node: "ghost", expansion: "" })).toBe("ghost");
});

test("instanceName throws on an expansion without one key per group", async () => {
	const [, index] = await fixture("nested-groups.json");
	expect(() =>
		index.instanceName({ node: "angles/polish/step", expansion: "[risk]" }),
	).toThrow();
	expect(() =>
		index.instanceName({ node: "angles/polish/step", expansion: "oops" }),
	).toThrow();
});

test("parseSelector reads back the node and keys instanceName shows", async () => {
	const [, index] = await fixture("nested-groups.json");
	const node = "angles/polish/step";
	for (const keys of [
		["risk", "2"],
		["", "x"],
	]) {
		const name = index.instanceName({ node, expansion: formatExpansion(keys) });
		expect(index.parseSelector(name)).toEqual({ node, keys });
	}
});

test("parseSelector takes a prefix selector as every instance under the first group key", async () => {
	const [, index] = await fixture("nested-groups.json");
	expect(index.parseSelector("angles[risk]/polish/step")).toEqual({
		node: "angles/polish/step",
		keys: ["risk"],
	});
	expect(index.parseSelector("angles/polish/step")).toEqual({
		node: "angles/polish/step",
		keys: [],
	});
});

test("parseSelector gives an unknown node id no keys, and refuses a misplaced key", async () => {
	const [, index] = await fixture("nested-groups.json");
	expect(index.parseSelector("ghost")).toEqual({ node: "ghost", keys: [] });
	expect(index.parseSelector("ghost[x]")).toBeUndefined();
	expect(index.parseSelector("angles/polish[2]/step")).toBeUndefined();
});
