import { describe, expect, test } from "bun:test";
import { IMPLICIT_OUT, settledSchema } from "@maestro/ir";
import type { CodeEntry, KeyFunction } from "../node";
import { code, composeWith, HASH, irOf, loader } from "./fixtures/support";

const STRING = { type: "string" };
const BOOLEAN = { type: "boolean" };

const keyFn = {
	key: {
		runtime: "ts",
		module: "test.ts",
		export: "firstChar",
		codeHash: HASH,
	},
};

/** A parMap `m` over `items`, its body `m/u` reading each item, with `over` merged on the parMap. */
const mapOver = (items: unknown, over: object = {}) => [
	code("m/u", "upper", { in: { name: STRING } }),
	{
		id: "m",
		kind: "parMap",
		cardinality: { upTo: 4 },
		onError: "continue",
		in: { items: { type: "array", items: STRING } },
		literals: { items },
		inner: { item: STRING },
		out: {
			results: { type: "array", items: settledSchema({ type: "object" }) },
		},
		members: { r: "m/u" },
		...over,
	},
];

const intoBody = (group: string, port: string, to: string, toPort: string) => ({
	kind: "data",
	from: { node: group, port },
	to: { node: to, port: toPort },
});

const composed = (nodes: object[], edges: object[] = [], over: object = {}) =>
	composeWith(irOf(nodes, edges), over);

const plan = async (nodes: object[], edges: object[] = [], over = {}) => {
	const result = await composed(nodes, edges, over);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.plan;
};

const codes = async (nodes: object[], edges: object[] = []) => {
	const result = await composed(nodes, edges);
	return result.ok ? [] : result.diagnostics.map((d) => [d.code, d.hint]);
};

const body = [intoBody("m", "item", "m/u", "name")];

describe("compose calls no author code (ADR 0009)", () => {
	test("loads each function once, and calls neither a code node's nor a key function", async () => {
		const calls: string[] = [];
		let loads = 0;
		const spy =
			(name: string): CodeEntry & KeyFunction =>
			() => {
				calls.push(name);
				return { text: name };
			};
		const nodes = [
			...mapOver(["a", "b"], keyFn),
			code("x", "upper", { in: { name: STRING }, literals: { name: "z" } }),
		];
		const load = loader({ upper: spy("upper"), firstChar: spy("firstChar") });
		await plan(nodes, body, {
			loadCode: (ref: Parameters<typeof load>[0]) => {
				loads++;
				return load(ref);
			},
		});
		expect(loads).toBe(2);
		expect(calls).toEqual([]);
	});

	const absent = (module: string) => ({
		runtime: "ts",
		module,
		export: "absent",
		codeHash: module === "maestro:stdlib" ? "maestro:stdlib@0.1.0" : HASH,
	});

	test.each([
		["a code node", "greet.ts"],
		["a stdlib node", "maestro:stdlib"],
	])("a function compose cannot load stops compose: %s", async (_, module) => {
		const node = code("a", "absent", { worker: absent(module) });
		expect(await codes([node])).toEqual([
			[
				"SCOPE.export",
				`Export 'absent' from '${module}', or fix the worker reference of 'a'`,
			],
		]);
	});

	test("a key function compose cannot load stops compose", async () => {
		expect(
			await codes(mapOver(["a"], { key: absent("greet.ts") }), body),
		).toEqual([
			[
				"SCOPE.export",
				"Export 'absent' from 'greet.ts', or fix the worker reference of 'm'",
			],
		]);
	});

	test("a loaded value that is not a function stops compose", async () => {
		const result = await composed([code("a", "upper")], [], {
			loadCode: async () => 42 as never,
		});
		expect(result.ok ? [] : result.diagnostics.map((d) => d.message)).toEqual([
			"compose cannot load 'upper' from 'test.ts' for 'a': 'upper' in 'test.ts' is not a function",
		]);
	});
});

