import { afterEach, describe, expect, test } from "bun:test";
import { chmod, symlink } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { ConfigError, sourceOf } from "@maestro/core/config";
import { type ConfigRequest, loadConfig, loadDotenv } from "./config";
import { cleanup, scratch } from "./fixtures/packs";
import { builtinHosts } from "./hosts";

afterEach(cleanup);

/** A home, an XDG config home, and a workspace `ws` with a nested cwd, holding `files` by path under the root. */
async function tree(files: Record<string, string>) {
	const root = await scratch();
	for (const [path, text] of Object.entries(files))
		await Bun.write(join(root, path), text);
	const request = (over: Partial<ConfigRequest> = {}): ConfigRequest => ({
		cwd: join(root, "ws/sub/deeper"),
		env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg") },
		hosts: builtinHosts({}),
		...over,
	});
	return { root, request };
}

const USER = "xdg/maestro/config.yaml";
const WORKSPACE = "ws/.maestro/config.yaml";
const PROFILE = "ws/.maestro/profiles/fast.yaml";

async function refusal(promise: Promise<unknown>) {
	const error = await promise.catch((e: unknown) => e);
	if (!(error instanceof ConfigError)) throw error;
	return error.diagnostics.map((d) => [d.code, d.message]);
}

describe("config files", () => {
	test("layer default, user, workspace, profile and -c, each value keeping its layer, and its file and line or flag", async () => {
		const { root, request } = await tree({
			[USER]: "concurrency: 2\ncaps:\n  instances: 10\npacks: [packs/a]\n",
			[WORKSPACE]: "concurrency: 3\ncaps:\n  calls: 4\ntarget:\n  repo: app\n",
			[PROFILE]: "\nconcurrency: 5\ndataRoot: data\n",
			"ws/sub/deeper/.keep": "",
		});
		const config = await loadConfig(
			request({ overrides: [{ profile: "fast", config: ["concurrency=7"] }] }),
		);
		expect(config.core).toEqual({
			concurrency: 7,
			caps: { instances: 10, calls: 4 },
			dataRoot: join(root, "ws/data"),
			workspace: "ws",
		});
		expect(config.workspace).toBe(join(root, "ws"));
		expect(config.packs).toEqual([
			{ dir: join(root, "xdg/maestro/packs/a"), listedBy: join(root, USER) },
		]);
		expect(config.composed.values.target).toEqual({
			repo: join(root, "ws/app"),
		});
		const source = (...path: string[]) => sourceOf(config.composed, path);
		expect([
			source("concurrency"),
			source("caps", "instances"),
			source("caps", "calls"),
			source("dataRoot"),
		]).toEqual([
			{ layer: "flag", flag: "-c concurrency=7" },
			{ layer: "user", file: join(root, USER), line: 3 },
			{ layer: "workspace", file: join(root, WORKSPACE), line: 3 },
			{ layer: "profile", file: join(root, PROFILE), line: 3 },
		]);
	});

	test("anchor the paths each host declares, and leave other keys as written", async () => {
		const { root, request } = await tree({
			[WORKSPACE]: "cache:\n  dir: c\n  name: ../n\n",
		});
		const [repo] = builtinHosts({});
		if (!repo) throw new Error("no builtin host");
		const config = await loadConfig(
			request({ hosts: [{ ...repo, paths: [["cache", "dir"]] }] }),
		);
		expect(config.composed.values.cache).toEqual({
			dir: join(root, "ws/c"),
			name: "../n",
		});
	});

	test("outside a workspace, take the defaults, the workspace named empty", async () => {
		const { root, request } = await tree({});
		const config = await loadConfig(
			request({
				cwd: root,
				env: { HOME: join(root, "home"), XDG_DATA_HOME: "/data" },
			}),
		);
		expect(config.core).toEqual({
			concurrency: availableParallelism(),
			caps: {},
			dataRoot: "/data/maestro",
			workspace: "",
		});
		expect(config.workspace).toBeUndefined();
	});

	test("a workspace may set its own data root, relative to the workspace root", async () => {
		const { root, request } = await tree({
			[WORKSPACE]: "dataRoot: data\nworkspace: shop\n",
		});
		expect((await loadConfig(request())).core).toMatchObject({
			dataRoot: join(root, "ws/data"),
			workspace: "shop",
		});
	});

	test.each([
		[
			"a profile with no file",
			"fast",
			"ws/sub",
			"--profile fast names no file",
		],
		[
			"a profile name that is a path",
			"../config",
			"ws/sub",
			"--profile takes a name, not a path: '../config'",
		],
		[
			"a profile outside a workspace",
			"fast",
			"",
			"--profile fast needs a workspace",
		],
	])("refuse %s", async (_, profile, cwd, message) => {
		const { root, request } = await tree({ "ws/.maestro/.keep": "" });
		const found = await refusal(
			loadConfig(request({ overrides: [{ profile }], cwd: join(root, cwd) })),
		);
		expect(found).toEqual([["CFG.profile", expect.stringContaining(message)]]);
	});

	test("a -c reads its value as YAML at its key, merge tags and a quoted key holding '.' among them, a path relative to the workspace root, else the cwd", async () => {
		const { root, request } = await tree({
			[WORKSPACE]:
				"packs: [a]\ntarget:\n  checks:\n    lint: l\n    test: t\nprofiles:\n  reviewer:\n    runtime:\n      harness: pi\n      thinking: high\n",
		});
		const config = await loadConfig(
			request({
				overrides: [
					{
						config: [
							"packs=!append [b]",
							"target.checks.lint=!delete",
							"profiles.reviewer.runtime=!replace {harness: claude, model: y}",
							'target.checks."a.b"=x',
							"target.repo=app",
							"concurrency=4",
							"target.note=|\n  one\n  two",
						],
					},
				],
			}),
		);
		expect(config.packs).toEqual([
			{ dir: join(root, "ws/a"), listedBy: join(root, WORKSPACE) },
			{ dir: join(root, "ws/b"), listedBy: "-c 'packs=!append [b]'" },
		]);
		expect(config.composed.values.target).toEqual({
			checks: { test: "t", "a.b": "x" },
			repo: join(root, "ws/app"),
			note: "one\ntwo\n",
		});
		expect(config.composed.values.profiles).toEqual({
			reviewer: { runtime: { harness: "claude", model: "y" } },
		});
		expect(config.core.concurrency).toBe(4);
		const outside = await loadConfig(
			request({ cwd: root, overrides: [{ config: ["dataRoot=d"] }] }),
		);
		expect(outside.core.dataRoot).toBe(join(root, "d"));
	});

	test.each([
		["no '='", "concurrency", "CFG.flag", "-c concurrency takes <key>=<value>"],
		["an empty key", "=4", "CFG.flag", "-c =4: '' is not a key path"],
		[
			"a value off its key's schema",
			"concurrency=x",
			"CFG.schema",
			"-c concurrency=x: config 'concurrency' must be integer",
		],
		["a value that is not YAML", "caps=[1", "CFG.yaml", "-c 'caps=[1': "],
		[
			"a value holding a quote",
			"caps=[it's",
			"CFG.yaml",
			"-c 'caps=[it'\\''s': ",
		],
		[
			"a tag on the wrong shape",
			"packs=!append x",
			"CFG.tag",
			"-c 'packs=!append x': !append tags a scalar",
		],
	])(
		"refuse a -c with %s, naming it as typed",
		async (_, arg, code, message) => {
			const { request } = await tree({});
			const found = await refusal(
				loadConfig(request({ overrides: [{ config: [arg] }] })),
			);
			expect(found).toEqual([[code, expect.stringContaining(message)]]);
		},
	);

	test("install each directory under the data home's packs once by its real path, after those listed, skipping hidden ones, and none when it is missing", async () => {
		const { root, request } = await tree({
			[USER]: "packs: [../../data/maestro/packs/b, elsewhere, ../../real/c]\n",
			"data/maestro/packs/a/.keep": "",
			"data/maestro/packs/b/.keep": "",
			"data/maestro/packs/file": "",
			"data/maestro/packs/.cache/.keep": "",
			"real/c/.keep": "",
		});
		await symlink(join(root, "real/c"), join(root, "data/maestro/packs/c"));
		const env = {
			HOME: join(root, "home"),
			XDG_CONFIG_HOME: join(root, "xdg"),
			XDG_DATA_HOME: join(root, "data"),
		};
		const packs = join(root, "data/maestro/packs");
		expect((await loadConfig(request({ env }))).packs).toEqual([
			{ dir: join(packs, "b"), listedBy: join(root, USER) },
			{ dir: join(root, "xdg/maestro/elsewhere"), listedBy: join(root, USER) },
			{ dir: join(root, "real/c"), listedBy: join(root, USER) },
			{ dir: join(packs, "a") },
		]);
		const bare = await loadConfig(
			request({ env: { HOME: join(root, "home") } }),
		);
		expect(bare.packs).toEqual([]);
	});

	test("give the roots of the workspace, the user and each pack, by its manifest's id, at its real path", async () => {
		const manifest = (id: string) =>
			JSON.stringify({ id, version: "1.0.0", entry: "index.js", sdk: "*" });
		const { root, request } = await tree({
			[WORKSPACE]: "",
			[USER]: "packs: [../../p/one, ../../p/link, ../../p/broken]\n",
			"p/one/maestro-pack.json": manifest("one"),
			"p/two/maestro-pack.json": manifest("two"),
			"p/broken/maestro-pack.json": "{",
		});
		await symlink(join(root, "p/two"), join(root, "p/link"));
		const config = await loadConfig(request());
		expect(config.roots).toEqual({
			workspace: join(root, "ws/.maestro"),
			user: join(root, "xdg/maestro"),
			packs: { one: join(root, "p/one"), two: join(root, "p/two") },
		});
		const outside = await loadConfig(
			request({ cwd: root, env: { HOME: join(root, "home") } }),
		);
		expect(outside.roots).toEqual({
			user: join(root, "home/.config/maestro"),
			packs: {},
		});
	});

	test("anchor a path under any profile to its file, and leave a tag pending under a profile", async () => {
		const { root, request } = await tree({
			[USER]:
				"profiles:\n  a:\n    instructions: i.md\n    attachments:\n      kb: { path: kb, hint: h }\n",
			[WORKSPACE]:
				"profiles:\n  classics/b:\n    runtime:\n      thinking: !delete\n",
		});
		const config = await loadConfig(request());
		expect(config.composed.values.profiles).toEqual({
			a: {
				instructions: join(root, "xdg/maestro/i.md"),
				attachments: { kb: { path: join(root, "xdg/maestro/kb"), hint: "h" } },
			},
			"classics/b": { runtime: {} },
		});
	});

	test("refuse packs off the CLI's schema", async () => {
		const { request } = await tree({ [WORKSPACE]: "packs: ./a\n" });
		expect(await refusal(loadConfig(request()))).toEqual([
			["CFG.schema", "config 'packs' must be array"],
		]);
	});
});

describe("the .env beside the user config", () => {
	test("fills a variable the environment leaves unset, and keeps one it sets", async () => {
		const { root } = await tree({
			"xdg/maestro/.env": "MAESTRO_TEST_UNSET=file\nMAESTRO_TEST_SET=file\n",
		});
		process.env.MAESTRO_TEST_SET = "shell";
		try {
			loadDotenv({ XDG_CONFIG_HOME: join(root, "xdg") });
			expect(process.env.MAESTRO_TEST_UNSET).toBe("file");
			expect(process.env.MAESTRO_TEST_SET).toBe("shell");
		} finally {
			delete process.env.MAESTRO_TEST_UNSET;
			delete process.env.MAESTRO_TEST_SET;
		}
	});

	test("one that cannot be read is refused, naming it", async () => {
		const { root } = await tree({ "xdg/maestro/.env": "A=1\n" });
		const file = join(root, "xdg/maestro/.env");
		await chmod(file, 0);
		expect(() => loadDotenv({ XDG_CONFIG_HOME: join(root, "xdg") })).toThrow(
			`cannot read ${file}: EACCES: permission denied, open '${file}'\nMake it readable, or remove it`,
		);
	});
});
