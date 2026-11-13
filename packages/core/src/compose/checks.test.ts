import { describe, expect, test } from "bun:test";
import {
	CORE_TYPES,
	type HostNode,
	type JsonSchema,
	MAESTRO_TYPE,
	settledSchema,
} from "@maestro/ir";
import { layered, parseLayer, valuesLayer } from "../config";
import type { NodeKind } from "../host";
import {
	code,
	composeWith,
	DATA_ROOT,
	data,
	fakeHost,
	golden,
	irOf,
} from "./fixtures/support";
import type { ComposeInput } from "./index";

const STRING = { type: "string" };
const NUMBER = { type: "number" };
const marked = (type: string, rest: object = {}) => ({
	[MAESTRO_TYPE]: type,
	...rest,
});

const failures = async (...args: Parameters<typeof composeWith>) => {
	const result = await composeWith(...args);
	return result.ok ? [] : result.diagnostics;
};

const edge = (from: object, to: object, over: object = {}) =>
	failures(
		irOf(
			[
				code("a", "a", { out: { v: from } }),
				code("b", "b", { in: { v: to }, ...over }),
			],
			[data("a", "b", "v")],
		),
	);

describe("edge types", () => {
	test.each([
		["the same type", STRING, STRING],
		["an integer into a number", { type: "integer" }, NUMBER],
		["an untyped side", {}, NUMBER],
		[
			"differing enums and annotations",
			{ type: "string", enum: ["a"] },
			{ type: "string", enum: ["b"], description: "d" },
		],
		[
			"differing required and extra properties",
			{ type: "object", properties: { k: STRING, x: STRING }, required: ["k"] },
			{
				type: "object",
				properties: { k: STRING },
				additionalProperties: false,
			},
		],
		["a marker into an untyped port", marked(CORE_TYPES.file), {}],
		[
			"one marker over differing content",
			marked(CORE_TYPES.file, STRING),
			marked(CORE_TYPES.file, NUMBER),
		],
	])("accept %s", async (_, from, to) => {
		expect(await edge(from, to)).toEqual([]);
	});

	test.each([
		["another type", STRING, NUMBER, ""],
		["a number into an integer", NUMBER, { type: "integer" }, ""],
		[
			"other items",
			{ type: "array", items: STRING },
			{ type: "array", items: NUMBER },
			" at /items",
		],
		[
			"a shared property of another type",
			{ type: "object", properties: { k: STRING } },
			{ type: "object", properties: { k: NUMBER } },
			" at /properties/k",
		],
		["another marker", marked(CORE_TYPES.file), marked(CORE_TYPES.dir), ""],
		["a marker into a plain type", marked(CORE_TYPES.file), STRING, ""],
		[
			"JSON file content of another type",
			marked(CORE_TYPES.jsonFile, { properties: { k: STRING } }),
			marked(CORE_TYPES.jsonFile, { properties: { k: NUMBER } }),
			" at /properties/k",
		],
	])("reject %s", async (_, from, to, at) => {
		const [found, ...rest] = await edge(from, to);
		expect(rest).toEqual([]);
		expect(found?.code).toBe("TYPE.edge");
		expect(found?.message).toEndWith(`is expected${at}`);
	});

	test("checks a data edge into a fan-in input against the settled value (ADR 0006)", async () => {
		const fanin = (value: JsonSchema) =>
			edge(STRING, settledSchema(value), { fanin: true });
		expect(await fanin(STRING)).toEqual([]);
		expect((await fanin(NUMBER)).map((d) => d.code)).toEqual(["TYPE.edge"]);
	});

	test("checks a guard's source port is a boolean", async () => {
		const guard = (out: object) =>
			failures(
				irOf(
					[code("a", "a", { out: { v: out } }), code("b", "b")],
					[
						{
							kind: "control",
							from: { node: "a", port: "v" },
							to: { node: "b" },
						},
					],
				),
			);
		expect(await guard({ type: "boolean" })).toEqual([]);
		expect((await guard(STRING)).map((d) => d.message)).toEqual([
			"edge from 'a.v' to 'the guard of b' carries string where boolean is expected",
		]);
	});

	test("rejects a marker the artifact walker cannot reach", async () => {
		const out = { v: { anyOf: [marked(CORE_TYPES.file)] } };
		const [found] = await failures(irOf([code("a", "a", { out })]));
		expect(found?.code).toBe("TYPE.marker");
		expect(found?.path).toBe("/nodes/0/out/v/anyOf/0");
	});

	test("rejects a node kind no installed host registers", async () => {
		const [found] = await failures(irOf([{ id: "a", kind: "other.task" }]));
		expect(found?.code).toBe("HOST.kind");
	});
});

