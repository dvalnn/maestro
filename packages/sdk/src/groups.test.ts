import { describe, expect, test } from "bun:test";
import { buildOf, diagnose, nodeOf } from "./fixtures/context";
import { partKey } from "./fixtures/workers";
import {
	Bool,
	hostNode,
	Int,
	List,
	map,
	type Ref,
	repeat,
	seq,
	Text,
} from "./index";

const task = (inputs: Record<string, unknown> = {}, label?: string) =>
	hostNode("fake.task", {
		label,
		in: inputs,
		out: { text: Text(), done: Bool() },
	});

const list = () =>
	hostNode("fake.list", { out: { items: List(Text()) } }).out.items;

describe("map", () => {
	test("over build-time items has an exact size and one member per body", () => {
		const ir = buildOf(() =>
			map(["a", "b"], (item) => task({ prompt: item }), { onError: "settle" }),
		);
		expect(nodeOf(ir, "map")).toMatchObject({
			kind: "map",
			items: ["a", "b"],
			cardinality: { exact: 2 },
			onError: "settle",
			inner: { item: { type: "string" } },
			members: { result: "map/task" },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "map", port: "item" },
			to: { node: "map/task", port: "prompt" },
		});
	});

	test("over a Ref takes its items by edge, bounded by max", () => {
		const ir = buildOf(() =>
			map(list(), (item) => task({ prompt: item }), {
				onError: "propagate",
				max: 4,
			}),
		);
		expect(nodeOf(ir, "map")).toMatchObject({
			cardinality: { upTo: 4 },
			in: { items: { type: "array", items: { type: "string" } } },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "list", port: "items" },
			to: { node: "map", port: "items" },
		});
	});

	test("an object of results is one member per entry", () => {
		const ir = buildOf(() =>
			map([1, 2], () => ({ a: task({}, "a"), b: task({}, "b") }), {
				onError: "settle",
			}),
		);
		expect(nodeOf(ir, "map")).toMatchObject({
			members: { a: "map/a", b: "map/b" },
		});
	});

	test("a key function is emitted as a worker", () => {
		const ir = buildOf(() =>
			map([{ name: "x" }, { name: "x" }], () => task(), {
				onError: "settle",
				key: partKey,
			}),
		);
		expect(nodeOf(ir, "map")).toMatchObject({ key: { export: "partKey" } });
	});

	test.each<[string, unknown[]]>([
		["primitive", ["a", "b", "a"]],
		["numeric", [1, 2, 1]],
		["sanitized alike", ["a b", "a_b"]],
		["index and primitive", [{ a: 1 }, "0"]],
	])("duplicate %s items fail with SCOPE.key", (_name, items) => {
		const error = diagnose(() =>
			buildOf(() => map(items, () => task(), { onError: "settle" })),
		);
		expect(error.code).toBe("SCOPE.key");
	});

	test.each<[string, unknown[]]>([
		["structured items keyed by index", [{ a: 1 }, { a: 1 }]],
		["null and the index it stands at", [null, "0"]],
	])("%s are distinct", (_name, items) => {
		const ir = buildOf(() => map(items, () => task(), { onError: "settle" }));
		expect(nodeOf(ir, "map")).toMatchObject({ cardinality: { exact: 2 } });
	});

	test.each([
		[
			"a Ref without max",
			() => map(list(), () => task(), { onError: "settle" }),
		],
		[
			"build-time items with max",
			() => map(["a"], () => task(), { onError: "settle", max: 2 }),
		],
		[
			"a max below 1",
			() => map(list(), () => task(), { onError: "settle", max: 0 }),
		],
	])("%s fails with BOUND.max", (_name, fn) => {
		expect(diagnose(() => buildOf(fn)).code).toBe("BOUND.max");
	});

	test("a body that returns no node inside it fails with TYPE.member", () => {
		const error = diagnose(() =>
			buildOf(() => {
				const outside = task();
				return map(["a"], () => outside, { onError: "settle" });
			}),
		);
		expect(error.code).toBe("TYPE.member");
	});

	test("an item Ref read outside its body fails with REF.escape", () => {
		const error = diagnose(() =>
			buildOf(() => {
				let leaked: Ref<string> | undefined;
				map(
					["a"],
					(item) => {
						leaked = item;
						return task();
					},
					{ onError: "settle" },
				);
				return task({ prompt: leaked });
			}),
		);
		expect(error.code).toBe("REF.escape");
	});
});

