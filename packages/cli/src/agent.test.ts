import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanup } from "./fixtures/packs";
import { GREET, hostOf, json, world } from "./fixtures/world";
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
	test("lists each profile with its runtime and winning root, a pack shadow marked, a broken row's other faults under it", async () => {
		const w = await roster();
		const listed = await w.call(["agent", "ls"]);
		expect(listed.err).toBe("");
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

	test("a profile with neither harness nor model shows dashes and no fault", async () => {
		const w = await roster();
		await Bun.write(
			join(w.cwd, ".maestro/profiles/bare/profile.yaml"),
			"runtime: {}\n",
		);
		const listed = await w.call(["agent", "ls"]);
		expect(listed.out).toMatch(/^ {2}bare +- +- +workspace$/m);
		expect(listed.out).not.toContain("no harness or model");
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
	test("names each preset layer by its own name, a later preset winning a key", async () => {
		const w = await roster();
		await Bun.write(
			join(w.cwd, ".maestro/presets/stub.yaml"),
			"profiles:\n  demo/builder:\n    runtime: { thinking: low }\n",
		);
		const shown = await w.call([
			"agent",
			"show",
			"demo/builder",
			...["--preset", "risky", "--preset", "stub"],
		]);
		expect(shown).toMatchObject({ code: 0, err: "" });
		expect(shown.out).toContain(
			"  model       opus  [preset risky]\n  thinking    low  [preset stub]\n",
		);
	});

	test('a preset\'s profiles."*" stubs a profile only the config files name, show and config naming the preset', async () => {
		const w = await roster();
		await Bun.write(
			join(w.cwd, ".maestro/presets/stub.yaml"),
			'profiles:\n  "*": { runtime: !replace { harness: stub } }\n',
		);
		const stub = ["--preset", "risky", "--preset", "stub"];
		const shown = await w.call(["agent", "show", "demo/builder", ...stub]);
		expect(shown).toMatchObject({ code: 0, err: "" });
		expect(shown.out).toContain(
			"  harness     stub  [preset stub]\n  model       stub\n",
		);
		const config = await w.call(["config", ...GREET, ...stub], {
			hosts: [...builtinHosts({}), hostOf()],
		});
		expect(config).toMatchObject({ code: 0, err: "" });
		expect(config.out).toMatch(
			/^profiles\.\*\.runtime\.harness +preset stub +"stub" +.*stub\.yaml:2$/m,
		);
	});

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
Run maestro agent probe demo/builder --preset risky -c profiles.demo/builder.limits.tokens=3000000 to check it against claude`);
		for (const line of shown.out.split("\n").slice(0, -1))
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
Run maestro agent probe scout to check it against pi`);
	});

	test("an unknown profile is refused with the nearest name", async () => {
		const w = await roster();
		expect(await w.call(["agent", "show", "demo/bilder"])).toMatchObject({
			code: 1,
			err: "error: profile demo/bilder is in no profile root\n  Did you mean 'demo/builder'?",
		});
	});
});

describe("agent show, a profile with a harness or model unset", () => {
	test("shows - for each, says there is no harness to declare an environment, exits 0 and ends with the fix on stderr", async () => {
		const w = await roster();
		await Bun.write(
			join(w.cwd, ".maestro/profiles/bare/profile.yaml"),
			"limits: { tokens: 1 }\n",
		);
		const shown = await w.call(["agent", "show", "bare"]);
		expect(shown.code).toBe(0);
		expect(shown.out).toBe(`bare
  from        .maestro/profiles/bare/

Runtime
  harness     -
  model       -

Limits
  tokens      1

Environment   no harness to declare one`);
		expect(shown.err).toBe(
			"harness and model unset\n  Pass --preset, or set profiles.bare.runtime in .maestro/config.yaml",
		);
	});

	test("a model alone unset still declares the harness's environment, and the fix names the model", async () => {
		const w = await roster();
		const shown = await w.call(["agent", "show", "broken"]);
		expect(shown.code).toBe(0);
		expect(shown.out).toContain("  harness     pi\n  model       -\n");
		expect(shown.out).toContain("Environment   declared only");
		expect(shown.err).toBe(
			"model unset\n  Pass --preset, or set profiles.broken.runtime.model in .maestro/config.yaml",
		);
	});
});

