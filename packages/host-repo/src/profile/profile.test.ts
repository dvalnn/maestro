import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@maestro/core";
import {
	ConfigError,
	type LayerName,
	layered,
	parseLayer,
	sourceOf,
} from "@maestro/core/config";
import { type HostSetup, hostSetup, type Roots } from "@maestro/core/host";
import { HOST_DEFERRED, HOST_PATHS } from "../host/config";
import { repoHost } from "../host/index";
import { findProfile, isProfileName, resolveProfile, untunable } from "./index";

const root = mkdtempSync(join(tmpdir(), "maestro-profile-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ROOTS: Roots = {
	workspace: join(root, "ws/.maestro"),
	user: join(root, "xdg/maestro"),
	packs: {
		classics: join(root, "packs/classics"),
		acme: join(root, "packs/acme"),
	},
};
const W = join(root, "ws/.maestro/profiles");
const U = join(root, "xdg/maestro/profiles");
const CLASSICS = join(root, "packs/classics/profiles");
const ACME = join(root, "packs/acme/profiles");

const RUNTIME = "runtime: { harness: claude, model: opus }\n";
const write = (path: string, text: string) => Bun.write(join(root, path), text);

await Promise.all([
	write("ws/.maestro/profiles/auditor/profile.yaml", RUNTIME),
	write("xdg/maestro/profiles/auditor/profile.yaml", RUNTIME),
	write("ws/.maestro/profiles/solo.yaml", "unrelated: config profile\n"),
	write("packs/classics/profiles/scout/profile.yaml", RUNTIME),
	write(
		"xdg/maestro/profiles/classics/builder/profile.yaml",
		"runtime: { harness: claude }\ninstructions: instructions.md\nattachments:\n  kb: { path: kb, hint: read it }\n",
	),
	write("xdg/maestro/profiles/classics/builder/instructions.md", "build\n"),
	write("xdg/maestro/profiles/classics/builder/kb/notes.md", "notes\n"),
	write("packs/classics/profiles/builder/profile.yaml", RUNTIME),
	write("packs/acme/profiles/builder/profile.yaml", RUNTIME),
	write("outside.md", "secret\n"),
	write(
		"ws/.maestro/profiles/reserved/profile.yaml",
		`${RUNTIME}mcp: {}\nskills: []\n`,
	),
	write("ws/.maestro/profiles/bound/profile.yaml", "readOnly: [/etc]\n"),
	write(
		"ws/.maestro/profiles/dotdot/profile.yaml",
		"instructions: ../auditor/profile.yaml\n",
	),
	write("ws/.maestro/profiles/linked/profile.yaml", "instructions: link.md\n"),
	write("ws/.maestro/profiles/missing/profile.yaml", "instructions: gone.md\n"),
	write("ws/.maestro/profiles/unknown/profile.yaml", `${RUNTIME}modle: x\n`),
	write(
		"ws/.maestro/profiles/slow/profile.yaml",
		`${RUNTIME}limits: { timeout: soon }\n`,
	),
	write("ws/.maestro/profiles/empty/.keep", ""),
	write("ws/.maestro/profiles/auditor/kb/notes.md", "notes\n"),
	write("ws/.maestro/profiles/dirinstr/profile.yaml", "instructions: kb\n"),
	write("ws/.maestro/profiles/dirinstr/kb/notes.md", "notes\n"),
	write(
		"ws/.maestro/profiles/whole/profile.yaml",
		"attachments:\n  all: { path: ., hint: all of it }\n",
	),
	write(
		"ws/.maestro/profiles/badname/profile.yaml",
		`${RUNTIME}attachments:\n  Bad-Name: { path: profile.yaml, hint: x }\n`,
	),
]);
symlinkSync(join(root, "outside.md"), join(W, "linked/link.md"));
symlinkSync(join(root, "outside.md"), join(U, "classics/builder/kb/link.md"));

/**
 * The repo host's setup under `ROOTS` and a config of `files`, each a layer's YAML by layer, under the host's path keys
 * and deferred paths.
 */
function setupOf(files: Partial<Record<LayerName, string>>): HostSetup {
	const layers = Object.entries(files).map(([layer, text]) =>
		parseLayer(text, {
			file: join(root, `${layer}.yaml`),
			layer: layer as LayerName,
			paths: HOST_PATHS,
		}),
	);
	const dataRoot = parseLayer("dataRoot: /data\n", {
		file: join(root, "default.yaml"),
		layer: "default",
	});
	const config = layered([dataRoot, ...layers], HOST_DEFERRED);
	return hostSetup(repoHost({ harnesses: [] }), config, ROOTS);
}

/** The code, message and hint of each diagnostic a `ConfigError` from `make` carries. */
async function refusal(make: () => Promise<unknown>) {
	const error = await make().catch((e: unknown) => e);
	if (!(error instanceof ConfigError)) throw error;
	return error.diagnostics.map((d) => [d.message, d.hint, d.source?.line]);
}

test.each([
	["auditor", true],
	["classics/builder", true],
	["a-b_c9", true],
	["classics/builder/x", false],
	["Classics", false],
	["../x", false],
	["/x", false],
	["", false],
])("'%s' is a profile name: %p", (name, expected) => {
	expect(isProfileName(name)).toBe(expected);
});

describe("lookup", () => {
	test.each([
		["auditor", join(W, "auditor"), [join(U, "auditor")]],
		[
			"classics/builder",
			join(U, "classics/builder"),
			[join(CLASSICS, "builder")],
		],
		["acme/builder", join(ACME, "builder"), []],
		["classics/scout", join(CLASSICS, "scout"), []],
	])("finds %s first in %s, shadowing the rest", async (name, dir, shadows) => {
		expect(await findProfile(name, ROOTS)).toEqual({ dir, shadows });
	});

	test.each([
		["a bare name a pack holds", "scout"],
		["a name only a .yaml file holds", "solo"],
		["a pack no root installs", "other/builder"],
		["a name that is no profile name", "../auditor"],
		["a directory without its profile.yaml", "empty"],
		["a pack's directory in the user root", "classics"],
		["an attachment's directory", "auditor/kb"],
	])("finds nothing for %s", async (_, name) => {
		expect(await findProfile(name, ROOTS)).toBeUndefined();
	});

	test("without a workspace root, the user root wins", async () => {
		const { workspace: _, ...noWorkspace } = ROOTS;
		expect(await findProfile("auditor", noWorkspace)).toEqual({
			dir: join(U, "auditor"),
			shadows: [],
		});
	});
});

describe("resolution", () => {
	const dir = join(U, "classics/builder");

	test("layers the config of a host setup over the directory, each field from its layer, with the hash of each regular file", async () => {
		const setup = setupOf({
			user: "profiles:\n  classics/builder:\n    runtime: { model: sonnet }\n",
			workspace:
				"profiles:\n  classics/builder:\n    runtime: { thinking: high }\n    readOnly: [/srv/docs]\n",
			preset:
				"profiles:\n  classics/builder:\n    limits: { timeout: 20m }\n    attachments:\n      more: { path: m.md, hint: more }\n",
			flag: "profiles:\n  classics/builder:\n    limits: { tokens: 1000 }\n    attachments:\n      kb: { hint: read it twice }\n",
		});
		const profile = await resolveProfile("classics/builder", setup);
		expect(profile).toMatchObject({
			name: "classics/builder",
			dir,
			shadows: [join(CLASSICS, "builder")],
			fields: {
				runtime: { harness: "claude", model: "sonnet", thinking: "high" },
				instructions: join(dir, "instructions.md"),
				attachments: {
					kb: { path: join(dir, "kb"), hint: "read it twice" },
					more: { path: join(root, "m.md"), hint: "more" },
				},
				readOnly: ["/srv/docs"],
				limits: { timeout: 20 * 60 * 1000, tokens: 1000 },
			},
		});
		const layer = (...path: string[]) => sourceOf(profile, path)?.layer;
		expect([
			layer("runtime", "harness"),
			layer("runtime", "model"),
			layer("runtime", "thinking"),
			layer("instructions"),
			layer("attachments", "kb", "path"),
			layer("attachments", "kb", "hint"),
			layer("attachments", "more", "path"),
			layer("readOnly"),
			layer("limits", "timeout"),
			layer("limits", "tokens"),
		]).toEqual([
			"directory",
			"user",
			"workspace",
			"directory",
			"directory",
			"flag",
			"preset",
			"workspace",
			"preset",
			"flag",
		]);
		expect(sourceOf(profile, ["runtime", "harness"])).toEqual({
			layer: "directory",
			file: join(dir, "profile.yaml"),
			line: 1,
		});
		expect(profile.files).toEqual({
			"instructions.md": `sha256:${sha256Hex("build\n")}`,
			"kb/notes.md": `sha256:${sha256Hex("notes\n")}`,
			"profile.yaml": `sha256:${sha256Hex(await Bun.file(join(dir, "profile.yaml")).text())}`,
		});
	});

	test("refuses a runtime config leaves without a harness or model, naming the key to set", async () => {
		const deleted = setupOf({
			flag: "profiles:\n  classics/builder:\n    runtime: { harness: !delete }\n",
		});
		expect(
			await refusal(() => resolveProfile("classics/builder", deleted)),
		).toEqual([
			[
				"profile classics/builder: no harness",
				"Set profiles.classics/builder.runtime.harness",
				undefined,
			],
			[
				"profile classics/builder: no model",
				"Set profiles.classics/builder.runtime.model",
				undefined,
			],
		]);
	});

	test.each([
		[
			"reserved keys",
			"reserved",
			[
				[
					"profile reserved: mcp is reserved, not yet supported",
					`Drop 'mcp' from ${join(W, "reserved/profile.yaml")}`,
					2,
				],
				[
					"profile reserved: skills is reserved, not yet supported",
					`Drop 'skills' from ${join(W, "reserved/profile.yaml")}`,
					3,
				],
			],
			"",
		],
		[
			"readOnly in the file",
			"bound",
			[
				[
					"profile bound: readOnly binds host paths, which a profile file holds none of",
					`Drop 'readOnly' from ${join(W, "bound/profile.yaml")}, and set it in config under 'profiles.bound.readOnly'`,
					1,
				],
			],
			"",
		],
		[
			"a path that escapes by ..",
			"dotdot",
			[
				[
					"profile dotdot: 'instructions' is ../auditor/profile.yaml, which is outside the profile",
					`Keep it inside ${join(W, "dotdot")}, or set it in config under 'profiles.dotdot.instructions'`,
					1,
				],
			],
			"",
		],
		[
			"a path that escapes by a symlink",
			"linked",
			[
				[
					"profile linked: 'instructions' is link.md, which is outside the profile",
					`Keep it inside ${join(W, "linked")}, or set it in config under 'profiles.linked.instructions'`,
					1,
				],
			],
			"",
		],
		[
			"a path that does not exist",
			"missing",
			[
				[
					"profile missing: 'instructions' is gone.md, which does not exist",
					`Create it in ${join(W, "missing")}`,
					1,
				],
			],
			"",
		],
		[
			"a key off the schema",
			"unknown",
			[
				[
					"profile unknown must NOT have additional properties ('modle')",
					"Fix it where it is set",
					1,
				],
			],
			"",
		],
		[
			"a timeout that is no duration",
			"slow",
			[
				[
					"profile slow: limits.timeout 'soon' is not a duration",
					"Write it as 500ms, 90s, 15m, 12h or 7d",
					2,
				],
			],
			"",
		],
		[
			"instructions that are a directory",
			"dirinstr",
			[
				[
					"profile dirinstr: 'instructions' is kb, which is not a file",
					`Point it at a file inside ${join(W, "dirinstr")}`,
					1,
				],
			],
			"",
		],
		[
			"an attachment that is the profile directory",
			"whole",
			[
				[
					"profile whole: 'attachments.all.path' is ., which is the profile directory itself",
					`Point it at a file or directory inside ${join(W, "whole")}`,
					2,
				],
			],
			"",
		],
		[
			"an attachment name off its pattern",
			"badname",
			[
				[
					"profile badname: 'attachments.Bad-Name' is not an allowed name",
					"Fix it where it is set",
					3,
				],
			],
			"",
		],
		[
			"reserved keys config sets",
			"auditor",
			[
				[
					"profile auditor: mcp is reserved, not yet supported",
					`Drop 'profiles.auditor.mcp' from ${join(root, "workspace.yaml")}`,
					3,
				],
			],
			"profiles:\n  auditor:\n    mcp: {}\n",
		],
	])("refuses %s, naming the profile", async (_, name, expected, workspace) => {
		expect(
			await refusal(() => resolveProfile(name, setupOf({ workspace }))),
		).toEqual(expected);
	});

	test.each([
		["classics/buildr", "Did you mean 'classics/builder'?"],
		[
			"classic",
			`Create ${join(W, "classic/profile.yaml")}, or name another profile`,
		],
		["auditor/kc", "Install pack 'auditor', or name another profile"],
		[
			"classics/zzzzzz",
			"Update pack 'classics' to a version with profile 'zzzzzz', or name another profile",
		],
	])(
		"refuses %s, which no root holds, with a near profile, the pack to install or update, or where to create it",
		async (name, hint) => {
			expect(await refusal(() => resolveProfile(name, setupOf({})))).toEqual([
				[`profile ${name} is in no profile root`, hint, undefined],
			]);
		},
	);
});

test("an error for each profile config tunes that no root holds, where config sets it, with a near name or where to create it", async () => {
	const setup = setupOf({
		workspace:
			"profiles:\n  auditor: {}\n  classics/buildr:\n    runtime: { model: m }\n  zzzzzz: {}\n",
	});
	expect(
		(await untunable(setup)).map((d) => [d.message, d.hint, d.source?.line]),
	).toEqual([
		[
			"config 'profiles.classics/buildr' tunes profile 'classics/buildr', which no profile root holds",
			"Did you mean 'classics/builder'?",
			4,
		],
		[
			"config 'profiles.zzzzzz' tunes profile 'zzzzzz', which no profile root holds",
			`Create ${join(W, "zzzzzz/profile.yaml")}, or drop 'profiles.zzzzzz'`,
			5,
		],
	]);
});
