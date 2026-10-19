import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	ConfigError,
	type Layer,
	parseLayer,
	sourceOf,
} from "@maestro/core/config";
import type { Ir } from "@maestro/ir";
import type { Described } from "@maestro/sdk/loader";
import { fakeHost } from "@maestro/testkit";
import { cleanup, DEMO, packOf, scratch } from "./fixtures/packs";
import { openPack } from "./loader";
import { flagOf, type ParamRequest, paramValues } from "./params";

afterEach(cleanup);

const USER = "/home/u/.config/maestro/config.yaml";
const WORKSPACE = "/w/.maestro/config.yaml";
const PROFILE = "/w/.maestro/profiles/fast.yaml";

const demo = async () =>
	openPack({ dir: await packOf(join(DEMO, "index.ts"), await scratch()) });

const fileLayers = (user: string, workspace = "", profile = ""): Layer[] => [
	parseLayer(user, { file: USER, layer: "user" }),
	parseLayer(workspace, { file: WORKSPACE, layer: "workspace" }),
	parseLayer(profile, { file: PROFILE, layer: "profile" }),
];

function refusal(make: () => unknown) {
	try {
		make();
	} catch (e) {
		if (e instanceof ConfigError)
			return e.diagnostics.map((d) => [d.code, d.message, d.hint]);
		throw e;
	}
	throw new Error("expected a ConfigError");
}

function built(result: ReturnType<Awaited<ReturnType<typeof demo>>["build"]>) {
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ir;
}

const literalOf = (ir: Ir, id: string, port: string) =>
	ir.nodes.find((n) => n.id === id)?.literals?.[port];

test("a param's flag is its name in kebab-case", () => {
	expect(["maxRepairs", "max_repairs", "name"].map(flagOf)).toEqual([
		"--max-repairs",
		"--max-repairs",
		"--name",
	]);
});