describe("expansion", () => {
	test("expands a parMap over a plain list into keyed instances", async () => {
		const { expansion, bounds } = await plan(mapOver(["a b", "c"]), body);
		expect(expansion.m).toEqual({ "": { keys: ["a_b", "c"] } });
		expect(bounds.nodes["m/u"]).toEqual({ exact: 2 });
	});

	test("counts a parMap keyed by a key function without calling it, though its keys would collide, and up to its groups' bounds below", async () => {
		const { expansion, bounds } = await plan(
			mapOver(["ab", "ac", "b"], keyFn),
			body,
		);
		expect(expansion.m).toEqual({ "": { exact: 3 } });
		expect(bounds.nodes["m/u"]).toEqual({ exact: 3 });
		const inner = mapOver(["p", "q"], { id: "m/n", members: { r: "m/n/u" } });
		const nested = await plan(
			[
				code("m/n/u", "upper", { in: { name: STRING } }),
				...inner.slice(1),
				...mapOver(["ab", "ac", "b"], {
					...keyFn,
					members: { r: "m/u", n: "m/n" },
				}),
			],
			[...body, intoBody("m/n", "item", "m/n/u", "name")],
		);
		expect(nested.bounds.nodes["m/n/u"]).toEqual({ upTo: 12 });
	});

	test("keys a parMap over an enclosing parMap's item per outer instance, naming the instance", async () => {
		const inner = {
			id: "o/m",
			kind: "parMap",
			cardinality: { upTo: 3 },
			onError: "continue",
			in: { items: { type: "array", items: STRING } },
			inner: { item: STRING },
			out: { results: { type: "array" } },
			members: { r: "o/m/u" },
		};
		const outer = {
			id: "o",
			kind: "parMap",
			cardinality: { exact: 2 },
			onError: "continue",
			items: [
				["x", "y"],
				["z", "z"],
			],
			inner: { item: { type: "array", items: STRING } },
			out: { results: { type: "array" } },
			members: { r: "o/m" },
		};
		const result = await composed(
			[code("o/m/u", "upper", { in: { name: STRING } }), inner, outer],
			[
				intoBody("o", "item", "o/m", "items"),
				intoBody("o/m", "item", "o/m/u", "name"),
			],
		);
		expect(result.ok ? [] : result.diagnostics).toEqual([
			expect.objectContaining({
				code: "SCOPE.key",
				message: "parMap 'o[1]/m' gives items 0 and 1 the same key 'z'",
			}),
		]);
	});

	const list = code("p", "list", {
		out: { items: { type: "array", items: STRING } },
	});
	const guard = {
		kind: "control",
		from: { node: "g", port: "yes" },
		to: { node: "m" },
	};

	test.each([
		[
			"a parMap over a node's result",
			[list, ...mapOver(undefined, { literals: {} })],
			[...body, intoBody("p", "items", "m", "items")],
		],
		[
			"a parMap under a guard a node feeds",
			[code("g", "flag", { out: { yes: BOOLEAN } }), ...mapOver(["a"])],
			[...body, guard],
		],
	])("leaves %s a region of up to its bound", async (_, nodes, edges) => {
		const { expansion, bounds } = await plan(nodes, edges);
		expect(expansion.m).toEqual({ "": { upTo: 4 } });
		expect(bounds.nodes["m/u"]).toEqual({ upTo: 4 });
	});

	test("leaves a loop a region", async () => {
		const INTEGER = { type: "integer" };
		const { ok, reason } = IMPLICIT_OUT;
		const { expansion } = await plan(
			[
				code("r/s", "index", { in: { index: INTEGER, text: STRING } }),
				{
					id: "r",
					kind: "loop",
					cardinality: { upTo: 5 },
					in: { text: STRING },
					literals: { text: "s" },
					inner: { ok, reason, index: INTEGER, text: STRING },
					out: { text: STRING },
					members: { result: "r/s" },
					test: { at: "end", port: { node: "r/s", port: "ok" } },
				},
			],
			["index", "text"].map((port) => intoBody("r", port, "r/s", port)),
		);
		expect(expansion.r).toEqual({ "": { upTo: 5 } });
	});

	test.each([
		[
			{ kind: "map", onError: "stop", out: { results: { type: "array" } } },
			{ keys: ["0", "1"] },
			{ upTo: 2 },
		],
		[
			{ kind: "find", cond: { node: "q/u", port: "ok" } },
			{ upTo: 2 },
			{ upTo: 2 },
		],
		[
			{ kind: "parFind", cond: { node: "q/u", port: "ok" } },
			{ upTo: 2 },
			{ upTo: 2 },
		],
	])(
		"a group over a plain list as %o expands to %o",
		async (over, want, count) => {
			const { expansion, bounds } = await plan(
				[
					code("q/u", "upper", { in: { name: STRING } }),
					{
						id: "q",
						cardinality: { upTo: 2 },
						items: ["a", "b"],
						inner: { item: STRING },
						out: { text: STRING },
						members: { result: "q/u" },
						...over,
					},
				],
				[intoBody("q", "item", "q/u", "name")],
			);
			expect(expansion.q).toEqual({ "": want });
			expect(bounds.nodes["q/u"]).toEqual(count);
		},
	);

	test("expands a fold over a plain list into one instance per index, each phase up to its bound", async () => {
		const { ok, reason } = IMPLICIT_OUT;
		const phase = (id: string) =>
			code(id, "upper", { in: { name: STRING }, out: { text: STRING } });
		const { expansion, bounds } = await plan(
			[
				phase("f/first/u"),
				phase("f/step/u"),
				{
					id: "f",
					kind: "fold",
					cardinality: { upTo: 3 },
					items: ["a", "b", "c"],
					inner: {
						item: STRING,
						text: STRING,
						ok,
						reason,
						index: { type: "integer" },
					},
					out: { text: STRING },
					members: { first: "f/first/u", step: "f/step/u" },
					first: ["f/first/u"],
				},
			],
			["f/first/u", "f/step/u"].map((to) => intoBody("f", "item", to, "name")),
		);
		expect(expansion.f).toEqual({ "": { keys: ["0", "1", "2"] } });
		expect(bounds.nodes["f/step/u"]).toEqual({ upTo: 3 });
	});

	test.each([
		[
			["a", "a"],
			{},
			"SCOPE.key",
			"Give parMap 'm' a key function, or make its items distinct",
		],
		[
			["a", "b", "c", "d", "e"],
			{},
			"BOUND.items",
			"Raise the bound of 'm' to 5 or more",
		],
		[
			["a", "b", "c", "d", "e"],
			keyFn,
			"BOUND.items",
			"Raise the bound of 'm' to 5 or more",
		],
	])("items %o under %o give %s", async (items, over, want, hint) => {
		expect(await codes(mapOver(items, over), body)).toEqual([[want, hint]]);
	});

	test.each([
		[20, [], { exact: 7 }],
		[6, ["'instances' may reach at least 7, over its cap of 6"], undefined],
	])(
		"caps instances at %d, under an IR bound of 21, with 7 known",
		async (instances, messages, bound) => {
			const nodes = [
				code("m/v", "upper"),
				...mapOver(["a", "b", "c"], { cardinality: { upTo: 10 } }),
			];
			const result = await composed(nodes, body, { caps: { instances } });
			expect(result.ok ? [] : result.diagnostics.map((d) => d.message)).toEqual(
				messages,
			);
			expect(result.ok ? result.plan.bounds.instances : undefined).toEqual(
				bound,
			);
		},
	);
});
