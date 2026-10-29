import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanup } from "./fixtures/packs";
import { json, world } from "./fixtures/world";
import { builtinHosts } from "./hosts";

afterEach(cleanup);

const COLUMNS = 80;

/**
 * A world whose workspace forks the demo pack's `builder`, tuned by the workspace and user config files and by preset
 * `risky`, and holds a profile with no model; the user holds a pi profile.
 */
async function roster() {
	const w = await world();
	const write = (path: string, text: string) => Bun.write(path, text);
	const builder = join(w.cwd, ".maestro/profiles/demo/builder");
	await mkdir(join(w.cwd, ".maestro/skills/jj"), { recursive: true });
	await Promise.all([
		write(
			join(builder, "profile.yaml"),
			"runtime: { harness: claude, model: sonnet, thinking: high }\ninstructions: instructions.md\nattachments:\n  style: { path: style.md, hint: for the house style }\nlimits: { timeout: 45m, tokens: 2000000 }\ncontext: { strategy: handoff, at: 25%, max: 2 }\n",
		),
		write(join(builder, "instructions.md"), "Build it.\nTest it.\n"),
		write(join(builder, "style.md"), "terse\n"),
		write(
			join(w.pack, "profiles/builder/profile.yaml"),
			"limits: { tokens: 1 }\n",
		),
		write(
			join(w.pack, "profiles/reviewer/profile.yaml"),
			"runtime: { harness: stub, model: none }\n",
		),
		write(
			join(w.cwd, ".maestro/profiles/broken/profile.yaml"),
			"runtime: { harness: pi }\n",
		),
		write(
			join(w.cwd, ".maestro/profiles/slow/profile.yaml"),
			"runtime: { harness: pi }\nlimits: { timeout: soon }\n",
		),
		write(
			join(w.env.XDG_CONFIG_HOME, "maestro/profiles/scout/profile.yaml"),
			"runtime: { harness: pi, model: gpt }\n",
		),
		write(
			join(w.cwd, ".maestro/config.yaml"),
			`packs: [${w.pack}]\nprofiles:\n  demo/builder:\n    attachments:\n      jj: { path: .maestro/skills/jj, hint: for jj }\n`,
		),
		write(
			join(w.env.XDG_CONFIG_HOME, "maestro/config.yaml"),
			"profiles:\n  demo/builder:\n    readOnly: [/srv/kb]\n",
		),
		write(
			join(w.cwd, ".maestro/presets/risky.yaml"),
			"profiles:\n  demo/builder:\n    runtime: { model: opus }\n",
		),
	]);
	const hosts = builtinHosts({});
	const call = (args: string[], over: Parameters<typeof w.call>[1] = {}) =>
		w.call(args, { hosts, ...over });
	return { ...w, call };
}

const TUNED = [
	"--preset",
	"risky",
	"-c",
	"profiles.demo/builder.limits.tokens=3000000",
];

describe("agent ls", () => {
	test("lists each profile with its runtime and winning root, a pack shadow marked, a broken row's other faults under it, the unset ones counted on stderr", async () => {
		const w = await roster();
		const listed = await w.call(["agent", "ls"]);
		expect(listed.err.split("\n")).toEqual([
			"2 profiles have no harness or model",
			"  Set them under profiles: in .maestro/config.yaml, or pass --preset",
		]);
		expect(listed.code).toBe(0);
		expect(listed.out.split("\n")).toEqual([
			"Profiles         harness  model   from",
			"  broken         -        -       workspace",
			"  demo/builder   claude   sonnet  workspace  [shadows pack]",
			"  demo/reviewer  stub     none    pack",
			"  scout          pi       gpt     user",
			"  slow           -        -       workspace",
			"    limits.timeout 'soon' is not a duration",
		]);
	});

	test("--json gives each row's fields, and an empty roster says where profiles go", async () => {
		const w = await roster();
		const { profiles } = json(await w.call(["agent", "ls", "--json"]));
		expect(profiles).toEqual([
			{
				name: "broken",
				root: "workspace",
				dir: join(w.cwd, ".maestro/profiles/broken"),
				shadowsPack: false,
				error: "profile broken: no model",
			},
			{
				name: "demo/builder",
				root: "workspace",
				dir: join(w.cwd, ".maestro/profiles/demo/builder"),
				shadowsPack: true,
				harness: "claude",
				model: "sonnet",
			},
			expect.objectContaining({ name: "demo/reviewer", root: "pack" }),
			expect.objectContaining({ name: "scout", root: "user" }),
			expect.objectContaining({
				name: "slow",
				error:
					"profile slow: no model; profile slow: limits.timeout 'soon' is not a duration",
			}),
		]);
		const empty = await (await world()).call(["agent", "ls"]);
		expect(empty).toMatchObject({
			code: 0,
			out: "",
			err: "no profile in any profile root\nCreate .maestro/profiles/<name>/profile.yaml, or install a pack that ships one",
		});
	});
});

