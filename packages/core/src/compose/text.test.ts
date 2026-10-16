import { describe, expect, test } from "bun:test";
import { type Ir, reject } from "@maestro/ir";
import {
	code,
	composeWith,
	fakeHost,
	golden,
	irOf,
	loader,
} from "./fixtures/support";
import type { ComposeInput } from "./index";
import { listing, render, summary } from "./index";

const planOf = async (ir: Ir, over: Partial<ComposeInput> = {}) => {
	const result = await composeWith(ir, over);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.plan;
};

/** A guard folded false, one on an implicit port folded true, a long value with a `#` and a long rejection. */
const folding = () =>
	planOf(
		irOf(
			[
				code("g", "flag", { out: { yes: { type: "boolean" } } }),
				code("long", "long"),
				code("t", "never"),
				code("r", "refuse"),
			],
			[
				{
					kind: "control",
					from: { node: "g", port: "yes" },
					to: { node: "t" },
				},
				{
					kind: "control",
					from: { node: "long", port: "ok" },
					to: { node: "r" },
				},
			],
		),
		{
			loadCode: loader({
				flag: () => ({ yes: false }),
				long: () => ({ text: `#${"x".repeat(100)}` }),
				refuse: () => reject(`line one\nline two ${"y".repeat(60)}`),
			}),
		},
	);

describe("text forms", () => {
	test("summary: instances, host counts, folded instances and warnings in one line", async () => {
		const host = fakeHost({
			bounds: () => ({ calls: 1 }),
			validate: () => [
				{ code: "x", severity: "warning", message: "m", hint: "h" },
			],
		});
		expect(summary(await planOf(await golden("minimal.json")))).toBe(
			"minimal: 1 node instance, 1 folded",
		);
		expect(
			summary(
				await planOf(await golden("fanout-fanin-loop.json"), { hosts: [host] }),
			),
		).toBe(
			"fanout-fanin-loop: up to 11 node instances, up to 5 calls, 0 folded, 1 warning",
		);
	});

	test("listing: each node's count, expansions and folded values, then bounds", async () => {
		expect(listing(await planOf(await golden("minimal.json")))).toBe(
			[
				"minimal: 1 node instance, 1 folded",
				"nodes:",
				"  greet  code  1",
				'    greet folded ok {"text":"hello, world"}',
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
			'      n3[["repeat refine/loop<br/>up to 2<br/>refine/loop: up to 2"]]',
			'    n0[["map topics<br/>3<br/>topics: alpha, beta, gamma"]]',
			'    n1(["topics/draft<br/>fake.task"])',
			'  n2[/"pick<br/>fan-in firstOk"/]',
			'  n0 -->|"item to prompt"| n1',
			'  n0 ==>|"collect"| n2',
		])
			expect(chart.split("\n")).toContain(line);
	});

	test("draws guards and ordering edges dashed, and regions as up to their bound", async () => {
		const chart = render(
			await planOf(await golden("guards-and-escalation.json")),
		).split("\n");
		expect(chart).toContain('  n3 -.->|"when nonEmpty"| n4');
		expect(chart).toContain('  n6 -.->|"after, tolerates rejected"| n7');
		expect(chart).toContain(
			'    n1[["map each<br/>up to 4<br/>each: up to 4"]]',
		);
		expect(chart).toContain('  n6{"gate<br/>assert"}');
	});

	test("marks folded values and resolved guards, cut and escaped", async () => {
		const chart = render(await folding()).split("\n");
		expect(chart).toContain('  n0 -.->|"when yes = false"| n2');
		expect(chart).toContain(
			`  n1["long<br/>code long<br/>folded long ok {#quot;text#quot;:#quot;#35;${"x".repeat(29)}…"]`,
		);
		expect(chart).toContain('  n1 -.->|"when ok = true"| n3');
		expect(chart).toContain(
			`  n3["r<br/>code refuse<br/>folded r rejected: line one line two ${"y".repeat(21)}…"]`,
		);
		expect(chart).toContain(
			'  n2["t<br/>code never<br/>folded t skipped: its guard is false"]',
		);
	});
});
