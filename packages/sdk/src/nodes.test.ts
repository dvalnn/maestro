import { describe, expect, test } from "bun:test";
import { buildOf, diagnose, nodeOf } from "./fixtures/context";
import {
	copyOut,
	fetchText,
	merge,
	stamp,
	verdict,
	wantsOtherContext,
} from "./fixtures/workers";
import {
	assert,
	Bool,
	code,
	File,
	hostNode,
	Int,
	List,
	type Rejection,
	Text,
} from "./index";

const WORKER = {
	runtime: "ts",
	module: "workers.ts",
	export: "merge",
	codeHash: `sha256:${"0".repeat(64)}`,
};

const task = (label?: string) =>
	hostNode("fake.task", {
		label,
		out: { text: Text(), done: Bool(), parts: List(Text()) },
	});

describe("code", () => {
	test("emits the resolved worker, ports, literals, reads and writes as written", () => {
		const ir = buildOf(() => {
			const t = task();
			code(merge, {
				in: { parts: t.out.parts, sep: "\n" },
				out: { text: Text() },
				reads: ["src/**"],
				writes: ["out/a.txt"],
				pure: false,
			});
		});
		expect(nodeOf(ir, "merge")).toMatchObject({
			kind: "code",
			label: "merge",
			worker: WORKER,
			pure: false,
			reads: ["src/**"],
			writes: ["out/a.txt"],
			in: {
				parts: { type: "array", items: { type: "string" } },
				sep: { type: "string" },
			},
			literals: { sep: "\n" },
			out: { text: { type: "string" } },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "task", port: "parts" },
			to: { node: "merge", port: "parts" },
		});
	});

	test("is pure by default", () => {
		expect(
			nodeOf(
				buildOf(() => code(stamp)),
				"stamp",
			),
		).toMatchObject({
			pure: true,
		});
	});

	test("checks the function against in and out at compile time", () => {
		buildOf(() => {
			const t = task();
			// @ts-expect-error: merge returns no output 'count'.
			code(merge, {
				in: { parts: t.out.parts, sep: "," },
				out: { text: Text(), count: Int() },
			});
			code(merge, {
				// @ts-expect-error: merge takes no input 'extra'.
				in: { parts: t.out.parts, sep: ",", extra: 1 },
				label: "merge_2",
			});
			// @ts-expect-error: merge's 'parts' is a list, and 'text' is Text.
			code(merge, { in: { parts: t.out.text, sep: "," }, label: "merge_3" });
			code(verdict, { in: { text: t.out.text }, out: { text: Text() } });
		});
		const canReject: Rejection extends ReturnType<typeof verdict>
			? true
			: false = true;
		expect(canReject).toBe(true);
	});

	test("hands the function a CodeContext and accepts an async function", () => {
		const ir = buildOf(() => {
			const doc = hostNode("fake.doc", { out: { doc: File() } }).out.doc;
			code(copyOut, { in: { doc }, out: { copy: File() } });
			code(fetchText, { in: { url: "u" }, out: { text: Text() } });
			// @ts-expect-error: a code function's context is a CodeContext.
			code(wantsOtherContext, { out: { at: Int() } });
		});
		expect(ir.nodes.map((n) => n.id)).toEqual([
			"doc",
			"copyOut",
			"fetchText",
			"wantsOtherContext",
		]);
	});

	test.each([
		["a lambda", () => ({})],
		[
			"an unexported function",
			function local() {
				return {};
			},
		],
	])("fails with SCOPE.export at the call site for %s", (_name, fn) => {
		const error = diagnose(() =>
			buildOf(() => {
				code(fn);
			}),
		);
		expect(error.code).toBe("SCOPE.export");
		expect(error.source?.file).toBe(import.meta.path);
	});
});

describe("hostNode", () => {
	test("emits the kind, a label from it and a plain config", () => {
		const ir = buildOf(() =>
			hostNode("fake.check", { config: { strict: true } }),
		);
		expect(nodeOf(ir, "check")).toMatchObject({
			kind: "fake.check",
			config: { strict: true },
		});
	});

	test("a Ref in config fails with REF.value", () => {
		const error = diagnose(() =>
			buildOf(() => hostNode("fake.check", { config: { x: task().out.text } })),
		);
		expect(error.code).toBe("REF.value");
	});
});

describe("common options", () => {
	test("when is a control edge from the guard's port", () => {
		const ir = buildOf(() => {
			const t = task();
			hostNode("fake.check", { when: t.out.done, tag: "gate" });
		});
		expect(nodeOf(ir, "check").tag).toBe("gate");
		expect(ir.edges).toContainEqual({
			kind: "control",
			from: { node: "task", port: "done" },
			to: { node: "check" },
		});
	});

	test("tolerate is a control edge from each upstream, the guard included", () => {
		const ir = buildOf(() => {
			const a = task("a");
			const b = task("b");
			hostNode("fake.check", {
				in: { text: a.out.text },
				when: b.out.done,
				tolerate: "rejected",
			});
		});
		const tolerant = ir.edges.filter((e) => e.kind === "control" && e.tolerate);
		expect(tolerant.map((e) => e.from.node).toSorted()).toEqual(["a", "b"]);
	});

	test.each([
		["a plain boolean", () => true],
		["a non-Bool Ref", () => task().out.text],
	])("when given %s fails with REF.bool", (_name, guard) => {
		const error = diagnose(() =>
			buildOf(() => hostNode("fake.check", { when: guard() as never })),
		);
		expect(error.code).toBe("REF.bool");
	});
});

describe("node ids", () => {
	test.each([
		["derived", undefined],
		["explicit", "x"],
	])("a duplicate %s id fails with SCOPE.duplicate", (_name, label) => {
		const error = diagnose(() =>
			buildOf(() => {
				task(label);
				task(label);
			}),
		);
		const id = label ?? "task";
		expect(error).toMatchObject({ code: "SCOPE.duplicate", node: id });
		expect(error.hint).toBe(
			`Give one of the nodes with id '${id}' a label of its own`,
		);
	});

	test("a label an id cannot hold fails with SCOPE.name", () => {
		expect(diagnose(() => buildOf(() => task("a/b"))).code).toBe("SCOPE.name");
	});
});

describe("assert", () => {
	test("a true plain condition emits nothing", () => {
		const ir = buildOf(() => {
			assert(true, "holds", { onFail: "failed" });
			task();
		});
		expect(ir.nodes.map((n) => n.kind)).toEqual(["fake.task"]);
	});

	test("a false plain condition fails with ASSERT.failed", () => {
		const error = diagnose(() =>
			buildOf(() => assert(false, "too many", { onFail: "failed" })),
		);
		expect(error.code).toBe("ASSERT.failed");
	});

	test.each([
		["a plain string", () => "yes"],
		["a non-Bool Ref", () => task().out.text],
	])("a condition that is %s fails with REF.bool", (_name, cond) => {
		const error = diagnose(() =>
			buildOf(() => assert(cond() as never, "x", { onFail: "failed" })),
		);
		expect(error.code).toBe("REF.bool");
	});

	test("a Ref condition is an assert node fed by an edge", () => {
		const ir = buildOf(() =>
			assert(task().out.done, "done", { onFail: "rejected" }),
		);
		expect(nodeOf(ir, "assert")).toMatchObject({
			kind: "assert",
			message: "done",
			onFail: "rejected",
			in: { cond: { type: "boolean" } },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "task", port: "done" },
			to: { node: "assert", port: "cond" },
		});
	});
});

test("a constructor outside a build fails with SCOPE.build", () => {
	expect(diagnose(() => code(stamp)).code).toBe("SCOPE.build");
});
