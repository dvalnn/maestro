import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { type CodeContext, reject, type Settled } from "@maestro/ir";
import pkg from "../package.json";
import { buildOf } from "./fixtures/context";
import { STDLIB_MODULE } from "./graph";
import { hostNode } from "./host";
import {
	allSettled,
	Bool,
	firstOk,
	JsonFile,
	List,
	lookup,
	not,
	okOnly,
	readJson,
	Struct,
	Text,
	when,
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
					doc: Struct({ a: Text() }),
					file: JsonFile(Text()),
					text: Text(),
					names: List(Text()),
					done: Bool(),
				},
			});
			lookup({ a: 1 }, t.out.text);
			when(t.out.done, t.out.text);
			not(t.out.done);
			t.out.doc.get("a");
			readJson(t.out.file);
			t.out.text.or("none");
			okOnly([t.out.text]);
			allSettled([t.out.text]);
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

describe("get", () => {
	test.each([
		["a field", { a: 1 }, "a", 1],
		["a nested field", { a: { b: [2] } }, "a.b", [2]],
		["a null field", { a: null }, "a", null],
	])("returns %s", (_name, value, path, expected) => {
		expect(fns.get({ value, path })).toEqual({ value: expected });
	});

	test.each([
		["a missing field", { a: 1 }, "b", "b"],
		["a missing nested field", { a: {} }, "a.b", "b"],
		["a field of a scalar", { a: 1 }, "a.b", "b"],
		["an array index", { a: [7] }, "a.0", "0"],
		["an inherited field", {}, "toString", "toString"],
	])("throws on %s, naming the path", (_name, value, path, key) => {
		expect(() => fns.get({ value, path })).toThrow(
			`get: path '${path}' has no field '${key}'`,
		);
	});
});

test("not negates its value", () => {
	expect([fns.not({ value: true }), fns.not({ value: false })]).toEqual([
		{ value: false },
		{ value: true },
	]);
});

describe("or", () => {
	test.each([
		["ok", ok("v"), "v"],
		["ok with a falsy value", ok(0), 0],
		["rejected", rejected("no"), "fb"],
		["rejected with a value", { ...rejected("no"), value: "v" }, "fb"],
		["skipped", skipped, "fb"],
	])(
		"delivers the right value when the input is %s",
		(_name, value, expected) => {
			expect(fns.or({ value, fallback: "fb" })).toEqual({ value: expected });
		},
	);

	test("throws when the input failed, naming its reason", () => {
		const value = { ...failed("disk full"), value: "v" };
		expect(() => fns.or({ value, fallback: "fb" })).toThrow(
			"or: its input failed: disk full",
		);
	});
});

describe("readJson", () => {
	let dir = "";
	beforeAll(async () => {
		dir = await mkdtemp(joinPath(tmpdir(), "maestro-read-json-"));
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));
	const ctx = { path: (ref) => joinPath(dir, ref.path) } as CodeContext;
	const schema = {
		type: "object",
		required: ["steps"],
		properties: { steps: { type: "array", items: { type: "string" } } },
	};
	const read = async (text: string) => {
		await writeFile(joinPath(dir, "plan.json"), text);
		const file = { path: "plan.json", contentHash: `sha256:${"0".repeat(64)}` };
		return fns.readJson({ file, schema }, ctx);
	};

	test("returns the file's content when it matches the schema", async () => {
		expect(await read('{"steps":["a","b"]}')).toEqual({
			value: { steps: ["a", "b"] },
		});
	});

	test.each([
		["is not JSON", "{steps", "readJson: 'plan.json' is not JSON: "],
		[
			"misses the schema",
			'{"steps":[1]}',
			"readJson: 'plan.json' does not match its schema: 'steps.0' must be string",
		],
		[
			"misses a required field",
			"{}",
			"readJson: 'plan.json' does not match its schema: the content must have required property 'steps'",
		],
	])(
		"rejects with the reason when the file %s",
		async (_name, text, reason) => {
			const result = await read(text);
			expect(result).toMatchObject({ outcome: "rejected" });
			expect("reason" in result ? result.reason : "").toStartWith(reason);
		},
	);

	test("throws when the file is missing", async () => {
		const file = { path: "none.json", contentHash: `sha256:${"0".repeat(64)}` };
		await expect(fns.readJson({ file, schema }, ctx)).rejects.toThrow("ENOENT");
	});
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

describe("reducers", () => {
	const mixed = [ok("a"), rejected("r"), ok("b"), skipped, failed("f")];

	test("allSettled returns every input in order, from results", () => {
		expect(fns.allSettled({ results: mixed })).toEqual({ value: mixed });
	});

	test("in0 to inN are read in order past in9, by allSettled and okOnly", () => {
		const thirteen = [
			...Array.from({ length: 12 }, (_, i) => ok(i)),
			rejected("r"),
		];
		expect(fns.allSettled(ins(...thirteen))).toEqual({ value: thirteen });
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
		for (const reduce of [fns.firstOk, fns.okOnly, fns.allSettled])
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
