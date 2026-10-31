import { describe, expect, test } from "bun:test";
import { availableParallelism } from "node:os";
import {
	ConfigError,
	commandLineOf,
	coreConfig,
	coreDefaults,
	type LayerName,
	layered,
	layeredOver,
	parseLayer,
	sourceOf,
	valuesLayer,
} from "./index";

const USER = "/home/u/.config/maestro/config.yaml";
const WORKSPACE = "/w/.maestro/config.yaml";

const parse = (
	text: string,
	file = WORKSPACE,
	layer: LayerName = "workspace",
) =>
	parseLayer(text, {
		file,
		layer,
		paths: [["dataRoot"], ["packs"], ["target", "repo"]],
	});

/** The diagnostics a failed parse or merge gives, as code, message and location. */
function refusal(make: () => unknown) {
	try {
		make();
	} catch (e) {
		if (e instanceof ConfigError)
			return e.diagnostics.map((d) => [d.code, d.message, d.source]);
		throw e;
	}
	throw new Error("expected a ConfigError");
}

describe("merge tags", () => {
	const user = () =>
		parse("a:\n  b: 1\n  c: 2\nlist: [x]\nkeep: 1\n", USER, "user");

	test("a mapping merges by key, and any other value is replaced whole", () => {
		const top = parse("a:\n  b: 3\nlist: [y]\n");
		expect(layered([user(), top]).values).toEqual({
			a: { b: 3, c: 2 },
			list: ["y"],
			keep: 1,
		});
	});

	test("!replace, !append and !delete apply to what is beneath", () => {
		const top = parse(
			"a: !replace\n  d: 4\nlist: !append [y]\nkeep: !delete\n",
		);
		const composed = layered([user(), top]);
		expect(composed.values).toEqual({ a: { d: 4 }, list: ["x", "y"] });
		expect(sourceOf(composed, ["list", "0"])).toEqual({
			layer: "user",
			file: USER,
			line: 4,
		});
		expect(sourceOf(composed, ["list", "1"])).toMatchObject({
			file: WORKSPACE,
		});
	});

	test("!append over nothing is the list itself", () => {
		expect(layered([parse("list: !append [y]\n")]).values).toEqual({
			list: ["y"],
		});
	});

	test.each([
		["an unknown tag", "a: !merge {}\n", "workspace", "unknown tag !merge", 1],
		["a YAML tag", "a:\n  b: !!str 1\n", "workspace", "unknown tag !!str", 2],
		[
			"!replace on a scalar",
			"a: !replace 1\n",
			"workspace",
			"!replace tags a scalar, and only a mapping merges",
			1,
		],
		[
			"!append on a mapping",
			"a: !append {}\n",
			"workspace",
			"!append tags a mapping, and only a list appends",
			1,
		],
		[
			"!delete with a value",
			"keep: !delete 1\n",
			"workspace",
			"!delete takes no value",
			1,
		],
		[
			"a tag inside a list item",
			"list:\n  - x\n  - !replace {}\n",
			"workspace",
			"the tag !replace is not allowed inside a list item",
			3,
		],
		[
			"!delete of a key nothing beneath sets",
			"zz: !delete\n",
			"merge",
			"!delete on 'zz', which nothing beneath sets",
			1,
		],
		[
			"!append over a scalar",
			"keep: !append [1]\n",
			"merge",
			"!append on 'keep', which is a scalar beneath it, and only a list takes it",
			1,
		],
	])(
		"refuses %s, naming the file and line",
		(_, text, stage, message, line) => {
			const make = () =>
				stage === "merge" ? layered([user(), parse(text)]) : parse(text);
			expect(refusal(make)).toEqual([
				[
					"CFG.tag",
					`${WORKSPACE}:${line}: ${message}`,
					{ file: WORKSPACE, line },
				],
			]);
		},
	);

	test.each([
		["invalid YAML", "a: [1\n", 2],
		["a file that is not a mapping", "- a\n", 1],
		["a YAML merge key", "base: &b\n  x: 1\nc:\n  <<: *b\n", 4],
	])("refuses %s, naming the file and line", (_, text, line) => {
		expect(refusal(() => parse(text))).toEqual([
			[
				"CFG.yaml",
				expect.stringContaining(WORKSPACE),
				{ file: WORKSPACE, line },
			],
		]);
	});
});