describe("host nodes", () => {
	const INTEGER = { type: "integer" };
	const fixed = fakeHost({
		types: ["fake.handle"],
		kinds: [
			{
				...fakeHost().kinds[0],
				name: "fake.fixed",
				config: { type: "object", properties: { retries: INTEGER } },
				ports: (n: HostNode) => {
					const { retries = 0 } = n.config ?? {};
					if (!Number.isInteger(retries))
						throw new Error(`retries ${retries} is no integer`);
					return {
						in: { prompt: STRING },
						out: { text: STRING, count: INTEGER },
					};
				},
			} as NodeKind,
		],
	});
	const node = (over: object = {}) => ({
		id: "t",
		kind: "fake.fixed",
		in: { prompt: STRING },
		literals: { prompt: "p" },
		out: { text: STRING, count: NUMBER },
		...over,
	});
	const found = async (over: object) =>
		(await failures(irOf([node(over)]), { hosts: [fixed] })).map((d) => [
			d.code,
			d.message,
		]);

	test("accept a node whose config and ports match its kind's, by the edge rule", async () => {
		expect(await found({ config: { retries: 2 } })).toEqual([]);
	});

	test.each([
		[
			"a config off the kind's schema",
			{ config: { retries: "x" } },
			"HOST.config",
			"config 'retries' of node 't' must be integer",
		],
		[
			"a port the IR lacks",
			{ in: {}, literals: {} },
			"HOST.ports",
			"node 't' lacks in port 'prompt', which kind 'fake.fixed' gives it",
		],
		[
			"a port the kind lacks",
			{ out: { text: STRING, count: INTEGER, extra: STRING } },
			"HOST.ports",
			"node 't' has out port 'extra', which kind 'fake.fixed' does not give it",
		],
		[
			"a port of another type",
			{ out: { text: NUMBER, count: INTEGER } },
			"HOST.ports",
			"out port 'text' of node 't' is number where kind 'fake.fixed' gives string",
		],
	])("reject %s", async (_, over, code, message) => {
		expect(await found(over)).toEqual([[code, message]]);
	});

	test("a ports() that throws is a HOST.ports error naming the host", async () => {
		const throwing = fakeHost({
			kinds: [
				{
					...fakeHost().kinds[0],
					ports: () => {
						throw new Error("down");
					},
				} as NodeKind,
			],
		});
		const diagnostics = await failures(irOf([node({ kind: "fake.task" })]), {
			hosts: [throwing],
		});
		expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
			["HOST.ports", "host 'fake' failed in ports() of node 't': down"],
		]);
	});

	test("reject a type no one installed owns, and accept core's, an installed host's and a marker-shaped value", async () => {
		const out = {
			mine: marked("fake.handle"),
			core: { type: "array", items: marked(CORE_TYPES.file) },
			other: marked("other.thing"),
			value: { type: "object", default: marked("other.value") },
		};
		const ir = irOf([code("a", "a", { out })]);
		const diagnostics = await failures(ir, { hosts: [fixed] });
		expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
			[
				"TYPE.owner",
				"the x-maestro-type 'other.thing' at /nodes/0/out/other is owned by neither core nor an installed host",
			],
		]);
	});
});

