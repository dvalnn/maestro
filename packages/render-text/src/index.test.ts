import { describe, expect, test } from "bun:test";
import type { Plan } from "@maestro/ir";
import { parseIr } from "@maestro/ir";
import { listing, render, summary } from "./index";

/** A plan golden of ir, by name. */
const plan = async (name: string): Promise<Plan> =>
	structuredClone((await import(`@maestro/ir/plans/${name}`)).default);

const lines = async (name: string) => render(await plan(name)).split("\n");

const SHIP = [
	"flowchart TD",
	"  start((start))",
	"  stop(((end)))",
	'  n0["plan<br/>code"]',
	'  n1["implement<br/>code"]',
	'  n2["writeTests<br/>code"]',
	'  n3["verify<br/>code"]',
	'  n4["audit<br/>code"]',
	'  n5[/"audit_or<br/>fan-in or"/]',
	'  n6["report<br/>code"]',
	'  f0@{ shape: fork, label: " " }',
	'  f1@{ shape: fork, label: " " }',
	'  j3@{ shape: join, label: " " }',
	'  j6@{ shape: join, label: " " }',
	'  j4@{ shape: join, label: " " }',
	"  start --> n0",
	"  n0 --> f0",
	'  f0 -->|"spec"| n1',
	'  f0 -->|"spec"| n2',
	"  n1 --> f1",
	'  f1 -->|"patch"| j3',
	'  n2 -->|"tests"| j3',
	"  j3 --> n3",
	'  f1 -->|"patch"| j4',
	'  f0 -.->|"when risky, else skip"| j4',
	"  j4 --> n4",
	'  n4 -->|"note to value"| n5',
	'  n3 -->|"verdict"| j6',
	'  n5 -->|"value to note"| j6',
	"  j6 --> n6",
	"  n6 --> stop",
];

describe("text forms", () => {
	test("summary: instances, host counts and warnings in one line", async () => {
		expect(summary(await plan("minimal"))).toBe("minimal: 1 node instance");
		const warned = await plan("fanout-fanin-loop");
		warned.bounds.counts = { calls: { upTo: 5 } };
		warned.diagnostics = [
			{ code: "x", severity: "warning", message: "m", hint: "h" },
		];
		expect(summary(warned)).toBe(
			"fanout-fanin-loop: up to 13 node instances, up to 5 calls, 1 warning",
		);
	});

	test("listing: each node's count and expansions, then bounds", async () => {
		expect(listing(await plan("minimal"))).toBe(
			[
				"minimal: 1 node instance",
				"nodes:",
				"  greet  code  1",
				"bounds:",
				"  instances  1",
			].join("\n"),
		);
		expect(listing(await plan("nested-groups"))).toContain(
			"  angles/polish       loop       2\n    angles[wide]/polish expands to 1 to 3\n",
		);
	});
});

