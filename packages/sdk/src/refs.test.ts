import { describe, expect, test } from "bun:test";
import { settledSchema } from "@maestro/ir";
import pkg from "../package.json";
import { buildOf, diagnose, nodeOf } from "./fixtures/context";
import { hostNode } from "./host";
import {
	allSettled,
	Bool,
	composition,
	File,
	firstOk,
	Int,
	iter,
	Json,
	type JsonArtifact,
	JsonFile,
	List,
	lookup,
	type MapResults,
	okOnly,
	type Ref,
	type Result,
	readJson,
	Struct,
	Text,
	use,
	when,
} from "./index";

const STDLIB = `maestro:stdlib@${pkg.version}`;
const STRING = { type: "string" };

const task = (label?: string) =>
	hostNode("fake.task", {
		label,
		out: {
			text: Text(),
			done: Bool(),
			doc: Struct({ meta: Struct({ title: Text() }) }),
			names: List(Text()),
			counts: List(Int()),
		},
	});

const stdlibNode = (ir: ReturnType<typeof buildOf>, id: string) =>
	nodeOf(ir, id) as {
		worker: { module: string; export: string; codeHash: string };
	};

describe("a Ref used as a value", () => {
	test("a Ref wrapped in an object says to pass the Ref itself", () => {
		const error = diagnose(() =>
			buildOf(() =>
				hostNode("fake.sink", { in: { x: { r: task().out.text } } }),
			),
		);
		expect(error.hint).toMatch(/Pass the Ref itself/);
	});

	test.each([
		["in a template string", (r: unknown) => `${r}`],
		["by String()", (r: unknown) => String(r)],
		["in arithmetic", (r: unknown) => +(r as number)],
		["by JSON.stringify", (r: unknown) => JSON.stringify({ r })],
		[
			"nested in a literal input",
			(r: unknown) => hostNode("fake.sink", { in: { x: [r] } }),
		],
		[
			"inside a hostNode config",
			(r: unknown) => hostNode("fake.sink", { config: { r } }),
		],
	])("%s fails with REF.value and names the lift", (_name, use) => {
		const error = diagnose(() => buildOf(() => use(task().out.text)));
		expect(error.code).toBe("REF.value");
		expect(error.hint).toMatch(/get|code node|own/);
	});

	test.each([
		["in a template string", (r: unknown) => `${r}`],
		["by JSON.stringify", (r: unknown) => JSON.stringify(r)],
	])("a node's result used %s fails with REF.value", (_name, use) => {
		expect(diagnose(() => buildOf(() => use(task()))).code).toBe("REF.value");
	});

	test("a node's result fed as an input fails with REF.value", () => {
		const error = diagnose(() =>
			buildOf(() => hostNode("fake.sink", { in: { x: task() } })),
		);
		expect(error.code).toBe("REF.value");
	});

	test("a literal that is not JSON fails with TYPE.literal", () => {
		const error = diagnose(() =>
			buildOf(() => hostNode("fake.sink", { in: { x: new Map() } })),
		);
		expect(error.code).toBe("TYPE.literal");
	});
});

