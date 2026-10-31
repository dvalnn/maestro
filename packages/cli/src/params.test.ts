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
import { baseOf, loadConfig } from "./config";
import { cleanup, DEMO, packOf, scratch } from "./fixtures/packs";
import { openPack } from "./loader";
import { flagOf, type ParamRequest, paramValues } from "./params";

afterEach(cleanup);

const USER = "/home/u/.config/maestro/config.yaml";
const WORKSPACE = "/w/.maestro/config.yaml";
const PRESET = "/w/.maestro/presets/fast.yaml";
const CWD = "/w";

const demo = async () =>
	openPack({ dir: await packOf(join(DEMO, "index.ts"), await scratch()) });

const fileLayers = (user: string, workspace = "", preset = ""): Layer[] => [
	parseLayer(user, { file: USER, layer: "user" }),
	parseLayer(workspace, { file: WORKSPACE, layer: "workspace" }),
	parseLayer(preset, { file: PRESET, layer: "preset" }),
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
	test("resolve default, example set, user, workspace, preset and flag, each value keeping its source", async () => {
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
			base: () => CWD,
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
			{ layer: "preset", file: PRESET, line: 3 },
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
				base: () => CWD,
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
			base: () => CWD,
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

	test.each<[string, boolean, boolean, string]>([
		["a bare file with no example set", true, false, "Pass --name"],
		[
			"a bare file with an example set",
			true,
			true,
			"Pass --name, or give it in the composition's example set",
		],
		[
			"a pack with an example set",
			false,
			true,
			"Pass --name, or set 'demo.greet.name' in the config, or give it in the composition's example set",
		],
	])("the required hint of %s", async (_, bare, given, hint) => {
		const pack = await demo();
		expect(
			refusal(() =>
				paramValues({
					layers: [],
					pack: "demo",
					compositions: pack.compositions,
					root: "greet",
					example: given ? { loud: 1 } : undefined,
					hosts: [fakeHost()],
					base: () => CWD,
					bare,
				}),
			)[0]?.[2],
		).toBe(hint);
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
		base: () => CWD,
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
});

describe("a file param", () => {
	const ticket = (type: string, name = "ticket"): Described[] => [
		{
			name,
			params: {
				type: "object",
				properties: { doc: { "x-maestro-type": type } },
				required: [],
				additionalProperties: false,
			},
			examples: [],
		},
	];
	const request = (over: Partial<ParamRequest>): ParamRequest => ({
		layers: [],
		pack: "demo",
		compositions: ticket("core.markdown"),
		root: "ticket",
		hosts: [],
		base: () => CWD,
		...over,
	});

	test("takes a flag's path relative to the cwd, and a config file's as its other paths, as the reference its file is staged under", async () => {
		const root = await scratch();
		const workspace = join(root, "ws");
		const cwd = join(workspace, "sub");
		const user = join(root, "config");
		const env = { XDG_CONFIG_HOME: user, XDG_DATA_HOME: join(root, "data") };
		const userDir = join(user, "maestro");
		for (const dir of [workspace, cwd, userDir])
			await Bun.write(join(dir, "spec.md"), dir);
		const staged = async (file: string, text: string, flag?: string) => {
			await Bun.write(file, text);
			const config = await loadConfig({ cwd, env, hosts: [] });
			const read = paramValues(
				request({
					layers: config.layers,
					flags: flag === undefined ? undefined : { doc: flag },
					base: (source) => baseOf(config, cwd, source),
				}),
			);
			const [one] = read.staged;
			expect(read.root.doc).toEqual(one?.ref);
			return one?.source;
		};
		const doc = "demo:\n  ticket:\n    doc: spec.md\n";
		const userFile = join(userDir, "config.yaml");
		const workspaceFile = join(workspace, ".maestro/config.yaml");
		expect(await staged(userFile, doc)).toBe(join(userDir, "spec.md"));
		expect(await staged(workspaceFile, doc)).toBe(join(workspace, "spec.md"));
		expect(await staged(workspaceFile, doc, "spec.md")).toBe(
			join(cwd, "spec.md"),
		);
		const hex = new Bun.CryptoHasher("sha256").update(cwd).digest("hex");
		expect(
			paramValues(request({ flags: { doc: join(cwd, "spec.md") } })).root,
		).toEqual({
			doc: { path: `${hex}/spec.md`, contentHash: `sha256:${hex}` },
		});
	});

	test("refuses a file it cannot read, naming the flag and the path", () => {
		const found = refusal(() =>
			paramValues(request({ flags: { doc: "gone.md" } })),
		);
		expect(found).toEqual([
			[
				"CFG.param",
				"param 'doc' (--doc) of 'demo.ticket' names 'gone.md', which is not a readable file",
				"Pass a valid --doc, or fix 'demo.ticket.doc' in the config",
			],
		]);
	});

	test("refuses a directory, and a file the config gives another composition", () => {
		const layers = fileLayers("demo:\n  sub:\n    doc: spec.md\n");
		const compositions = [...ticket("core.dir"), ...ticket("core.file", "sub")];
		expect(
			refusal(() => paramValues(request({ layers, compositions }))),
		).toEqual([
			[
				"CFG.param",
				"param 'doc' (--doc) of 'demo.ticket' takes core.dir, a directory, which a param cannot take",
				"Declare 'doc' of 'demo.ticket' as File, Markdown or JsonFile, which take a file's path",
			],
			[
				"CFG.param",
				"config 'demo.sub.doc' takes core.file, a file, which only the root composition's params take",
				"Remove it from the config, and feed the file to 'demo.sub' through a port of its use",
			],
		]);
	});
});
