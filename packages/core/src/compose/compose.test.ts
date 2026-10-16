import { describe, expect, test } from "bun:test";
import type { Diagnostic, HostNode, Ir } from "@maestro/ir";
import type { Bounds, Host } from "../host";
import {
	code,
	composeWith,
	fakeHost,
	golden,
	irOf,
	loader,
	sdkBuilt,
} from "./fixtures/support";

const planOf = async (ir: Ir, hosts?: Host[], caps = {}) => {
	const result = await composeWith(ir, { caps, ...(hosts ? { hosts } : {}) });
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.plan;
};

const warning = (code: string): Diagnostic => ({
	code,
	severity: "warning",
	message: "noted",
	hint: "Ignore it",
});

describe("compose", () => {
	test.each([
		["minimal.json", golden, { exact: 1 }, "greet", { exact: 1 }],
		[
			"fanout-fanin-loop.json",
			golden,
			{ upTo: 11 },
			"topics/draft",
			{ exact: 3 },
		],
		[
			"nested-groups.json",
			golden,
			{ upTo: 15 },
			"angles/polish/step",
			{ upTo: 6 },
		],
		[
			"guards-and-escalation.json",
			golden,
			{ upTo: 13 },
			"each/work",
			{ upTo: 4 },
		],
		["fanout.json", sdkBuilt, { upTo: 16 }, "map/task", { exact: 2 }],
	])("bounds %s", async (file, load, instances, node, count) => {
		const { bounds } = await planOf(await load(file));
		expect(bounds.instances).toEqual(instances);
		expect(bounds.nodes[node]).toEqual(count);
	});

	test("an error from a host's validate stops compose before the plan", async () => {
		const host = fakeHost({
			validate: (graph) => [
				{
					...warning("cap"),
					severity: "error",
					node: [...graph.nodes.keys()][0],
				},
			],
		});
		const result = await composeWith(await golden("fanout-fanin-loop.json"), {
			hosts: [host],
		});
		expect(result).toEqual({
			ok: false,
			diagnostics: [
				{ ...warning("HOST.cap"), severity: "error", node: "topics" },
			],
		});
	});

	test.each(["environment", "validate"] as const)(
		"a host whose %s() throws stops compose with a HOST error naming it",
		async (name) => {
			const host = fakeHost({
				[name]: () => {
					throw new Error("down");
				},
			});
			const result = await composeWith(await golden("minimal.json"), {
				hosts: [host],
			});
			expect(
				result.ok ? [] : result.diagnostics.map((d) => [d.code, d.message]),
			).toEqual([[`HOST.${name}`, `host 'fake' failed in ${name}(): down`]]);
		},
	);

	test("keeps a host's warnings in the plan, each code under HOST once", async () => {
		const host = fakeHost({
			validate: async () => [warning("cap"), warning("HOST.kind")],
		});
		const plan = await planOf(await golden("minimal.json"), [host]);
		expect(plan.diagnostics.map((d) => d.code)).toEqual([
			"HOST.cap",
			"HOST.kind",
		]);
	});
});

describe("bounds (D-23)", () => {
	const calls = (only?: string) =>
		fakeHost({
			bounds: (node: HostNode): Bounds =>
				only === undefined || node.id === only ? { calls: 2 } : {},
		});

	test("sums each host count over the instances of its nodes", async () => {
		const ir = await golden("fanout-fanin-loop.json");
		expect((await planOf(ir, [calls("topics/draft")])).bounds.counts).toEqual({
			calls: { exact: 6 },
		});
		expect((await planOf(ir, [calls()])).bounds.counts).toEqual({
			calls: { upTo: 10 },
		});
	});

	test.each([
		["fanout-fanin-loop.json", { instances: 11, calls: 10 }, []],
		[
			"fanout-fanin-loop.json",
			{ instances: 10 },
			["'instances' may reach at least 11, over its cap of 10"],
		],
		[
			"fanout-fanin-loop.json",
			{ calls: 5 },
			["'calls' may reach at least 6, over its cap of 5"],
		],
		[
			"minimal.json",
			{ instances: 0 },
			["'instances' may reach 1, over its cap of 0"],
		],
	])("%s with caps %o gives %o", async (file, caps, messages) => {
		const result = await composeWith(await golden(file), {
			caps,
			hosts: [calls()],
		});
		expect(
			result.ok ? [] : result.diagnostics.map((d) => [d.code, d.message]),
		).toEqual(messages.map((m) => ["BOUND.cap", m]));
	});

	test("stops at the first group instance that passes a cap", async () => {
		const ir = irOf([
			code("r/c", "boom", { pure: true }),
			{
				id: "r",
				kind: "repeat",
				cardinality: { upTo: 20000 },
				in: { text: { type: "string" } },
				literals: { text: "" },
				inner: { index: { type: "integer" }, text: { type: "string" } },
				out: { text: { type: "string" } },
				members: { result: "r/c" },
			},
		]);
		const result = await composeWith(ir, {
			caps: { instances: 10 },
			loadCode: loader({
				boom: () => {
					throw new Error("folded");
				},
			}),
		});
		expect(result.ok ? [] : result.diagnostics.map((d) => d.message)).toEqual([
			"'instances' may reach at least 20001, over its cap of 10",
		]);
	});
});