describe("seq", () => {
	test("tries items in order up to until, and mirrors its member's outputs", () => {
		const ir = buildOf(() =>
			seq(["a", "b"], (item) => task({ prompt: item }), {
				until: (r) => r.ok,
			}),
		);
		expect(nodeOf(ir, "seq")).toMatchObject({
			kind: "seq",
			cardinality: { upTo: 2 },
			members: { result: "seq/task" },
			until: { node: "seq/task", port: "ok" },
			out: { text: { type: "string" }, done: { type: "boolean" } },
		});
	});

	test("until may read a Bool output of the member", () => {
		const ir = buildOf(() =>
			seq(["a"], () => task(), { until: (r) => r.out.done }),
		);
		expect(nodeOf(ir, "seq")).toMatchObject({
			until: { node: "seq/task", port: "done" },
		});
	});

	test("an until that compares a Ref fails with REF.bool and names the fix", () => {
		const error = diagnose(() =>
			buildOf(() =>
				seq(["a"], () => task(), {
					until: (r) => (r.outcome !== ("ok" as never)) as never,
				}),
			),
		);
		expect(error.code).toBe("REF.bool");
		expect(error.hint).toContain("!==");
	});

	test("an until that reads a node outside the body fails with REF.bool", () => {
		const error = diagnose(() =>
			buildOf(() => {
				const outside = task();
				return seq(["a"], () => task(), { until: () => outside.ok });
			}),
		);
		expect(error.code).toBe("REF.bool");
	});

	test("over an empty list fails with BOUND.max", () => {
		expect(diagnose(() => buildOf(() => seq([], () => task()))).code).toBe(
			"BOUND.max",
		);
	});
});

describe("repeat", () => {
	const counter = (inputs: Record<string, unknown>, label?: string) =>
		hostNode("fake.count", {
			label,
			in: inputs,
			out: { n: Int(), done: Bool() },
		});

	test("threads the state from init through its step, bounded by max", () => {
		const ir = buildOf(() =>
			repeat({
				init: counter({}, "init"),
				step: (state, index) => counter({ n: state.out.n, index }),
				until: (r) => r.out.done,
				max: 3,
				tolerate: "rejected",
			}),
		);
		expect(nodeOf(ir, "repeat")).toMatchObject({
			kind: "repeat",
			cardinality: { upTo: 3 },
			tolerate: "rejected",
			in: { n: { type: "integer" }, done: { type: "boolean" } },
			out: { n: { type: "integer" }, done: { type: "boolean" } },
			inner: {
				n: { type: "integer" },
				done: { type: "boolean" },
				index: { type: "integer" },
			},
			members: { result: "repeat/count" },
			until: { node: "repeat/count", port: "done" },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "init", port: "n" },
			to: { node: "repeat", port: "n" },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "repeat", port: "index" },
			to: { node: "repeat/count", port: "index" },
		});
	});

	test.each([
		["names", () => task()],
		[
			"types",
			() =>
				hostNode("fake.count", { in: {}, out: { n: Text(), done: Bool() } }),
		],
	])(
		"a step whose output %s differ from the state fails with TYPE.state",
		(_name, step) => {
			const error = diagnose(() =>
				buildOf(() =>
					repeat({
						init: counter({}),
						step: () => step() as never,
						max: 2,
					}),
				),
			);
			expect(error.code).toBe("TYPE.state");
		},
	);

	test("a state port named index fails with TYPE.state", () => {
		const indexed = () =>
			hostNode("fake.count", { in: {}, out: { index: Int() } });
		const error = diagnose(() =>
			buildOf(() => repeat({ init: indexed(), step: indexed, max: 2 })),
		);
		expect(error).toMatchObject({
			code: "TYPE.state",
			message:
				"the state of repeat 'repeat' has a port named 'index', which names the iteration",
		});
	});

	test("an init that is not a node's result fails with TYPE.member", () => {
		const error = diagnose(() =>
			buildOf(() =>
				repeat({
					init: counter({}).out.n as never,
					step: (s) => s as never,
					max: 2,
				}),
			),
		);
		expect(error.code).toBe("TYPE.member");
	});

	test("a missing max fails with BOUND.max", () => {
		const error = diagnose(() =>
			buildOf(() =>
				repeat({
					init: counter({}),
					step: (s) => counter({ n: s.out.n }),
					max: undefined as never,
				}),
			),
		);
		expect(error.code).toBe("BOUND.max");
	});
});
