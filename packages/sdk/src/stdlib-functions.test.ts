import { describe, expect, test } from "bun:test";
import { join as joinPath } from "node:path";
import { reject, type Settled } from "@maestro/ir";
import pkg from "../package.json";
import { buildOf } from "./fixtures/context";
import { STDLIB_MODULE } from "./graph";
import {
	Bool,
	firstOk,
	hostNode,
	List,
	lookup,
	okOnly,
	Record,
	settle,
	Text,
	when,
	zip,
} from "./index";
import * as fns from "./stdlib-functions";

const ok = (value: unknown): Settled<unknown> => ({ outcome: "ok", value });
const rejected = (reason: string): Settled<unknown> => ({
	outcome: "rejected",
	reason,
});
const failed = (reason: string): Settled<unknown> => ({
	outcome: "failed",
	reason,
});
const skipped: Settled<unknown> = { outcome: "skipped" };

/** A reducer's ports as a fan-in node with one input per output has them. */
const ins = (...inputs: Settled<unknown>[]) =>
	Object.fromEntries(inputs.map((s, i) => [`in${i}`, s])) as {
		in0: Settled<unknown>;
	};

describe("the stdlib module", () => {
	test("exports exactly the functions the SDK emits nodes for, on the package's ./stdlib subpath", async () => {
		const ir = buildOf(() => {
			const t = hostNode("fake.task", {
				out: {
					doc: Record({ a: Text() }),
					text: Text(),
					names: List(Text()),
					done: Bool(),
				},
			});
			zip(t.out.names, t.out.names);
			lookup({ a: 1 }, t.out.text);
			when(t.out.done, t.out.text);
			t.out.doc.pick("a");
			t.out.text.or("none");
			okOnly([t.out.text]);
			settle([t.out.text]);
			return firstOk([t.out.text]);
		});
		const emitted = ir.nodes.flatMap((n) =>
			"worker" in n && n.worker.module === STDLIB_MODULE
				? [n.worker.export]
				: [],
		);
		const subpath = await import(
			joinPath(import.meta.dir, "..", pkg.exports["./stdlib"])
		);
		expect(Object.keys(subpath).toSorted()).toEqual(emitted.toSorted());
		for (const name of emitted) expect(subpath[name]).toBeFunction();
	});
});

describe("pick", () => {
	test.each([
		["a field", { a: 1 }, "a", 1],
		["a nested field", { a: { b: [2] } }, "a.b", [2]],
		["a null field", { a: null }, "a", null],
	])("returns %s", (_name, value, path, expected) => {
		expect(fns.pick({ value, path })).toEqual({ value: expected });
	});

	test.each([
		["a missing field", { a: 1 }, "b", "b"],
		["a missing nested field", { a: {} }, "a.b", "b"],
		["a field of a scalar", { a: 1 }, "a.b", "b"],
		["an array index", { a: [7] }, "a.0", "0"],
		["an inherited field", {}, "toString", "toString"],
	])("throws on %s, naming the path", (_name, value, path, key) => {
		expect(() => fns.pick({ value, path })).toThrow(
			`pick: path '${path}' has no field '${key}'`,
		);
	});
});

describe("or", () => {
	test.each([
		["ok", ok("v"), "v"],
		["ok with a falsy value", ok(0), 0],
		["rejected", rejected("no"), "fb"],
		["failed", failed("no"), "fb"],
		["skipped", skipped, "fb"],
		["failed with a value", { ...failed("no"), value: "v" }, "fb"],
	])(
		"delivers the right value when the input is %s",
		(_name, value, expected) => {
			expect(fns.or({ value, fallback: "fb" })).toEqual({ value: expected });
		},
	);
});

describe("lookup", () => {
	test.each([
		["an object entry", { a: 1 }, "a", 1],
		["a null entry", { a: null }, "a", null],
		["an array index", ["x", "y"], 1, "y"],
		["a number key on an object", { 1: "x" }, 1, "x"],
	])("returns %s", (_name, table, key, expected) => {
		expect(fns.lookup({ table, key })).toEqual({ value: expected });
	});

	test.each([
		["a missing key", { a: 1 }, "b", '"b"'],
		["an inherited key", {}, "toString", '"toString"'],
		["an index out of range", ["x"], 1, "1"],
		["a string key on an array", ["x"], "0", '"0"'],
		["an array's length", ["x"], "length", '"length"'],
	])("throws on %s, naming the key", (_name, table, key, named) => {
		expect(() => fns.lookup({ table, key })).toThrow(
			`lookup: no entry under key ${named}`,
		);
	});
});