describe("agent show", () => {
	test("prints each section at column 15, a value's source only where a layer above the profile set it, uncoloured when piped", async () => {
		const w = await roster();
		const shown = await w.call(["agent", "show", "demo/builder", ...TUNED]);
		expect(shown).toMatchObject({ code: 0, err: "" });
		expect(shown.out).toBe(`demo/builder
  from        .maestro/profiles/demo/builder/
  shadows     demo pack: profiles/builder/

Runtime
  harness     claude
  model       opus  [preset risky]
  thinking    high

Instructions  instructions.md, 2 lines

Attachments   host                 agent
  style       style.md             /in/style
  jj          .maestro/skills/jj/  /in/jj  [workspace config]

Read-only     host     agent
              /srv/kb  /srv/kb  [user config]

Limits
  timeout     45m
  tokens      3000000  [-c]

Context
  strategy    handoff
  at          25%
  max         2

Environment   declared only
  tools       Bash Read Write Edit
  subagents   off
  skills      none
  mcp         none
  hooks       none
  files       none
  compaction  claude's own
Add --probe to check it against claude`);
		for (const line of shown.out.split("\n"))
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
		const colored = await w.call(["agent", "show", "demo/builder", ...TUNED], {
			terminal: () => ({ columns: COLUMNS, rows: 24 }),
		});
		expect(colored.out).not.toBe(shown.out);
		expect(Bun.stripANSI(colored.out)).toBe(shown.out);
	});

	test("leaves out empty sections but Environment, which a harness without a baseline does not declare", async () => {
		const w = await roster();
		await Bun.write(
			join(w.cwd, ".maestro/profiles/later/profile.yaml"),
			"runtime: { harness: codex, model: gpt }\n",
		);
		expect((await w.call(["agent", "show", "later"])).out).toBe(
			`later
  from        .maestro/profiles/later/

Runtime
  harness     codex
  model       gpt

Environment   not declared by codex`,
		);
	});

	test("--yaml folds the layers into one profile.yaml, each source and agent path a trailing comment", async () => {
		const w = await roster();
		const yaml = await w.call([
			"agent",
			"show",
			"demo/builder",
			"--yaml",
			...TUNED,
		]);
		expect(yaml.out).toBe(`# demo/builder
# from    .maestro/profiles/demo/builder/
# shadows demo pack: profiles/builder/
runtime:
  harness: claude
  model: opus # preset risky
  thinking: high
instructions: instructions.md
attachments:
  style:
    path: style.md # agent sees /in/style
    hint: for the house style
  jj:
    path: .maestro/skills/jj # workspace config; agent sees /in/jj
    hint: for jj # workspace config
readOnly:
  - /srv/kb # user config
limits:
  timeout: 45m
  tokens: 3000000 # -c
context:
  strategy: handoff
  at: 25%
  max: 2
---
# environment, declared only
tools:
  - Bash
  - Read
  - Write
  - Edit
subagents: false
skills: []
mcp: []
hooks: []
contextFiles: []
compaction: harness`);
	});

	test("--json gives the same fields, paths absolute", async () => {
		const w = await roster();
		const dir = join(w.cwd, ".maestro/profiles/demo/builder");
		const shown = json(
			await w.call(["agent", "show", "demo/builder", "--json", ...TUNED]),
		);
		expect(shown).toMatchObject({
			name: "demo/builder",
			root: "workspace",
			dir,
			shadows: [join(w.pack, "profiles/builder")],
			runtime: { harness: "claude", model: "opus", thinking: "high" },
			instructions: join(dir, "instructions.md"),
			attachments: {
				style: {
					path: join(dir, "style.md"),
					hint: "for the house style",
					agent: "/in/style",
				},
				jj: { path: join(w.cwd, ".maestro/skills/jj"), agent: "/in/jj" },
			},
			readOnly: ["/srv/kb"],
			limits: { timeout: "45m", tokens: 3000000 },
			context: { strategy: "handoff", at: "25%", max: 2 },
			environment: { declared: { subagents: false, compaction: "harness" } },
		});
		const config = (file: string, line: number) => ({
			file: join(file, "config.yaml"),
			line,
		});
		expect(shown.sources).toMatchObject({
			"runtime.harness": {
				layer: "directory",
				file: join(dir, "profile.yaml"),
				line: 1,
			},
			"runtime.model": {
				layer: "preset",
				file: join(w.cwd, ".maestro/presets/risky.yaml"),
				line: 3,
			},
			"limits.tokens": {
				layer: "flag",
				flag: "-c profiles.demo/builder.limits.tokens=3000000",
			},
			"attachments.jj.path": {
				layer: "workspace",
				...config(join(w.cwd, ".maestro"), 5),
			},
			"readOnly.0": {
				layer: "user",
				...config(join(w.env.XDG_CONFIG_HOME, "maestro"), 3),
			},
		});
	});

	test("pi's profile declares pi's baseline", async () => {
		const w = await roster();
		expect((await w.call(["agent", "show", "scout"])).out).toBe(`scout
  from        ${join(w.env.XDG_CONFIG_HOME, "maestro/profiles/scout")}/

Runtime
  harness     pi
  model       gpt

Environment   declared only
  tools       read bash edit write
  subagents   off
  skills      none
  mcp         none
  hooks       none
  files       none
  compaction  pi's own
Add --probe to check it against pi`);
	});

	test("an unknown profile is refused with the nearest name", async () => {
		const w = await roster();
		expect(await w.call(["agent", "show", "demo/bilder"])).toMatchObject({
			code: 2,
			err: "HOST.profile: profile demo/bilder is in no profile root\n  Did you mean 'demo/builder'?",
		});
	});
});

