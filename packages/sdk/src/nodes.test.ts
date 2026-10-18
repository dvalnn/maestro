import { describe, expect, test } from "bun:test";
import { MAX_TIMEOUT } from "@maestro/ir";
import { buildOf, diagnose, nodeOf } from "./fixtures/context";
import {
	copyOut,
	fetchText,
	lint,
	merge,
	miscount,
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
	literal,
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
			return code(merge, {
				in: { parts: t.out.parts, sep: "\n" },
				out: { text: Text() },
				reads: ["src/**"],
				writes: ["out/a.txt"],
				timeout: 5000,
			});
		});
		expect(nodeOf(ir, "merge")).toMatchObject({
			kind: "code",
			worker: WORKER,
			timeout: 5000,
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

	test("has no timeout by default", () => {
		const node = nodeOf(
			buildOf(() => code(stamp)),
			"stamp",
		);
		expect(node).not.toHaveProperty("timeout");
	});

	test.each([0, 1.5, -1, MAX_TIMEOUT + 1])(
		"a timeout of %p fails with BOUND.timeout",
		(timeout) => {
			expect(
				diagnose(() => buildOf(() => code(stamp, { timeout }))),
			).toMatchObject({
				code: "BOUND.timeout",
				message: `timeout of code node 'stamp' must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT}, got ${timeout}`,
			});
		},
	);

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
			code(lint, { in: { text: t.out.text }, out: { findings: List(Text()) } });
			// @ts-expect-error: miscount rejects with 'findings' that are no list of Text.
			code(miscount, {
				in: { text: t.out.text },
				out: { findings: List(Text()) },
			});
			return code(verdict, { in: { text: t.out.text }, out: { text: Text() } });
		});
		const canReject: Rejection<never> extends ReturnType<typeof verdict>
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
			return code(wantsOtherContext, { out: { at: Int() } });
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
	test("emits the kind, an id from it and a plain config", () => {
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

	test("a literal input carries its declared type, and a bare value only its JSON type", () => {
		const Handle = {
			schema: { type: "string", "x-maestro-type": "fake.handle" },
		};
		const ir = buildOf(() =>
			hostNode("fake.check", {
				in: { typed: literal("h1", Handle), bare: "h1" },
			}),
		);
		expect(nodeOf(ir, "check")).toMatchObject({
			in: { typed: Handle.schema, bare: { type: "string" } },
			literals: { typed: "h1", bare: "h1" },
		});
	});
});

describe("common options", () => {
	test("when is a control edge from the guard's port", () => {
		const ir = buildOf(() => {
			const t = task();
			return hostNode("fake.check", { when: t.out.done });
		});
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
			return hostNode("fake.check", {
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
			return task();
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
		const ir = buildOf(() => {
			const t = task();
			assert(t.out.done, "done", { onFail: "rejected" });
			return t;
		});
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