describe("render", () => {
	test("marks start and end around a node", async () => {
		expect((await lines("minimal")).join("\n")).toBe(
			[
				"flowchart TD",
				"  start((start))",
				"  stop(((end)))",
				'  n0["greet<br/>code"]',
				"  start --> n0",
				"  n0 --> stop",
			].join("\n"),
		);
	});

	test("draws fan-out with its expansion, fan-in behind a collect barrier, a loop bound and a scope", async () => {
		const chart = await lines("fanout-fanin-loop");
		for (const line of [
			'  subgraph s0["refine"]',
			'      n3[["loop<br/>0 to 2"]]',
			'    n0[["parMap<br/>alpha, beta, gamma"]]',
			'    n1(["draft<br/>fake.task"])',
			'  n2[/"best<br/>fan-in firstOk"/]',
			'  n0 -->|"item to prompt"| n1',
			'  n0 ==>|"collect"| n2',
		])
			expect(chart).toContain(line);
	});

	test("merges parallel data edges and loops a loop back", async () => {
		const chart = await lines("nested-groups");
		expect(chart).toContain('  n2 -->|"text to prompt, index to round"| n3');
		expect(chart.join("\n")).not.toContain("shape: fork");
		expect(chart).toContain('  n3 -.->|"next, test"| n2');
	});

	test("loops a fold back from its step alone", async () => {
		const folded = await plan("nested-groups");
		const polish = folded.ir.nodes.find((n) => n.id === "angles/polish");
		Object.assign(polish ?? {}, {
			kind: "fold",
			members: { first: "angles/draft", step: "angles/polish/step" },
		});
		const chart = render(folded);
		expect(chart).toContain('  n3 -.->|"next"| n2');
		expect(chart).not.toContain('  n1 -.->|"next"|');
	});

	test("titles each subgraph relative to its container", async () => {
		const chart = await lines("nested-groups");
		expect(chart).toContain('  subgraph gn0["angles"]');
		expect(chart).toContain('    subgraph gn2["polish"]');
		const deep = await plan("nested-groups");
		for (const n of deep.ir.nodes)
			n.id = n.id.replace("angles/polish", "angles/ab/polish");
		for (const e of deep.ir.edges) {
			e.from.node = e.from.node.replace("angles/polish", "angles/ab/polish");
			e.to.node = e.to.node.replace("angles/polish", "angles/ab/polish");
		}
		expect(render(deep)).toContain('    subgraph gn2["ab/polish"]');
	});

	test("ties a group's body to its header, one dashed edge per node", async () => {
		const chart = await lines("nested-groups");
		expect(chart).toContain('  n3 -.->|"next, test"| n2');
		expect(chart).not.toContain("  n3 -.-> n2");
		expect(chart).toContain("  n2 -.-> n0");
		expect(chart).toContain("  n4 -.-> n0");
		const found = await plan("nested-groups");
		const polish = found.ir.nodes.find((n) => n.id === "angles/polish");
		const step = found.ir.nodes.find((n) => n.id === "angles/polish/step");
		Object.assign(polish ?? {}, {
			kind: "find",
			cond: { node: "angles/polish/step", port: "hit" },
			in: { items: { type: "array" } },
			inner: { item: { type: "string" } },
			out: { hit: { type: "boolean" }, text: { type: "string" } },
		});
		delete (polish as { test?: unknown }).test;
		Object.assign(step ?? {}, {
			in: { prompt: { type: "string" } },
			out: { hit: { type: "boolean" }, text: { type: "string" } },
		});
		found.ir.edges = found.ir.edges.filter(
			(e) => e.to.node !== "angles/polish/step",
		);
		const feed = found.ir.edges.find((e) => e.to.node === "angles/polish");
		if (feed?.kind === "data") feed.to.port = "items";
		found.ir.edges.push({
			kind: "data",
			from: { node: "angles/polish", port: "item" },
			to: { node: "angles/polish/step", port: "prompt" },
		});
		expect(parseIr(found.ir)).toMatchObject({ ok: true });
		expect(render(found).split("\n")).toContain('  n3 -.->|"test"| n2');
		(polish as { kind: string }).kind = "parFind";
		expect(render(found).split("\n")).toContain('  n3 -.->|"test"| n2');
	});

	test("starts only the nodes nothing outside waits on, a group by what feeds its body", async () => {
		const starts = (chart: string[]) =>
			chart.filter((l) => l.includes("start -->"));
		expect(starts(await lines("nested-groups"))).toEqual(["  start --> n0"]);
		const fed = await plan("fanout-fanin-loop");
		const loop = fed.ir.nodes.find((n) => n.id === "refine/loop");
		Object.assign(loop ?? {}, { literals: { text: "x" } });
		fed.ir.edges = fed.ir.edges.filter((e) => e.to.node !== "refine/loop");
		fed.ir.edges.push({
			kind: "control",
			from: { node: "text" },
			to: { node: "refine/loop/step" },
		});
		expect(parseIr(fed.ir)).toMatchObject({ ok: true });
		expect(starts(render(fed).split("\n"))).toEqual(["  start --> n0"]);
	});

	test("draws guards and ordering edges dashed, and regions as up to their bound", async () => {
		const chart = await lines("guards-and-escalation");
		expect(chart).toContain('  f3 -.->|"when nonEmpty, else skip"| n4');
		expect(chart).toContain('  n6 -.->|"after, tolerates rejected"| j7');
		expect(chart).toContain('    n1[["parMap<br/>up to 4"]]');
		expect(chart).toContain('  n6{"gate<br/>assert"}');
		expect(chart).toContain('  n7["summary<br/>code summarize"]');
		expect(chart).toContain('  n0["plan<br/>code"]');
	});

	test("declares a bar inside its node's group and leaves a group's reads of its own body unbarred", async () => {
		const nested = await plan("nested-groups");
		nested.ir.edges.push({
			kind: "data",
			from: { node: "angles/draft", port: "text" },
			to: { node: "angles/critique", port: "context" },
		});
		const chart = render(nested).split("\n");
		expect(chart.slice(chart.indexOf('  subgraph gn0["angles"]'))).toEqual(
			expect.arrayContaining([
				'    f1@{ shape: fork, label: " " }',
				'    j4@{ shape: join, label: " " }',
				"  n1 --> f1",
				'  f1 -->|"text"| n2',
				'  f1 -->|"text to context"| j4',
				"  j4 --> n4",
			]),
		);
		expect(chart.filter((l) => l.includes("@{"))).toHaveLength(2);
	});

	test("draws the ship plan with fork and join bars, an explicit skip and an or", async () => {
		expect(await lines("ship")).toEqual(SHIP);
	});

	test("shows a group header's expansion once, or one line per path, a loop's as its steps", async () => {
		const header = (chart: string) =>
			chart.split("\n").find((l) => l.includes('[["loop'));
		const nested = await plan("nested-groups");
		expect(header(render(nested))).toBe(
			'      n2[["loop<br/>[wide]: 1 to 3<br/>[deep]: 1 to 3"]]',
		);
		nested.expansion["angles/polish"] = {};
		expect(header(render(nested))).toBe('      n2[["loop<br/>1 to 3"]]');
		const polish = nested.ir.nodes.find((n) => n.id === "angles/polish");
		if (polish?.kind === "loop") polish.test.at = "start";
		expect(header(render(nested))).toBe('      n2[["loop<br/>0 to 3"]]');
	});

	test("cuts a long key list, and counts the instances a key function names", async () => {
		const fanout = await plan("fanout-fanin-loop");
		fanout.expansion.topics = {
			"": { keys: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"] },
		};
		expect(render(fanout).split("\n")).toContain(
			'    n0[["parMap<br/>alpha, bravo, charlie, delta, echo, fox…"]]',
		);
		fanout.expansion.topics = { "": { exact: 3 } };
		expect(render(fanout).split("\n")).toContain('    n0[["parMap<br/>3"]]');
	});
});