describe("agent show --probe", () => {
	/** The stub's report, laid over its own: MCP servers it does not declare, one named long, and no word on hooks. */
	const LONG = "internal-knowledge-base-search-for-the-whole-house";
	const STRAY = JSON.stringify({ mcp: ["github", LONG], hooks: null });

	test("starts the stub as a concert would, checks each part of its report, and exits 0 when nothing contradicts", async () => {
		const w = await roster();
		const probed = await w.call(["agent", "show", "demo/reviewer", "--probe"]);
		expect(probed).toMatchObject({ code: 0, err: "probing stub…" });
		expect(probed.out).toEndWith(`Environment   probed stub
✓ tools       none
✓ subagents   off
✓ skills      none
✓ mcp         none
✓ hooks       none
✓ files       none
? compaction  stub's own

0 faults`);
	});

	test("a part the harness loads and the profile does not declare is a fault under its row, wrapped within 80 columns, which exits 1; an unreported part is ?", async () => {
		const w = await roster();
		const env = { MAESTRO_STUB_ENVIRONMENT: STRAY };
		const probed = await w.call(["agent", "show", "demo/reviewer", "--probe"], {
			env,
		});
		expect(probed.code).toBe(1);
		expect(probed.out).toEndWith(`✗ mcp         none
              github loaded, not declared
              ${LONG} loaded, not
              declared
? hooks       none
✓ files       none
? compaction  stub's own

2 faults`);
		for (const line of probed.out.split("\n"))
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
		const colored = await w.call(
			["agent", "show", "demo/reviewer", "--probe"],
			{ env, terminal: () => ({ columns: COLUMNS, rows: 24 }) },
		);
		expect(Bun.stripANSI(colored.out)).toBe(probed.out);

		const { environment } = json(
			await w.call(["agent", "show", "demo/reviewer", "--probe", "--json"], {
				env,
			}),
		);
		expect(environment.observed).toMatchObject({ mcp: ["github", LONG] });
		expect(environment.observed).not.toHaveProperty("hooks");
		expect(environment.checks).toContainEqual({
			part: "mcp",
			mark: "✗",
			faults: ["github loaded, not declared", `${LONG} loaded, not declared`],
		});
	});

	test("keeps the model's window the harness reports, which show then prints under Context and --json carries", async () => {
		const w = await roster();
		const shownJson = async () =>
			json(await w.call(["agent", "show", "demo/reviewer", "--json"]));
		expect((await shownJson()).window).toBeNull();
		const silent = await w.call(["agent", "show", "demo/reviewer", "--probe"]);
		expect(silent.out).toContain("\nContext\n? window      not reported\n");
		const env = { MAESTRO_STUB_ENVIRONMENT: '{"window":200000}' };
		const probed = await w.call(["agent", "show", "demo/reviewer", "--probe"], {
			env,
		});
		expect(probed.out).toContain("\nContext\n  window      200000\n");
		expect((await shownJson()).window).toBe(200_000);
	});

	test.each(["{not json", "[1]"])(
		"a MAESTRO_STUB_ENVIRONMENT of %s is a usage error",
		async (value) => {
			const w = await roster();
			const env = { MAESTRO_STUB_ENVIRONMENT: value };
			expect(
				await w.call(["agent", "show", "demo/reviewer", "--probe"], { env }),
			).toMatchObject({
				code: 2,
				err: `probing stub…\nMAESTRO_STUB_ENVIRONMENT holds '${value}', not a JSON object\nSet it to an object such as '{"mcp":["github"]}', or unset it`,
			});
		},
	);

	test("a harness no build ships is refused, naming the ones that are", async () => {
		const w = await roster();
		await Bun.write(
			join(w.cwd, ".maestro/profiles/later/profile.yaml"),
			"runtime: { harness: codex, model: gpt }\n",
		);
		expect(await w.call(["agent", "show", "later", "--probe"])).toMatchObject({
			code: 2,
			err: "harness 'codex' is not loaded\nSet 'profiles.later.runtime.harness' to one of: pi, claude, stub",
		});
	});
});