describe("a deferred path", () => {
	const DEFERRED = [["tuned", "*"]];
	const BASE = "/p/base.yaml";
	const base = () =>
		parseLayer("list: [a]\nmap:\n  x: 1\n  y: 2\ngone: 1\nfile: f.md\n", {
			file: BASE,
			layer: "directory",
			paths: [["file"]],
		});
	const user = () =>
		parse(
			"tuned:\n  one:\n    list: !append [b]\n    map: !replace\n      z: 3\n    gone: !delete\n",
			USER,
			"user",
		);

	test("leaves a tag that finds nothing beneath pending, and still refuses one outside it", () => {
		const composed = layered([user()], DEFERRED);
		expect(composed.values).toEqual({
			tuned: { one: { list: ["b"], map: { z: 3 } } },
		});
		expect(refusal(() => layered([user()]))).toEqual([
			[
				"CFG.tag",
				`${USER}:6: !delete on 'tuned.one.gone', which nothing beneath sets`,
				{ file: USER, line: 6 },
			],
		]);
		expect(() => layered([parse("zz: !delete\n")], DEFERRED)).toThrow(
			ConfigError,
		);
	});

	test("layered over a base, applies each tag to it, crediting the base's values to its layer", () => {
		const flag = parse("tuned:\n  one:\n    map:\n      w: 4\n", USER, "flag");
		const composed = layered([user(), parse("other: 1\n"), flag], DEFERRED);
		const over = layeredOver(composed, ["tuned", "one"], base());
		expect(over.values).toEqual({
			list: ["a", "b"],
			map: { z: 3, w: 4 },
			file: "/p/f.md",
		});
		expect(sourceOf(over, ["list", "0"])).toEqual({
			layer: "directory",
			file: BASE,
			line: 1,
		});
		expect(sourceOf(over, ["map", "z"])).toMatchObject({ layer: "user" });
		expect(sourceOf(over, ["map", "w"])).toMatchObject({ layer: "flag" });
		expect(sourceOf(over, ["file"])).toMatchObject({ layer: "directory" });
	});

	test.each([
		[
			"nothing that tunes it",
			"tuned:\n  two: { x: 1 }\n",
			{ list: ["a"], map: { x: 1, y: 2 }, gone: 1, file: "/p/f.md" },
		],
		[
			"a !replace above it",
			"tuned: !replace\n  one:\n    map: { v: 5 }\n",
			{ map: { v: 5 } },
		],
		["a !delete of it", "tuned:\n  one: !delete\n", {}],
	])("layered over a base, is the base under %s", (_, text, expected) => {
		const composed = layered([parse(text)], DEFERRED);
		expect(layeredOver(composed, ["tuned", "one"], base()).values).toEqual(
			expected,
		);
	});

	test("layered over a base, refuses a tag that finds nothing there either", () => {
		const composed = layered(
			[parse("tuned:\n  one:\n    nothing: !delete\n")],
			DEFERRED,
		);
		expect(
			refusal(() => layeredOver(composed, ["tuned", "one"], base())),
		).toEqual([
			[
				"CFG.tag",
				`${WORKSPACE}:3: !delete on 'tuned.one.nothing', which nothing beneath sets`,
				{ file: WORKSPACE, line: 3 },
			],
		]);
	});
});

