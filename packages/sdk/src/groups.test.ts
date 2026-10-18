import { describe, expect, test } from "bun:test";
import { buildOf, diagnose, nodeOf } from "./fixtures/context";
import { partKey } from "./fixtures/workers";
import { hostNode } from "./host";
import {
	assert,
	Bool,
	Int,
	iter,
	List,
	loop,
	not,
	type Ref,
	type Result,
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

describe("parMap", () => {
	test("over build-time items has an exact size and one member per body", () => {
		const ir = buildOf(() =>
			iter.parMap(["a", "b"], (item) => task({ prompt: item }), {
				onError: "continue",
			}),
		);
		expect(nodeOf(ir, "parMap")).toMatchObject({
			kind: "parMap",
			items: ["a", "b"],
			cardinality: { exact: 2 },
			onError: "continue",
			inner: { item: { type: "string" } },
			members: { result: "parMap/task" },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "parMap", port: "item" },
			to: { node: "parMap/task", port: "prompt" },
		});
	});

	test("over a Ref takes its items by edge, bounded by max", () => {
		const ir = buildOf(() =>
			iter.parMap(list(), (item) => task({ prompt: item }), {
				onError: "stop",
				max: 4,
			}),
		);
		expect(nodeOf(ir, "parMap")).toMatchObject({
			cardinality: { upTo: 4 },
			in: { items: { type: "array", items: { type: "string" } } },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "list", port: "items" },
			to: { node: "parMap", port: "items" },
		});
	});

	test("a member's value is its one result's outputs, or a record of them by result name", () => {
		const ir = buildOf(() => {
			iter.parMap(["a"], () => task(), { onError: "continue" });
			return iter.parMap(
				[1, 2],
				() => ({ a: task({}, "a"), b: task({}, "b") }),
				{ onError: "continue", label: "two" },
			);
		});
		const outputs = {
			type: "object",
			properties: { text: { type: "string" }, done: { type: "boolean" } },
		};
		expect(nodeOf(ir, "parMap")).toMatchObject({
			out: { results: { items: { properties: { value: outputs } } } },
		});
		expect(nodeOf(ir, "two")).toMatchObject({
			members: { a: "two/a", b: "two/b" },
			out: {
				results: {
					items: {
						properties: {
							value: { properties: { a: outputs, b: outputs } },
						},
					},
				},
			},
		});
	});

	test("a body that returns an object of one result fails with TYPE.member", () => {
		const error = diagnose(() =>
			buildOf(() =>
				iter.parMap(["a"], () => ({ only: task() }), { onError: "continue" }),
			),
		);
		expect(error).toMatchObject({
			code: "TYPE.member",
			hint: "Return that Result handle itself",
		});
	});

	test("a key function of a parMap or parFind is emitted as a worker", () => {
		const items = [{ name: "x" }, { name: "x" }];
		const ir = buildOf(() => {
			iter.parFind(
				items,
				() => task(),
				(r) => r.ok,
				{ key: partKey },
			);
			return iter.parMap(items, () => task(), {
				onError: "continue",
				key: partKey,
			});
		});
		for (const kind of ["parMap", "parFind"])
			expect(nodeOf(ir, kind)).toMatchObject({
				key: { export: "partKey" },
			});
	});

	test.each<[string, unknown[]]>([
		["primitive", ["a", "b", "a"]],
		["numeric", [1, 2, 1]],
		["sanitized alike", ["a b", "a_b"]],
		["index and primitive", [{ a: 1 }, "0"]],
	])("duplicate %s items fail with SCOPE.key", (_name, items) => {
		const error = diagnose(() =>
			buildOf(() => iter.parMap(items, () => task(), { onError: "continue" })),
		);
		expect(error.code).toBe("SCOPE.key");
	});

	test.each<[string, unknown[]]>([
		["structured items keyed by index", [{ a: 1 }, { a: 1 }]],
		["null and the index it stands at", [null, "0"]],
	])("%s are distinct", (_name, items) => {
		const ir = buildOf(() =>
			iter.parMap(items, () => task(), { onError: "continue" }),
		);
		expect(nodeOf(ir, "parMap")).toMatchObject({
			cardinality: { exact: 2 },
		});
	});

	test("max is typed for each iter function: none over a written list, required over a Ref", () => {
		const t = () => task();
		const c = (r: { ok: Ref<boolean> }) => r.ok;
		const go = { onError: "continue" } as const;
		const f = { first: t, step: t };
		const unbuilt = () => {
			// @ts-expect-error a written list sizes the group itself.
			iter.parMap(["a"], t, { ...go, max: 2 });
			// @ts-expect-error a written list sizes the group itself.
			iter.map(["a"], t, { ...go, max: 2 });
			// @ts-expect-error a written list sizes the group itself.
			iter.find(["a"], t, c, { max: 2 });
			// @ts-expect-error a written list sizes the group itself.
			iter.parFind(["a"], t, c, { max: 2 });
			// @ts-expect-error a written list sizes the group itself.
			iter.fold(["a"], { ...f, max: 2 });
			// @ts-expect-error a Ref needs a max.
			iter.parMap(list(), t, go);
			// @ts-expect-error a Ref needs a max.
			iter.map(list(), t, go);
			// @ts-expect-error a Ref needs a max.
			iter.find(list(), t, c);
			// @ts-expect-error a Ref needs a max.
			iter.parFind(list(), t, c);
			// @ts-expect-error a Ref needs a max.
			iter.fold(list(), f);
		};
		expect(unbuilt).toBeFunction();
	});

	test("a max below 1 fails with BOUND.max", () => {
		const error = diagnose(() =>
			buildOf(() =>
				iter.parMap(list(), () => task(), { onError: "continue", max: 0 }),
			),
		);
		expect(error.code).toBe("BOUND.max");
	});

	test("a body that returns no node inside it fails with TYPE.member", () => {
		const error = diagnose(() =>
			buildOf(() => {
				const outside = task();
				return iter.parMap(["a"], () => outside, { onError: "continue" });
			}),
		);
		expect(error.code).toBe("TYPE.member");
	});

	test("an item Ref read outside its body fails with REF.escape", () => {
		const error = diagnose(() =>
			buildOf(() => {
				let leaked: Ref<string> | undefined;
				iter.parMap(
					["a"],
					(item) => {
						leaked = item;
						return task();
					},
					{ onError: "continue" },
				);
				return task({ prompt: leaked });
			}),
		);
		expect(error.code).toBe("REF.escape");
	});
});

