import { describe, expect, test } from "bun:test";
import type { Diagnostic, HostNode, Ir } from "@maestro/ir";
import type { Bounds, Host, HostSetup } from "../host";
import {
	composeWith,
	DATA_ROOT,
	fakeHost,
	golden,
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
		"minimal",
		"fanout-fanin-loop",
		"nested-groups",
		"guards-and-escalation",
		"ship",
	])("composes the %s golden IR into its plan golden", async (name) => {
		const expected = (await import(`@maestro/ir/plans/${name}`)).default;
		expect(await planOf(await golden(`${name}.json`))).toEqual(expected);
	});

	test.each([
		["minimal.json", golden, { exact: 1 }, "greet", { exact: 1 }],
		[
			"fanout-fanin-loop.json",
			golden,
			{ upTo: 13 },
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
		["fanout.json", sdkBuilt, { upTo: 20 }, "parMap/task", { exact: 2 }],
	])("bounds %s", async (file, load, instances, node, count) => {
		const { bounds } = await planOf(await load(file));
		expect(bounds.instances).toEqual(instances);
		expect(bounds.nodes[node]).toEqual(count);
	});

	test("takes no params, and its plan carries none", async () => {
		const ir = await golden("guards-and-escalation.json");
		// @ts-expect-error: params live in the SDK and the CLI, and the IR is a snapshot of their values.
		const result = await composeWith(ir, { params: { maxParts: 4 } });
		expect(result.ok && result.plan).not.toHaveProperty("params");
	});

	test("an error from a host's validate fails compose, with the plan beside its diagnostics", async () => {
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
		const diagnostics = [
			{ ...warning("HOST.cap"), severity: "error" as const, node: "topics" },
		];
		expect(result).toEqual({
			ok: false,
			diagnostics,
			plan: expect.objectContaining({ diagnostics }),
		});
		expect(!result.ok && result.plan?.bounds.instances).toEqual({ upTo: 13 });
	});

	test("an error from the checks of step 1 comes with no plan", async () => {
		const ir = await golden("minimal.json");
		const result = await composeWith(
			{ ...ir, nodes: [{ id: "a", kind: "other.task" }] },
			{},
		);
		expect(!result.ok && result.diagnostics[0]?.code).toBe("HOST.kind");
		expect(!result.ok && result.plan).toBeUndefined();
	});

	test("a host whose validate() throws stops compose with a HOST error naming it", async () => {
		const host = fakeHost({
			validate: () => {
				throw new Error("down");
			},
		});
		const result = await composeWith(await golden("minimal.json"), {
			hosts: [host],
		});
		expect(
			result.ok ? [] : result.diagnostics.map((d) => [d.code, d.message]),
		).toEqual([["HOST.validate", "host 'fake' failed in validate(): down"]]);
	});

	test("each host's validate gets its own config namespaces and store, and no other host's", async () => {
		const seen: Record<string, HostSetup> = {};
		const watching =
			(name: string): Host["validate"] =>
			(_, setup) => {
				seen[name] = setup;
				return [];
			};
		const other: Host = {
			...fakeHost({ validate: watching("other") }),
			name: "other",
			kinds: [],
			config: { other: { type: "object" } },
		};
		const result = await composeWith(await golden("minimal.json"), {
			hosts: [fakeHost({ validate: watching("fake") }), other],
			config: {
				values: {
					fake: { retries: 2 },
					other: { depth: 1 },
					dataRoot: DATA_ROOT,
				},
				sources: [],
				layers: [],
			},
		});
		expect(result.ok).toBe(true);
		expect(seen).toEqual({
			fake: {
				config: { fake: { retries: 2 } },
				sources: [],
				layers: [],
				commandLine: { values: {}, replaced: [] },
				store: `${DATA_ROOT}/hosts/fake`,
				roots: { user: "/nonexistent", packs: {} },
			},
			other: {
				config: { other: { depth: 1 } },
				sources: [],
				layers: [],
				commandLine: { values: {}, replaced: [] },
				store: `${DATA_ROOT}/hosts/other`,
				roots: { user: "/nonexistent", packs: {} },
			},
		});
	});

	test("two hosts registering one node kind are refused", async () => {
		await expect(
			composeWith(await golden("minimal.json"), {
				hosts: [fakeHost(), { ...fakeHost(), name: "other" }],
			}),
		).rejects.toThrow(
			"node kind 'fake.task' is registered twice, by host 'fake' and by host 'other'\nLoad only one host that registers 'fake.task'",
		);
	});

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
		["fanout-fanin-loop.json", { instances: 13, calls: 10 }, []],
		[
			"fanout-fanin-loop.json",
			{ instances: 12 },
			["'instances' may reach at least 13, over its cap of 12"],
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
});