describe("lifting combinators", () => {
	test("get is a stdlib node typed by the path", () => {
		const ir = buildOf(() => task().out.doc.get("meta.title"));
		expect(nodeOf(ir, "task_meta_title")).toMatchObject({
			kind: "code",
			worker: { module: "maestro:stdlib", export: "get", codeHash: STDLIB },
			literals: { path: "meta.title" },
			out: { value: STRING },
		});
	});

	test("get takes its type from the path, and a path the type lacks does not compile", () => {
		const unbuilt = () => {
			const doc = task().out.doc;
			const title: Ref<string> = doc.get("meta.title");
			// @ts-expect-error the field at meta.title is Text.
			const count: Ref<number> = doc.get("meta.title");
			// @ts-expect-error the type has no field meta.x.
			doc.get("meta.x");
			const deep = doc as unknown as Ref<{
				a: { b: { c: { d: { e: { f: { g: { h: { i: string } } } } } } } };
			}>;
			deep.get("a.b.c.d.e.f.g.h");
			// @ts-expect-error a typed path names at most 8 fields.
			deep.get("a.b.c.d.e.f.g.h.i");
			return [title, count];
		};
		expect(unbuilt).toBeFunction();
	});

	test("get on a path the type lacks fails with TYPE.path", () => {
		const error = diagnose(() =>
			buildOf(() => task().out.doc.get("meta.x" as never)),
		);
		expect(error.code).toBe("TYPE.path");
	});

	test("get into a list fails with TYPE.path, and into an untyped value builds", () => {
		const error = diagnose(() =>
			buildOf(() => task().out.names.get("0" as never)),
		);
		expect(error.code).toBe("TYPE.path");
		const bare = diagnose(() =>
			buildOf(() =>
				hostNode("fake.task", {
					out: { l: Json({ items: { type: "string" } }) },
				}).out.l.get("0"),
			),
		);
		expect(bare.code).toBe("TYPE.path");
		const ir = buildOf(() =>
			hostNode("fake.task", { out: { any: Json({}) } }).out.any.get("a.b"),
		);
		expect(nodeOf(ir, "task_a_b")).toMatchObject({ out: { value: {} } });
	});

	test("or is a fan-in node that receives its input as Settled", () => {
		const ir = buildOf(() => task().out.text.or("none"));
		expect(nodeOf(ir, "task_or")).toMatchObject({
			fanin: true,
			in: { value: settledSchema(STRING), fallback: STRING },
			literals: { fallback: "none" },
			out: { value: STRING },
		});
	});

	test("or fails with TYPE.or on a parMap's results, and on a Ref fallback", () => {
		const results = diagnose(() =>
			buildOf(() =>
				iter
					.parMap(["a"], () => task(), { onError: "continue" })
					.out.results.or([]),
			),
		);
		expect(results).toMatchObject({ code: "TYPE.or" });
		expect(results.hint).toContain("okOnly");
		const fallback = diagnose(() =>
			buildOf(() => {
				const t = task();
				return t.out.text.or(t.out.text as never);
			}),
		);
		expect(fallback).toMatchObject({ code: "TYPE.or" });
		expect(fallback.hint).toContain("firstOk");
	});

	test("when is a stdlib node guarded by its condition", () => {
		const ir = buildOf(() => {
			const t = task();
			return when(t.out.done, t.out.text);
		});
		expect(stdlibNode(ir, "task_when").worker.export).toBe("when");
		expect(ir.edges).toContainEqual({
			kind: "control",
			from: { node: "task", port: "done" },
			to: { node: "task_when" },
		});
	});

	test("lookup takes a plain table and a Ref key", () => {
		const ir = buildOf(() => lookup({ a: 1, b: 2 }, task().out.text));
		expect(nodeOf(ir, "task_lookup")).toMatchObject({
			literals: { table: { a: 1, b: 2 } },
			in: { key: STRING },
			out: { value: { type: "integer" } },
		});
	});

	test("lookup into an array takes a number key, and a string key fails with TYPE.key", () => {
		const t = () =>
			hostNode("fake.task", { out: { n: Int(), text: Text() } }).out;
		expect(() => buildOf(() => lookup(["x"], t().n))).not.toThrow();
		const error = diagnose(() =>
			buildOf(() => lookup(["x"], t().text as never)),
		);
		expect(error.code).toBe("TYPE.key");
	});

	test("lookup with a Ref in its table fails with REF.value", () => {
		const error = diagnose(() =>
			buildOf(() => {
				const t = task();
				lookup({ a: t.out.text }, t.out.text);
			}),
		);
		expect(error.code).toBe("REF.value");
	});
});

describe("readJson", () => {
	const Plan = Struct({ steps: List(Text()) });
	const planner = () =>
		hostNode("fake.task", {
			label: "planner",
			out: {
				plan: JsonFile(Plan, { description: "the plan" }),
				summary: JsonFile(Text()),
				notes: File(),
				raw: Json({}),
			},
		}).out;

	test("is a stdlib node whose value is the file's content, typed and checked by its schema", () => {
		const ir = buildOf(() => {
			const plan: Ref<{ steps: string[] }> = readJson(planner().plan);
			return plan;
		});
		const content = { ...(Plan.schema as object), description: "the plan" };
		expect(nodeOf(ir, "planner_plan_json")).toMatchObject({
			kind: "code",
			worker: { module: "maestro:stdlib", export: "readJson" },
			literals: { schema: content },
			out: { value: content },
		});
	});

	test("names its node by the source node and port, so two JSON outputs of one node read without labels", () => {
		const ir = buildOf(() => {
			const out = planner();
			readJson(out.plan);
			return readJson(out.summary);
		});
		expect(ir.nodes.map((n) => n.id)).toEqual([
			"planner",
			"planner_plan_json",
			"planner_summary_json",
		]);
	});

	test("over an artifact that is not a JSON file does not compile, and fails with TYPE.artifact", () => {
		const error = diagnose(() =>
			// @ts-expect-error a File is no JsonFile.
			buildOf(() => readJson(planner().notes)),
		);
		expect(error).toMatchObject({
			code: "TYPE.artifact",
			message:
				"readJson reads a core.json-file artifact, and this Ref is a core.file",
		});
	});

	test("over a Ref cast past its type fails with TYPE.artifact", () => {
		const raw = () => planner().raw as Ref<JsonArtifact<unknown>>;
		const error = diagnose(() => buildOf(() => readJson(raw())));
		expect(error).toMatchObject({
			code: "TYPE.artifact",
			message:
				"readJson reads a core.json-file artifact, and this Ref is not an artifact",
		});
	});
});

