import { afterAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
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
import {
	findProfile,
	isProfileName,
	profilesDigest,
	resolveProfile,
	untunable,
} from "./index";

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
	write("ws/.maestro/profiles/shared/guide.md", "guide\n"),
	write(
		"ws/.maestro/profiles/sharer/profile.yaml",
		`${RUNTIME}instructions: ../shared/guide.md\nattachments:\n  all: { path: ../shared, hint: shared }\n`,
	),
	write(
		"ws/.maestro/profiles/spaced/profile.yaml",
		"attachments:\n  all: { path: .., hint: all }\n",
	),
	write(
		"ws/.maestro/profiles/ownself/profile.yaml",
		`${RUNTIME}attachments:\n  all: { path: ../ownself, hint: self }\n`,
	),
	write("xdg/maestro/profiles/classics/shared/note.md", "note\n"),
	write(
		"xdg/maestro/profiles/classics/lens/profile.yaml",
		`${RUNTIME}attachments:\n  all: { path: ../shared, hint: shared }\n`,
	),
	write(
		"xdg/maestro/profiles/classics/reach/profile.yaml",
		`${RUNTIME}attachments:\n  all: { path: ../../auditor, hint: other level }\n`,
	),
	write("packs/acme/profiles/shared/x.md", "x\n"),
	write(
		"packs/acme/profiles/user/profile.yaml",
		`${RUNTIME}attachments:\n  all: { path: ../shared, hint: shared }\n`,
	),
	write("ws/.maestro/profiles/reserved/profile.yaml", `${RUNTIME}mcp: {}\n`),
	write("ws/.maestro/profiles/bound/profile.yaml", "readOnly: [/etc]\n"),
	write(
		"ws/.maestro/profiles/dotdot/profile.yaml",
		"instructions: ../../../../outside.md\n",
	),
	write("ws/.maestro/profiles/linked/profile.yaml", "instructions: link.md\n"),
	write("ws/.maestro/profiles/missing/profile.yaml", "instructions: gone.md\n"),
	write("ws/.maestro/profiles/unknown/profile.yaml", `${RUNTIME}modle: x\n`),
	write(
		"ws/.maestro/profiles/slow/profile.yaml",
		`${RUNTIME}limits: { timeout: soon }\n`,
	),
	write(
		"ws/.maestro/profiles/uncapped/profile.yaml",
		`${RUNTIME}context: { strategy: handoff, at: 50000 }\n`,
	),
	write(
		"ws/.maestro/profiles/whole-window/profile.yaml",
		`${RUNTIME}context: { strategy: compact, at: "100%" }\n`,
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
await Promise.all([
	write(
		"ws/.maestro/profiles/kitted/profile.yaml",
		`${RUNTIME}harnessExtras: extras\n`,
	),
	write("ws/.maestro/profiles/kitted/extras/models.json", "{}\n"),
	write("ws/.maestro/profiles/kitted/extras/lib/index.js", "x\n"),
	write(
		"ws/.maestro/profiles/kitshare/profile.yaml",
		`${RUNTIME}harnessExtras: ../kit-extras\n`,
	),
	write("ws/.maestro/profiles/kit-extras/models.json", "{}\n"),
	write(
		"ws/.maestro/profiles/kitgone/profile.yaml",
		`${RUNTIME}harnessExtras: gone\n`,
	),
	write(
		"ws/.maestro/profiles/kitfile/profile.yaml",
		`${RUNTIME}harnessExtras: profile.yaml\n`,
	),
	write(
		"ws/.maestro/profiles/kitlinks/profile.yaml",
		`${RUNTIME}harnessExtras: extras\n`,
	),
	write("ws/.maestro/profiles/kitlinks/extras/models.json", "{}\n"),
	write("config-extras/models.json", "{}\n"),
]);
symlinkSync("../models.json", join(W, "kitted/extras/lib/models.json"));
symlinkSync("models.json", join(W, "kit-extras/alias.json"));
symlinkSync(join(root, "outside.md"), join(W, "kitlinks/extras/abs"));
symlinkSync("nothing", join(W, "kitlinks/extras/dangling"));
symlinkSync(".", join(W, "kitlinks/extras/loop"));
symlinkSync("../profile.yaml", join(W, "kitlinks/extras/up"));
await write("ws/.maestro/profiles/kitlinks/extras-x/f", "f\n");
symlinkSync("../extras-x/f", join(W, "kitlinks/extras/sib"));
mkdirSync(join(W, "kitlinks/extras/a"));
mkdirSync(join(W, "kitlinks/extras/b"));
symlinkSync("../b", join(W, "kitlinks/extras/a/x"));
symlinkSync("../a", join(W, "kitlinks/extras/b/y"));
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

describe("shared paths", () => {
	test("a path out of the profile directory resolves inside its namespace directory", async () => {
		const profile = await resolveProfile("sharer", setupOf({}));
		expect(profile.fields).toMatchObject({
			instructions: join(W, "shared/guide.md"),
			attachments: { all: { path: join(W, "shared") } },
		});
	});

	test("a profile's own directory by a path out and back is the profile directory", async () => {
		expect(
			(await refusal(() => resolveProfile("ownself", setupOf({})))).map(
				(r) => r[0],
			),
		).toEqual([
			"profile ownself: 'attachments.all.path' is ., which is the profile directory itself",
		]);
	});

	test.each([
		["a shadow", "classics/lens", join(U, "classics/shared")],
		["a pack's own profile", "acme/user", join(ACME, "shared")],
	])(
		"%s resolves a path in its own namespace directory",
		async (_, name, dir) => {
			const profile = await resolveProfile(name, setupOf({}));
			expect(profile.fields.attachments).toMatchObject({ all: { path: dir } });
		},
	);

	test("the digest changes when a shared file changes, and not when none a profile names does", async () => {
		const before = await profilesDigest(ROOTS);
		await write("ws/.maestro/profiles/shared/guide.md", "edited\n");
		const after = await profilesDigest(ROOTS);
		await write("ws/.maestro/profiles/shared/guide.md", "guide\n");
		expect(after).not.toBe(before);
		expect(await profilesDigest(ROOTS)).toBe(before);
	});
});

const skill = (description: string, body = "") =>
	`---\nname: x\ndescription: ${description}\n---\n${body}`;
await Promise.all([
	write(
		"packs/classics/skills/tdd/SKILL.md",
		skill(
			'"Test-driven development: red, green. Use when building test-first."',
			"Read [`codebase-design`](../codebase-design/SKILL.md).\n",
		),
	),
	write(
		"packs/classics/skills/codebase-design/SKILL.md",
		skill("Vocabulary for deep modules. Use when designing."),
	),
	write("packs/classics/skills/bare/SKILL.md", "no frontmatter\n"),
	write(
		"packs/classics/skills/deep/SKILL.md",
		skill("Nested links. Use when testing."),
	),
	write(
		"packs/classics/skills/deep/ref/notes.md",
		"[own](../SKILL.md) and [sibling](../../codebase-design/SKILL.md#intro)\n",
	),
	write(
		"ws/.maestro/skills/codebase-design/SKILL.md",
		skill("A bare twin. Use when clashing."),
	),
	write(
		"ws/.maestro/profiles/deepd/profile.yaml",
		`${RUNTIME}skills: [classics/deep]\n`,
	),
	write(
		"ws/.maestro/profiles/clash/profile.yaml",
		`${RUNTIME}skills: [classics/codebase-design, codebase-design]\n`,
	),
	write("ws/.maestro/skills/writing/SKILL.md", skill("Write docs.")),
	write(
		"ws/.maestro/profiles/skilled/profile.yaml",
		`${RUNTIME}skills: [classics/tdd, classics/codebase-design, writing]\n`,
	),
	write(
		"ws/.maestro/profiles/lonely/profile.yaml",
		`${RUNTIME}skills: [classics/tdd]\n`,
	),
	write(
		"ws/.maestro/profiles/ghost/profile.yaml",
		`${RUNTIME}skills: [classics/tdc]\n`,
	),
	write(
		"ws/.maestro/profiles/bare/profile.yaml",
		`${RUNTIME}skills: [classics/bare]\n`,
	),
]);

describe("skills", () => {
	test("each is found like a profile, mounted by its own name and described by its frontmatter", async () => {
		const { skills } = (await resolveProfile("skilled", setupOf({}))).fields;
		expect(skills).toEqual([
			{
				name: "tdd",
				ref: "classics/tdd",
				dir: join(ROOTS.packs.classics ?? "", "skills/tdd"),
				description:
					"Test-driven development: red, green. Use when building test-first.",
			},
			{
				name: "codebase-design",
				ref: "classics/codebase-design",
				dir: join(ROOTS.packs.classics ?? "", "skills/codebase-design"),
				description: "Vocabulary for deep modules. Use when designing.",
			},
			{
				name: "writing",
				ref: "writing",
				dir: join(ROOTS.workspace ?? "", "skills/writing"),
				description: "Write docs.",
			},
		]);
	});

	test.each([
		[
			"a link to a skill the profile does not attach",
			"lonely",
			"profile lonely: skill classics/tdd links ../codebase-design/SKILL.md, which the profile does not attach",
			"Add classics/codebase-design to its skills, or drop the link from tdd",
		],
		[
			"a link from a nested file, resolved from its folder and with an anchor",
			"deepd",
			"profile deepd: skill classics/deep links ../codebase-design/SKILL.md, which the profile does not attach",
			"Add classics/codebase-design to its skills, or drop the link from deep",
		],
		[
			"two skills on one mount name",
			"clash",
			"profile clash: skills classics/codebase-design and codebase-design both mount at /skills/codebase-design",
			"Drop one of classics/codebase-design and codebase-design from skills",
		],
		[
			"a skill no root holds",
			"ghost",
			"profile ghost: skill classics/tdc is in no skill root",
			"Did you mean 'classics/tdd'?",
		],
		[
			"a skill with no description",
			"bare",
			`profile bare: skill classics/bare has no description in ${join(ROOTS.packs.classics ?? "", "skills/bare/SKILL.md")}`,
			`Add a 'description' to the frontmatter of ${join(ROOTS.packs.classics ?? "", "skills/bare/SKILL.md")}`,
		],
	])("refuses %s", async (_, name, message, fix) => {
		expect(await refusal(() => resolveProfile(name, setupOf({})))).toEqual([
			[message, fix, 2],
		]);
	});

	test("the digest changes when a skill changes", async () => {
		const before = await profilesDigest(ROOTS);
		await write("ws/.maestro/skills/writing/SKILL.md", skill("Edited."));
		const after = await profilesDigest(ROOTS);
		await write("ws/.maestro/skills/writing/SKILL.md", skill("Write docs."));
		expect(after).not.toBe(before);
	});
});

describe("the digest of shared paths", () => {
	test("skips a named path that is no regular file or directory", async () => {
		const sock = join(W, "shared/sock");
		const server = createServer().listen(sock);
		await once(server, "listening");
		await write(
			"ws/.maestro/profiles/socky/profile.yaml",
			`${RUNTIME}attachments:\n  s: { path: ../shared/sock, hint: s }\n`,
		);
		try {
			expect(await profilesDigest(ROOTS)).toStartWith("sha256:");
		} finally {
			server.close();
			rmSync(join(W, "socky"), { recursive: true, force: true });
			rmSync(sock, { force: true });
		}
	});

	test("adds no shared file of a profile file with a refused path", async () => {
		await write(
			"ws/.maestro/profiles/halfbad/profile.yaml",
			`${RUNTIME}instructions: ../shared/guide.md\nattachments:\n  o: { path: ../../../../outside.md, hint: o }\n`,
		);
		try {
			const before = await profilesDigest(ROOTS);
			await write("ws/.maestro/profiles/shared/guide.md", "edited\n");
			const edited = await profilesDigest(ROOTS);
			await write("ws/.maestro/profiles/shared/guide.md", "guide\n");
			// `sharer` names the guide too, so the digest moves; drop it to see halfbad alone.
			expect(edited).not.toBe(before);
			rmSync(join(W, "sharer"), { recursive: true, force: true });
			const alone = await profilesDigest(ROOTS);
			await write("ws/.maestro/profiles/shared/guide.md", "edited\n");
			const aloneEdited = await profilesDigest(ROOTS);
			expect(aloneEdited).toBe(alone);
			await write(
				"ws/.maestro/profiles/sharer/profile.yaml",
				`${RUNTIME}instructions: ../shared/guide.md\nattachments:\n  all: { path: ../shared, hint: shared }\n`,
			);
		} finally {
			await write("ws/.maestro/profiles/shared/guide.md", "guide\n");
			rmSync(join(W, "halfbad"), { recursive: true, force: true });
		}
	});
});

describe("harness extras", () => {
	test("resolves relative to the profile directory, inside or beside it in the namespace directory", async () => {
		const kitted = await resolveProfile("kitted", setupOf({}));
		const kitshare = await resolveProfile("kitshare", setupOf({}));
		expect(kitted.fields.harnessExtras).toBe(join(W, "kitted/extras"));
		expect(kitshare.fields.harnessExtras).toBe(join(W, "kit-extras"));
	});

	test.each([
		[
			"kitgone",
			"profile kitgone: 'harnessExtras' is gone, which does not exist",
			`Create it in ${W}`,
		],
		[
			"kitfile",
			"profile kitfile: 'harnessExtras' is profile.yaml, which is not a directory",
			`Point it at a directory inside ${W}`,
		],
	])(
		"refuses %s's path, naming the profile and the path",
		async (name, message, hint) => {
			expect(await refusal(() => resolveProfile(name, setupOf({})))).toEqual([
				[message, hint, 2],
			]);
		},
	);

	test("refuses a config path that does not exist or is no directory, naming the profile and the path", async () => {
		const gone = join(root, "config-gone");
		const file = join(root, "config-extras/models.json");
		const refused = async (path: string) =>
			refusal(() =>
				resolveProfile(
					"auditor",
					setupOf({
						workspace: `profiles:\n  auditor:\n    harnessExtras: ${path}\n`,
					}),
				),
			);
		expect(await refused(gone)).toEqual([
			[
				`profile auditor: 'harnessExtras' is ${gone}, which does not exist`,
				"Point it at a directory",
				3,
			],
		]);
		expect(await refused(file)).toEqual([
			[
				`profile auditor: 'harnessExtras' is ${file}, which is not a directory`,
				"Point it at a directory",
				3,
			],
		]);
	});

	test("refuses each link that is absolute, dangling, cyclic or resolves outside the directory, naming the profile and the link", async () => {
		const fix = (link: string) =>
			`Make ${link} a relative link to an entry inside ${join(W, "kitlinks/extras")}, so the directory is self-contained`;
		expect(
			await refusal(() => resolveProfile("kitlinks", setupOf({}))),
		).toEqual([
			["profile kitlinks: harnessExtras link a/x is cyclic", fix("a/x"), 2],
			["profile kitlinks: harnessExtras link abs is absolute", fix("abs"), 2],
			["profile kitlinks: harnessExtras link b/y is cyclic", fix("b/y"), 2],
			[
				"profile kitlinks: harnessExtras link dangling points at nothing",
				fix("dangling"),
				2,
			],
			["profile kitlinks: harnessExtras link loop is cyclic", fix("loop"), 2],
			[
				"profile kitlinks: harnessExtras link sib resolves outside the directory",
				fix("sib"),
				2,
			],
			[
				"profile kitlinks: harnessExtras link up resolves outside the directory",
				fix("up"),
				2,
			],
		]);
	});

	test("a directory config sets replaces the profile's whole", async () => {
		const profile = await resolveProfile(
			"kitted",
			setupOf({
				workspace: "profiles:\n  kitted:\n    harnessExtras: config-extras\n",
			}),
		);
		expect(profile.fields.harnessExtras).toBe(join(root, "config-extras"));
		expect(sourceOf(profile, ["harnessExtras"])?.layer).toBe("workspace");
	});

	test.each([
		[
			"a file in the profile directory",
			"ws/.maestro/profiles/kitted/extras/models.json",
		],
		[
			"a file beside it in the namespace directory",
			"ws/.maestro/profiles/kit-extras/models.json",
		],
	])("the digest changes when %s changes", async (_, path) => {
		const before = await profilesDigest(ROOTS);
		await write(path, "edited\n");
		const after = await profilesDigest(ROOTS);
		await write(path, "{}\n");
		expect(after).not.toBe(before);
		expect(await profilesDigest(ROOTS)).toBe(before);
	});

	test.each([
		[
			"in the profile directory",
			join(W, "kitted/extras/lib/models.json"),
			"../models.json",
		],
		[
			"beside it in the namespace directory",
			join(W, "kit-extras/alias.json"),
			"models.json",
		],
	])(
		"the digest changes when a link's target changes %s",
		async (_, link, target) => {
			const before = await profilesDigest(ROOTS);
			rmSync(link);
			symlinkSync(`./${target}`, link);
			const after = await profilesDigest(ROOTS);
			rmSync(link);
			symlinkSync(target, link);
			expect(after).not.toBe(before);
			expect(await profilesDigest(ROOTS)).toBe(before);
		},
	);

	/** The config layers of a workspace config that sets profile auditor's extras directory to `path`. */
	const extrasAt = (path: string) =>
		setupOf({
			workspace: `profiles:\n  auditor:\n    harnessExtras: ${path}\n`,
		}).layers;

	test("the digest ignores a directory config sets outside the namespace directory", async () => {
		const layers = extrasAt(join(root, "config-extras"));
		const before = await profilesDigest(ROOTS, layers);
		await write("config-extras/models.json", "edited\n");
		const after = await profilesDigest(ROOTS, layers);
		await write("config-extras/models.json", "{}\n");
		expect(after).toBe(before);
	});

	test("the digest ignores a directory config sets beside the namespace directory, its name sharing the namespace's as a prefix", async () => {
		await write("ws/.maestro/profiles-x/models.json", "{}\n");
		const layers = extrasAt(`${W}-x`);
		const before = await profilesDigest(ROOTS, layers);
		await write("ws/.maestro/profiles-x/models.json", "edited\n");
		const after = await profilesDigest(ROOTS, layers);
		rmSync(`${W}-x`, { recursive: true, force: true });
		expect(after).toBe(before);
	});

	test("the digest changes when a file changes in a directory config sets inside the namespace directory", async () => {
		await write("ws/.maestro/profiles/config-kit/models.json", "{}\n");
		const layers = extrasAt(join(W, "config-kit"));
		const before = await profilesDigest(ROOTS, layers);
		await write("ws/.maestro/profiles/config-kit/models.json", "edited\n");
		const after = await profilesDigest(ROOTS, layers);
		rmSync(join(W, "config-kit"), { recursive: true, force: true });
		expect(after).not.toBe(before);
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

	test('a layer\'s profiles."*" reaches a profile only a lower layer names, its tags applying', async () => {
		const setup = setupOf({
			user: "profiles:\n  auditor:\n    runtime: { model: sonnet, thinking: high }\n",
			preset: 'profiles:\n  "*":\n    runtime: !replace { harness: stub }\n',
		});
		const profile = await resolveProfile("auditor", setup);
		expect(profile.fields.runtime).toEqual({ harness: "stub", model: "stub" });
		expect(sourceOf(profile, ["runtime", "harness"])).toEqual({
			layer: "preset",
			file: join(root, "preset.yaml"),
			line: 3,
		});
	});

	test('a named entry beats profiles."*" in its own layer and above it, field by field', async () => {
		const setup = setupOf({
			user: 'profiles:\n  "*":\n    runtime: { model: any, thinking: low }\n',
			workspace:
				'profiles:\n  "*":\n    limits: { tokens: 5 }\n  auditor:\n    limits: { tokens: 7, timeout: 1m }\n    runtime: { model: named }\n',
		});
		const profile = await resolveProfile("auditor", setup);
		expect(profile.fields).toMatchObject({
			runtime: { harness: "claude", model: "named", thinking: "low" },
			limits: { tokens: 7, timeout: 60_000 },
		});
		expect(sourceOf(profile, ["runtime", "thinking"])?.layer).toBe("user");
	});

	test('a !replace on profiles holding only "*" replaces every profile\'s fields beneath it', async () => {
		const setup = setupOf({
			user: "profiles:\n  auditor:\n    limits: { tokens: 3 }\n",
			preset: 'profiles: !replace\n  "*":\n    runtime: { harness: stub }\n',
		});
		const profile = await resolveProfile("auditor", setup);
		expect(profile.fields.runtime).toEqual({ harness: "stub", model: "stub" });
		expect(profile.fields.limits).toEqual({});
	});

	test('a !delete under "*" drops the field a lower layer set', async () => {
		const setup = setupOf({
			user: "profiles:\n  auditor:\n    runtime: { thinking: high }\n",
			preset: 'profiles:\n  "*":\n    runtime: { thinking: !delete }\n',
		});
		const profile = await resolveProfile("auditor", setup);
		expect(profile.fields.runtime).toEqual({
			harness: "claude",
			model: "opus",
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
				"profile classics/builder: no harness or model",
				"Set profiles.classics/builder.runtime.harness and profiles.classics/builder.runtime.model",
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
					`profile dotdot: 'instructions' is ../../../../outside.md, which is outside the namespace directory ${W}`,
					`Keep it inside ${W}, or set it in config under 'profiles.dotdot.instructions'`,
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
					`profile linked: 'instructions' is link.md, which is outside the namespace directory ${W}`,
					`Keep it inside ${W}, or set it in config under 'profiles.linked.instructions'`,
					1,
				],
			],
			"",
		],
		[
			"an attachment that is the namespace directory",
			"spaced",
			[
				[
					"profile spaced: 'attachments.all.path' is .., which is the namespace directory itself",
					`Point it at a file or directory inside ${W}`,
					2,
				],
			],
			"",
		],
		[
			"a shadow's path that reaches another level",
			"classics/reach",
			[
				[
					`profile classics/reach: 'attachments.all.path' is ../../auditor, which is outside the namespace directory ${join(U, "classics")}`,
					`Keep it inside ${join(U, "classics")}, or set it in config under 'profiles.classics/reach.attachments.all.path'`,
					3,
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
					`Create it in ${W}`,
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
			"a handoff with no cap",
			"uncapped",
			[
				[
					"profile uncapped: context.max is required for strategy handoff",
					"Set profiles.uncapped.context.max, the most handoffs the agent may make",
					2,
				],
			],
			"",
		],
		[
			"a context trigger of the whole window",
			"whole-window",
			[
				[
					"profile whole-window: 'context.at' must match pattern \"^([1-9][0-9]?)%$\"",
					"Fix it where it is set",
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
					`Point it at a file inside ${W}`,
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
					`Point it at a file or directory inside ${W}`,
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

test('profiles."*" tunes no profile by name', async () => {
	const setup = setupOf({ workspace: 'profiles:\n  "*": {}\n' });
	expect(await untunable(setup)).toEqual([]);
});