describe("map", () => {
	test("goes in order: at most its items, and its duplicates allowed", () => {
		const ir = buildOf(() =>
			iter.map(["a", "a"], (item) => task({ prompt: item }), {
				onError: "stop",
			}),
		);
		expect(nodeOf(ir, "map")).toMatchObject({
			kind: "map",
			cardinality: { upTo: 2 },
			onError: "stop",
			members: { result: "map/task" },
			out: { results: { type: "array" } },
		});
	});
});

describe.each(["find", "parFind"] as const)("%s", (kind) => {
	test("reads its condition on the member and mirrors its outputs", () => {
		const ir = buildOf(() =>
			iter[kind](
				["a", "b"],
				(item) => task({ prompt: item }),
				(r) => r.ok,
			),
		);
		expect(nodeOf(ir, kind)).toMatchObject({
			kind,
			cardinality: { upTo: 2 },
			members: { result: `${kind}/task` },
			cond: { node: `${kind}/task`, port: "ok" },
			out: { text: { type: "string" }, done: { type: "boolean" } },
		});
	});

	test("its condition may read a Bool output of the member", () => {
		const ir = buildOf(() =>
			iter[kind](
				["a"],
				() => task(),
				(r) => r.out.done,
			),
		);
		expect(nodeOf(ir, kind)).toMatchObject({
			cond: { node: `${kind}/task`, port: "done" },
		});
	});

	test("a condition that compares a Ref fails with REF.bool and names the fix", () => {
		const error = diagnose(() =>
			buildOf(() =>
				iter[kind](
					["a"],
					() => task(),
					(r) => (r.reason !== ("" as never)) as never,
				),
			),
		);
		expect(error.code).toBe("REF.bool");
		expect(error.hint).toContain("!==");
	});

	test("a condition that reads a node outside the body fails with REF.bool", () => {
		const error = diagnose(() =>
			buildOf(() => {
				const outside = task();
				return iter[kind](
					["a"],
					() => task(),
					() => outside.ok,
				);
			}),
		);
		expect(error.code).toBe("REF.bool");
	});
});

const one = () => task();

test.each([
	["parMap", () => iter.parMap([], one, { onError: "stop" })],
	["map", () => iter.map([], one, { onError: "stop" })],
	["find", () => iter.find([], one, (r) => r.ok)],
	["parFind", () => iter.parFind([], one, (r) => r.ok)],
	["fold", () => iter.fold([], { first: one, step: one })],
])("a %s over an empty written list has an exact size of 0", (kind, build) => {
	expect(nodeOf(buildOf(build), kind)).toMatchObject({
		items: [],
		cardinality: { exact: 0 },
	});
});

