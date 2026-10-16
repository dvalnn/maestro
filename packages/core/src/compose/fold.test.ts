import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_TYPES, MAESTRO_TYPE, reject, settledSchema } from "@maestro/ir";
import type { CodeFunction } from "../worker";
import {
	code,
	composeWith,
	data,
	fakeHost,
	HASH,
	irOf,
	loader,
} from "./fixtures/support";

const STRING = { type: "string" };
const BOOLEAN = { type: "boolean" };

const functions: Record<string, CodeFunction> = {
	upper: ({ name }) => ({ text: String(name).toUpperCase() }),
	exclaim: ({ text }) => ({ text: `${text}!` }),
	flag: ({ on }) => ({ yes: on }),
	refuse: () => reject("not today"),
	clock: (_, ctx) => ({ text: String(ctx.clock) }),
	concert: (_, ctx) => ({ text: ctx.concert }),
	boom: () => {
		throw new Error("boom");
	},
	number: () => ({ text: 3 }) as never,
	os: (_, ctx) => ({ text: String((ctx.env.fake as { os: string }).os) }),
	lenses: () => ({ items: ["x", "y", "z"] }),
	list: ({ n }) => ({
		items: ["a b", "c", "a_b", "d", "e"].slice(0, Number(n)),
	}),
	firstChar: ((item: string) => item[0]) as never,
	file: () => ({ file: "/somewhere" }),
	write: async (_, ctx) => {
		await Bun.write(join(ctx.scratch, "f.txt"), "x");
		return { text: "written" };
	},
	nothing: () => undefined as never,
	pathRead: (_, ctx) => ({ text: typeof ctx.path }),
	shown: ({ opts }) => ({ text: JSON.stringify(opts) }),
	pathCall: (_, ctx) => ({ text: (ctx.path as () => string)() }),
	index: ({ index, text }) => {
		if (Number(index) > 0) throw new Error("past the first iteration");
		return { text: `${text}${index}` };
	},
};

const named = (id: string, name: string, over: object = {}) =>
	code(id, name, {
		in: { name: STRING },
		literals: { name: "ab" },
		...over,
	});
const exclaim = (id: string) => code(id, "exclaim", { in: { text: STRING } });

const composed = (nodes: object[], edges: object[] = [], over: object = {}) =>
	composeWith(irOf(nodes, edges), { loadCode: loader(functions), ...over });

const plan = async (
	nodes: object[],
	edges: object[] = [],
	over: object = {},
) => {
	const result = await composed(nodes, edges, over);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.plan;
};

const codes = async (nodes: object[], edges: object[] = []) => {
	const result = await composed(nodes, edges);
	return result.ok ? [] : result.diagnostics.map((d) => [d.code, d.hint]);
};

const mapOver = (n: number, over: object = {}, list: object = {}) => [
	[
		code("m/u", "upper", { in: { name: STRING } }),
		code("p", "list", {
			in: { n: { type: "integer" } },
			literals: { n },
			out: { items: { type: "array", items: STRING } },
			...list,
		}),
		{
			id: "m",
			kind: "map",
			cardinality: { upTo: 4 },
			onError: "settle",
			in: { items: { type: "array", items: STRING } },
			inner: { item: STRING },
			out: {
				results: { type: "array", items: settledSchema({ type: "object" }) },
			},
			members: { r: "m/u" },
			...over,
		},
	],
	[
		data("p", "m", "items"),
		{
			kind: "data",
			from: { node: "m", port: "item" },
			to: { node: "m/u", port: "name" },
		},
	],
];

