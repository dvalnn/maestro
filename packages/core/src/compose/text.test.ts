import { describe, expect, test } from "bun:test";
import type { Ir } from "@maestro/ir";
import {
	code,
	composeWith,
	data,
	fakeHost,
	golden,
	irOf,
} from "./fixtures/support";
import type { ComposeInput } from "./index";
import { listing, render, summary } from "./index";

const planOf = async (ir: Ir, over: Partial<ComposeInput> = {}) => {
	const result = await composeWith(ir, over);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.plan;
};

/** A map named `id` over `items`, its body reading each item, with `over` merged on the map. */
const map = (id: string, items: string[], over: object = {}) => ({
	nodes: [
		code(`${id}/u`, "upper", { in: { name: { type: "string" } } }),
		{
			id,
			kind: "map",
			cardinality: { upTo: items.length },
			onError: "settle",
			literals: { items },
			in: { items: { type: "array", items: { type: "string" } } },
			inner: { item: { type: "string" } },
			out: { results: { type: "array" } },
			members: { r: `${id}/u` },
			...over,
		},
	],
	edges: [
		{
			kind: "data",
			from: { node: id, port: "item" },
			to: { node: `${id}/u`, port: "name" },
		},
	],
});

describe("text forms", () => {
	test("summary: instances, host counts and warnings in one line", async () => {
		const host = fakeHost({
			bounds: () => ({ calls: 1 }),
			validate: () => [
				{ code: "x", severity: "warning", message: "m", hint: "h" },
			],
		});
		expect(summary(await planOf(await golden("minimal.json")))).toBe(
			"minimal: 1 node instance",
		);
		expect(
			summary(
				await planOf(await golden("fanout-fanin-loop.json"), { hosts: [host] }),
			),
		).toBe(
			"fanout-fanin-loop: up to 11 node instances, up to 5 calls, 1 warning",
		);
	});

	test("listing: each node's count and expansions, then bounds", async () => {
		expect(listing(await planOf(await golden("minimal.json")))).toBe(
			[
				"minimal: 1 node instance",
				"nodes:",
				"  greet  code  1",
				"bounds:",
				"  instances  1",
			].join("\n"),
		);
		expect(listing(await planOf(await golden("nested-groups.json")))).toContain(
			"  angles/polish       repeat     2\n    angles[wide]/polish expands to up to 3\n",
		);
	});
});

describe("render (architecture 11)", () => {
	test("draws fan-out with its expansion, fan-in behind a collect barrier, a loop bound and a scope", async () => {
		const chart = render(await planOf(await golden("fanout-fanin-loop.json")));
		for (const line of [
			"flowchart TD",
			'  subgraph s0["refine"]',
			'      n3[["repeat<br/>up to 2"]]',
			'    n0[["map<br/>alpha, beta, gamma"]]',
			'    n1(["draft<br/>fake.task"])',
			'  n2[/"pick<br/>fan-in firstOk"/]',
			'  n0 -->|"item to prompt"| n1',
			'  n0 ==>|"collect"| n2',
		])
			expect(chart.split("\n")).toContain(line);
	});

	test("marks start and end, merges parallel data edges, loops a repeat back and shows each header fact once", async () => {
		const items = map("map", ["cats", "dogs", "owls"]);
		const chart = render(
			await planOf(
				irOf(
					[
						...items.nodes,
						code("gather", "gather", {
							fanin: true,
							in: { results: { type: "array" } },
						}),
						code("repeat/polish", "polish", {
							in: { round: { type: "integer" }, text: { type: "string" } },
						}),
						{
							id: "repeat",
							kind: "repeat",
							cardinality: { upTo: 3 },
							in: { text: { type: "string" } },
							inner: { index: { type: "integer" }, text: { type: "string" } },
							out: { text: { type: "string" } },
							members: { result: "repeat/polish" },
						},
						code("publish", "publish", { in: { text: { type: "string" } } }),
					],
					[
						...items.edges,
						{
							kind: "collect",
							from: { node: "map", port: "results" },
							to: { node: "gather", port: "results" },
						},
						{
							kind: "data",
							from: { node: "gather", port: "text" },
							to: { node: "repeat", port: "text" },
						},
						data("repeat", "repeat/polish"),
						{
							kind: "data",
							from: { node: "repeat", port: "index" },
							to: { node: "repeat/polish", port: "round" },
						},
						data("repeat", "publish"),
					],
				),
			),
		);
		expect(chart).toBe(
			[
				"flowchart TD",
				"  start((start))",
				"  stop(((end)))",
				'  subgraph gn1["map"]',
				'    n1[["map<br/>cats, dogs, owls"]]',
				'    n0["u<br/>code upper"]',
				"  end",
				'  subgraph gn4["repeat"]',
				'    n4[["repeat<br/>up to 3"]]',
				'    n3["polish<br/>code"]',
				"  end",
				'  n2[/"gather<br/>fan-in"/]',
				'  n5["publish<br/>code"]',
				"  start --> n1",
				'  n1 -->|"item to name"| n0',
				'  n1 ==>|"collect"| n2',
				'  n2 -->|"text"| n4',
				'  n4 -->|"text, index to round"| n3',
				'  n4 -->|"text"| n5',
				'  n3 -.->|"next"| n4',
				"  n5 --> stop",
			].join("\n"),
		);
	});

	test("draws guards and ordering edges dashed, and regions as up to their bound", async () => {
		const chart = render(
			await planOf(await golden("guards-and-escalation.json")),
		).split("\n");
		expect(chart).toContain('  n3 -.->|"when nonEmpty"| n4');
		expect(chart).toContain('  n6 -.->|"after, tolerates rejected"| n7');
		expect(chart).toContain('    n1[["map<br/>up to 4"]]');
		expect(chart).toContain('  n6{"gate<br/>assert"}');
		expect(chart).toContain('  n7["summary<br/>code summarize"]');
		expect(chart).toContain('  n0["plan<br/>code"]');

		const nested = await golden("nested-groups.json");
		const empty = structuredClone(nested);
		for (const n of empty.nodes)
			if (n.id === "angles" && n.kind === "map")
				Object.assign(n, { items: [], cardinality: { exact: 0 } });
		const header = (ir: Ir) =>
			planOf(ir).then((p) =>
				render(p)
					.split("\n")
					.find((l) => l.includes('[["repeat')),
			);
		expect(await header(nested)).toBe(
			'      n2[["repeat<br/>[wide]: up to 3<br/>[deep]: up to 3"]]',
		);
		expect(await header(empty)).toBe('      n2[["repeat<br/>up to 3"]]');
	});

	test("cuts a long key list, and counts the instances a key function names", async () => {
		const long = map("long", [
			"alpha",
			"bravo",
			"charlie",
			"delta",
			"echo",
			"foxtrot",
		]);
		const keyed = map("k", ["a", "b", "c"], {
			key: { ...code("k", "firstChar").worker },
		});
		const chart = render(
			await planOf(
				irOf([...long.nodes, ...keyed.nodes], [...long.edges, ...keyed.edges]),
			),
		).split("\n");
		expect(chart).toContain(
			'    n1[["map<br/>alpha, bravo, charlie, delta, echo, fox…"]]',
		);
		expect(chart).toContain('    n3[["map<br/>3"]]');
	});
});
