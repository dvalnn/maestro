import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import {
	buildOf,
	buildValid,
	context,
	diagnose,
	nodeOf,
} from "./fixtures/context";
import { fanout } from "./fixtures/examples";
import { stamp } from "./fixtures/workers";
import {
	type BuildContext,
	build,
	buildNamed,
	buildTwice,
	code,
	composition,
	describe as describeExports,
	hostNode,
	Int,
	irJson,
	List,
	type Ref,
	Text,
	use,
} from "./index";

const task = (inputs: Record<string, unknown> = {}) =>
	hostNode("fake.task", { in: inputs, out: { text: Text() } });

const shout = composition(
	"shout",
	{ ports: { text: Text() }, params: { times: Int({ default: 1 }) } },
	({ times }, { text }) => task({ text, times }),
);

describe("composition", () => {
	test("emits its header and the emitter but not its params, and fills defaults", () => {
		const root = composition(
			"greet",
			{
				doc: "Says hello.",
				params: { name: Text(), times: Int({ default: 1 }) },
				examples: [{ name: "x" }],
			},
			({ name, times }) => task({ name, times }),
		);
		const ir = buildValid(root, { name: "ada" });
		expect(ir.composition).toEqual({
			id: "greet",
			version: "0.1.0",
			pack: "fixtures",
			doc: "Says hello.",
		});
		expect(ir.emitter).toEqual({ name: "@maestro/sdk", version: pkg.version });
		expect(ir).not.toHaveProperty("params");
		expect(nodeOf(ir, "task").literals).toEqual({ name: "ada", times: 1 });
	});

	test.each([
		[
			"a bad name",
			() => composition("Bad Name", { examples: [{}] }, () => 0),
			"SCOPE.name",
		],
		[
			"no ports and no examples",
			() => composition("c", {}, () => 0),
			"CFG.examples",
		],
		[
			"ports built alone",
			() => build(shout as never, {}, context),
			"SCOPE.ports",
		],
	])("%s fails", (_name, fn, code) => {
		expect(diagnose(fn).code).toBe(code);
	});

	test("a composition with ports may take examples", () => {
		const ported = composition(
			"c",
			{ ports: { t: Text() }, examples: [{}] },
			() => 0,
		);
		expect(ported.examples).toEqual([{}]);
	});

	test("build returns only IR that parseIr accepts", () => {
		const badHash: BuildContext = {
			...context,
			resolveCode: (fn) => ({
				runtime: "ts",
				module: "workers.ts",
				export: fn.name,
				codeHash: "md5:0",
			}),
		};
		const root = composition("bad", { examples: [{}] }, () => code(stamp));
		expect(diagnose(() => build(root, {}, badHash))).toMatchObject({
			code: "IR.schema",
			severity: "error",
		});
	});
});

describe("use", () => {
	test("builds the sub in a scope of its own, with its ports fed by edge or literal", () => {
		const ir = buildOf(() => {
			use(shout, { text: task().out.text }, { params: { times: 2 } });
			return use(shout, { text: "plain" }, { label: "again" });
		});
		expect(ir.scopes).toEqual([
			{
				id: "shout",
				composition: "shout",
				ports: { text: { type: "string" } },
			},
			{
				id: "again",
				composition: "shout",
				ports: { text: { type: "string" } },
			},
		]);
		expect(nodeOf(ir, "shout/task")).toMatchObject({
			literals: { times: 2 },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "task", port: "text" },
			to: { node: "shout/task", port: "text" },
		});
		expect(nodeOf(ir, "again/task").literals).toEqual({
			text: "plain",
			times: 1,
		});
	});

	test("a port fed a plain value can feed a nested use", () => {
		const relay = composition(
			"relay",
			{ ports: { text: Text() } },
			(_params, { text }) => use(shout, { text }),
		);
		const ir = buildOf(() => use(relay, { text: "plain" }));
		expect(nodeOf(ir, "relay/shout/task").literals).toEqual({
			text: "plain",
			times: 1,
		});
	});

	test("a Ref fed to a param fails with REF.param", () => {
		const error = diagnose(() =>
			buildOf(() =>
				use(
					shout,
					{ text: "x" },
					{ params: { times: task().out.text as never } },
				),
			),
		);
		expect(error.code).toBe("REF.param");
	});

	test("ports that differ from the declared ones fail with TYPE.ports", () => {
		const error = diagnose(() => buildOf(() => use(shout, {} as never)));
		expect(error.code).toBe("TYPE.ports");
	});

	test("the build context's configured params stand over the defaults, and the use site over them", () => {
		const root = composition("t", { examples: [{}] }, () => {
			use(shout, { text: "a" });
			return use(shout, { text: "b" }, { params: { times: 2 }, label: "set" });
		});
		const params = { [context.pack.id]: { shout: { times: 3 } } };
		const ir = build(root, {}, { ...context, params });
		expect(nodeOf(ir, "shout/task").literals?.times).toBe(3);
		expect(nodeOf(ir, "set/task").literals?.times).toBe(2);
	});
});

