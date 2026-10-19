import { afterEach, describe, expect, test } from "bun:test";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { ConfigError, sourceOf } from "@maestro/core/config";
import { type ConfigRequest, loadConfig } from "./config";
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
	test("layer default, user, workspace and profile, each value keeping its layer, file and line", async () => {
		const { root, request } = await tree({
			[USER]: "concurrency: 2\ncaps:\n  instances: 10\npacks: [../packs/a]\n",
			[WORKSPACE]:
				"concurrency: 3\ncaps:\n  calls: 4\ntarget:\n  repo: ../app\n",
			[PROFILE]: "\nconcurrency: 5\n",
			"ws/sub/deeper/.keep": "",
		});
		const config = await loadConfig(request({ profile: "fast" }));
		expect(config.core).toEqual({
			concurrency: 5,
			caps: { instances: 10, calls: 4 },
			dataRoot: join(root, "home/.local/share/maestro"),
			workspace: "ws",
		});
		expect(config.workspace).toBe(join(root, "ws"));
		expect(config.packs).toEqual([join(root, "xdg/packs/a")]);
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
			{ layer: "profile", file: join(root, PROFILE), line: 2 },
			{ layer: "user", file: join(root, USER), line: 3 },
			{ layer: "workspace", file: join(root, WORKSPACE), line: 3 },
			{ layer: "default" },
		]);
	});

	test("anchor the paths each host declares, and leave other keys as written", async () => {
		const { root, request } = await tree({
			[WORKSPACE]: "cache:\n  dir: ../c\n  name: ../n\n",
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

	test("a workspace may set its own data root, relative to its config file", async () => {
		const { root, request } = await tree({
			[WORKSPACE]: "dataRoot: data\nworkspace: shop\n",
		});
		expect((await loadConfig(request())).core).toMatchObject({
			dataRoot: join(root, "ws/.maestro/data"),
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
			loadConfig(request({ profile, cwd: join(root, cwd) })),
		);
		expect(found).toEqual([["CFG.profile", expect.stringContaining(message)]]);
	});

	test("refuse packs off the CLI's schema", async () => {
		const { request } = await tree({ [WORKSPACE]: "packs: ./a\n" });
		expect(await refusal(loadConfig(request()))).toEqual([
			["CFG.schema", "config 'packs' must be array"],
		]);
	});
});