describe("provenance", () => {
	test("a relative path is relative to the directory of the file that sets it", () => {
		const composed = layered([
			parse("packs: [../p]\n", USER, "user"),
			parse(
				"dataRoot: data\npacks: !append [./q, /abs]\ntarget:\n  repo: ../repo\n",
			),
		]);
		expect(composed.values).toEqual({
			dataRoot: "/w/.maestro/data",
			packs: ["/home/u/.config/p", "/w/.maestro/q", "/abs"],
			target: { repo: "/w/repo" },
		});
	});

	test("a * in a path key matches any one key", () => {
		const composed = layered([
			parseLayer("t:\n  a:\n    p: x\n    q: x\n  b:\n    p: [y, /z]\n", {
				file: WORKSPACE,
				layer: "workspace",
				paths: [["t", "*", "p"]],
			}),
		]);
		expect(composed.values).toEqual({
			t: {
				a: { p: "/w/.maestro/x", q: "x" },
				b: { p: ["/w/.maestro/y", "/z"] },
			},
		});
	});

	test("a path without a value of its own takes the nearest value above it, else the first beneath it", () => {
		const composed = layered([parse("a:\n  b:\n    c: 1\n")]);
		const line = (path: string[]) => sourceOf(composed, path)?.line;
		expect([line(["a", "b", "c", "d"]), line(["a"]), line(["z"])]).toEqual([
			3,
			3,
			undefined,
		]);
	});
});

test("the command-line values are the leaves a preset or -c set, a list whole, and no file's", () => {
	const config = layered([
		parse("tools: {a: {harness: h, model: m}}\nlist: [1]\nkeep: 1"),
		parse("tools: {a: {harness: stub}}\nlist: [2, 3]", USER, "preset"),
		parse("tools: {b: {model: z}}", USER, "flag"),
	]);
	expect(commandLineOf(config).values).toEqual({
		tools: { a: { harness: "stub" }, b: { model: "z" } },
		list: [2, 3],
	});
});

describe("core config", () => {
	const defaults = coreDefaults("/data", "w");

	test("defaults to the default layer's values", () => {
		expect(coreConfig(layered([defaults]))).toEqual({
			concurrency: availableParallelism(),
			caps: {},
			dataRoot: "/data",
			workspace: "w",
			limits: {},
		});
	});

	test("refuses a value off its schema at its file and line, and a key a !delete unset", () => {
		const top = parse(
			'workspace: !delete\ncaps:\n  instances: -1\ndataRoot: ""\n',
		);
		expect(refusal(() => coreConfig(layered([defaults, top])))).toEqual([
			["CFG.required", "config key 'workspace' is unset", undefined],
			[
				"CFG.schema",
				"config 'caps.instances' must be >= 0",
				{ file: WORKSPACE, line: 3 },
			],
			[
				"CFG.schema",
				"config 'dataRoot' must NOT have fewer than 1 characters",
				{ file: WORKSPACE, line: 4 },
			],
		]);
	});

	test("reads limits.timeout as milliseconds, and refuses one that is no duration or longer than a timer holds", () => {
		const limits = (timeout: string) =>
			coreConfig(layered([defaults, parse(`limits:\n  timeout: ${timeout}\n`)]))
				.limits;
		expect(limits("2h")).toEqual({ timeout: 7_200_000 });
		expect(refusal(() => limits("2 hours"))).toEqual([
			[
				"CFG.schema",
				"config 'limits.timeout' '2 hours' is not a duration",
				{ file: WORKSPACE, line: 2 },
			],
		]);
		expect(refusal(() => limits("30d"))).toEqual([
			[
				"CFG.schema",
				"config 'limits.timeout' '30d' is longer than 2147483647ms",
				{ file: WORKSPACE, line: 2 },
			],
		]);
	});

	test("a values layer credits every value to its source", () => {
		const composed = layered([
			defaults,
			valuesLayer({ concurrency: 2 }, { layer: "flag" }),
		]);
		expect(sourceOf(composed, ["concurrency"])).toEqual({ layer: "flag" });
		expect(coreConfig(composed).concurrency).toBe(2);
	});
});