describe("agent probe", () => {
	/** The stub's report, laid over its own: MCP servers it does not declare, one named long, and no word on hooks. */
	const LONG = "internal-knowledge-base-search-for-the-whole-house";
	const STRAY = JSON.stringify({ mcp: ["github", LONG], hooks: null });

	test("starts the stub as a concert would, checks each part of its report, and exits 0 when nothing contradicts", async () => {
		const w = await roster();
		const probed = await w.call(["agent", "probe", "demo/reviewer"]);
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
		const probed = await w.call(["agent", "probe", "demo/reviewer"], {
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
		const colored = await w.call(["agent", "probe", "demo/reviewer"], {
			env,
			terminal: () => ({ columns: COLUMNS, rows: 24 }),
		});
		expect(Bun.stripANSI(colored.out)).toBe(probed.out);

		const { environment } = json(
			await w.call(["agent", "probe", "demo/reviewer", "--json"], {
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

	test("a host that cannot start a sandbox fails the probe with the sandbox's fix last, not a login hint", async () => {
		const w = await roster();
		const access = spyOn(fs, "accessSync").mockImplementation(() => {
			throw new Error("ENOENT");
		});
		try {
			const probed = await w.call(["agent", "probe", "demo/reviewer"]);
			expect(probed.code).toBe(1);
			expect(probed.err).toEndWith("Install bash at /bin/bash");
		} finally {
			access.mockRestore();
		}
	});

	test("keeps the model's window the harness reports, which show then prints under Context and --json carries", async () => {
		const w = await roster();
		const shownJson = async () =>
			json(await w.call(["agent", "show", "demo/reviewer", "--json"]));
		expect((await shownJson()).window).toBeNull();
		const silent = await w.call(["agent", "probe", "demo/reviewer"]);
		expect(silent.out).toContain("\nContext\n? window      not reported\n");
		const env = { MAESTRO_STUB_ENVIRONMENT: '{"window":200000}' };
		const probed = await w.call(["agent", "probe", "demo/reviewer"], {
			env,
		});
		expect(probed.out).toContain(
			"\nContext\n  window      200000  kept for stub none\n",
		);
		expect((await shownJson()).window).toBe(200_000);
	});

	test.each(["{not json", "[1]"])(
		"a MAESTRO_STUB_ENVIRONMENT of %s is a failure",
		async (value) => {
			const w = await roster();
			const env = { MAESTRO_STUB_ENVIRONMENT: value };
			expect(
				await w.call(["agent", "probe", "demo/reviewer"], { env }),
			).toMatchObject({
				code: 1,
				err: `probing stub…\nerror: MAESTRO_STUB_ENVIRONMENT holds '${value}', not a JSON object\n  Set it to an object such as '{"mcp":["github"]}', or unset it`,
			});
		},
	);

	test("a profile with no harness is a usage error naming the fix", async () => {
		const w = await roster();
		await Bun.write(
			join(w.cwd, ".maestro/profiles/bare/profile.yaml"),
			"limits: { tokens: 1 }\n",
		);
		expect(await w.call(["agent", "probe", "bare"])).toMatchObject({
			code: 2,
			err: "error: profile bare leaves harness and model unset, so there is nothing to probe\n  Pass --preset, or set profiles.bare.runtime in .maestro/config.yaml",
		});
	});

	test("a harness no build ships is refused, naming the ones that are", async () => {
		const w = await roster();
		await Bun.write(
			join(w.cwd, ".maestro/profiles/later/profile.yaml"),
			"runtime: { harness: codex, model: gpt }\n",
		);
		expect(await w.call(["agent", "probe", "later"])).toMatchObject({
			code: 2,
			err: "error: harness 'codex' is not loaded\n  Set 'profiles.later.runtime.harness' to one of: pi, claude, stub",
		});
	});
});

test.each([
	[
		["agent"],
		"expected ls, show or probe, got nothing\nRun 'maestro agent ls', 'maestro agent show <profile>', or 'maestro agent probe <profile>'",
	],
	[
		["agent", "list"],
		"expected ls, show or probe, got 'list'\nRun 'maestro agent ls', 'maestro agent show <profile>', or 'maestro agent probe <profile>'",
	],
	[
		["agent", "ls", "scout"],
		"agent ls takes no profile, got 1\nRun 'maestro agent show <profile>' for one profile",
	],
	[["agent", "ls", "--seat", "a/b"], "agent ls takes no --seat\nDrop --seat"],
	[
		["agent", "probe", "scout", "--seat", "a/b"],
		"agent probe takes no --seat\nDrop --seat",
	],
	[
		["agent", "probe"],
		"maestro agent probe needs a profile\nName one as 'maestro agent ls' lists it",
	],
	[
		["agent", "show", "scout", "--yaml"],
		"unknown flag --yaml\nRun 'maestro agent ls', 'maestro agent show <profile>', or 'maestro agent probe <profile>'",
	],
	[
		["agent", "show", "scout", "--probe"],
		"unknown flag --probe\nRun 'maestro agent ls', 'maestro agent show <profile>', or 'maestro agent probe <profile>'",
	],
	[
		["agent", "show", "--concert", "c"],
		"maestro agent show needs a node\nName one as 'maestro ls <concert>' lists it",
	],
	[
		["agent", "show"],
		"maestro agent show needs a profile\nName one as 'maestro agent ls' lists it",
	],
	[
		["agent", "show", "scout", "--prompt"],
		"--prompt takes --seat: the prompt is a seat's\nAdd --seat <composition id>/<seat> and name its composition",
	],
	[
		["agent", "show", "--seat", "smoke/smoke"],
		"maestro agent show needs a composition\nName it by file path or <pack>.<composition>",
	],
])("agent %j is a usage error", async (args, err) => {
	const w = await roster();
	const refused = await w.call(args);
	expect(refused.code).toBe(2);
	if (args.includes("--json")) return expect(json(refused).error).toBe(err);
	const [what = "", ...fix] = err.split("\n");
	expect(refused.err).toStartWith(`error: ${what}\n`);
	expect(refused.err).toEndWith(`\n  ${fix.join("\n")}`);
});

test("agent --help names the ls, show and probe verbs", async () => {
	const helped = await (await roster()).call(["agent", "--help"]);
	expect(helped.out).toContain(
		[
			"Usage: maestro agent ls [flags]  (alias: ag)",
			"       maestro agent show <profile> [flags]",
			"       maestro agent probe <profile> [flags]",
		].join("\n"),
	);
});