describe("fold", () => {
	const merged = (inputs: Record<string, unknown>, label?: string) =>
		hostNode("fake.merge", { label, in: inputs, out: { n: Int() } });

	test("seeds through first and adds each next item through step, each phase's ids under its name", () => {
		const ir = buildOf(() =>
			iter.fold(list(), {
				first: (item) => {
					assert(merged({}, "seed").ok, "seeded", { onFail: "rejected" });
					return merged({ item });
				},
				step: (acc, item, index) => merged({ n: acc.out.n, item, index }),
				max: 3,
				tolerate: "rejected",
			}),
		);
		expect(nodeOf(ir, "fold")).toMatchObject({
			kind: "fold",
			cardinality: { upTo: 3 },
			tolerate: "rejected",
			members: { first: "fold/first/merge", step: "fold/step/merge" },
			first: ["fold/first/seed", "fold/first/assert", "fold/first/merge"],
			out: { n: { type: "integer" } },
			inner: {
				item: { type: "string" },
				n: { type: "integer" },
				ok: { type: "boolean" },
				index: { type: "integer" },
			},
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "fold", port: "n" },
			to: { node: "fold/step/merge", port: "n" },
		});
	});

	test("a step whose outputs differ from first fails with TYPE.state", () => {
		const error = diagnose(() =>
			buildOf(() =>
				iter.fold(["a", "b"], {
					first: () => merged({}),
					step: () => task() as never,
				}),
			),
		);
		expect(error.code).toBe("TYPE.state");
	});

	test.each(["item", "ok"])(
		"an accumulator port named %s fails with TYPE.state",
		(port) => {
			const named = () =>
				hostNode("fake.merge", { in: {}, out: { [port]: Int() } });
			const error = diagnose(() =>
				buildOf(() => iter.fold(["a"], { first: named, step: named })),
			);
			expect(error).toMatchObject({
				code: "TYPE.state",
				message: `the state of fold 'fold' has a port named '${port}', a name the fold state holds itself`,
			});
		},
	);
});

describe("loop", () => {
	const counter = (inputs: Record<string, unknown>, label?: string) =>
		hostNode("fake.count", {
			label,
			in: inputs,
			out: { n: Int(), done: Bool() },
		});

	test("while reads its condition on the state before the step: a node of the body fed only by the state", () => {
		const ir = buildOf(() =>
			loop.while((state) => not(state.ok), {
				init: counter({}, "init"),
				step: (state, index) => counter({ n: state.out.n, index }),
				max: 3,
				tolerate: "rejected",
			}),
		);
		expect(nodeOf(ir, "loop")).toMatchObject({
			kind: "loop",
			cardinality: { upTo: 3 },
			tolerate: "rejected",
			in: { n: { type: "integer" }, done: { type: "boolean" } },
			out: { n: { type: "integer" }, done: { type: "boolean" } },
			inner: {
				n: { type: "integer" },
				done: { type: "boolean" },
				ok: { type: "boolean" },
				reason: { type: "string" },
				index: { type: "integer" },
			},
			members: { result: "loop/count" },
			test: { at: "start", port: { node: "loop/loop_not", port: "value" } },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "init", port: "n" },
			to: { node: "loop", port: "n" },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "loop", port: "ok" },
			to: { node: "loop/loop_not", port: "value" },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "loop", port: "index" },
			to: { node: "loop/count", port: "index" },
		});
	});

	test("doWhile reads its condition on the step's result", () => {
		const ir = buildOf(() =>
			loop.doWhile((r) => not(r.out.done), {
				init: counter({}, "init"),
				step: (state) => counter({ n: state.out.n }),
				max: 2,
			}),
		);
		expect(nodeOf(ir, "loop")).toMatchObject({
			members: { result: "loop/count" },
			test: { at: "end", port: { node: "loop/count_not", port: "value" } },
		});
	});

	test("takes only its own options", () => {
		buildOf(() =>
			loop.doWhile((r) => r.ok, {
				init: counter({}),
				step: () => counter({}),
				max: 2,
				// @ts-expect-error until is no option of a loop: its condition comes first.
				until: (r: Result) => r.ok,
			}),
		);
	});

	test("a while condition on a Bool port of the state tests that port at start", () => {
		const ir = buildOf(() =>
			loop.while((state) => state.ok, {
				init: counter({}),
				step: (state) => counter({ n: state.out.n }),
				max: 2,
			}),
		);
		expect(nodeOf(ir, "loop")).toMatchObject({
			test: { at: "start", port: { node: "loop", port: "ok" } },
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
					loop.doWhile((r) => r.ok, {
						init: counter({}),
						step: () => step() as never,
						max: 2,
					}),
				),
			);
			expect(error.code).toBe("TYPE.state");
		},
	);

	test.each(["index", "ok", "reason"])(
		"a state port named %s fails with TYPE.state",
		(port) => {
			const named = () =>
				hostNode("fake.count", { in: {}, out: { [port]: Int() } });
			const error = diagnose(() =>
				buildOf(() =>
					loop.doWhile((r) => r.ok, { init: named(), step: named, max: 2 }),
				),
			);
			expect(error).toMatchObject({
				code: "TYPE.state",
				message: `the state of loop 'loop' has a port named '${port}', a name the loop state holds itself`,
			});
		},
	);

	test("an init that is not a node's result fails with TYPE.member", () => {
		const error = diagnose(() =>
			buildOf(() =>
				loop.while((s) => not(s.ok), {
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
				loop.while((s) => not(s.ok), {
					init: counter({}),
					step: (s) => counter({ n: s.out.n }),
					max: undefined as never,
				}),
			),
		);
		expect(error.code).toBe("BOUND.max");
	});
});