describe("config", () => {
	const ir = () => golden("fanout-fanin-loop.json");
	const unused = fakeHost({
		name: "other",
		kinds: [],
		config: { other: { type: "object", required: ["x"] } },
	});
	const packs = { demo: { greet: ["name", "loud"] } };
	const configOf = (values: Record<string, unknown>) =>
		layered([
			valuesLayer({ dataRoot: DATA_ROOT, ...values }, { layer: "user" }),
		]);
	const found = async (
		values: Record<string, unknown>,
		over: Partial<ComposeInput> = {},
	) =>
		failures(await ir(), {
			config: configOf(values),
			core: {
				dataRoot: STRING,
				core: { type: "object", additionalProperties: false },
			},
			hosts: [fakeHost(), unused],
			packs,
			...over,
		});
	const requiring = fakeHost({
		config: { fake: { type: "object", required: ["retries"] } },
	});

	test.each<
		[string, Record<string, unknown>, string, string, Partial<ComposeInput>?]
	>([
		[
			"an unclaimed key near a claimed one",
			{ fak: {} },
			"CFG.unclaimed",
			"Did you mean 'fake'? Rename 'fak' to 'fake'",
		],
		[
			"a short unclaimed key, too far for a hint",
			{ fa: {} },
			"CFG.unclaimed",
			"Remove 'fa' from the config, or install the pack or host that claims it. To configure a composition file, make it a pack",
		],
		[
			"an unclaimed key",
			{ zzzzz: {} },
			"CFG.unclaimed",
			"Remove 'zzzzz' from the config, or install the pack or host that claims it. To configure a composition file, make it a pack",
		],
		[
			"a key under a pack that names none of its compositions",
			{ demo: { gret: {} } },
			"CFG.unclaimed",
			"Did you mean 'demo.greet'? Rename 'demo.gret' to 'demo.greet'",
		],
		[
			"a key under a composition that names none of its params",
			{ demo: { greet: { nmae: "x" } } },
			"CFG.unclaimed",
			"Did you mean 'demo.greet.name'? Rename 'demo.greet.nmae' to 'demo.greet.name'",
		],
		[
			"a pack's value that is not a mapping",
			{ demo: 3 },
			"CFG.schema",
			"Set 'demo' to a mapping of its compositions, or remove it",
		],
		[
			"a used host's namespace off its schema",
			{ fake: { retries: "x" } },
			"CFG.schema",
			expect.any(String),
		],
		[
			"a core namespace off its schema",
			{ core: { x: 1 } },
			"CFG.schema",
			expect.any(String),
		],
		[
			"a used host's absent namespace that requires a key",
			{},
			"CFG.schema",
			"Change 'fake' in the config to match the schema of its owner",
			{ hosts: [requiring] },
		],
		[
			"a composition named like an inherited property",
			{ demo: { constructor: { a: 1 } } },
			"CFG.unclaimed",
			"Remove 'demo.constructor' from the config, or install what claims it",
		],
		[
			"a pack whose id a host's namespace claims",
			{},
			"CFG.claim",
			"Rename pack 'fake', or uninstall it",
			{ packs: { ...packs, fake: {} } },
		],
	])("rejects %s", async (_, values, want, hint, over = {}) => {
		expect((await found(values, over)).map((d) => [d.code, d.hint])).toEqual([
			[want, hint],
		]);
	});

	test("accepts a pack's composition params, and ignores the namespace of a host the graph does not use (D-24)", async () => {
		expect(await found({ demo: { greet: { name: "x" } }, other: {} })).toEqual(
			[],
		);
	});

	test("refuses a -c key under a composition the concert does not use, and ignores the same key from a file or preset", async () => {
		const reach = {
			demo: { other: ["x"], "refine-until-done": ["x"] },
		};
		const via = async (key: string, origin: Parameters<typeof parseLayer>[1]) =>
			failures(await ir(), {
				packs: reach,
				config: layered([
					parseLayer(`demo:\n  ${key}:\n    x: 1\ndataRoot: /data\n`, origin),
				]),
			});
		const flag = {
			layer: "flag",
			flag: "-c demo.other.x=1",
			key: "demo.other.x",
			base: "/w",
		} as const;
		expect(
			(await via("other", flag)).map((d) => [d.code, d.message, d.hint]),
		).toEqual([
			[
				"CFG.unreached",
				"config key 'demo.other' reaches no composition of this concert (from -c demo.other.x)",
				"Drop the -c, or perform a composition that uses 'other'",
			],
		]);
		expect(await via("refine-until-done", flag)).toEqual([]);
		for (const layer of ["workspace", "preset"] as const)
			expect(await via("other", { layer, file: "/w/c.yaml" })).toEqual([]);
	});

	test("locates a config error at the file and line that set the key", async () => {
		const layer = parseLayer(
			"demo:\n  greet:\n    nmae: x\ndataRoot: /data\n",
			{
				file: "/w/.maestro/config.yaml",
				layer: "workspace",
			},
		);
		const diagnostics = await failures(await ir(), {
			config: layered([layer]),
			packs,
		});
		expect(diagnostics.map((d) => [d.message, d.source])).toEqual([
			[
				"config key 'demo.greet.nmae' is claimed by no param of composition 'demo.greet'",
				{ file: "/w/.maestro/config.yaml", line: 3 },
			],
		]);
	});
});