describe("param values", () => {
	test("resolve default, example set, user, workspace, profile and flag, each value keeping its source", async () => {
		const pack = await demo();
		const request: ParamRequest = {
			layers: fileLayers(
				"demo:\n  greet:\n    name: user\n    loud: 1\n  echo:\n    times: 2\n",
				"demo:\n  greet:\n    name: workspace\n",
				"demo:\n  echo:\n    times: 3\n",
			),
			pack: "demo",
			compositions: pack.compositions,
			root: "greet",
			example: { name: "example", loud: 5 },
			flags: { loud: 7 },
			hosts: [fakeHost()],
		};
		const params = paramValues(request);
		expect(params.root).toEqual({ name: "workspace", loud: 7 });
		const source = (...path: string[]) =>
			sourceOf(params.composed, ["demo", ...path]);
		expect([
			source("greet", "name"),
			source("greet", "loud"),
			source("echo", "times"),
		]).toEqual([
			{ layer: "workspace", file: WORKSPACE, line: 3 },
			{ layer: "flag" },
			{ layer: "profile", file: PROFILE, line: 3 },
		]);
		const ir = built(pack.build("greet", params.root, params.configured));
		expect(literalOf(ir, "echo/echo", "times")).toBe(3);

		const filled = paramValues({
			...request,
			flags: undefined,
			layers: fileLayers("", "demo:\n  greet:\n    name: ws\n"),
		});
		expect(filled.root).toEqual({ name: "ws", loud: 5 });
		expect(sourceOf(filled.composed, ["demo", "greet", "loud"])).toEqual({
			layer: "example",
		});

		const workspaceOnly = paramValues({
			...request,
			example: undefined,
			flags: undefined,
			layers: fileLayers("", "demo:\n  greet:\n    name: ws\n"),
		});
		expect(workspaceOnly.root).toEqual({ name: "ws" });
		const defaults = built(
			pack.build("greet", workspaceOnly.root, workspaceOnly.configured),
		);
		expect(literalOf(defaults, "echo/echo", "times")).toBe(1);
	});

	test("the example set fills only an unset param, an optional one only when no optional one is set, and no merge tag acts on it", async () => {
		const pack = await demo();
		const greet = pack.compositions.find((c) => c.name === "greet");
		if (!greet) throw new Error("no greet");
		const tagged = {
			...greet,
			params: {
				...greet.params,
				properties: {
					...greet.params.properties,
					tags: { type: "array", items: { type: "string" }, default: [] },
					change: { type: "string" },
					revs: { type: "string" },
				},
			},
		};
		const root = (workspace: string) =>
			paramValues({
				layers: fileLayers("", workspace),
				pack: "demo",
				compositions: [tagged],
				root: "greet",
				example: { name: "e", tags: ["e"], change: "e" },
				hosts: [fakeHost()],
			}).root;
		expect(root("demo:\n  greet:\n    tags: !append [c]\n")).toEqual({
			name: "e",
			tags: ["c"],
			change: "e",
		});
		expect(root("")).toEqual({ name: "e", tags: ["e"], change: "e" });
		expect(root("demo:\n  greet:\n    revs: r\n")).toEqual({
			name: "e",
			tags: ["e"],
			revs: "r",
		});
	});

	test("refuse a missing required param, and a value off its schema, naming the flag", async () => {
		const pack = await demo();
		const request: ParamRequest = {
			layers: fileLayers("demo:\n  greet:\n    loud: loud\n"),
			pack: "demo",
			compositions: pack.compositions,
			root: "greet",
			hosts: [fakeHost()],
		};
		expect(refusal(() => paramValues(request))).toEqual([
			[
				"CFG.required",
				"param 'name' (--name) of 'demo.greet' is required",
				"Pass --name, or set 'demo.greet.name' in the config",
			],
			[
				"CFG.schema",
				"param 'loud' (--loud) of 'demo.greet' must be integer",
				"Pass a valid --loud, or fix 'demo.greet.loud' in the config",
			],
		]);
	});

	test("a bare file's missing param names only the flag, and the example set when it has one", async () => {
		const pack = await demo();
		const request = (examples: Record<string, unknown>[]) => ({
			layers: [],
			pack: "demo",
			compositions: pack.compositions.map((c) => ({ ...c, examples })),
			root: "greet",
			hosts: [fakeHost()],
			bare: true,
		});
		const hints = (examples: Record<string, unknown>[]) =>
			refusal(() => paramValues(request(examples)))[0]?.[2];
		expect(hints([])).toBe("Pass --name");
		expect(hints([{ loud: 1 }])).toBe(
			"Pass --name, or give it in the composition's example set",
		);
	});
});

describe("a typed param", () => {
	const request = async (
		over: Partial<ParamRequest>,
	): Promise<ParamRequest> => ({
		layers: [],
		pack: "demo",
		compositions: (await demo()).compositions,
		root: "ticket",
		hosts: [fakeHost()],
		...over,
	});

	test("is read through its host from a flag and from YAML", async () => {
		const fromFlag = paramValues(
			await request({ flags: { handle: "item#4" } }),
		);
		expect(fromFlag.root).toEqual({ handle: { name: "item", number: 4 } });
		const yaml = fileLayers("demo:\n  ticket:\n    handle: item#3\n");
		expect(paramValues(await request({ layers: yaml })).root).toEqual({
			handle: { name: "item", number: 3 },
		});
	});

	test("refuses malformed text, naming the flag", async () => {
		const malformed = await request({ flags: { handle: "item" } });
		expect(refusal(() => paramValues(malformed))).toEqual([
			[
				"HOST.param",
				"param 'handle' (--handle) of 'demo.ticket': 'item' is not a fake.handle",
				"Write a handle as <name>#<number>, for example 'item#3'",
			],
		]);
	});

	test("refuses a core artifact type, naming the flag", () => {
		const described: Described[] = [
			{
				name: "ticket",
				params: {
					type: "object",
					properties: { doc: { "x-maestro-type": "core.file" } },
					required: [],
					additionalProperties: false,
				},
				examples: [],
			},
		];
		const found = refusal(() =>
			paramValues({
				layers: [],
				pack: "demo",
				compositions: described,
				root: "ticket",
				hosts: [],
			}),
		);
		expect(found).toEqual([
			[
				"CFG.param",
				"param 'doc' (--doc) of 'demo.ticket' takes core.file, an artifact, and a param cannot hold one",
				expect.any(String),
			],
		]);
	});
});