test.each([
	[
		["agent"],
		"expected ls or show, got nothing\nRun 'maestro agent ls', or 'maestro agent show <profile>'",
	],
	[
		["agent", "list"],
		"expected ls or show, got 'list'\nRun 'maestro agent ls', or 'maestro agent show <profile>'",
	],
	[
		["agent", "ls", "scout"],
		"agent ls takes no profile, got 1\nRun 'maestro agent show <profile>' for one profile",
	],
	[["agent", "ls", "--yaml"], "agent ls takes no --yaml\nDrop --yaml"],
	[["agent", "ls", "--probe"], "agent ls takes no --probe\nDrop --probe"],
	[
		["agent", "show", "scout", "--probe", "--yaml"],
		"--yaml and --probe both given\nPass one of them",
	],
	[
		["agent", "show", "x", "--probe", "--concert", "c"],
		"--probe and --concert both given\nPass one of them",
	],
	[
		["agent", "show", "--concert", "c"],
		"expected one node, got 0\nName a node, as 'maestro ls <concert>' lists it",
	],
	[
		["agent", "show"],
		"expected one profile, got 0\nName a profile, as 'maestro agent ls' lists it",
	],
	[
		["agent", "show", "scout", "--prompt"],
		"--prompt takes --seat: the prompt is a seat's\nAdd --seat <composition id>/<seat> and name its composition",
	],
	[
		["agent", "show", "--seat", "smoke/smoke"],
		"expected one composition, got 0\nName the composition the seat sits in: a file, or <pack>.<composition>",
	],
	[
		["agent", "show", "scout", "--yaml", "--json"],
		"--yaml and --json both given\nPass one of them",
	],
])("agent %j is a usage error", async (args, err) => {
	const w = await roster();
	const refused = await w.call(args);
	expect(refused.code).toBe(2);
	expect(args.includes("--json") ? json(refused).error : refused.err).toBe(err);
});