describe("fold", () => {
	test("folds pure code nodes whose inputs are known, through their dependents", async () => {
		const { folded } = await plan(
			[named("a", "upper"), exclaim("b")],
			[data("a", "b")],
		);
		expect(folded.b).toEqual({ "": { outcome: "ok", value: { text: "AB!" } } });
	});

	test("never folds an impure node or one with an artifact output", async () => {
		const artifact = { [MAESTRO_TYPE]: CORE_TYPES.file };
		const { folded } = await plan([
			named("impure", "upper", { pure: false }),
			code("artifact", "file", { out: { file: artifact } }),
		]);
		expect(folded).toEqual({});
	});

	test("makes the scratch directory with its parents only when a node uses it, and removes the node's", async () => {
		const scratch = join(tmpdir(), `compose-${crypto.randomUUID()}`, "deep");
		await plan(
			[code("a", "upper", { in: { name: STRING }, literals: { name: "x" } })],
			[],
			{ scratch },
		);
		expect(existsSync(scratch)).toBe(false);
		const { folded } = await plan([code("a", "write")], [], { scratch });
		expect(folded.a?.[""]).toEqual({
			outcome: "ok",
			value: { text: "written" },
		});
		expect(readdirSync(scratch)).toEqual([]);
	});

	test("loads each function once per compose", async () => {
		let loads = 0;
		const load = loader(functions);
		const [nodes = [], edges = []] = mapOver(2);
		const again = code("x", "upper", {
			in: { name: STRING },
			literals: { name: "z" },
		});
		await plan([...nodes, again], edges, {
			loadCode: (ref: Parameters<typeof load>[0]) => {
				loads++;
				return load(ref);
			},
		});
		expect(loads).toBe(2);
	});

	test("hands a folded node the hosts' environment", async () => {
		const { folded } = await plan([code("a", "os")], [], {
			hosts: [fakeHost({ environment: () => ({ os: "linux" }) })],
		});
		expect(folded.a?.[""]).toEqual({ outcome: "ok", value: { text: "linux" } });
	});

	const guarded = (on: boolean, over: object = {}) =>
		plan(
			[
				code("g", "flag", {
					in: { on: BOOLEAN },
					literals: { on },
					out: { yes: BOOLEAN },
					...over,
				}),
				named("t", "upper"),
				exclaim("d"),
			],
			[
				{
					kind: "control",
					from: { node: "g", port: "yes" },
					to: { node: "t" },
				},
				data("t", "d"),
			],
		);

	test("a known false guard skips its target and what depends on it", async () => {
		const { folded } = await guarded(false);
		expect(folded.t?.[""]).toEqual({
			outcome: "skipped",
			reason: "its guard is false",
		});
		expect(folded.d?.[""]).toEqual({
			outcome: "skipped",
			reason: "'t' is skipped",
		});
	});

	test("a known true guard lets its target fold", async () => {
		const { folded } = await guarded(true);
		expect(folded.d?.[""]).toEqual({ outcome: "ok", value: { text: "AB!" } });
	});

	test("an unknown guard leaves its target and what depends on it unfolded", async () => {
		const { folded } = await guarded(true, { pure: false });
		expect(folded).toEqual({});
	});

	test("a rejection is folded, and only a tolerant ordering edge or repeat admits it (CORE-04)", async () => {
		const after = (to: string, tolerate?: string) => ({
			kind: "control",
			from: { node: "r" },
			to: { node: to },
			...(tolerate ? { tolerate } : {}),
		});
		const { folded } = await plan(
			[
				code("r", "refuse"),
				exclaim("d"),
				named("strict", "upper"),
				named("tolerant", "upper"),
				code("loop/step", "exclaim", { pure: false, in: { text: STRING } }),
				{
					id: "loop",
					kind: "repeat",
					cardinality: { upTo: 2 },
					tolerate: "rejected",
					in: { text: STRING },
					inner: { index: { type: "integer" }, text: STRING },
					out: { text: STRING },
					members: { result: "loop/step" },
				},
			],
			[
				data("r", "d"),
				after("strict"),
				after("tolerant", "rejected"),
				data("r", "loop"),
				data("loop", "loop/step"),
			],
		);
		expect(folded.r?.[""]).toEqual({
			outcome: "rejected",
			reason: "not today",
		});
		expect(folded.d?.[""]).toEqual({
			outcome: "skipped",
			reason: "'r' is rejected",
		});
		expect(folded.strict?.[""]?.outcome).toBe("skipped");
		expect(folded.tolerant?.[""]).toEqual({
			outcome: "ok",
			value: { text: "AB" },
		});
		expect(folded.loop).toBeUndefined();
	});

	test("a fan-in node is not skipped for a rejected input (ADR 0006)", async () => {
		const fanin = code("f", "exclaim", {
			fanin: true,
			in: { text: settledSchema(STRING) },
		});
		const { folded } = await plan(
			[code("r", "refuse"), fanin],
			[data("r", "f")],
		);
		expect(folded.f).toBeUndefined();
	});

	test("a folded node's inputs are checked without their schema defaults", async () => {
		const opts = {
			type: "object",
			properties: { n: { type: "integer", default: 3 } },
		};
		const { folded } = await plan([
			code("a", "shown", { in: { opts }, literals: { opts: {} } }),
		]);
		expect(folded.a?.[""]).toEqual({ outcome: "ok", value: { text: "{}" } });
	});

	test("a node that only reads ctx.path folds", async () => {
		const { folded } = await plan([code("a", "pathRead")]);
		expect(folded.a?.[""]).toEqual({
			outcome: "ok",
			value: { text: "function" },
		});
	});

	test.each([
		["pathCall", "PURE.ambient", "Mark node 'a' pure: false to use ctx.path"],
		["clock", "PURE.ambient", "Mark node 'a' pure: false to use ctx.clock"],
		["concert", "PURE.ambient", "Mark node 'a' pure: false to use ctx.concert"],
		[
			"boom",
			"PURE.fold",
			"Fix 'boom' in 'test.ts', which fails on these inputs",
		],
		[
			"number",
			"TYPE.output",
			expect.stringContaining("return outputs that match"),
		],
		[
			"nothing",
			"PURE.fold",
			"Fix 'nothing' in 'test.ts', which fails on these inputs",
		],
	])(
		"a node that fails to fold with '%s' stops compose with %s",
		async (name, want, hint) => {
			expect(await codes([code("a", name)])).toEqual([[want, hint]]);
		},
	);

	test("a node folded with inputs off its in schemas points at what feeds it", async () => {
		const node = code("a", "upper", {
			in: { name: { type: "integer" } },
			literals: { name: "x" },
		});
		expect(await codes([node])).toEqual([
			[
				"PURE.fold",
				"Feed 'a' values that match its in schemas: fix the edges, params or literals that feed it",
			],
		]);
	});

	const absent = (module: string) => ({
		runtime: "ts",
		module,
		export: "absent",
		codeHash: module === "maestro:stdlib" ? "maestro:stdlib@0.1.0" : HASH,
	});

	test.each([
		["a node compose does not fold", "greet.ts"],
		["a stdlib node", "maestro:stdlib"],
	])("a function compose cannot load stops compose: %s", async (_, module) => {
		const node = code("a", "absent", { pure: false, worker: absent(module) });
		expect(await codes([node])).toEqual([
			[
				"SCOPE.export",
				`Export 'absent' from '${module}', or fix the worker reference of 'a'`,
			],
		]);
	});

	test("a key function compose cannot load stops compose, though the map's items are unknown", async () => {
		const [nodes = [], edges = []] = mapOver(
			2,
			{ key: absent("greet.ts") },
			{ pure: false },
		);
		expect(await codes(nodes, edges)).toEqual([
			[
				"SCOPE.export",
				"Export 'absent' from 'greet.ts', or fix the worker reference of 'm'",
			],
		]);
	});

	test("a loaded value that is not a function stops compose", async () => {
		const result = await composed([code("a", "upper", { pure: false })], [], {
			loadCode: async () => 42 as never,
		});
		expect(result.ok ? [] : result.diagnostics.map((d) => d.message)).toEqual([
			"compose cannot load 'upper' from 'test.ts' for 'a': 'upper' in 'test.ts' is not a function",
		]);
	});

	test("an assert on known inputs folds, and a false one stops compose", async () => {
		const assert = (cond: boolean) => ({
			id: "check",
			kind: "assert",
			in: { cond: BOOLEAN },
			literals: { cond },
			message: "needs it",
			onFail: "failed",
		});
		expect((await plan([assert(true)])).folded.check?.[""]?.outcome).toBe("ok");
		expect(await codes([assert(false)])).toEqual([
			["ASSERT.failed", "Change the params or config that break it"],
		]);
	});
});

