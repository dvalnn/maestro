import { describe, expect, test } from "bun:test";
import {
	CORE_TYPES,
	type JsonSchema,
	MAESTRO_TYPE,
	settledSchema,
} from "@maestro/ir";
import {
	code,
	composeWith,
	data,
	fakeHost,
	golden,
	irOf,
} from "./fixtures/support";

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
				code("a", "a", { pure: false, out: { v: from } }),
				code("b", "b", { pure: false, in: { v: to }, ...over }),
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
			edge(STRING, settledSchema(value), { fanin: true, pure: true });
		expect(await fanin(STRING)).toEqual([]);
		expect((await fanin(NUMBER)).map((d) => d.code)).toEqual(["TYPE.edge"]);
	});

	test("checks a guard's source port is a boolean", async () => {
		const guard = (out: object) =>
			failures(
				irOf(
					[
						code("a", "a", { pure: false, out: { v: out } }),
						code("b", "b", { pure: false }),
					],
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
		const [found] = await failures(
			irOf([code("a", "a", { pure: false, out })]),
		);
		expect(found?.code).toBe("TYPE.marker");
		expect(found?.path).toBe("/nodes/0/out/v/anyOf/0");
	});

	test("rejects a node kind no installed host registers", async () => {
		const [found] = await failures(irOf([{ id: "a", kind: "other.task" }]));
		expect(found?.code).toBe("HOST.kind");
	});
});

describe("params", () => {
	test("applies defaults (D-17)", async () => {
		const result = await composeWith(
			await golden("guards-and-escalation.json"),
			{ params: {} },
		);
		expect(result.ok && result.plan.params).toEqual({ maxParts: 4 });
	});

	test("composes one param schema with an $id twice in a process", async () => {
		const ir = () =>
			irOf([code("a", "a", { pure: false })], [], {
				params: {
					schema: { $id: "https://x.test/p", type: "object" },
					examples: [{}],
				},
			});
		expect((await failures(ir())).concat(await failures(ir()))).toEqual([]);
	});

	test("rejects a value off the param schema", async () => {
		const [found] = await failures(await golden("guards-and-escalation.json"), {
			params: { maxParts: "x" },
		});
		expect([found?.code, found?.message]).toEqual([
			"CFG.params",
			"param 'maxParts' must be integer",
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
	const hints = async (config: Record<string, unknown>) =>
		(await failures(await ir(), { config, hosts: [fakeHost(), unused] })).map(
			(d) => [d.code, d.hint],
		);

	test.each([
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
			"Remove 'fa' from the config, or install what claims it",
		],
		[
			"an unclaimed key",
			{ zzzzz: {} },
			"CFG.unclaimed",
			"Remove 'zzzzz' from the config, or install what claims it",
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
	])("rejects %s", async (_, config, want, hint) => {
		const core = { core: { type: "object", additionalProperties: false } };
		const found = await failures(await ir(), {
			config,
			core,
			hosts: [fakeHost(), unused],
		});
		expect(found.map((d) => [d.code, d.hint])).toEqual([[want, hint]]);
	});

	test("ignores the namespace of an installed host the graph does not use (D-24)", async () => {
		expect(await hints({ other: {} })).toEqual([]);
	});

	test("checks the IR's own config namespaces", async () => {
		const found = await failures(await golden("guards-and-escalation.json"), {
			config: { fake: { retries: "x" } },
			hosts: [fakeHost({ config: {} })],
		});
		expect(found.map((d) => d.message)).toEqual([
			"config 'fake.retries' must be integer",
		]);
	});
});
