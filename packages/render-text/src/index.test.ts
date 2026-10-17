import { describe, expect, test } from "bun:test";
import type { Plan } from "@maestro/ir";
import { listing, render, summary } from "./index";

/** A plan golden of ir, by name. */
const plan = async (name: string): Promise<Plan> =>
	structuredClone((await import(`@maestro/ir/plans/${name}`)).default);

const lines = async (name: string) => render(await plan(name)).split("\n");

describe("text forms", () => {
	test("summary: instances, host counts and warnings in one line", async () => {
		expect(summary(await plan("minimal"))).toBe("minimal: 1 node instance");
		const warned = await plan("fanout-fanin-loop");
		warned.bounds.counts = { calls: { upTo: 5 } };
		warned.diagnostics = [
			{ code: "x", severity: "warning", message: "m", hint: "h" },
		];
		expect(summary(warned)).toBe(
			"fanout-fanin-loop: up to 11 node instances, up to 5 calls, 1 warning",
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
			"  angles/polish       repeat     2\n    angles[wide]/polish expands to up to 3\n",
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
			'      n3[["repeat<br/>up to 2"]]',
			'    n0[["map<br/>alpha, beta, gamma"]]',
			'    n1(["draft<br/>fake.task"])',
			'  n2[/"pick<br/>fan-in firstOk"/]',
			'  n0 -->|"item to prompt"| n1',
			'  n0 ==>|"collect"| n2',
		])
			expect(chart).toContain(line);
	});

	test("merges parallel data edges and loops a repeat back", async () => {
		const chart = await lines("nested-groups");
		expect(chart).toContain('  n2 -->|"text to prompt, index to round"| n3');
		expect(chart).toContain('  n3 -.->|"next"| n2');
	});

	test("draws guards and ordering edges dashed, and regions as up to their bound", async () => {
		const chart = await lines("guards-and-escalation");
		expect(chart).toContain('  n3 -.->|"when nonEmpty"| n4');
		expect(chart).toContain('  n6 -.->|"after, tolerates rejected"| n7');
		expect(chart).toContain('    n1[["map<br/>up to 4"]]');
		expect(chart).toContain('  n6{"gate<br/>assert"}');
		expect(chart).toContain('  n7["summary<br/>code summarize"]');
		expect(chart).toContain('  n0["plan<br/>code"]');
	});

	test("shows a group header's expansion once, or one line per path", async () => {
		const header = (chart: string) =>
			chart.split("\n").find((l) => l.includes('[["repeat'));
		const nested = await plan("nested-groups");
		expect(header(render(nested))).toBe(
			'      n2[["repeat<br/>[wide]: up to 3<br/>[deep]: up to 3"]]',
		);
		nested.expansion["angles/polish"] = {};
		expect(header(render(nested))).toBe('      n2[["repeat<br/>up to 3"]]');
	});

	test("cuts a long key list, and counts the instances a key function names", async () => {
		const fanout = await plan("fanout-fanin-loop");
		fanout.expansion.topics = {
			"": { keys: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"] },
		};
		expect(render(fanout).split("\n")).toContain(
			'    n0[["map<br/>alpha, bravo, charlie, delta, echo, fox…"]]',
		);
		fanout.expansion.topics = { "": { exact: 3 } };
		expect(render(fanout).split("\n")).toContain('    n0[["map<br/>3"]]');
	});
});