describe("lift ids", () => {
	const result = (label: string) =>
		hostNode("fake.task", {
			label,
			out: { result: Struct({ text: Text(), a: Json({}) }) },
		}).out.result;

	test("are the source node and what the lift does, so one field of two nodes builds", () => {
		const ir = buildOf(() => {
			result("plan").get("text");
			return result("critique").get("text");
		});
		expect(ir.nodes.map((n) => n.id)).toEqual([
			"plan",
			"plan_text",
			"critique",
			"critique_text",
		]);
	});

	test("compose along a chain", () => {
		const ir = buildOf(() => result("x").get("a").get("b"));
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "x_a", port: "value" },
			to: { node: "x_a_b", port: "value" },
		});
	});

	test("turn characters an id cannot hold into _", () => {
		const ir = buildOf(() => result("x").get("a").get("my field"));
		expect(nodeOf(ir, "x_a_my_field").literals).toEqual({ path: "my field" });
	});

	test("give way to a label", () => {
		const ir = buildOf(() => {
			const text = result("x").get("text");
			text.or("a");
			return text.or("b", { label: "fallback" });
		});
		expect(nodeOf(ir, "fallback").literals).toEqual({ fallback: "b" });
	});

	test.each([
		["the same lift twice", "a", "Reuse the Ref the first or returned"],
		[
			"a different lift",
			"b",
			"Give one of the nodes with id 'x_text_or' a label of its own",
		],
	])("taken by %s fail with SCOPE.duplicate", (_name, second, hint) => {
		const error = diagnose(() =>
			buildOf(() => {
				const text = result("x").get("text");
				text.or("a");
				text.or(second);
			}),
		);
		expect(error).toMatchObject({ code: "SCOPE.duplicate", hint });
	});
});

describe("reducers", () => {
	test.each([
		["firstOk", firstOk, STRING],
		["okOnly", okOnly, { type: "array", items: STRING }],
		["allSettled", allSettled, { type: "array", items: settledSchema(STRING) }],
	])(
		"%s is a fan-in stdlib node with one port per input",
		(name, reduce, value) => {
			const ir = buildOf(() =>
				reduce([task("a").out.text, task("b").out.text]),
			);
			expect(nodeOf(ir, name)).toMatchObject({
				fanin: true,
				worker: { module: "maestro:stdlib", export: name, codeHash: STDLIB },
				in: { in0: settledSchema(STRING), in1: settledSchema(STRING) },
				out: { value },
			});
			expect(ir.result).toEqual({ node: name });
		},
	);

	test.each([
		["results", (m: Result<MapResults>) => m.out.results],
		["handle", (m: Result<MapResults>) => m],
	])("over a parMap's %s it reads one collect edge", (_name, inputs) => {
		const ir = buildOf(() =>
			firstOk(
				inputs(iter.parMap(["a"], () => task(), { onError: "continue" })),
			),
		);
		expect(ir.edges).toContainEqual({
			kind: "collect",
			from: { node: "parMap", port: "results" },
			to: { node: "firstOk", port: "results" },
		});
	});

	test("over a parMap, the value is typed by the members' outputs, so a get path is checked at build", () => {
		const reduced = () =>
			firstOk(iter.parMap(["a"], () => task(), { onError: "continue" })).out
				.value;
		const ir = buildOf(() => reduced().get("text"));
		expect(nodeOf(ir, "firstOk_text")).toMatchObject({
			out: { value: STRING },
		});
		const error = diagnose(() =>
			buildOf(() => reduced().get("result" as never)),
		);
		expect(error).toMatchObject({
			code: "TYPE.path",
			message: "get path 'result' names no field 'result'",
			hint: "Get one of: text, done, doc, names, counts",
		});
	});

	test("inputs of different types give a value of anyOf", () => {
		const ir = buildOf(() => {
			const t = task();
			return firstOk<unknown>([t.out.text, t.out.done]);
		});
		expect(nodeOf(ir, "firstOk").out).toEqual({
			value: { anyOf: [STRING, { type: "boolean" }] },
		});
	});

	test.each([
		["an empty list", () => []],
		["a plain Ref", () => task().out.text],
		["the handle of a node that is not a parMap", () => task()],
	])("given %s fails with TYPE.reducer", (_name, inputs) => {
		const error = diagnose(() => buildOf(() => firstOk(inputs() as never)));
		expect(error.code).toBe("TYPE.reducer");
	});

	test("the result is the returned node, or the node of a returned port", () => {
		expect(buildOf(() => task()).result).toEqual({ node: "task" });
		expect(buildOf(() => task().out.text).result).toEqual({ node: "task" });
	});

	const echo = composition(
		"echo",
		{ ports: { text: Text() } },
		(_, { text }) => text,
	);

	test.each([
		["nothing", () => {}],
		["a plain-value Ref", () => use(echo, { text: "x" })],
		["an object of named outputs", () => ({ text: task().out.text })],
	])("a build that returns %s fails with TYPE.result", (_name, returned) => {
		expect(diagnose(() => buildOf(returned))).toMatchObject({
			code: "TYPE.result",
			message: "the build of 't' returned no node",
			hint: "Return the node whose outcome is the concert result, or a reducer over several",
		});
	});
});