describe("zip", () => {
	test("pairs the i-th items", () => {
		expect(fns.zip({ a: [1, 2], b: ["x", "y"] })).toEqual({
			value: [
				[1, "x"],
				[2, "y"],
			],
		});
	});

	test("throws on lists of different lengths, naming both", () => {
		expect(() => fns.zip({ a: [1, 2], b: ["x"] })).toThrow(
			"zip: lists differ in length, 2 and 1",
		);
	});

	const a = [{ id: 1 }, { id: 2 }, { n: "no id" }, { id: null }, { id: 4 }];
	const b = [
		{ id: 2, m: 1 },
		{ id: 1 },
		{ id: 2, m: 2 },
		{ m: "no id" },
		{ id: null },
		{ id: 3 },
	];

	test("pairs items whose key is equal, a's order then b's, and drops the unmatched", () => {
		expect(fns.zip({ a, b, on: "id" })).toEqual({
			value: [
				[a[0], b[1]],
				[a[1], b[0]],
				[a[1], b[2]],
			],
		});
	});

	test.each([
		["a number and its string", [{ id: 1 }], [{ id: "1" }], []],
		["a string", [{ id: "x" }], [{ id: "x" }], [[{ id: "x" }, { id: "x" }]]],
		[
			"a boolean",
			[{ id: false }],
			[{ id: false }],
			[[{ id: false }, { id: false }]],
		],
	])("compares %s by strict equality", (_name, left, right, value) => {
		expect(fns.zip({ a: left, b: right, on: "id" })).toEqual({ value });
	});

	test.each([
		["an object", { k: 1 }, '{"k":1}'],
		["an array", [1], "[1]"],
	])("throws on %s as a key, naming it, in either list", (_name, id, named) => {
		const message = `zip: key ${named} of field 'id' is not a string, number or boolean`;
		expect(() => fns.zip({ a: [{ id }], b: [], on: "id" })).toThrow(message);
		expect(() => fns.zip({ a: [], b: [{ id }], on: "id" })).toThrow(message);
	});
});

describe("reducers", () => {
	const mixed = [ok("a"), rejected("r"), ok("b"), skipped, failed("f")];

	test("settle returns every input in order, from results", () => {
		expect(fns.settle({ results: mixed })).toEqual({ value: mixed });
	});

	test("in0 to inN are read in order past in9, by settle and okOnly", () => {
		const thirteen = [
			...Array.from({ length: 12 }, (_, i) => ok(i)),
			rejected("r"),
		];
		expect(fns.settle(ins(...thirteen))).toEqual({ value: thirteen });
		expect(fns.okOnly(ins(...thirteen))).toEqual({
			value: Array.from({ length: 12 }, (_, i) => i),
		});
	});

	test.each([
		[
			"in0 missing",
			{ in1: ok(1), in2: ok(2) },
			"'in0' is missing from: in1, in2",
		],
		["a gap", { in0: ok(0), in2: ok(2) }, "'in1' is missing from: in0, in2"],
		[
			"a stray port",
			{ in0: ok(0), other: ok(1) },
			"'in1' is missing from: in0, other",
		],
	])("a reducer throws on %s", (_name, ports, named) => {
		for (const reduce of [fns.firstOk, fns.okOnly, fns.settle])
			expect(() => reduce(ports as never)).toThrow(named);
	});

	test("okOnly returns the values of the ok inputs, in order", () => {
		expect(fns.okOnly({ results: mixed })).toEqual({ value: ["a", "b"] });
		expect(fns.okOnly({ results: [] })).toEqual({ value: [] });
	});

	describe("firstOk", () => {
		test("returns the first ok input's value", () => {
			expect(fns.firstOk({ results: mixed })).toEqual({ value: "a" });
			expect(fns.firstOk(ins(rejected("r"), ok(0), ok(1)))).toEqual({
				value: 0,
			});
		});

		test("rejects with the reasons when none is ok and none failed, counting skipped as rejected", () => {
			const results = [
				rejected("r"),
				skipped,
				{ outcome: "skipped" as const, reason: "s" },
			];
			expect(fns.firstOk({ results })).toEqual(
				reject("firstOk: no input was ok: r; skipped; s"),
			);
		});

		test("throws when none is ok and any failed", () => {
			expect(() =>
				fns.firstOk({ results: [rejected("r"), failed("f")] }),
			).toThrow("firstOk: no input was ok: r; f");
		});

		test("rejects when there are no inputs", () => {
			expect(fns.firstOk({ results: [] })).toEqual(
				reject("firstOk: no input was ok: there were none"),
			);
		});
	});
});