describe("a bundle's entry", () => {
	const greet = composition(
		"greet",
		{
			doc: "Greets.",
			params: { name: Text(), loud: Int({ default: 0 }) },
			examples: [{ name: "x" }],
		},
		({ name }) => task({ name }),
	);
	const exports = { greet, again: greet, shout, helper: stamp };

	test("describe gives each exported composition once, with its params as JSON Schema", () => {
		expect(describeExports(exports)).toEqual([
			{
				name: "greet",
				doc: "Greets.",
				params: {
					type: "object",
					properties: {
						name: { type: "string" },
						loud: { type: "integer", default: 0 },
					},
					required: ["name"],
					additionalProperties: false,
				},
				examples: [{ name: "x" }],
			},
			{
				name: "shout",
				doc: undefined,
				params: {
					type: "object",
					properties: { times: { type: "integer", default: 1 } },
					required: [],
					additionalProperties: false,
				},
				examples: [],
			},
		]);
	});

	test("buildNamed builds a composition by name, as irJson", () => {
		const ir = buildNamed(exports, "greet", { name: "x" }, context);
		expect(ir).toBe(irJson(build(greet, { name: "x" }, context)));
	});

	test.each([
		[
			"an export named as the entry's own",
			{ build: stamp, greet },
			"SCOPE.name",
		],
		[
			"two compositions sharing a name",
			{ greet, other: composition("greet", { examples: [{}] }, () => task()) },
			"SCOPE.duplicate",
		],
	])("describe refuses %s", (_, given, code) => {
		expect(diagnose(() => describeExports(given)).code).toBe(code);
	});

	test("buildNamed refuses a name no export has", () => {
		expect(diagnose(() => buildNamed(exports, "nope", {}, context)).code).toBe(
			"SCOPE.name",
		);
	});

	test("a resolveCode that throws fails the node with SCOPE.export and its message", () => {
		const throwing: BuildContext = {
			...context,
			resolveCode: () => {
				throw new Error("function 'stamp' is reachable under two names");
			},
		};
		const root = composition("t", { examples: [{}] }, () => code(stamp));
		expect(diagnose(() => build(root, {}, throwing))).toMatchObject({
			code: "SCOPE.export",
			message: "function 'stamp' is reachable under two names",
		});
	});
});

describe("byte stability", () => {
	test("two builds give identical bytes, and buildTwice returns the IR", () => {
		const first = irJson(buildValid(fanout));
		expect(irJson(buildValid(fanout))).toBe(first);
		expect(irJson(buildTwice(fanout, {}, context))).toBe(first);
	});

	test("irJson sorts every object's keys", () => {
		const ir = buildOf(() => task({ b: 1, a: { d: 2, c: 3 } }));
		expect(irJson(ir)).toContain('"literals":{"a":{"c":3,"d":2},"b":1}');
	});

	test("a build that changes a param default changes no later build", () => {
		const greedy = composition(
			"greedy",
			{ params: { names: List(Text(), { default: ["a"] }) }, examples: [{}] },
			({ names }) => {
				names.push("b");
				return task({ names });
			},
		);
		const ir = buildTwice(greedy, {}, context);
		expect(nodeOf(ir, "task").literals).toEqual({ names: ["a", "b"] });
		expect(greedy.params.names.schema).toMatchObject({ default: ["a"] });
	});

	test("two processes give identical bytes", () => {
		const script = `${import.meta.dir}/fixtures/print-ir.ts`;
		const outputs = [1, 2].map(() =>
			Bun.spawnSync([process.execPath, script]).stdout.toString(),
		);
		expect(outputs[0]).toBe(irJson(buildValid(fanout)));
		expect(outputs[1]).toBe(outputs[0]);
	});

	test("a build that keeps state between builds fails with PURE.unstable", () => {
		let calls = 0;
		const drifting = composition("drift", { examples: [{}] }, () => {
			calls++;
			return task({ calls });
		});
		expect(diagnose(() => buildTwice(drifting, {}, context)).code).toBe(
			"PURE.unstable",
		);
	});

	test("a Ref from another build fails with REF.escape", () => {
		let kept: Ref<string> | undefined;
		buildOf(() => {
			kept = task().out.text;
			return kept;
		});
		expect(diagnose(() => buildOf(() => task({ kept }))).code).toBe(
			"REF.escape",
		);
	});

	test("a build inside a build fails with SCOPE.build", () => {
		expect(diagnose(() => buildOf(() => buildOf(() => task()))).code).toBe(
			"SCOPE.build",
		);
	});
});