describe("expansion", () => {
	const keyFn = {
		key: {
			runtime: "ts",
			module: "test.ts",
			export: "firstChar",
			codeHash: HASH,
		},
	};

	test("expands a map over known items into keyed instances, each folded", async () => {
		const [nodes, edges] = mapOver(2);
		const { expansion, folded, bounds } = await plan(nodes ?? [], edges);
		expect(expansion.m).toEqual({ "": { keys: ["a_b", "c"] } });
		expect(folded["m/u"]).toEqual({
			"[a_b]": { outcome: "ok", value: { text: "A B" } },
			"[c]": { outcome: "ok", value: { text: "C" } },
		});
		expect(bounds.nodes["m/u"]).toEqual({ exact: 2 });
	});

	const guardedMap = (flag: object) => {
		const [nodes = [], edges = []] = mapOver(2);
		const guard = {
			kind: "control",
			from: { node: "g", port: "yes" },
			to: { node: "m" },
		};
		return plan(
			[...nodes, code("g", "flag", { out: { yes: BOOLEAN }, ...flag })],
			[...edges, guard],
			{
				loadCode: loader({
					...functions,
					upper: () => {
						throw new Error("folded");
					},
					flag: () => ({ yes: false }),
				}),
			},
		);
	};

	test("leaves a group under a false guard a region, and folds nothing in it", async () => {
		const { expansion, folded } = await guardedMap({});
		expect(expansion.m).toEqual({ "": { upTo: 4 } });
		expect(folded.m).toEqual({
			"": { outcome: "skipped", reason: "its guard is false" },
		});
		expect(folded["m/u"]).toBeUndefined();
	});

	test("leaves a group under an unknown guard a region, and folds nothing in it", async () => {
		const { expansion, folded } = await guardedMap({ pure: false });
		expect(expansion.m).toEqual({ "": { upTo: 4 } });
		expect(Object.keys(folded)).toEqual(["p"]);
	});

	test("leaves a repeat a region, folding only its first iteration from its inputs", async () => {
		const INTEGER = { type: "integer" };
		const { expansion, folded } = await plan(
			[
				code("r/s", "index", { in: { index: INTEGER, text: STRING } }),
				{
					id: "r",
					kind: "repeat",
					cardinality: { upTo: 5 },
					in: { text: STRING },
					literals: { text: "s" },
					inner: { index: INTEGER, text: STRING },
					out: { text: STRING },
					members: { result: "r/s" },
				},
			],
			["index", "text"].map((port) => ({
				kind: "data",
				from: { node: "r", port },
				to: { node: "r/s", port },
			})),
		);
		expect(expansion.r).toEqual({ "": { upTo: 5 } });
		expect(folded["r/s"]).toEqual({
			"[0]": { outcome: "ok", value: { text: "s0" } },
		});
	});

	test.each([
		[{}, { keys: ["0", "1"] }, { upTo: 2 }, ["[0]", "[1]"]],
		[{ until: { node: "q/u", port: "ok" } }, { upTo: 2 }, { upTo: 2 }, ["[0]"]],
	])(
		"a seq over known items with %o expands to %o",
		async (over, want, count, instances) => {
			const { expansion, folded, bounds } = await plan(
				[
					code("q/u", "upper", { in: { name: STRING } }),
					{
						id: "q",
						kind: "seq",
						cardinality: { upTo: 2 },
						items: ["a", "b"],
						inner: { item: STRING },
						out: { text: STRING },
						members: { result: "q/u" },
						...over,
					},
				],
				[
					{
						kind: "data",
						from: { node: "q", port: "item" },
						to: { node: "q/u", port: "name" },
					},
				],
			);
			expect(expansion.q).toEqual({ "": want });
			expect(Object.keys(folded["q/u"] ?? {})).toEqual(instances);
			expect(folded["q/u"]?.["[0]"]).toEqual({
				outcome: "ok",
				value: { text: "A" },
			});
			expect(bounds.nodes["q/u"]).toEqual(count);
		},
	);

	test.each([
		[20, [], ["lenses", "upper"], { exact: 11 }],
		[
			6,
			["'instances' may reach at least 11, over its cap of 6"],
			["lenses"],
			undefined,
		],
	])(
		"caps instances at %d, under an IR bound of 32, with 11 known",
		async (instances, messages, called, bound) => {
			const [nodes = [], edges = []] = mapOver(
				3,
				{ cardinality: { upTo: 10 } },
				{
					worker: {
						runtime: "ts",
						module: "test.ts",
						export: "lenses",
						codeHash: HASH,
					},
				},
			);
			const body = ["m/v", "m/w"].map((id) =>
				code(id, "boom", { pure: false }),
			);
			const calls = new Set<string>();
			const spy =
				(name: string): CodeFunction =>
				(inputs, ctx) => {
					calls.add(name);
					return functions[name]?.(inputs, ctx) ?? {};
				};
			const result = await composed([...body, ...nodes], edges, {
				caps: { instances },
				loadCode: loader({
					...functions,
					lenses: spy("lenses"),
					upper: spy("upper"),
				}),
			});
			expect(result.ok ? [] : result.diagnostics.map((d) => d.message)).toEqual(
				messages,
			);
			expect([...calls]).toEqual(called);
			expect(result.ok ? result.plan.bounds.instances : undefined).toEqual(
				bound,
			);
		},
	);

	test("keys a map through its key function", async () => {
		const [nodes, edges] = mapOver(2, keyFn);
		expect((await plan(nodes ?? [], edges)).expansion.m).toEqual({
			"": { keys: ["a", "c"] },
		});
	});

	test("leaves a map over unknown items a region of up to its bound", async () => {
		const [nodes, edges] = mapOver(2, {}, { pure: false });
		const { expansion, bounds } = await plan(nodes ?? [], edges);
		expect(expansion.m).toEqual({ "": { upTo: 4 } });
		expect(bounds.nodes["m/u"]).toEqual({ upTo: 4 });
	});

	test.each([
		[
			3,
			{},
			"SCOPE.key",
			"Give map 'm' a key function, or make its items distinct",
		],
		[
			4,
			keyFn,
			"SCOPE.key",
			"Make 'firstChar' return a distinct key for each item",
		],
		[5, {}, "BOUND.items", "Raise the bound of 'm' to 5 or more"],
	])("%i items under %o give %s", async (n, over, want, hint) => {
		const [nodes, edges] = mapOver(n, over);
		expect(await codes(nodes ?? [], edges)).toEqual([[want, hint]]);
	});
});
