import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Host, HostSetup } from "@maestro/core/host";
import { openRecord } from "@maestro/core/perform";
import { IR_VERSION } from "@maestro/ir";
import { shortId, shortIds, stateWord } from "@maestro/render-text/live";
import { SDK_VERSION, STDLIB_HASH } from "@maestro/sdk/loader";
import { fakeHost } from "@maestro/testkit";
import { fixedRun, transcript, until } from "@maestro/transcript";
import pkg from "../package.json";
import {
	cleanup,
	demoSource,
	FIXTURES,
	packOf,
	scratch,
} from "./fixtures/packs";
import {
	closingOf,
	configValues,
	ECHO,
	FIRST,
	GREET,
	hostOf,
	idOf,
	json,
	shortOf,
	world,
} from "./fixtures/world";
import { codeHashOf } from "./loader";
import { diffColored, renderDiagnostic, renderWarning } from "./output";
import { startPager } from "./pager";
import { olderHint } from "./records";

const GOLDEN = join(FIXTURES, "../../../ir/fixtures");
const HELLO = join(FIXTURES, "hello.ts");
const CLASH = join(FIXTURES, "clash.ts");
const CLASH_OUT = join(FIXTURES, "clash-out.ts");
const CLASH_NO = join(FIXTURES, "clash-no.ts");
const LOUD = join(FIXTURES, "loud.ts");
const DESCRIBED = join(FIXTURES, "described.ts");
const USES_ECHO = join(FIXTURES, "uses_echo.ts");
const ESC = "\u001b";
const SGR = new RegExp(`${ESC}\\[[\\d;]*m`);

function expectPlainClosing(
	text: string,
	verb: string | undefined,
	term: string | undefined,
) {
	if (verb === "wait" || term === "dumb") expect(text).not.toContain(ESC);
	else expect(text).not.toMatch(SGR);
}

/** The keys of an `ls --json` listing row, the whole of it. */
const LIST_ROW = [
	"id",
	"short",
	"status",
	"pack",
	"composition",
	"workspace",
	"tour",
	"title",
	"encoreOf",
	"startedAt",
	"settledAt",
	"elapsedMs",
	"tokens",
	"diskUse",
	"facts",
	"notes",
];

/** Forgets the disk use the record keeps for `ids`, as a store from before it kept any: `ls` then shows none and `prune` measures it. */
function unmeasured(w: Awaited<ReturnType<typeof world>>, ...ids: string[]) {
	const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
	for (const id of ids)
		db.run("UPDATE concerts SET disk_use = NULL WHERE id = ?", [id]);
	db.close();
}

/** A code node writing two files and returning them beside plain values, and a stdlib node keyed on SDK 0.0.0. */
const WRITE = `export async function write(_: object, ctx: { scratch: string }) {
	for (const name of ["a.txt", "b.txt"]) await Bun.write(\`\${ctx.scratch}/\${name}\`, name);
	const [a, b] = ["a.txt", "b.txt"].map((name) => \`\${ctx.scratch}/\${name}\`);
	return { file: a, nested: { files: [b] }, n: 2, s: "a b", multi: "a\\nb", tab: "a\\tb", cr: "a\\rb", sep: "a\\u2028b", none: null };
}
`;

const FILE = { "x-maestro-type": "core.file" };

const writeIr = (codeHash: string) => ({
	irVersion: "1.0",
	composition: { id: "write", version: "0.1.0", pack: "fixtures" },
	emitter: { name: "hand", version: "1" },
	scopes: [],
	nodes: [
		{
			id: "get",
			kind: "code",
			in: { value: { type: "object" }, path: { type: "string" } },
			literals: { value: { a: 1 }, path: "a" },
			out: { value: { type: "integer" } },
			worker: {
				runtime: "ts",
				module: "maestro:stdlib",
				export: "get",
				codeHash: "maestro:stdlib@0.0.0",
			},
		},
		{
			id: "write",
			kind: "code",
			out: {
				file: FILE,
				nested: {
					type: "object",
					properties: { files: { type: "array", items: FILE } },
				},
				n: { type: "number" },
				s: { type: "string" },
				multi: { type: "string" },
				tab: { type: "string" },
				cr: { type: "string" },
				sep: { type: "string" },
				none: { type: "null" },
			},
			worker: { runtime: "ts", module: "write.ts", export: "write", codeHash },
		},
	],
	edges: [],
	result: { node: "write" },
});

afterEach(cleanup);

// Seam: the CLI's exit code for a tour supplied by an operator.
test("--tour accepts a 64-character tour", async () => {
	const w = await world();
	const result = await w.call(["ls", "--tour", "a".repeat(64), "--json"]);
	expect(result.code).toBe(0);
});

describe("compose and config", () => {
	// Seam: config's terminal, piped and JSON output for compositions and recorded concerts.
	test("config fits values while keeping their source and location and hints at full values", async () => {
		const w = await world();
		const value = "long-value-".repeat(12);
		const host: Host = {
			...hostOf(),
			config: { mode: { type: "object", required: ["token"] } },
		};
		await Bun.write(
			join(w.cwd, ".maestro/config.yaml"),
			`packs: [${w.pack}]\nmode: { token: ${value} }\n`,
		);
		const performed = await w.call(["perform", ...GREET], { hosts: [host] });
		expect(performed.code).toBe(0);
		const env = { HOME: w.root, TERM: "xterm" };
		for (const target of ["demo.greet", idOf(performed)]) {
			const args = ["config", target];
			const on = await w.call([...args, "--color"], {
				hosts: [host],
				env,
				terminal: () => ({ columns: 80, rows: 24 }),
			});
			expect(on.code).toBe(0);
			const plain = stripVTControlCharacters(on.out);
			const row =
				plain.split("\n").find((line) => line.startsWith("mode.token")) ?? "";
			expect(row).toContain("workspace");
			expect(row).toContain("~/ws/.maestro/config.yaml:2");
			const piped = await w.call(args, { hosts: [host], env });
			expect(piped.out).toContain(value);
			expect(piped.out).not.toContain("Full values:");
			const jsonArgs = [...args, "--json"];
			const document = await w.call(jsonArgs, {
				hosts: [host],
				env,
				terminal: () => ({ columns: 80, rows: 24 }),
			});
			expect(json(document)).toEqual(
				json(await w.call(jsonArgs, { hosts: [host], env })),
			);
			expect(configValues(document)["mode.token"]).toBe(value);
			expect(
				plain.split("\n").every((line) => Bun.stringWidth(line) <= 80),
			).toBe(true);
			expect(row).toContain("…");
			expect(on.out).toContain(
				`${ESC}[2mFull values: maestro config ${target} --json${ESC}[22m`,
			);
		}
	});

	test("config hints at its own invocation when a value is cut and at nothing when none is", async () => {
		const w = await world();
		const value = "long-value-".repeat(12);
		const host: Host = {
			...hostOf(),
			config: { mode: { type: "object", required: ["token"] } },
		};
		await Bun.write(
			join(w.cwd, ".maestro/config.yaml"),
			`packs: [${w.pack}]\nmode: { token: ${value} }\n`,
		);
		const env = { HOME: w.root, TERM: "xterm" };
		const args = ["config", "demo.greet", "-c", "mode.other=a b"];
		const at = async (columns: number) =>
			(
				await w.call(args, {
					hosts: [host],
					env,
					terminal: () => ({ columns, rows: 24 }),
				})
			).out;
		expect(await at(80)).toContain(
			"Full values: maestro config demo.greet -c 'mode.other=a b' --json",
		);
		expect(await at(1000)).not.toContain("Full values:");
	});

	test("config's hint puts --json before a -- and stays whole however long the invocation, while its table fits", async () => {
		const w = await world();
		const value = "long-value-".repeat(12);
		const host: Host = {
			...hostOf(),
			config: { mode: { type: "object", required: ["token"] } },
		};
		await Bun.write(
			join(w.cwd, ".maestro/config.yaml"),
			`packs: [${w.pack}]\nmode: { token: ${value} }\n`,
		);
		const env = { HOME: w.root, TERM: "xterm" };
		const terminal = () => ({ columns: 80, rows: 24 });
		const ended = await w.call(["config", "demo.greet", "--"], {
			hosts: [host],
			env,
			terminal,
		});
		expect(ended.out).toContain("maestro config demo.greet --json --");
		const long = await w.call(
			["config", "demo.greet", "-c", `mode.other=${"y".repeat(220)}`],
			{
				hosts: [host],
				env,
				terminal,
			},
		);
		const [hint = "", ...rows] = long.out.split("\n").reverse();
		expect(rows.every((l) => Bun.stringWidth(l) <= 80)).toBe(true);
		// The hint is a command to run, so it stays whole however wide it is.
		expect(stripVTControlCharacters(hint)).toBe(
			`Full values: maestro config demo.greet -c mode.other=${"y".repeat(220)} --json`,
		);
		// A cut colored cell stops its color, so it cannot run into the next row.
		const count = (l: string, code: string) =>
			l.split(`${ESC}[${code}m`).length - 1;
		expect(rows.some((l) => l.includes(`…${ESC}[0m`))).toBe(true);
		// Bold and dim both end at 22, or at a reset.
		for (const l of rows)
			expect(count(l, "1") + count(l, "2")).toBe(
				count(l, "22") + count(l, "0"),
			);
	});

	// Seam: config's table on a terminal and in a pipe, for a composition and a recorded concert.
	test("config distinguishes table headings, sources and home file locations on a terminal", async () => {
		const w = await world();
		await Bun.write(
			join(w.cwd, ".maestro/config.yaml"),
			`packs: [${w.pack}]\nconcurrency: 2\n`,
		);
		const terminal = () => ({ columns: 200, rows: 24 });
		const env = { HOME: w.root, TERM: "xterm" };
		const performed = await w.call(["perform", ...GREET], {
			hosts: [hostOf()],
			env,
		});
		expect(performed.code).toBe(0);
		for (const target of ["demo.greet", idOf(performed)]) {
			const on = await w.call(["config", target, "--color"], { terminal, env });
			expect(on.code).toBe(0);
			expect(on.out).toStartWith("\u001b[1m");
			expect(stripVTControlCharacters(on.out).split("\n")[0]).toMatch(
				/^key +source +value +from$/,
			);
			expect(on.out).toContain("\u001b[2mworkspace\u001b[22m");
			expect(on.out).toContain(
				"\u001b[2m~/ws/.maestro/config.yaml:2\u001b[22m",
			);
			// A row with no file or flag ends at its value, no escape after it.
			expect(on.out).toMatch(
				new RegExp(
					`^caps +${RegExp.escape("\u001b[2mdefault\u001b[22m")} +\\{\\}$`,
					"m",
				),
			);
			const piped = await w.call(["config", target], { env });
			expect(piped.code).toBe(0);
			expect(piped.out).toMatch(
				new RegExp(
					`^concurrency +workspace +2 +${RegExp.escape(join(w.cwd, ".maestro/config.yaml"))}:2$`,
					"m",
				),
			);
			expect(piped.out).not.toContain("\u001b[");
		}
	});
	test("config bolds a header only on a terminal and leaves empty from cells unstyled", async () => {
		const w = await world();
		const terminal = () => ({ columns: 200, rows: 24 });
		const forced = await w.call(["config", "demo.greet", "--color"]);
		expect(forced.code).toBe(0);
		expect(forced.out).not.toContain("\u001b[1m");
		const plain = await w.call(["config", "demo.greet", "--no-color"], {
			terminal,
		});
		expect(plain.out).toMatch(/^key +source +value +from\n/);
		const on = await w.call(["config", "demo.greet", "--color"], { terminal });
		expect(on.out.split("\n").filter((l) => l !== l.trimEnd())).toEqual([]);
	});
	// Seam: recorded readers' exit codes and JSON, with config files and code unavailable, after a host stops declaring a deferred key.
	test("recorded readers show the performed plan and composed snapshot without config files or composition code, and every concert when one no longer composes", async () => {
		const w = await world();
		const former: Host = {
			...hostOf(),
			config: {
				mode: { type: "object", required: ["token"] },
				profiles: { type: "object" },
			},
			paths: [["mode", "path"]],
			deferred: [["profiles"]],
		};
		const config = join(w.cwd, ".maestro/config.yaml");
		const recorded = `packs: [${w.pack}]\nmode: { token: recorded, path: relative }\n`;
		await Bun.write(config, recorded);
		await Bun.write(
			join(w.cwd, ".maestro/presets/fast.yaml"),
			"concurrency: 3\n",
		);
		const perform = async (...flags: string[]) => {
			const performed = await w.call(["perform", ...GREET, ...flags], {
				hosts: [former],
			});
			expect(performed.code).toBe(0);
			return idOf(performed);
		};
		const healthy = await perform("--preset", "fast");
		await Bun.write(
			config,
			`${recorded}profiles:\n  retired:\n    missing: !delete\n`,
		);
		const pending = await perform();
		const compose = (id: string, flag: string, options = {}) =>
			w.call(["compose", "--concert", id, flag], {
				hosts: [former],
				...options,
			});
		const before = await compose(healthy, "--json");
		expect(before.code).toBe(0);
		const plan = json(before).plan;
		expect(plan.bounds.instances).toEqual({ exact: 4 });
		const pendingPlan = await compose(pending, "--plan");
		expect(pendingPlan.code).toBe(0);
		await Bun.write(config, "[broken YAML");
		await Bun.write(
			join(w.env.XDG_CONFIG_HOME, "maestro/config.yaml"),
			"[broken YAML",
		);
		await Bun.write(
			join(w.pack, "index.js"),
			"throw new Error('composition must not load');",
		);
		const reader: Host = {
			...hostOf(),
			config: { mode: { type: "object", required: ["future"] } },
			paths: [["mode", "path"]],
		};
		const outside = { cwd: await scratch(), hosts: [reader] };
		const composed = await compose(healthy, "--json", outside);
		expect(composed.code).toBe(0);
		expect(json(composed)).toMatchObject({ ok: true, plan });
		const after = await compose(pending, "--plan", outside);
		expect(after.code).toBe(0);
		expect(after.out).toBe(pendingPlan.out);
		expect(after.err).not.toBe("");
		const document = await compose(pending, "--json", outside);
		expect(document.code).toBe(0);
		expect(json(document)).toMatchObject({
			ok: true,
			plan: { bounds: { instances: { exact: 4 } } },
		});
		const listed = await w.call(["ls", "--json"], outside);
		expect(listed.code).toBe(0);
		const rows = json(listed);
		expect(rows.map((row: { id: string }) => row.id).sort()).toEqual(
			[healthy, pending].sort(),
		);
		const single = async (id: string) => {
			const shown = await w.call(["ls", id, "--json"], outside);
			expect(shown.code).toBe(0);
			return json(shown);
		};
		expect(await single(healthy)).toMatchObject({ id: healthy });
		expect(await single(pending)).toMatchObject({ id: pending, status: "ok" });
		const configured = await w.call(["config", healthy, "--json"], outside);
		expect(configured.code).toBe(0);
		expect(configValues(configured)).toMatchObject({
			concurrency: 3,
			workspace: "ws",
			"mode.token": "recorded",
			"mode.path": join(w.cwd, "relative"),
		});
		expect((await w.call(["config", pending, "--json"], outside)).code).toBe(1);
		const table = await w.call(["ls"], outside);
		expect(table.code).toBe(0);
		expect(
			table.out
				.split("\n")
				.slice(1)
				.map((line) => line.split(/\s+/)[0])
				.sort(),
		).toEqual([shortOf(healthy), shortOf(pending)].sort());
	});

	test("compose prints the summary, the plan with --plan, and one document with --json", async () => {
		const w = await world();
		const summary = await w.call(["c", ...GREET]);
		expect(summary).toMatchObject({
			code: 0,
			out: expect.stringContaining("greet: 4 node instances"),
		});
		expect((await w.call(["compose", ...GREET, "--plan"])).out).toContain(
			"bounds:",
		);
		expect((await w.call(["compose", ...GREET, "--graph"])).out).toContain(
			"flowchart",
		);
		const drawn = await w.call(["compose", ...GREET, "--graph", "--flow"]);
		expect(drawn.code).toBe(0);
		expect(drawn.out).toContain("flowchart TD\n  start((start))\n");
		expect(drawn.out).toContain("<br/><small>");
		const alone = await w.call(["compose", ...GREET, "--flow"]);
		expect(alone.code).toBe(0);
		expect(alone.out).toBe(drawn.out);
		expect(json(await w.call(["compose", ...GREET, "--json"]))).toMatchObject({
			ok: true,
			plan: { bounds: { instances: { exact: 4 } } },
		});
	});

	// Seams: compose's JSON and exit code for a file and a recorded concert, and the --out file.
	const loopFanPlan = {
		bounds: {
			instances: { upTo: 16 },
			nodes: {
				init: { exact: 1 },
				rounds: { exact: 1 },
				"rounds/fan": { upTo: 2 },
				"rounds/fan/worker": { upTo: 4 },
				"rounds/firstOk": { upTo: 2 },
				"rounds/firstOk_text": { upTo: 2 },
				"rounds/finish": { upTo: 2 },
				"rounds/finish_not": { upTo: 2 },
			},
			counts: {},
		},
		expansion: { rounds: { "": { upTo: 2 } } },
		diagnostics: [],
		nodes: [
			{ id: "init", kind: "fake.task" },
			{ id: "rounds", kind: "loop" },
			{ id: "rounds/fan", kind: "parMap" },
			{ id: "rounds/fan/worker", kind: "fake.task" },
			{ id: "rounds/firstOk", kind: "code" },
			{ id: "rounds/firstOk_text", kind: "code" },
			{ id: "rounds/finish", kind: "fake.task" },
			{ id: "rounds/finish_not", kind: "code" },
		],
	};

	test("compose --plan --json prints a lean plan for a file, including its groups", async () => {
		const w = await world();
		const shown = await w.call([
			"compose",
			join(FIXTURES, "loop-fan.ts"),
			"--plan",
			"--json",
		]);
		expect(shown.code).toBe(0);
		expect(json(shown)).toEqual({ ok: true, plan: loopFanPlan, agents: [] });
	});

	test("compose --concert --plan --json prints the recorded lean plan", async () => {
		const w = await world();
		const done = { outcome: "ok", outputs: { text: "done" } } as const;
		const hosts = [
			fakeHost({
				steps: {
					init: [done],
					"rounds/fan/worker": [done],
					"rounds/finish": [done],
				},
			}),
		];
		const performed = await w.call(["perform", join(FIXTURES, "loop-fan.ts")], {
			hosts,
		});
		expect(performed.code).toBe(0);
		const shown = await w.call(
			["compose", "--concert", idOf(performed), "--plan", "--json"],
			{ hosts },
		);
		expect(shown.code).toBe(0);
		expect(json(shown)).toEqual({ ok: true, plan: loopFanPlan, agents: [] });
	});

	test("compose --json without --plan prints the full document", async () => {
		const w = await world();
		const shown = await w.call([
			"compose",
			join(FIXTURES, "loop-fan.ts"),
			"--json",
		]);
		expect(shown.code).toBe(0);
		const document = json(shown);
		expect(Object.keys(document).sort()).toEqual(["agents", "ok", "plan"]);
		expect(document).toMatchObject({
			ok: true,
			agents: [],
			plan: {
				bounds: loopFanPlan.bounds,
				expansion: loopFanPlan.expansion,
				diagnostics: [],
				ir: {
					nodes: expect.arrayContaining([
						expect.objectContaining({ id: "rounds", kind: "loop" }),
						expect.objectContaining({ id: "rounds/fan", kind: "parMap" }),
					]),
					edges: expect.any(Array),
					scopes: expect.any(Array),
				},
			},
		});
	});

	test("compose --plan --json saves --out before printing the lean plan", async () => {
		const w = await world();
		const file = join(FIXTURES, "loop-fan.ts");
		const out = join(w.root, "plan.json");
		const shown = await w.call([
			"compose",
			file,
			"--plan",
			"--json",
			"--out",
			out,
		]);
		expect(shown.code).toBe(0);
		expect(await Bun.file(out).json()).toMatchObject({
			nodes: expect.arrayContaining([
				expect.objectContaining({ id: "rounds", kind: "loop" }),
			]),
			edges: expect.any(Array),
		});
		const refused = await w.call([
			"compose",
			file,
			"--plan",
			"--json",
			"--out",
			w.root,
		]);
		expect(refused.code).not.toBe(0);
		if (refused.out !== "") expect(json(refused).ok).toBe(false);
		expect(json(shown)).toEqual({ ok: true, plan: loopFanPlan, agents: [] });
	});

	test("compose highlights the composition name on a terminal and leaves piped output plain", async () => {
		const w = await world();
		const args = ["compose", ...GREET];
		const terminal = () => ({ columns: 120, rows: 24 });
		const piped = await w.call(args);
		const shown = await w.call(args, { terminal });
		expect(piped.code).toBe(0);
		expect(shown.code).toBe(0);
		expect(piped.out).toStartWith("greet: 4 node instances");
		expect(shown.out).toStartWith(`${ESC}[1mgreet${ESC}[22m: 4 node instances`);
		expect(stripVTControlCharacters(shown.out)).toBe(piped.out);
	});

	test("compose --plan highlights the composition name on a terminal", async () => {
		const w = await world();
		const shown = await w.call(["compose", ...GREET, "--plan"], {
			terminal: () => ({ columns: 120, rows: 24 }),
		});
		expect(shown.code).toBe(0);
		expect(shown.out).toStartWith(`${ESC}[1mgreet${ESC}[22m: 4 node instances`);
	});

	test("compose --concert pre-flights the graph the concert recorded, not one built anew, and takes no composition or param flag", async () => {
		const w = await world();
		const id = idOf(await w.call(["p", ...GREET]));
		const planOf = async (args: string[]) =>
			json(await w.call(["compose", ...args, "--json"])).plan;
		const recorded = await planOf(["--concert", id]);
		expect(recorded).toEqual(await planOf(GREET));
		expect(recorded).not.toEqual(await planOf(["demo.greet", "--name", "y"]));
		for (const [args, err] of [
			[
				["--concert", id, "--name", "y"],
				/^error: unknown flag --name\n {2}See 'maestro compose --help'; 'maestro encore <id>'/,
			],
			[
				[...GREET, "--concert", id],
				/^error: maestro compose --concert takes no composition, got 'demo.greet'\n/,
			],
			[
				["--concert", id, "demo.greet"],
				/^error: maestro compose --concert takes no composition, got 'demo.greet'\n/,
			],
			[
				["--concert", "--plan"],
				/^error: maestro compose --concert needs a concert\n/,
			],
			[
				["--plan", "--concert"],
				/^error: maestro compose --concert needs a concert\n/,
			],
			[
				["--concert", "fffffff"],
				/^error: no concert 'fffffff' in the record\n/,
			],
		] as const)
			expect((await w.call(["c", ...args])).err).toMatch(err);
	});

	test("an example set's file resolves against the composition file's directory, or the pack's, not the cwd", async () => {
		const bare = await world();
		const out = await bare.call(["compose", join(FIXTURES, "sample.ts")]);
		expect(out.err).toBe("");
		expect(out.code).toBe(0);
		const packed = await world();
		const dir = await scratch();
		await packOf(join(FIXTURES, "sample.ts"), dir, { id: "sample" });
		await Bun.write(join(dir, "sample.md"), "A sample.\n");
		await Bun.write(
			join(packed.cwd, ".maestro/config.yaml"),
			`packs:\n  - ${dir}\n`,
		);
		expect((await packed.call(["compose", "sample.sample"])).code).toBe(0);
	});

	test("a composition that cannot be built exits 1 with its diagnostics, no location inside its bundle, or one document with --json", async () => {
		const w = await world();
		const file = join(FIXTURES, "twice.ts");
		const human = await w.call(["compose", file]);
		expect(human.code).toBe(1);
		expect(human.err).toMatch(/^error: /);
		expect((await w.call(["compose", file, "--json"])).code).toBe(1);
		const document = json(await w.call(["compose", file, "--json"]));
		expect(document.ok).toBe(false);
		expect(document.diagnostics.length).toBeGreaterThan(0);
	});

	test.each([
		["a pack's composition", GREET],
		["the file itself", [HELLO]],
	])(
		"a key under a bare file's name is unclaimed config when the target is %s",
		async (_, target) => {
			const w = await world();
			await Bun.write(
				join(w.cwd, ".maestro/config.yaml"),
				`packs:\n  - ${w.pack}\nhello:\n  hello:\n    name: yaml\n`,
			);
			expect(await w.call(["compose", ...target])).toMatchObject({
				code: 1,
				err: expect.stringContaining(
					"error: config key 'hello' is claimed by no installed host, pack or core\n  Remove 'hello' from the config, or install the pack or host that claims it. To configure a composition file, make it a pack",
				),
			});
		},
	);

	test("a pack's composition params reach a bare file that uses it, from -c, the workspace config and a preset", async () => {
		const w = await world();
		const out = join(w.root, "out");
		await Bun.write(
			join(w.cwd, ".maestro/presets/more.yaml"),
			"demo:\n  echo:\n    times: 4\n",
		);
		const timesOf = async (...extra: string[]) => {
			const file = join(out, `${extra.length}.json`);
			await w.call(["compose", USES_ECHO, "--out", file, ...extra]);
			const ir = await Bun.file(file).json();
			return ir.nodes.find((n: { id: string }) => n.id === "echo/echo").literals
				.times;
		};
		expect(await timesOf()).toBe(1);
		expect(await timesOf("-c", "demo.echo.times=3")).toBe(3);
		expect(await timesOf("--preset", "more")).toBe(4);
		await Bun.write(
			join(w.cwd, ".maestro/config.yaml"),
			`packs:\n  - ${w.pack}\ndemo:\n  echo:\n    times: 5\n`,
		);
		expect(await timesOf()).toBe(5);
	});

	// Seams: config's table and JSON, concert resolution and usage exits at the CLI.
	test("config shows a concert's recorded values, sources, params and invocation from any folder", async () => {
		const w = await world();
		const config = join(w.cwd, ".maestro/config.yaml");
		const preset = join(w.cwd, ".maestro/presets/a.yaml");
		await Bun.write(config, `packs: [${w.pack}]\nconcurrency: 2\n`);
		await Bun.write(preset, "concurrency: 4\n");
		await Bun.write(
			join(w.cwd, ".maestro/presets/b.yaml"),
			"workspace: rehearsal\n",
		);
		const flags = [
			"--preset",
			"a",
			"--preset",
			"b",
			"-c",
			"limits.tokens=10000",
			"-c",
			"limits.timeout=2h",
		];
		const performed = await w.call(["perform", ...GREET, ...flags], {
			hosts: [hostOf()],
		});
		expect(performed.code).toBe(0);
		const id = idOf(performed);
		await Bun.write(config, "[broken YAML");
		await Bun.write(preset, "[broken YAML");
		await Bun.write(
			join(w.env.XDG_CONFIG_HOME, "maestro/config.yaml"),
			"[broken YAML",
		);
		const outside = { cwd: await scratch(), hosts: [hostOf()] };
		const shown = await w.call(["config", id, "--json"], outside);
		expect(shown.code).toBe(0);
		const document = json(shown);
		expect(document).toMatchObject({
			presets: ["a", "b"],
			flags: ["limits.tokens=10000", "limits.timeout=2h"],
			limits: { tokens: 10000, timeout: 7200000 },
			params: { name: "x" },
			moduleDir: expect.any(String),
		});
		expect(document).not.toHaveProperty("file");
		expect(document.values).toContainEqual(
			expect.objectContaining({
				key: "packs",
				value: [w.pack],
				layer: "workspace",
				file: config,
				line: 1,
			}),
		);
		expect(document.values).toContainEqual(
			expect.objectContaining({
				key: "concurrency",
				value: 4,
				layer: "preset",
				file: preset,
				line: 1,
			}),
		);
		expect(document.values).toContainEqual(
			expect.objectContaining({
				key: "limits.tokens",
				value: 10000,
				layer: "flag",
				flag: "-c limits.tokens=10000",
			}),
		);
		expect(document.values).toContainEqual(
			expect.objectContaining({
				key: "demo.greet.name",
				value: "x",
				layer: "flag",
			}),
		);
		const table = await w.call(["config", id], outside);
		expect(table.code).toBe(0);
		expect(table.out).toMatch(
			new RegExp(`^concurrency +preset a +4 +${RegExp.escape(preset)}:1$`, "m"),
		);
		expect(table.out).toMatch(
			/^limits\.tokens +flag +10000 +-c limits\.tokens=10000$/m,
		);
		expect(table.out).toMatch(/^demo\.greet\.name +flag +"x"$/m);
	});

	test("config resolves concert ids and prefixes as ls does", async () => {
		const w = await world();
		const a = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const b = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const shared = [...a].findIndex((c, i) => c !== b[i]);
		const prefix = a.slice(0, shared + 1);
		const full = await w.call(["config", a, "--json"]);
		expect(full.code).toBe(0);
		for (const name of [prefix, shortId(a)]) {
			const abbreviated = await w.call(["config", name, "--json"]);
			expect(abbreviated.code).toBe(0);
			expect(json(abbreviated)).toEqual(json(full));
		}
		const ambiguous = a.slice(0, shared);
		const ls = await w.call(["ls", ambiguous]);
		const refused = await w.call(["config", ambiguous]);
		expect(ls.code).toBe(2);
		expect(refused.code).toBe(2);
		expect(refused.out).toBe("");
		expect(refused.err).not.toBe("");
	});

	test("config refuses presets and overrides for a concert", async () => {
		const w = await world();
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		for (const flags of [
			["--preset", "fast"],
			["-c", "concurrency=2"],
			["--config", "concurrency=2"],
		]) {
			for (const args of [
				["config", id, ...flags],
				[...flags, "config", id],
			]) {
				const refused = await w.call(args);
				expect(refused.code).toBe(2);
				expect(refused.out).toBe("");
			}
		}
	});

	test("config shows no presets, flags or limits for a concert performed without them", async () => {
		const w = await world();
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const document = json(await w.call(["config", id, "--json"]));
		expect(document.presets).toEqual([]);
		expect(document.flags).toEqual([]);
		expect(document).not.toHaveProperty("limits");
	});

	test("config shows the workspace value of a concert performed from a bare file named workspace", async () => {
		const w = await world();
		const file = join(FIXTURES, "workspace.ts");
		const performed = await w.call(["perform", file, "--name", "x"], {
			hosts: [hostOf()],
		});
		expect(performed.code).toBe(0);
		const rows = json(
			await w.call(["config", idOf(performed), "--json"]),
		).values;
		expect(
			rows.find((r: { key: string }) => r.key === "workspace"),
		).toBeDefined();
		expect(rows).not.toContainEqual(
			expect.objectContaining({ key: "workspace.named.name" }),
		);
	});

	test("config keeps the layer of a param that config gave and adds no row for a param no flag gave", async () => {
		const w = await world();
		const config = join(w.cwd, ".maestro/config.yaml");
		await Bun.write(
			config,
			`packs: [${w.pack}]\ndemo:\n  greet:\n    name: fromfile\n`,
		);
		const performed = await w.call(["perform", "demo.greet"], {
			hosts: [hostOf()],
		});
		expect(performed.code).toBe(0);
		const rows = json(
			await w.call(["config", idOf(performed), "--json"]),
		).values;
		const named = rows.filter(
			(r: { key: string }) => r.key === "demo.greet.name",
		);
		expect(named).toHaveLength(1);
		expect(named[0]).toMatchObject({
			value: "fromfile",
			layer: "workspace",
			file: config,
			line: 4,
		});
	});

	test("config refuses a second argument after a concert", async () => {
		const w = await world();
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const refused = await w.call(["config", id, "extra"]);
		expect(refused.code).toBe(2);
		expect(refused.out).toBe("");
		expect(refused.err).toContain("extra");
	});

	test("config --help for a concert lists no --preset or -c, and for a composition lists them", async () => {
		const w = await world();
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const concert = await w.call(["config", id, "--help"]);
		const composition = await w.call(["config", "demo.greet", "--help"]);
		const common = (text: string) => text.split("Common flags:")[1] ?? "";
		expect(common(concert.out)).not.toContain("--preset");
		expect(common(concert.out)).not.toContain("-c/--config");
		expect(common(composition.out)).toContain("--preset");
		expect(common(composition.out)).toContain("-c/--config");
	});

	test("config refuses a concert whose snapshot no longer composes and names the key", async () => {
		const w = await world();
		const former: Host = {
			...hostOf(),
			config: { retired: { type: "object" } },
			deferred: [["retired"]],
		};
		await Bun.write(
			join(w.cwd, ".maestro/config.yaml"),
			`packs: [${w.pack}]\nretired:\n  missing: !delete\n`,
		);
		const performed = await w.call(["perform", ...GREET], { hosts: [former] });
		expect(performed.code).toBe(0);
		const id = idOf(performed);
		await Bun.write(
			join(w.cwd, ".maestro/config.yaml"),
			`packs: [${w.pack}]\n`,
		);
		const broken = await w.call(["config", id], { hosts: [hostOf()] });
		expect(broken.code).toBe(1);
		expect(broken.out).toBe("");
		expect(broken.err.split(/[\s'"`,:;()]+/)).toContain("retired.missing");
	});

	test("config refuses a concert with a missing or unreadable snapshot", async () => {
		const w = await world();
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
		const cases: [string | null, RegExp][] = [
			[null, /predates config snapshots/],
			["[", /not one this maestro reads/],
		];
		for (const [snapshot, why] of cases) {
			db.run("UPDATE concerts SET snapshot = ? WHERE id = ?", [snapshot, id]);
			const refused = await w.call(["config", id]);
			expect(refused.code).toBe(1);
			expect(refused.out).toBe("");
			expect(refused.err).toMatch(why);
		}
		db.close();
	});

	test("config lists every value with the layer and the file and line, or the -c, it came from", async () => {
		const w = await world();
		const SET = ["-c", "concurrency=3"];
		const rows = json(await w.call(["cfg", ...GREET, ...SET, "--json"])).values;
		expect(rows).toContainEqual(
			expect.objectContaining({
				key: "demo.greet.name",
				value: "x",
				layer: "flag",
			}),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({ key: "packs", layer: "workspace", line: 1 }),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				key: "concurrency",
				layer: "flag",
				flag: "-c concurrency=3",
			}),
		);
		const text = (await w.call(["config", ...GREET, ...SET])).out;
		expect(text).toMatch(/^packs +workspace +.*config\.yaml:1$/m);
		expect(text).toMatch(/^concurrency +flag +3 +-c concurrency=3$/m);
	});

	test("config lists a composition whose required param nothing gives, that param unset", async () => {
		const w = await world();
		const listed = await w.call(["config", "demo.greet"]);
		expect(listed.code).toBe(0);
		expect(listed.out).toMatch(/^demo\.greet\.name +unset +unset$/m);
		expect(
			json(await w.call(["config", "demo.greet", "--json"])).values,
		).toContainEqual({
			key: "demo.greet.name",
			value: null,
			layer: "unset",
		});
	});

	test("config on a bare file lists the session's values and its required param unset", async () => {
		const w = await world();
		const file = join(FIXTURES, "named.ts");
		const text = (await w.call(["config", file, "-c", "concurrency=3"])).out;
		expect(text).toMatch(/^concurrency +flag +3 +-c concurrency=3$/m);
		expect(text).toMatch(/^named\.named\.name +unset +unset$/m);
	});

	test("config leaves a required param that is given off the unset rows", async () => {
		const w = await world();
		const rows = json(await w.call(["config", ...GREET, "--json"])).values;
		expect(rows).not.toContainEqual(
			expect.objectContaining({ key: "demo.greet.name", layer: "unset" }),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({ key: "demo.greet.name", value: "x" }),
		);
	});

	test("config names each preset layer by its own name", async () => {
		const w = await world();
		const presets = join(w.cwd, ".maestro/presets");
		await Bun.write(join(presets, "risky.yaml"), "concurrency: 4\n");
		await Bun.write(join(presets, "stub.yaml"), "workspace: rehearsal\n");
		const text = (
			await w.call([
				"config",
				...GREET,
				"--preset",
				"risky",
				"--preset",
				"stub",
			])
		).out;
		expect(text).toMatch(/^concurrency +preset risky +4 +.*risky\.yaml:1$/m);
		expect(text).toMatch(/^workspace +preset stub +.*stub\.yaml:1$/m);
	});

	test("--out of a pack writes an IR that performs, and of a bare file or a concert of one writes its bundle beside it", async () => {
		const w = await world();
		const dir = join(w.root, "out");
		const concert = idOf(await w.call(["p", HELLO], { hosts: [] }));
		for (const [name, target] of [
			["greet", GREET],
			["hello", [HELLO]],
			["again", ["--concert", concert]],
		] as const)
			expect(
				await w.call([
					"compose",
					...target,
					"--out",
					join(dir, `${name}.json`),
				]),
			).toMatchObject({
				code: 0,
				err: expect.stringContaining("wrote"),
			});
		expect((await readdir(dir)).sort()).toEqual([
			"again.bundle.js",
			"again.json",
			"greet.json",
			"hello.bundle.js",
			"hello.json",
		]);
		for (const [name, hosts] of [
			["greet", [hostOf()]],
			["hello", []],
			["again", []],
		] as const)
			expect(
				await w.call(["perform", join(dir, `${name}.json`)], { hosts }),
			).toMatchObject({
				code: 0,
				err: expect.stringMatching(/ {2}ok {2}\S+$/),
			});
	});
});

const CURSOR_CODE = new RegExp(`(${ESC}\\[\\d*[FJ])`);
const CURSOR_UP = new RegExp(`^${ESC}\\[(\\d*)F$`);

/** What a terminal shows after `writes`, each ending in a newline: `ESC[nF` moves up n lines, `ESC[J` clears below. */
function screenOf(writes: readonly string[]): string {
	const screen: string[] = [""];
	let row = 0;
	const put = (text: string) => {
		for (const [i, line] of text.split("\n").entries()) {
			if (i > 0) row += 1;
			screen[row] = line;
		}
	};
	const apply = (part: string) => {
		const up = CURSOR_UP.exec(part);
		if (up) row = Math.max(0, row - Number(up[1] || 1));
		else if (part === `${ESC}[J`) {
			screen.length = row;
			screen[row] = "";
		} else put(part);
	};
	for (const write of writes) {
		for (const part of write.split(CURSOR_CODE).filter(Boolean)) apply(part);
		row += 1;
		screen[row] ??= "";
	}
	return screen.join("\n");
}

type Held = {
	host: ReturnType<typeof hostOf>;
	writes: string[];
	running: Promise<{ code: number; out: string; err: string }>;
	/** Lets the held first step finish and the concert settle. */
	finish(): void;
};

/** Whether `writes` hold `text`, color codes aside. */
const wrote = (writes: readonly string[], text: string) =>
	stripVTControlCharacters(writes.join("\n")).includes(text);

/**
 * Runs `args` on a stderr terminal with a concert whose first step waits for `finish`, once it has started and, unless
 * `block` is false, the live block shows it running.
 */
async function held(
	w: Awaited<ReturnType<typeof world>>,
	args: readonly string[],
	{
		columns = 120,
		env = { TERM: "xterm", NO_COLOR: "1" },
		beforeHold,
		writes = [],
		text,
		sharedTerminal = false,
		block = true,
	}: {
		block?: boolean;
		sharedTerminal?: boolean;
		writes?: string[];
		text?: object;
		columns?: number | (() => number);
		env?: Record<string, string>;
		beforeHold?: (ctx: {
			emit: (event: object) => void;
		}) => void | Promise<void>;
	} = {},
): Promise<Held> {
	const step = Promise.withResolvers<typeof ECHO>();
	const started = Promise.withResolvers<void>();
	const base = hostOf(ECHO, {
		steps: {
			first: async (_instance: unknown, _inputs: unknown, ctx: never) => {
				await beforeHold?.(ctx);
				started.resolve();
				return step.promise;
			},
			"echo/echo": [ECHO],
		},
	});
	const host = text ? Object.create(base, { text: { value: text } }) : base;
	const running = w.call([...args], {
		hosts: [host],
		...(sharedTerminal && { terminal: () => ({ columns: 120, rows: 40 }) }),
		stderrTerminal: () => ({
			columns: typeof columns === "number" ? columns : columns(),
		}),
		env,
		stderr: (text) => writes.push(text),
	});
	await Promise.race([started.promise, running]);
	if (block) await until(() => wrote(writes, "now   ● first"));
	return { host, writes, running, finish: () => step.resolve(ECHO) };
}

const START = Date.UTC(2026, 0, 5, 9);

/** Runs `body` with the clock and the concert ids fixed. */
async function fixed<T>(
	body: (run: ReturnType<typeof fixedRun>) => Promise<T>,
): Promise<T> {
	const run = fixedRun(START);
	try {
		return await body(run);
	} finally {
		run.restore();
	}
}

/** A concert whose code node prints through `console.log`, or through `process.stdout`, while the first step runs. */
async function printed(via: "console" | "stdout") {
	const w = await world();
	const writes: string[] = [];
	const log = spyOn(console, "log").mockImplementation((text) => {
		writes.push(String(text));
	});
	const out = spyOn(process.stdout, "write").mockImplementation(((
		text: string,
	) => {
		writes.push(text.trimEnd());
		return true;
	}) as never);
	try {
		let during = "";
		const live = await held(w, ["perform", ...GREET], {
			writes,
			sharedTerminal: via === "stdout",
			env: { TERM: "xterm" },
			beforeHold: async () => {
				await until(() => wrote(writes, "● demo.greet"));
				if (via === "console") console.log("shout hey");
				else process.stdout.write("shout hey\n");
			},
		});
		during = screenOf(writes);
		live.finish();
		await live.running;
		return { during, settled: screenOf(writes) };
	} finally {
		log.mockRestore();
		out.mockRestore();
	}
}

/** A concert on a 100-column terminal that shrinks to 20 after other output, drawn up to the redraw at 20. */
async function shrunk(run: ReturnType<typeof fixedRun>) {
	const w = await world();
	const writes: string[] = [];
	const log = spyOn(console, "log").mockImplementation((text) => {
		writes.push(String(text));
	});
	let columns = 100;
	try {
		const live = await held(
			w,
			["perform", ...GREET, "--title", "a very long title"],
			{ writes, columns: () => columns, env: { TERM: "xterm" } },
		);
		const drawn = writes.length;
		columns = 20;
		const before = writes.length;
		console.log("MARK");
		const mark = writes.length;
		// The redraw the print itself makes, before any poll tick.
		const screen = screenOf(writes.slice(before + 1, mark));
		run.at(1000);
		await until(() => wrote(writes.slice(mark), "now   "));
		const end = writes.length;
		live.finish();
		await live.running;
		return { writes, drawn, mark, end, screen };
	} finally {
		log.mockRestore();
	}
}

/** A concert on a 100-column terminal that gets a Ctrl-C while its first step runs. */
async function interrupted() {
	const w = await world();
	const before = process.listenerCount("SIGINT");
	const live = await held(w, ["perform", ...GREET], {
		env: { TERM: "xterm" },
	});
	const during = process.listenerCount("SIGINT") - before;
	process.emit("SIGINT");
	const left = process.listenerCount("SIGINT") - before;
	live.finish();
	const result = await live.running;
	return { code: result.code, during, left, screen: screenOf(live.writes) };
}

describe("perform", () => {
	// Seam: stderr and stdout while a foreground command waits for a concert, and after it settles.
	// Transcript: what a stderr terminal shows while `perform` waits, and after the concert settles.
	test("draws the live block over itself as time passes, and the closing block in its place", async () => {
		const sections = [];
		for (const columns of [100, 40, 20]) {
			await fixed(async (run) => {
				const w = await world();
				let progress = () => {};
				const live = await held(
					w,
					["perform", ...GREET, "--title", "Live test"],
					{
						columns,
						env: { TERM: "xterm" },
						beforeHold: ({ emit }) => {
							progress = () =>
								emit({ kind: "tool", name: "bash", input: { command: "ls" } });
						},
					},
				);
				const drawn = live.writes.length;
				run.at(64_000);
				progress();
				await until(() => live.writes.length > drawn);
				const during = screenOf(live.writes);
				run.at(95_000);
				live.finish();
				await live.running;
				sections.push(
					{
						name: `perform on a ${columns}-column terminal, 1m04s in, while the first step runs`,
						columns,
						shown: during,
					},
					{
						name: `the same ${columns}-column terminal, after the concert settles at 1m35s`,
						columns,
						shown: screenOf(live.writes),
					},
				);
			});
		}
		const console_ = await fixed(() => printed("console"));
		const stdout = await fixed(() => printed("stdout"));
		const shrink = await fixed(shrunk);
		const ctrlC = await fixed(interrupted);
		sections.push(
			{
				name: "perform on a 100-column terminal while a code node prints: the block moves below it",
				columns: 100,
				shown: console_.during,
			},
			{
				name: "the same terminal after the concert settles: the printed line stays, the block is gone",
				columns: 100,
				shown: console_.settled,
			},
			{
				name: "a code node writing to process.stdout, after the concert settles",
				columns: 100,
				shown: stdout.settled,
			},
			{
				name: "the block redrawn at 20 columns by other output printing, after the terminal shrinks from 100",
				columns: 20,
				shown: shrink.screen,
			},
			{
				name: "perform on a 100-column terminal after a Ctrl-C",
				columns: 100,
				shown: ctrlC.screen,
			},
		);
		await transcript(
			new URL("./transcripts/perform-live.txt", import.meta.url),
			sections,
		);
	});

	test("redraws at the narrower width after the terminal shrinks, also after other output", async () => {
		const { writes, drawn, mark, end } = await fixed(shrunk);
		// The block drawn at 100 columns wraps at 20, so erasing it moves up past its own lines.
		const wide = stripVTControlCharacters(writes[drawn - 1] ?? "").split(
			"\n",
		).length;
		const up = new RegExp(`${ESC}\\[(\\d+)F`).exec(writes[drawn] ?? "");
		expect(Number(up?.[1])).toBeGreaterThan(wide);
		const after = stripVTControlCharacters(writes.slice(mark, end).join("\n"));
		for (const line of after.split("\n"))
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20);
	});

	test("keeps redrawing the elapsed time after a host's progress text throws", async () => {
		await fixed(async (run) => {
			const w = await world();
			let progress = () => {};
			let threw = false;
			const live = await held(w, ["perform", ...GREET], {
				text: {
					progress: () => {
						threw = true;
						throw new Error("bad text");
					},
				},
				beforeHold: ({ emit }) => {
					progress = () => emit({ kind: "tool", name: "bash", input: {} });
				},
			});
			progress();
			await until(() => threw);
			const mark = live.writes.length;
			run.at(5000);
			await until(() => wrote(live.writes.slice(mark), "● demo.greet"));
			live.finish();
			await live.running;
		});
	});

	test("a Ctrl-C ends the foreground perform with exit 130 and leaves a second one to kill", async () => {
		const { code, during, left } = await interrupted();
		expect(during).toBe(1);
		expect(left).toBe(0);
		expect(code).toBe(130);
	});

	test("ends the live block's poll wait at once when the concert settles", async () => {
		const sleep = Bun.sleep;
		let hung = false;
		let waiting = false;
		// Once `hung`, a poll's wait never ends by itself, so only a quit can end it; other sleeps run as they are.
		const wait = spyOn(Bun, "sleep").mockImplementation(((ms: number) => {
			if (!hung || ms !== 100) return sleep(ms);
			waiting = true;
			return new Promise(() => {});
		}) as never);
		try {
			const w = await world();
			const live = await held(w, ["perform", ...GREET]);
			hung = true;
			await until(() => waiting);
			live.finish();
			expect((await live.running).code).toBe(0);
		} finally {
			wait.mockRestore();
		}
	});

	test("colors the live block on a color terminal", async () => {
		const w = await world();
		const live = await held(w, ["perform", ...GREET], {
			env: { TERM: "xterm" },
		});
		const during = live.writes.join("\n");
		live.finish();
		await live.running;
		expect(during).toMatch(SGR);
	});

	test("prints a code node's output while a host's text hook prints and throws on redraw", async () => {
		const w = await world();
		const step = Promise.withResolvers<typeof ECHO>();
		const started = Promise.withResolvers<void>();
		const writes: string[] = [];
		const log = spyOn(console, "log").mockImplementation((text) => {
			writes.push(String(text));
		});
		let armed = false;
		let threw = false;
		const base = hostOf(ECHO, {
			steps: {
				first: [{ ...FIRST, enrichment: { session: "s" } }],
				"echo/echo": () => {
					started.resolve();
					return step.promise;
				},
			},
		});
		const host = Object.create(base, {
			text: {
				value: {
					actor: () => {
						if (!armed) return undefined;
						threw = true;
						// A print made while the block redraws goes straight out; it does not move the block again.
						console.log("hook says hi");
						throw new Error("bad text");
					},
				},
			},
		});
		try {
			const running = w.call(["perform", ...GREET], {
				hosts: [host],
				stderrTerminal: () => ({ columns: 120 }),
				env: { TERM: "xterm", NO_COLOR: "1" },
				stderr: (text) => writes.push(text),
			});
			await Promise.race([started.promise, running]);
			await until(() => wrote(writes, "● demo.greet"));
			armed = true;
			await until(() => threw);
			console.log("shout hey");
			step.resolve(ECHO);
			expect((await running).code).toBe(0);
			expect(screenOf(writes)).toContain("shout hey");
			expect(screenOf(writes)).toContain("hook says hi");
		} finally {
			log.mockRestore();
		}
	});

	test("leaves a piped stdout unread while the live block shows on stderr", async () => {
		const w = await world();
		const reads: string[] = [];
		const own = Object.getOwnPropertyDescriptor(process, "stdout");
		const value = process.stdout;
		Object.defineProperty(process, "stdout", {
			configurable: true,
			get: () => {
				reads.push("read");
				return value;
			},
		});
		try {
			const live = await held(w, ["perform", ...GREET]);
			live.finish();
			await live.running;
		} finally {
			if (own) Object.defineProperty(process, "stdout", own);
		}
		expect(reads).toEqual([]);
	});

	test.each([
		["--json", ["--json"], { TERM: "xterm" }],
		["TERM=dumb", [], { TERM: "dumb" }],
	])(
		"%s leaves the live block out while the concert runs",
		async (_mode, flags, env) => {
			const w = await world();
			const { writes, running, finish } = await held(
				w,
				["perform", ...GREET, ...flags],
				{ env, block: false },
			);
			const during = writes.join("\n");
			const id = idOf({ code: 0, out: "", err: during });
			finish();
			const result = await running;
			expect(result.code).toBe(0);
			expect(id).not.toBe("");
			expect(during).toBe(
				flags.length
					? `concert ${id}`
					: `concert ${id}\nFollow it: maestro watch ${shortOf(id)}`,
			);
			expect(wrote(writes, "now   ")).toBe(false);
		},
	);

	test("--no-color leaves the live block uncolored", async () => {
		const w = await world();
		const { writes, running, finish } = await held(
			w,
			["perform", ...GREET, "--no-color"],
			{ env: { TERM: "xterm" } },
		);
		const during = writes.join("\n");
		finish();
		await running;
		expect(during).not.toMatch(SGR);
	});

	test.each(["resume", "encore"])(
		"%s draws the live block on stderr while it waits",
		async (verb) => {
			const w = await world();
			const failed = await w.call(["perform", ...GREET], {
				hosts: [
					hostOf(ECHO, {
						steps: { first: [{ outcome: "failed", reason: "flaky" }] },
					}),
				],
			});
			const id = idOf(failed);
			const args =
				verb === "encore" ? [verb, id, "-c", "concurrency=2"] : [verb, id];
			const live = await held(w, args);
			live.finish();
			expect((await live.running).code).toBe(0);
		},
	);

	test("a code node that prints prints once when performed, and never when composed", async () => {
		const w = await world();
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			expect((await w.call(["compose", LOUD])).code).toBe(0);
			expect(log.mock.calls).toEqual([]);
			expect((await w.call(["perform", LOUD])).code).toBe(0);
			expect(log.mock.calls).toEqual([["shout hey"]]);
		} finally {
			log.mockRestore();
		}
	});

	test("prints each output on a line, an artifact as its absolute path when piped or under --json's artifacts, and keys a stdlib node on this engine's stdlib", async () => {
		const w = await world();
		await Bun.write(join(w.root, "write.ts"), WRITE);
		const file = join(w.root, "write.json");
		await Bun.write(file, JSON.stringify(writeIr(codeHashOf(WRITE))));
		const performed = await w.call(["perform", file]);
		expect(performed.code).toBe(0);
		const id = idOf(performed);
		const { outputs, artifacts: area } = json(
			await w.call(["wait", id, "--json"]),
		);
		expect(area).toBe(join(w.root, "data/maestro/concerts", id, "artifacts"));
		const a = join(area, outputs.file.path);
		const b = join(area, outputs.nested.files[0].path);
		expect(await Bun.file(a).text()).toBe("a.txt");
		const lines = [
			`file       ${a}`,
			`nested     {"files":["${b}"]}`,
			"n          2",
			"s          a b",
			'multi      "a\\nb"',
			'tab        "a\\tb"',
			'cr         "a\\rb"',
			'sep        "a\\u2028b"',
			"none       null",
		];
		expect(performed.out.split("\n")).toEqual(lines);
		const waited = await w.call(["wait", id], { env: { HOME: w.root } });
		expect(waited.out.split("\n")).toEqual(lines);
		expect(waited.err).toMatch(closingOf(id, "ok"));
		const record = openRecord(join(w.root, "data/maestro/record.db"));
		const [get] = record.find(id)?.ir.nodes ?? [];
		record.close();
		expect(get?.kind === "code" && get.worker.codeHash).toBe(STDLIB_HASH);
	});

	test("each stream of the closing block is colored and wrapped only on a terminal with color on, and home is ~ on a terminal stdout", async () => {
		const w = await world();
		await Bun.write(join(w.root, "write.ts"), WRITE);
		const file = join(w.root, "write.json");
		await Bun.write(file, JSON.stringify(writeIr(codeHashOf(WRITE))));
		const terminal = () => ({ columns: 40, rows: 24 });
		const env = { HOME: w.root };
		const id = idOf(await w.call(["perform", file]));
		const area = `data/maestro/concerts/${id}/artifacts/`;
		const both = await w.call(["wait", id], {
			terminal,
			stderrTerminal: terminal,
			env,
		});
		const unique = shortIds([id]).unique(id);
		expect(both.err).toContain(
			`${ESC}[1m${shortId(id).slice(0, unique)}${ESC}[22m${ESC}[2m${shortId(id).slice(unique, 8)}`,
		);
		expect(both.out).toContain(ESC);
		expect(stripVTControlCharacters(both.out)).toStartWith(
			`file       ~/${area}`,
		);
		const teed = await w.call(["wait", id], { stderrTerminal: terminal, env });
		expect(teed.err).toContain(ESC);
		expect(teed.out).not.toContain(ESC);
		expect(teed.out).toStartWith(`file       ${w.root}/${area}`);
		const logged = await w.call(["wait", id], { terminal, env });
		expect(logged.err).not.toContain(ESC);
		expect(logged.out).toContain(ESC);
		const offs: { env: Record<string, string>; flags: string[] }[] = [
			{ env: { NO_COLOR: "1" }, flags: [] },
			{ env: { TERM: "dumb" }, flags: [] },
			{ env: {}, flags: ["--no-color"] },
		];
		for (const off of offs)
			for (const verb of [
				["wait", id],
				["perform", file],
			]) {
				const plain = await w.call([...verb, ...off.flags], {
					terminal,
					stderrTerminal: terminal,
					env: { ...env, ...off.env },
				});
				expectPlainClosing(plain.err + plain.out, verb[0], off.env.TERM);
				expect(plain.out).toStartWith("file       ~/");
			}

		const reason =
			"a reason long enough to wrap on a terminal forty cells wide, and longer than any default width a piped stream could take";
		const broke = idOf(
			await w.call(["p", ...GREET], {
				hosts: [hostOf({ outcome: "failed", reason })],
			}),
		);
		const wrapped = await w.call(["wait", broke], { stderrTerminal: terminal });
		const rows = stripVTControlCharacters(wrapped.err).split("\n").slice(2);
		expect(rows[0]).toStartWith("reason     a reason");
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows.slice(1)) expect(row).toMatch(/^ {11}\S/);
		expect(rows.map((row) => row.slice(11)).join(" ")).toBe(reason);
		for (const piped of [{}, { terminal }])
			expect((await w.call(["wait", broke], piped)).err).toEndWith(
				`\nreason     ${reason}`,
			);
	});

	test("wait and foreground perform end with a dim details hint only on a terminal", async () => {
		const w = await world();
		const hosts = [hostOf()];
		const terminal = () => ({ columns: 120, rows: 24 });
		const performed = await w.call(["perform", ...GREET], { hosts, terminal });
		const id = idOf(performed);
		expect(performed.code).toBe(0);
		const hint = `${ESC}[2mDetails: maestro ls ${shortOf(id)} --json${ESC}[22m`;
		const waited = await w.call(["wait", id], { terminal });
		expect(waited.code).toBe(0);
		expect([
			performed.out.split("\n").at(-1),
			waited.out.split("\n").at(-1),
		]).toEqual([hint, hint]);
		expect((await w.call(["wait", id])).out).toBe("text       done");
		const piped = await w.call(["perform", ...GREET], { hosts });
		expect(piped.out).toBe("text       done");
	});

	test("the closing hint of a concert that ended inside a group is a shell command that names the step", async () => {
		const w = await world();
		const done = { outcome: "ok", outputs: { text: "done" } } as const;
		const host = fakeHost({
			steps: {
				init: [done],
				"rounds/fan/worker": [done],
				"rounds/finish": [{ outcome: "failed", reason: "flaky" }],
			},
		});
		const performed = await w.call(["perform", join(FIXTURES, "loop-fan.ts")], {
			hosts: [host],
		});
		const id = idOf(performed);
		const closed = await w.call(["wait", id], {
			hosts: [host],
			terminal: () => ({ columns: 80, rows: 24 }),
			env: { NO_COLOR: "1" },
		});
		expect(closed.code).toBe(1);
		const hint = closed.out.trim().split("\n").at(-1) ?? "";
		expect(hint.startsWith("Details: ")).toBe(true);
		// failglob refuses an unquoted word that globs to nothing, as zsh does.
		const shell = Bun.spawnSync([
			"bash",
			"-O",
			"failglob",
			"-c",
			`set -- ${hint.slice("Details: ".length)}; printf '%s\\n' "$@"`,
		]);
		expect(shell.exitCode).toBe(0);
		const words = shell.stdout.toString().trimEnd().split("\n");
		expect(words).toEqual([
			"maestro",
			"ls",
			shortOf(id),
			"rounds[0]/finish",
			"--json",
		]);
		const detail = await w.call(words.slice(1), { hosts: [host] });
		expect(detail.code).toBe(0);
		expect(json(detail)).toMatchObject({ status: "failed" });
	});

	test("ls on a terminal hints older concerts when the limit leaves some out, piped or --json never", async () => {
		const w = await world();
		for (let i = 0; i < 3; i++) await w.call(["p", ...GREET]);
		const terminal = () => ({ columns: 200, rows: 24 });
		const env = { NO_COLOR: "1" };
		const cut = await w.call(["ls", "--limit", "2"], { terminal, env });
		expect(cut.out).toEndWith("\nOlder concerts: maestro ls --limit 4");
		expect(cut.out.split("\n")).toHaveLength(4);
		const filtered = await w.call(
			["ls", "--limit", "2", "--status", "failed"],
			{
				terminal,
				env,
			},
		);
		expect(filtered.out).toEndWith(
			"Older concerts: maestro ls --status failed --limit 4",
		);
		const both = await w.call(
			["ls", "--limit", "1", "--workspace", "ws", "--status", "failed"],
			{ terminal, env },
		);
		expect(both.out).toEndWith(
			"Older concerts: maestro ls --status failed --workspace ws --limit 2",
		);
		const all = await w.call(["ls", "--limit", "3"], { terminal, env });
		expect(all.out).not.toContain("Older concerts");
		const piped = await w.call(["ls", "--limit", "2"]);
		expect(piped.out).not.toContain("Older concerts");
		const json = await w.call(["ls", "--limit", "2", "--json"], {
			terminal,
			env,
		});
		expect(JSON.parse(json.out)).toHaveLength(2);
		const colored = await w.call(["ls", "--limit", "2"], {
			terminal,
			env: { FORCE_COLOR: "1" },
		});
		expect(colored.out).toContain(
			`${ESC}[2mOlder concerts: maestro ls --limit 4${ESC}[22m`,
		);
	});

	test("the older-concerts hint carries the composition among the other filters", () => {
		expect(
			olderHint(
				{ tour: "t", composition: "greet.hello", status: "failed" },
				5,
				false,
			),
		).toBe(
			"Older concerts: maestro ls --status failed --composition greet.hello --tour t --limit 10",
		);
	});

	test("ls on a terminal without --limit hints twice the default of 20", async () => {
		const w = await world();
		for (let i = 0; i < 21; i++) await w.call(["p", ...GREET]);
		const out = await w.call(["ls"], {
			terminal: () => ({ columns: 200, rows: 24 }),
			env: { NO_COLOR: "1" },
		});
		expect(out.out).toEndWith("\nOlder concerts: maestro ls --limit 40");
		expect(out.out.split("\n")).toHaveLength(22);
	});

	test("the older-concerts hint quotes a filter value for the shell", () => {
		expect(
			olderHint(
				{ workspace: "it's a ws", status: "failed", tour: "plain-1" },
				5,
				false,
			),
		).toBe(
			"Older concerts: maestro ls --status failed --tour plain-1 --workspace 'it'\\''s a ws' --limit 10",
		);
	});

	test("a terminal stdout summarises a long output and ends with a hint, piped it keeps the value whole and nothing else", async () => {
		const w = await world();
		const text = Array.from({ length: 312 }, (_, i) => `line ${i}`).join("\n");
		const host = hostOf({ outcome: "ok", outputs: { text } });
		const id = idOf(await w.call(["p", ...GREET], { hosts: [host] }));
		const terminal = () => ({ columns: 40, rows: 24 });
		const on = await w.call(["wait", id], { terminal, env: { NO_COLOR: "1" } });
		expect(on.out).toBe(
			`text       text, 312 lines\nFull outputs: maestro wait ${shortOf(id)} --json | jq .outputs`,
		);
		expect((await w.call(["wait", id])).out).toBe(
			`text       ${JSON.stringify(text)}`,
		);
	});

	test.each([
		["ok", ECHO, 0, [], ["text       done"]],
		[
			"failed",
			{ outcome: "failed", reason: "flaky\nnow\u001b[2J" },
			1,
			[
				["at", "echo/echo"],
				["reason", "flaky now\\u001b[2J"],
			],
			[],
		],
		[
			"rejected",
			{ outcome: "rejected", reason: "not today", outputs: { text: "draft" } },
			3,
			[
				["at", "echo/echo"],
				["reason", "not today"],
			],
			["text       draft"],
		],
	] as const)(
		"a concert that settles %s prints only its outputs on stdout, its id and closing block on stderr, and exits %d",
		async (status, echo, code, rows, outputs) => {
			const w = await world();
			const performed = await w.call(["p", ...GREET], {
				hosts: [hostOf(echo)],
			});
			expect(performed.code).toBe(code);
			const id = idOf(performed);
			expect(performed.err).toMatch(closingOf(id, status, ...rows));
			expect(performed.err.split("\n")[0]).toBe(`concert ${id}`);
			expect(performed.out === "" ? [] : performed.out.split("\n")).toEqual([
				...outputs,
			]);
			const [, ...closing] = performed.err.split("\n");
			expect((await w.call(["wait", id])).err).toBe(closing.join("\n"));
			expect(json(await w.call(["ls", "--json"]))).toMatchObject([
				{ id, status },
			]);
			const doc = json(
				await w.call(["perform", ...GREET, "--json"], {
					hosts: [hostOf(echo)],
				}),
			);
			expect(doc).toMatchObject({
				id: expect.any(String),
				status,
				resultNode: "echo/echo",
			});
			expect(doc.outputs).toEqual("outputs" in echo ? echo.outputs : undefined);
		},
	);

	test("a compose error stops it before any node starts", async () => {
		const w = await world();
		const started: string[] = [];
		const host = fakeHost({
			steps: {
				clash: () => {
					started.push("x");
					return ECHO;
				},
			},
		});
		const performed = await w.call(["perform", join(FIXTURES, "twice.ts")], {
			hosts: [host],
		});
		expect(performed.code).toBe(1);
		expect(started).toEqual([]);
		expect(json(await w.call(["ls", "--json"]))).toEqual([]);
	});

	test("a golden IR file performs through the CLI", async () => {
		const w = await world();
		const performed = await w.call(["perform", join(GOLDEN, "minimal.json")], {
			hosts: [],
		});
		expect(performed).toMatchObject({
			code: 0,
			err: expect.stringMatching(/ {2}ok {2}\S+$/),
		});
	});
});

describe("usage errors", () => {
	// Seam: usage exits and the exact flag tokens named in operator-facing diagnostics.
	test("ls refuses --all with --limit and names both flags", async () => {
		const w = await world();
		for (const flags of [
			["--all", "--limit", "1"],
			["--limit", "1", "--all"],
		]) {
			const refused = await w.call(["ls", ...flags]);
			expect(refused.code).toBe(2);
			expect(refused.out).toBe("");
			expect(refused.err.match(/--[a-z][a-z-]*/g)).toEqual(
				expect.arrayContaining(["--all", "--limit"]),
			);
		}
	});

	test("ls refuses --all with --limit=value and prune refuses a selection before --all", async () => {
		const w = await world();
		const ls = await w.call(["ls", "--limit=1", "--all"]);
		expect(ls.code).toBe(2);
		expect(ls.out).toBe("");
		const pruned = await w.call(["prune", "--status", "ok", "--all", "--yes"]);
		expect(pruned.code).toBe(2);
		expect(pruned.out).toBe("");
		expect(pruned.err.match(/--[a-z][a-z-]*/g)).toContain("--all");
	});

	test("prune without a selection names --all among its choices", async () => {
		const w = await world();
		const refused = await w.call(["prune"]);
		expect(refused.code).toBe(2);
		expect(refused.out).toBe("");
		expect(refused.err.match(/--[a-z][a-z-]*/g)).toContain("--all");
		expect(existsSync(w.env.XDG_DATA_HOME)).toBe(false);
		const document = await w.call(["prune", "--json"]);
		expect(document.code).toBe(2);
		expect(document.err).toBe("");
		expect(json(document)).toMatchObject({ ok: false });
		expect(json(document).error ?? json(document).diagnostics).toBeDefined();
	});

	test("prune refuses --all combined with ids or any selection filter", async () => {
		const w = await world();
		const performed = await w.call(["perform", ...GREET], {
			hosts: [hostOf()],
		});
		expect(performed.code).toBe(0);
		const id = idOf(performed);
		expect((await w.call(["prune", "--all", "--dry-run"])).code).toBe(0);
		for (const selection of [
			[id],
			["--before", "1d"],
			["--tour", "history"],
			["--workspace", "ws"],
			["--status", "ok"],
			["--composition", "demo.greet"],
		]) {
			const refused = await w.call(["prune", "--all", ...selection, "--yes"]);
			expect(refused.code).toBe(2);
			expect(refused.out).toBe("");
			expect(refused.err).not.toBe("");
		}
		expect(json(await w.call(["ls", "--json"]))).toMatchObject([{ id }]);
	});

	// Seam: usage exits for forbidden flags, including common flags placed before the verb.
	test("recorded commands refuse presets and readers refuse config overrides as usage errors", async () => {
		const w = await world();
		await Bun.write(join(w.cwd, ".maestro/presets/fast.yaml"), "{}\n");
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const readers = [
			["ls"],
			["ls", id],
			["compose", "--concert", id],
			["cs", "show", id],
			["cs", "apply", id],
		];
		const presets = [["resume", id], ["encore", id], ...readers].map(
			(command) => ({
				command,
				flags: ["--preset", "fast"],
			}),
		);
		const overrides = readers.flatMap((command) =>
			["-c", "--config"].map((flag) => ({
				command,
				flags: [flag, "concurrency=2"],
			})),
		);
		for (const { command, flags } of [...presets, ...overrides]) {
			expect((await w.call([...command, ...flags])).code).toBe(2);
			expect((await w.call([...flags, ...command])).code).toBe(2);
		}
	});

	const USAGE: [string, string[], RegExp][] = [
		["no command", [], /^error: no command given\nUsage: maestro/],
		[
			"an unknown command",
			["frobnicate"],
			/^error: unknown command 'frobnicate'\n {2}Pick one of the commands in 'maestro --help'$/,
		],
		[
			"no composition",
			["perform"],
			/^error: maestro perform needs a composition\nUsage: maestro perform <composition>\n {2}Name a file or <pack>.<composition>, before its flags, or see 'maestro perform --help' for examples$/,
		],
		[
			"no composition and no --concert",
			["compose", "--plan"],
			/^error: maestro compose needs a composition\nUsage: maestro compose <composition>\n +maestro compose --concert <id>\n {2}Name a file or <pack>.<composition>, before its flags/,
		],
		[
			"an unknown composition",
			["perform", "demo.nope"],
			/^error: pack 'demo' has no composition 'nope'\n {2}Name one of: echo, greet, ticket$/,
		],
		[
			"a mistyped composition",
			["rep", "demo.gret"],
			/^error: pack 'demo' has no composition 'gret'\n {2}Did you mean 'greet'\?$/,
		],
		[
			"a mistyped pack",
			["perform", "dmeo.greet"],
			/^error: no pack 'dmeo' is installed\n {2}Did you mean 'demo'\?$/,
		],
		[
			"an uninstalled pack",
			["perform", "other.greet"],
			/^error: no pack 'other' is installed/,
		],
		[
			"an unknown flag",
			["perform", ...GREET, "--nmae", "x"],
			/^error: unknown flag --nmae\n {2}Did you mean --name\?$/,
		],
		[
			"a mistyped verb flag",
			["perform", ...GREET, "--titie", "x"],
			/^error: unknown flag --titie\n {2}Did you mean --title\?$/,
		],
		[
			"the --profile that --preset replaced",
			["perform", ...GREET, "--profile", "stub"],
			/^error: unknown flag --profile\n {2}Flags are perform's/,
		],
		[
			"perform --resume, now the resume verb",
			["perform", ...GREET, "--resume", "x"],
			/^error: unknown flag --resume/,
		],
		[
			"resume with a tour",
			["resume", "x", "--tour", "t"],
			/^error: unknown flag --tour/,
		],
		[
			"an unknown flag named like an Object member",
			["perform", ...GREET, "--constructor", "x"],
			/^error: unknown flag --constructor\n {2}Flags are perform's/,
		],
		[
			"an unknown flag with no near name",
			["perform", ...GREET, "--zzzzzz", "x"],
			/^error: unknown flag --zzzzzz\n {2}Flags are perform's/,
		],
		[
			"a tour that is not a slug",
			["perform", ...GREET, "--tour", "Bad Slug"],
			/^error: --tour takes a slug of at most 64 characters, not 'Bad Slug'/,
		],
		[
			"a tour with an empty segment",
			["perform", ...GREET, "--tour", "epic..story"],
			/^error: --tour takes a slug of at most 64 characters, not 'epic..story'\n {2}Write it as lower-case words joined by hyphens, in non-empty segments joined by dots/,
		],
		[
			"a tour with a leading dot",
			["perform", ...GREET, "--tour", ".epic"],
			/^error: --tour takes a slug/,
		],
		[
			"a tour with a trailing dot",
			["perform", ...GREET, "--tour", "epic."],
			/^error: --tour takes a slug/,
		],
		[
			"a tour too long",
			["perform", ...GREET, "--tour", "a".repeat(65)],
			/^error: --tour takes a slug/,
		],
		[
			"a bad duration",
			["wait", "nope", "--timeout", "5x"],
			/^error: --timeout takes a positive whole number and one unit, not '5x'\n {2}Write it as 500ms, 90s, 15m, 12h or 7d$/,
		],
		[
			"an unknown concert",
			["wait", "nope"],
			/^error: no concert 'nope' in the record\n {2}Check the id with 'maestro ls'$/,
		],
		[
			"kill without a concert",
			["kill"],
			/^error: maestro kill needs a concert\nUsage: maestro kill <concert>\n/,
		],
		[
			"watch without a concert",
			["watch"],
			/^error: maestro watch needs a concert\nUsage: maestro watch <concert>\n {2}Name one as 'maestro ls' lists it$/,
		],
		[
			"watch of an unknown concert",
			["w", "nope"],
			/^error: no concert 'nope' in the record\n {2}Check the id with 'maestro ls'$/,
		],
		[
			"prune with ids and --before",
			["prune", "a", "--before", "1d"],
			/^error: prune takes concert ids or filters, not both/,
		],
		[
			"prune with ids and --status",
			["prune", "a", "--status", "ok"],
			/^error: prune takes concert ids or filters, not both/,
		],
		[
			"prune --status running",
			["prune", "--status", "running"],
			/^error: --status running cannot be pruned.*\n {2}Pick another status, or stop the concert with 'maestro kill <concert>' first$/,
		],
		[
			"a bad prune --composition",
			["prune", "--composition", "greet"],
			/^error: --composition takes <pack>.<composition>, not 'greet'/,
		],
		[
			"a bad --before",
			["prune", "--before", "1x"],
			/^error: --before takes a positive whole number/,
		],
		[
			"tour with no concert",
			["tour", "set", "slug"],
			/^error: maestro tour set needs a slug and at least one concert\nUsage: maestro tour set <slug> <concert>\.\.\.\n/,
		],
		[
			"tour clear with no concert",
			["tour", "clear"],
			/^error: maestro tour clear needs at least one concert/,
		],
		[
			"tour with a bad slug",
			["tour", "set", "BAD", "x"],
			/^error: the tour slug takes a slug/,
		],
		[
			"the old tour form",
			["tour", "slug", "x"],
			/^error: expected set or clear, got 'slug'\n {2}Write maestro tour set/,
		],
		[
			"the old tour --clear",
			["tour", "--clear", "x"],
			/^error: unknown flag --clear/,
		],
		[
			"ls with two concerts",
			["ls", "a", "b", "c"],
			/^error: maestro ls takes at most a concert and an instance, got 3\nUsage: maestro ls \[<concert> \[<instance>\]\]\n/,
		],
		[
			"artifact show with too many arguments",
			["art", "show", "a", "b", "c", "d"],
			/^error: maestro artifact show takes a concert, an instance and at most a file, got 4\nUsage: maestro artifact ls <concert>\n {7}maestro artifact show <concert> <instance> \[<file>\]\n/,
		],
		[
			"the old artifact form",
			["art", "a", "b"],
			/^error: expected ls or show, got 'a'/,
		],
		[
			"changeset with an unknown action",
			["cs", "frob"],
			/^error: expected show, apply or drop, got 'frob'/,
		],
		[
			"changeset with --json, which it does not take",
			["cs", "show", "a", "--json"],
			/^error: unknown flag --json/,
		],
		[
			"watch with a key --frames does not name",
			["watch", "nope", "--frames", "zz"],
			/^error: --frames names no key: 'zz'/,
		],
		[
			"a status that is none",
			["ls", "--status", "bogus"],
			/^error: --status takes one of running, ok, failed, rejected, not 'bogus'/,
		],
		[
			"a tour that is none",
			["ls", "--tour", "BAD"],
			/^error: --tour takes a slug/,
		],
		[
			"a limit of zero",
			["ls", "--limit", "0"],
			/^error: --limit takes a positive whole number/,
		],
		[
			"resume with a composition",
			["resume", "x", "demo.greet"],
			/^error: maestro resume takes one concert, got 2\nUsage: maestro resume <concert>\n/,
		],
		[
			"resume with no concert",
			["resume"],
			/^error: maestro resume needs a concert\n/,
		],
		[
			"encore with no concert",
			["encore", "-c", "a=1"],
			/^error: maestro encore needs a concert\n/,
		],
		[
			"resume of an unknown concert",
			["resume", "nope"],
			/^error: no concert 'nope'/,
		],
		[
			"a -c without '='",
			["perform", ...GREET, "-c", "concurrency"],
			/^error: -c concurrency takes <key>=<value>\n {2}Write it as -c <key>=<value>/,
		],
		[
			"a -c with an empty key",
			["perform", ...GREET, "--config", "=4"],
			/^error: -c =4: '' is not a key path\n/,
		],
		[
			"a -c key nothing claims",
			["perform", ...GREET, "-c", "nope.x=1"],
			/^error: config key 'nope' .* \(from -c nope\.x\)\n/,
		],
		[
			"a -c value off its key's schema",
			["compose", ...GREET, "-c", "concurrency=x"],
			/^error: config 'concurrency' must be integer \(from -c concurrency\)\n/,
		],
		[
			"param flags on an IR file",
			["compose", join(GOLDEN, "minimal.json"), "--name", "x"],
			/^error: unknown flag --name\n {2}An IR file is already built/,
		],
		[
			"a param whose flag is a command's",
			["perform", CLASH],
			/^error: param 'tour' of 'clash\.clash' takes --tour, which the command takes too\n {2}Rename/,
		],
		[
			"a param whose flag is one of compose's, for compose",
			["compose", CLASH_OUT],
			/^error: param 'out' of 'clash-out\.clash-out' takes --out, which the command takes too\n {2}Rename/,
		],
		[
			"a boolean param whose --no- flag negates a common flag",
			["perform", CLASH_NO],
			/^error: param 'noColor' of 'clash-no\.clash-no' takes --no-color, which the command takes too\n {2}Rename/,
		],
		[
			"a param whose flag is one of perform's, for compose",
			["compose", CLASH],
			/^error: param 'tour' of 'clash\.clash' takes --tour, which the command takes too\n {2}Rename/,
		],
		[
			"a composition file whose name is not a pack id",
			["compose", join(FIXTURES, "Shout.ts")],
			/^error: composition file \S+\/Shout\.ts is named 'Shout', which is not a pack id\n {2}Rename it/,
		],
		[
			"a composition file named as an installed pack",
			["perform", join(FIXTURES, "demo.ts")],
			/^error: composition file \S+\/demo\.ts is named 'demo', the id of the pack at \S+\n {2}Rename the file$/,
		],
		[
			"a composition file that declares no example input set",
			["compose", join(FIXTURES, "bare.ts")],
			/^error: composition 'bare' declares no example input set\n/,
		],
		[
			"a composition file that is not there",
			["compose", "missing.ts"],
			/^error: no such file: missing\.ts\n {2}Check the path$/,
		],
		[
			"an IR file that is not there",
			["perform", "missing.json"],
			/^error: no such file: missing\.json\n {2}Check the path$/,
		],
		[
			"a missing required param",
			["perform", "demo.ticket"],
			/^error: param 'handle' \(--handle\)/,
		],
		[
			"a malformed typed param",
			["perform", "demo.ticket", "--handle", "nonsense"],
			/^error: param 'handle' \(--handle\) of 'demo\.ticket': 'nonsense'/,
		],
	];

	/** The rows whose error needs the record store, so they open it. */
	const NEEDS_STORE = [
		"an unknown concert",
		"watch of an unknown concert",
		"resume of an unknown concert",
	];

	/** The rows that are diagnostics of a build or the config, which exit 1; the rest are bad arguments, which exit 2. */
	const DIAGNOSED = [
		"a composition file that declares no example input set",
		"a composition file whose name is not a pack id",
		"a composition file named as an installed pack",
	];
	const exitOfRow = (what: string) => (DIAGNOSED.includes(what) ? 1 : 2);

	test.each(USAGE)(
		"%s exits 1 for a build diagnostic and 2 for bad arguments, and says what to do",
		async (_what, args, message) => {
			const w = await world();
			const outcome = await w.call(args);
			expect(outcome.out).toBe("");
			expect(outcome.err).toMatch(message);
			expect(outcome.code).toBe(exitOfRow(_what));
			if (!NEEDS_STORE.includes(_what))
				expect(existsSync(w.env.XDG_DATA_HOME)).toBe(false);
		},
	);

	test.each(USAGE.filter(([, args]) => args.length > 0 && args[0] !== "cs"))(
		"%s with --json prints one document on stdout and nothing on stderr",
		async (_what, args) => {
			const w = await world();
			const outcome = await w.call([...args, "--json"]);
			expect(outcome.err).toBe("");
			expect(outcome.code).toBe(exitOfRow(_what));
			const doc = json(outcome);
			expect(doc.ok).toBe(false);
			expect(doc.error ?? doc.diagnostics).toBeDefined();
		},
	);

	test("--help advertises preset and config flags only on commands that accept them", async () => {
		const w = await world();
		for (const args of [["--help"], ["p", "-h"], ["w", "-h"]])
			expect(await w.call(args)).toMatchObject({
				code: 0,
				out: expect.stringContaining("Usage: maestro"),
				err: "",
			});
		expect((await w.call(["--help"])).out).toMatch(/^ {2}watch +\(w\) +\S/m);
		for (const [alias, verb] of [
			["r", "resume"],
			["e", "encore"],
			["ag", "agent"],
		] as const) {
			expect((await w.call(["--help"])).out).toMatch(
				new RegExp(`^ {2}${verb} +\\(${alias}\\) +\\S`, "m"),
			);
			expect((await w.call([alias, "--help"])).out).toBe(
				(await w.call([verb, "--help"])).out,
			);
		}
		const verbs = [
			...(await w.call(["--help"])).out.matchAll(/^ {2}([a-z]+) /gm),
		].map(([, verb = ""]) => verb);
		expect(verbs).toContain("tour");
		const reads = ["ls", "wait", "watch", "kill", "tour", "prune", "artifact"];
		for (const verb of verbs) {
			const { out } = await w.call([verb, "--help"]);
			const flags: string[] = out.match(/--[a-z][a-z-]*/g) ?? [];
			expect(flags.includes("--preset")).toBe(
				!["resume", "encore", ...reads].includes(verb),
			);
			expect(flags.includes("--config")).toBe(!reads.includes(verb));
		}
		const forms: [string[], boolean][] = [
			[["compose", "--concert", "x"], false],
			[["compose", "demo.greet"], true],
			[["cs", "show"], false],
			[["cs", "apply"], false],
			[["cs", "drop"], true],
		];
		for (const [form, takes] of forms) {
			const flags: string[] =
				(await w.call([...form, "--help"])).out.match(/--[a-z][a-z-]*/g) ?? [];
			expect([
				form,
				flags.includes("--preset"),
				flags.includes("--config"),
			]).toEqual([form, takes, takes]);
		}
		const { out: root } = await w.call(["--help"]);
		expect(root).toMatch(/^ {2}-c, --config <key=value> +\S/m);
		expect(root).toMatch(/^ {6}--color +.*--no-color turns it off/m);
	});

	// Seam: root help's terminal and piped stdout.
	test("root help colors command names on a terminal and leaves piped help plain", async () => {
		const w = await world();
		const terminal = () => ({ columns: 200, rows: 24 });
		const on = await w.call(["--help", "--color"], { terminal });
		expect(on.code).toBe(0);
		expect(on.out).toContain(`${ESC}[36mrepertoire${ESC}[39m`);
		expect(on.out).toContain(`${ESC}[36mperform${ESC}[39m`);
		const piped = await w.call(["--help"]);
		expect(piped.code).toBe(0);
		expect(stripVTControlCharacters(on.out)).toBe(piped.out);
	});

	test("--help bolds headings and colors flags, and a table header is bold, only on a terminal with color on", async () => {
		const w = await world();
		const terminal = () => ({ columns: 80, rows: 24 });
		for (const args of [["--help"], ["ls", "--help"]]) {
			const on = (await w.call(args, { terminal })).out;
			expect(on).toContain(`${ESC}[1mFlags:${ESC}[22m`);
			expect(on).toContain(`${ESC}[36m--`);
			expect(on).toContain(`${ESC}[36m`);
			const off = (await w.call([...args, "--no-color"], { terminal })).out;
			expect(off).not.toContain(ESC);
			expect(stripVTControlCharacters(on)).toBe(off);
		}
		await w.call(["perform", ...GREET]);
		const header = (await w.call(["ls"], { terminal })).out;
		expect(header).toStartWith(`${ESC}[1mid${ESC}[22m`);
		expect((await w.call(["ls"])).out).toStartWith("id ");
	});

	test("--help given a composition adds its params after the flags, and not without one", async () => {
		const w = await world();
		const PARAMS =
			/\n\nParams\n {2}--name <text> +required\n {2}--loud <integer> +0\n\n/;
		expect((await w.call(["compose", "demo.greet", "--help"])).out).toMatch(
			PARAMS,
		);
		expect((await w.call(["p", HELLO, "-h"])).out).toMatch(/\n\nParams\n/);
		const colored = await w.call(["compose", "demo.greet", "--help"], {
			terminal: () => ({ columns: 80, rows: 24 }),
		});
		expect(colored.out).toContain(
			`${ESC}[1mParams${ESC}[22m\n  ${ESC}[36m--name <text>${ESC}[39m`,
		);
		expect((await w.call(["compose", "--help"])).out).not.toContain("Params");
		expect(await w.call(["compose", "demo.nope", "--help"])).toMatchObject({
			code: 0,
			out: expect.stringMatching(
				/^Build a composition[\s\S]*--graph +\S[^\n]*\n +--flow +\S[^\n]*\(experimental\)\n\nExamples:\n[\s\S]*\n\nCommon flags: /,
			),
			err: "params not shown: pack 'demo' has no composition 'nope'",
		});
	});
});

describe("help and color", () => {
	// Seam: the selection alternatives in the command's rendered usage.
	test("prune help shows --all as a selection beside concert ids and filters", async () => {
		const w = await world();
		const help = await w.call(["prune", "--help"]);
		expect(help.code).toBe(0);
		const usage = help.out.match(/Usage:[\s\S]*?(?=\n\n|$)/)?.[0] ?? "";
		expect(usage.match(/--[a-z][a-z-]*/g) ?? []).toContain("--all");
	});

	// Seam: `prune --help` on an 80-column terminal, and piped. The widest flag is `--composition <pack.name>`, indented
	// 2 + 4 cells and 25 long, then two spaces: its description starts at column 33 and has 47 cells.
	test("--help wraps a description under its column on an 80-column terminal, and piped help keeps it whole", async () => {
		const w = await world();
		const DESC =
			"Prune concerts that settled longer ago than this, such as 500ms, 90s, 15m, 12h or 7d";
		const terminal = () => ({ columns: 80, rows: 24 });
		const on = stripVTControlCharacters(
			(await w.call(["prune", "--help"], { terminal })).out,
		).split("\n");
		const at = on.findIndex((line) => line.includes("--before <duration>"));
		expect(at).toBeGreaterThan(-1);
		expect(on[at]?.indexOf("Prune")).toBe(33);
		const rows = [on[at]?.slice(33) ?? ""];
		for (const line of on.slice(at + 1)) {
			if (!line.startsWith(" ".repeat(33))) break;
			rows.push(line.slice(33));
		}
		for (const line of on)
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.join(" ").replace(/\s+/g, " ").trim()).toBe(DESC);

		const piped = (await w.call(["prune", "--help", "--no-color"])).out;
		expect(piped).toMatch(new RegExp(`--before <duration> +${DESC}\\n`));
	});

	// Seam: root help's tables on an 80-column terminal. Each description wraps under its own column.
	test("root help wraps each table's descriptions under their column on an 80-column terminal", async () => {
		const w = await world();
		const terminal = () => ({ columns: 80, rows: 24 });
		const lines = stripVTControlCharacters(
			(await w.call(["--help"], { terminal })).out,
		).split("\n");
		// The tables run from Commands to the Environment block, which the closing prose line follows.
		const tables = lines.slice(
			lines.indexOf("Commands:"),
			lines.findIndex((line) => line.startsWith("See '")),
		);
		for (const line of tables)
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
		const config = lines.findIndex(
			(line) =>
				line.includes("config") && line.includes("Show a composition's"),
		);
		expect(lines[config]?.indexOf("Show")).toBe(21);
		expect(lines[config + 1]).toBe(`${" ".repeat(21)}value came from`);
		const pager = lines.findIndex((line) => line.includes("PAGER"));
		expect(lines[pager]?.indexOf("The pager")).toBe(19);
		expect(lines[pager + 1]).toBe(
			`${" ".repeat(19)}-FRX); empty or cat turns paging off`,
		);
	});

	// Seam: `prune --help` on a 40-column terminal, narrower than the flag column plus the old 20-cell minimum.
	test("--help on a 40-column terminal keeps every line within the width", async () => {
		const w = await world();
		const terminal = () => ({ columns: 40, rows: 24 });
		const help = stripVTControlCharacters(
			(await w.call(["prune", "--help"], { terminal })).out,
		);
		// Only the tables are checked: the usage line and the examples are prose and do not wrap.
		const flags = help
			.split("\n")
			.slice(
				help.split("\n").indexOf("Flags:"),
				help.split("\n").indexOf("Examples:"),
			);
		for (const line of flags)
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
	});

	// The description read back from the wrapped lines of a row at `lines[at]`, each under `column`.
	const readBack = (lines: readonly string[], at: number, column: number) => {
		const rows = [lines[at]?.slice(column) ?? ""];
		for (const line of lines.slice(at + 1)) {
			if (!line.startsWith(" ".repeat(column))) break;
			rows.push(line.slice(column));
		}
		return rows.join(" ").replace(/\s+/g, " ").trim();
	};
	const linesOf = (out: string) => stripVTControlCharacters(out).split("\n");

	// Seam: root help's Flags table on a 40-column terminal, where its descriptions wrap under their column.
	test("root help wraps its Flags descriptions under their column on a 40-column terminal", async () => {
		const w = await world();
		const terminal = () => ({ columns: 40, rows: 24 });
		const lines = linesOf((await w.call(["--help"], { terminal })).out);
		const at = lines.findIndex((line) => line.startsWith("  --data-root"));
		expect(lines[at]?.indexOf("Print")).toBe(15);
		expect(readBack(lines, at, 15)).toBe(
			"Print the directory that holds maestro's record and packs",
		);
		const end = lines.findIndex((line) => line.startsWith("Common flags"));
		for (const line of lines.slice(lines.indexOf("Flags:"), end))
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
	});

	// Seam: `prune --help` on a 40-column terminal, where the argument's description wraps under its column.
	test("--help wraps an argument's description under its column on a 40-column terminal", async () => {
		const w = await world();
		const terminal = () => ({ columns: 40, rows: 24 });
		const lines = linesOf(
			(await w.call(["prune", "--help"], { terminal })).out,
		);
		const at = lines.findIndex((line) => line.startsWith("  <concert>"));
		expect(lines[at]?.indexOf("A settled")).toBe(13);
		expect(Bun.stringWidth(lines[at] ?? "")).toBeLessThanOrEqual(40);
		expect(readBack(lines, at, 13)).toBe(
			"A settled concert, as 'maestro ls' lists it",
		);
	});

	// Seam: a composition's `--help` on a 40-column terminal, where its Params descriptions wrap; piped, whole.
	test("compose --help wraps a param's description under its column on a 40-column terminal, and piped keeps it whole", async () => {
		const w = await world();
		const DESC = "Who to greet, by the name the greeting uses in its one line";
		const terminal = () => ({ columns: 40, rows: 24 });
		const lines = linesOf(
			(await w.call(["compose", DESCRIBED, "--help"], { terminal })).out,
		);
		const at = lines.findIndex((line) => line.includes("--name"));
		const column = lines[at]?.indexOf("Who") ?? -1;
		expect(column).toBeGreaterThan(0);
		expect(Bun.stringWidth(lines[at] ?? "")).toBeLessThanOrEqual(40);
		expect(readBack(lines, at, column)).toBe(DESC);
		const piped = (await w.call(["compose", DESCRIBED, "--help"])).out;
		expect(piped).toContain(DESC);
	});

	// Seam: `ls --help` on a 40-column terminal, where a host's report field descriptions wrap under their column.
	test("ls --help wraps a report field's description under its column on a 40-column terminal", async () => {
		const w = await world();
		const DESC =
			"a short line on what the agent did in this step, for the whole run to read back";
		const host: Host = {
			...hostOf(),
			text: { reportFields: { summary: DESC } },
		};
		const terminal = () => ({ columns: 40, rows: 24 });
		const lines = linesOf(
			(await w.call(["ls", "--help"], { hosts: [host], terminal })).out,
		);
		const at = lines.findIndex((line) => line.startsWith("  summary"));
		expect(lines[at]?.indexOf("a short")).toBe(11);
		expect(Bun.stringWidth(lines[at] ?? "")).toBeLessThanOrEqual(40);
		expect(readBack(lines, at, 11)).toBe(DESC);
	});

	const TERMINAL = () => ({ columns: 80, rows: 24 });
	const COMMON_LINE =
		"Common flags: --color, --debug, -h/--help (see 'maestro --help')";

	test("a command's help is its summary, usage, arguments, flags, examples and the common flags, in that order", async () => {
		const { out } = await (await world()).call(["artifact", "--help"]);
		const at = [
			"List a concert's artifacts",
			"Usage: maestro artifact",
			"Arguments:",
			"  <concert>   A concert, as 'maestro ls' lists it",
			"Flags:",
			"Examples:",
			"  # Read the plan the planner wrote\n  maestro artifact show 7f3c2a planner plan.md",
		].map((part) => out.indexOf(part));
		expect(at.every((i) => i >= 0)).toBe(true);
		expect(at).toEqual(at.toSorted((a, b) => a - b));
		expect(out).toEndWith(`\n\n${COMMON_LINE}`);
	});

	test("a command without examples has no Examples section", async () => {
		const { out } = await (await world()).call(["kill", "--help"]);
		expect(out).toStartWith(
			"Stop a running concert\n\nUsage: maestro kill <concert>",
		);
		expect(out).toContain("Arguments:\n  <concert>  A running concert");
		expect(out).not.toContain("Examples:");
		expect(out).toEndWith(COMMON_LINE);
	});

	test("maestro --help lists the common flags, the exit codes and the environment", async () => {
		const { out } = await (await world()).call(["--help"]);
		expect(out).toContain("Common flags (each command lists those it takes):");
		expect(out).toMatch(/Exit codes:\n {2}0 {4}Done/);
		expect(out).toMatch(/\n {2}124 {2}wait --timeout/);
		for (const name of [
			"NO_COLOR",
			"FORCE_COLOR",
			"TERM",
			"MAESTRO_TOUR",
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
		])
			expect(out).toMatch(new RegExp(`^ {2}${name} `, "m"));
		expect(out).not.toContain("MAESTRO_STUB");
	});

	test("help and help <command> show the root help and that command's", async () => {
		const w = await world();
		expect((await w.call(["help"])).out).toBe((await w.call(["--help"])).out);
		expect((await w.call(["help", "kill"])).out).toBe(
			(await w.call(["kill", "--help"])).out,
		);
		expect((await w.call(["help", "nope"])).err).toStartWith(
			"error: unknown command 'nope'",
		);
	});

	test("the common flags come before the command", async () => {
		const w = await world();
		const colored = await w.call(["--color", "kill", "--help"]);
		expect(colored.out).toContain(ESC);
		expect(
			(await w.call(["--no-color", "ls"], { terminal: TERMINAL })).out,
		).not.toContain(ESC);
		const refused = await w.call(["--debug", "kill"]);
		expect(refused).toMatchObject({
			code: 2,
			err: expect.stringContaining("at only"),
		});
	});

	test("leading common flags reach every command as trailing ones would", async () => {
		const w = await world();
		const trailing = json(await w.call(["compose", ...GREET, "--json"]));
		expect(json(await w.call(["--json", "compose", ...GREET]))).toEqual(
			trailing,
		);
		expect(
			json(await w.call(["--json", "-c", "concurrency=2", "config", ...GREET])),
		).toHaveProperty("values");
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		expect(json(await w.call(["--json", "art", "ls", id]))).toEqual([]);
	});

	test("an unknown leading flag is named with its did-you-mean, and a bare maestro or --json lists no help", async () => {
		const w = await world();
		expect((await w.call(["--frobnicate"])).err).toBe(
			"error: unknown flag --frobnicate\n  Flags are listed in 'maestro --help'",
		);
		expect((await w.call(["--colr"])).err).toBe(
			"error: unknown flag --colr\n  Did you mean --color?",
		);
		expect(json(await w.call(["--json"])).error).toBe(
			"no command given\nSee 'maestro --help' for the commands",
		);
		expect((await w.call([])).err).toContain("Commands:");
	});

	test("help <command> <args> adds that command's params, as --help does", async () => {
		const w = await world();
		const asked = await w.call(["help", "compose", "demo.greet"]);
		expect(asked.out).toBe(
			(await w.call(["compose", "demo.greet", "--help"])).out,
		);
		expect(asked.out).toContain("Params");
	});

	test("a mistyped alias is met with its verb", async () => {
		expect((await (await world()).call(["arr"])).err).toBe(
			"error: unknown command 'arr'\n  Did you mean 'artifact'?",
		);
	});

	test("a flag given no value because another flag follows is not one that takes none", async () => {
		const w = await world();
		expect((await w.call(["ls", "--limit", "--json"])).err).toStartWith(
			"error: --limit needs a value\n",
		);
		expect((await w.call(["resume", "-c"])).err).toStartWith(
			"error: --config needs a value\n",
		);
	});

	test("an argument error points to the help for examples only when the command has some", async () => {
		const w = await world();
		expect((await w.call(["kill"])).err).not.toContain("--help' for examples");
		expect((await w.call(["encore"])).err).toContain(
			"or see 'maestro encore --help' for examples",
		);
	});

	test("a mistyped command or alias is met with the verb it is near", async () => {
		const w = await world();
		for (const [typed, verb] of [
			["perfrom", "perform"],
			["repertoir", "repertoire"],
			["wach", "watch"],
		])
			expect((await w.call([typed ?? ""])).err).toBe(
				`error: unknown command '${typed}'\n  Did you mean '${verb}'?`,
			);
	});

	test("the parser's errors read as maestro's", async () => {
		const w = await world();
		expect((await w.call(["ls", "-x"])).err).toBe(
			"error: unknown flag -x\n  Flags are listed in 'maestro ls --help'",
		);
		expect((await w.call(["ls", "--limit"])).err).toBe(
			"error: --limit needs a value\n  Flags are listed in 'maestro ls --help'",
		);
		expect((await w.call(["ls", "--json=1"])).err).toStartWith(
			"error: --json takes no value",
		);
	});

	test("an argument error names the command, shows its usage line and points to its help", async () => {
		const refused = await (await world()).call(["artifact", "show"]);
		expect(refused).toMatchObject({ code: 2, out: "" });
		expect(refused.err).toBe(
			"error: maestro artifact show needs a concert\nUsage: maestro artifact ls <concert>\n       maestro artifact show <concert> <instance> [<file>]\n  Name one as 'maestro ls' lists it, or see 'maestro artifact --help' for examples",
		);
	});

	test.each([
		["off a terminal by default", [], {}, false],
		["off a terminal with --color", ["--color"], {}, true],
		["off a terminal with FORCE_COLOR", [], { FORCE_COLOR: "1" }, true],
		["with an empty FORCE_COLOR, not", [], { FORCE_COLOR: "" }, false],
		["--no-color over --color", ["--color", "--no-color"], {}, false],
		[
			"--no-color over FORCE_COLOR",
			["--no-color"],
			{ FORCE_COLOR: "1" },
			false,
		],
		["NO_COLOR over --color", ["--color"], { NO_COLOR: "1" }, false],
		[
			"NO_COLOR over FORCE_COLOR",
			[],
			{ NO_COLOR: "1", FORCE_COLOR: "1" },
			false,
		],
		[
			"TERM=dumb over FORCE_COLOR",
			[],
			{ TERM: "dumb", FORCE_COLOR: "1" },
			false,
		],
	])("color %s", async (_what, flags, env, colored) => {
		const w = await world();
		const { out, err } = await w.call(["kill", "--help", ...flags], { env });
		expect(out.includes(ESC)).toBe(colored);
		expect(
			(await w.call(["kill", "nope", ...flags], { env })).err.includes(ESC),
		).toBe(colored);
		expect(err).toBe("");
	});
});

// Seam: root-flag stdout and exit status, including the real CLI's .env loading.
test("--data-root prints the resolved data root and appears in root help", async () => {
	const w = await world();
	const result = await w.call(["--data-root"]);
	expect(result).toEqual({
		code: 0,
		out: join(w.root, "data/maestro"),
		err: "",
	});
	const help = await w.call(["--help"]);
	expect(help.code).toBe(0);
	expect(help.out.match(/--[a-z][a-z-]*/g)).toContain("--data-root");
});

test("--data-root uses the data home loaded from the user .env", async () => {
	const w = await world();
	const data = join(w.root, "data from env");
	await mkdir(join(w.env.XDG_CONFIG_HOME, "maestro"), { recursive: true });
	await Bun.write(
		join(w.env.XDG_CONFIG_HOME, "maestro/.env"),
		`XDG_DATA_HOME="${data}"\n`,
	);
	const child = Bun.spawn(
		[process.execPath, join(import.meta.dir, "maestro.ts"), "--data-root"],
		{
			cwd: w.cwd,
			env: { ...process.env, ...w.env, XDG_DATA_HOME: undefined },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code).toBe(0);
	expect(out).toBe(`${data}/maestro\n`);
	expect(err).toBe("");
});

describe("--version", () => {
	test("prints one line with the CLI, SDK, IR and Bun versions on stdout and exits 0", async () => {
		const w = await world();
		expect(await w.call(["--version"])).toEqual({
			code: 0,
			out: `maestro ${pkg.version} (sdk ${SDK_VERSION}, ir ${IR_VERSION}, bun ${Bun.version})`,
			err: "",
		});
	});
});

describe("the record", () => {
	// Seam: ls tables, JSON arrays and exit codes over the operator's record store.
	test("ls --all lists every match newest first without an older-concerts hint", async () => {
		const w = await world();
		const failed: string[] = [];
		for (let i = 0; i < 21; i++) {
			const performed = await w.call(
				["perform", ...GREET, "--tour", "history"],
				{
					hosts: [hostOf({ outcome: "failed", reason: "flaky" })],
				},
			);
			expect(performed.code).toBe(1);
			failed.unshift(idOf(performed));
		}
		const done = await w.call(["perform", ...GREET], { hosts: [hostOf()] });
		expect(done.code).toBe(0);
		const every = [idOf(done), ...failed];
		for (const [flags, expected] of [
			[[], every],
			[["--status", "failed"], failed],
		] as const) {
			const table = await w.call(["ls", "--all", ...flags], {
				terminal: () => ({ columns: 200, rows: 24 }),
				env: { NO_COLOR: "1" },
			});
			expect(table.code).toBe(0);
			expect(
				table.out
					.split("\n")
					.slice(1)
					.map((line) => line.split(/\s+/)[0]),
			).toEqual(expected.map(shortOf));
			const listed = await w.call(["ls", "--all", ...flags, "--json"]);
			expect(listed.code).toBe(0);
			expect(listed.err).toBe("");
			const rows: { id: string }[] = json(listed);
			expect(Array.isArray(rows)).toBe(true);
			expect(rows.map((row) => row.id)).toEqual(expected);
		}
	});

	// Seam: ls exit codes, table rows and JSON when the stored snapshot cannot be read, and what a listing row leaves to `ls <concert> --json`.
	test("ls lists every concert without the record's weight, and omits an unreadable snapshot", async () => {
		const w = await world();
		const perform = async () => {
			const result = await w.call(["perform", ...GREET], {
				hosts: [hostOf()],
			});
			expect(result.code).toBe(0);
			return idOf(result);
		};
		const before = await perform();
		const unreadable = await perform();
		const after = await perform();
		const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
		db.run("UPDATE concerts SET snapshot = ? WHERE id = ?", ["[", unreadable]);
		db.close();
		const outside = { cwd: await scratch(), hosts: [hostOf()] };
		const listed = await w.call(["ls", "--json"], outside);
		expect(listed.code).toBe(0);
		const rows = json(listed);
		expect(rows.map((row: { id: string }) => row.id).sort()).toEqual(
			[before, unreadable, after].sort(),
		);
		for (const row of rows) {
			expect(row).toMatchObject({ status: "ok" });
			for (const key of Object.keys(row)) expect(LIST_ROW).toContain(key);
		}
		expect(
			configValues(await w.call(["config", before, "--json"], outside)),
		).toMatchObject({ workspace: "ws" });
		const single = await w.call(["ls", unreadable, "--json"], outside);
		expect(single.code).toBe(0);
		expect(json(single)).toMatchObject({ id: unreadable, status: "ok" });
		const table = await w.call(["ls"], outside);
		expect(table.code).toBe(0);
		expect(
			table.out
				.split("\n")
				.slice(1)
				.map((line) => line.split(/\s+/)[0])
				.sort(),
		).toEqual([shortOf(before), shortOf(unreadable), shortOf(after)].sort());
		const plan = await w.call(
			["compose", "--concert", before, "--plan"],
			outside,
		);
		const shown = await w.call(
			["compose", "--concert", unreadable, "--plan"],
			outside,
		);
		expect(shown.code).toBe(0);
		expect(shown.out).toBe(plan.out);
		expect(shown.err).toContain("snapshot");
	});

	test("tours and titles are set at perform, changed by tour, filtered by ls, and the flag beats MAESTRO_TOUR", async () => {
		const w = await world();
		const perform = async (args: string[], env: Record<string, string> = {}) =>
			idOf(
				await w.call(["perform", ...GREET, ...args], {
					hosts: [hostOf()],
					env,
				}),
			);
		const a = await perform(["--tour", "release-1", "--title", "first try"]);
		const b = await perform([], { MAESTRO_TOUR: "from.env" });
		const c = await perform(["--tour", "release-1"], {
			MAESTRO_TOUR: "from.env",
		});
		const rows = async (...flags: string[]) =>
			json(await w.call(["ls", "--json", ...flags])).map(
				(r: { id: string }) => r.id,
			);
		expect(await rows("--tour", "release-1")).toEqual([c, a]);
		expect(await rows("--tour", "from")).toEqual([b]);
		expect(
			json(await w.call(["ls", "--json", "--tour", "release-1"]))[1],
		).toMatchObject({
			title: "first try",
			workspace: "ws",
		});

		const moved = await w.call(["tour", "set", "release-2", a, b]);
		expect(moved).toMatchObject({
			out: "",
			err: `release-2: ${a} ${b}`,
		});
		expect(await rows("--tour", "release-2")).toEqual([b, a]);
		expect(json(await w.call(["t", "clear", a, "--json"]))).toEqual({
			tour: null,
			concerts: [a],
		});
		expect(await rows("--tour", "release-2")).toEqual([b]);
	});

	test("ls filters by status, composition, workspace and limit, and lists a concert's node instances", async () => {
		const w = await world();
		const failing = { outcome: "failed", reason: "flaky" };
		const done = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		const broke = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf(failing)] }),
		);
		const rows = async (...flags: string[]) =>
			json(await w.call(["ls", "--json", ...flags])).map(
				(r: { id: string }) => r.id,
			);
		expect(await rows("--status", "failed")).toEqual([broke]);
		expect(
			await rows("--composition", "demo.greet", "--workspace", "ws"),
		).toEqual([broke, done]);
		expect(await rows("--composition", "other.greet")).toEqual([]);
		expect(await w.call(["ls", "--composition", "greet"])).toMatchObject({
			code: 2,
			err: "error: --composition takes <pack>.<composition>, not 'greet'\n  Write it as greet.hello",
		});
		expect((await w.call(["ls"])).out).toMatch(/\sfailed\s.*\sdemo\.greet\s/);
		expect(await rows("--limit", "1")).toEqual([broke]);
		const short = shortIds([done, broke]);
		expect(
			json(await w.call(["ls", "--json"])).map(
				(r: { short: string }) => r.short,
			),
		).toEqual([broke, done].map((id) => short.label(id, false)));
		const table = await w.call(["ls", broke]);
		expect(table.out).toMatch(/^echo\/echo\s+failed\s+flaky$/m);
		expect(json(await w.call(["ls", broke, "--json"]))).toMatchObject({
			id: broke,
			short: short.label(broke, false),
			instances: expect.arrayContaining([
				expect.objectContaining({ node: "echo/echo", status: "failed" }),
			]),
		});
	});

	// Seam: concert and instance listings on a terminal, in a pipe and as JSON.
	test("ls fits a long title before the tour and keeps the remaining concert columns", async () => {
		const w = await world();
		const title = "a long concert title ".repeat(8).trim();
		const tour = "release-one";
		const performed = await w.call(
			["perform", ...GREET, "--title", title, "--tour", tour],
			{ hosts: [hostOf()] },
		);
		expect(performed.code).toBe(0);
		const id = idOf(performed);
		const terminal = () => ({ columns: 80, rows: 24 });
		const on = await w.call(["ls", "--no-color"], { terminal });
		expect(on.code).toBe(0);
		const row =
			on.out.split("\n").find((line) => line.startsWith(shortOf(id))) ?? "";
		expect(row).toContain(tour);
		expect(row).toContain("ws");
		expect(row).toContain("demo.greet");
		expect(row).toContain("ok");
		expect((await w.call(["ls"])).out).toContain(title);
		const document = await w.call(["ls", "--json"], { terminal });
		expect(json(document)[0]).toMatchObject({ id, title, tour });
		expect(json(document)).toEqual(json(await w.call(["ls", "--json"])));
		expect(
			on.out.split("\n").every((line) => Bun.stringWidth(line) <= 80),
		).toBe(true);
		expect(row).toContain("…");
	});

	test("ls concert fits agent and reason without cutting instance names", async () => {
		const w = await world();
		const actor = "agent-model-".repeat(12);
		const reason = "the failure reason is too long to fit ".repeat(5).trim();
		const host: Host = {
			...hostOf({ outcome: "failed", reason, enrichment: { session: "s" } }),
			text: { actor: () => actor },
		};
		const performed = await w.call(["perform", ...GREET], { hosts: [host] });
		const id = idOf(performed);
		const terminal = () => ({ columns: 80, rows: 24 });
		const on = await w.call(["ls", id, "--no-color"], {
			terminal,
			hosts: [host],
		});
		expect(on.code).toBe(0);
		const row =
			on.out.split("\n").find((line) => line.startsWith("echo/echo")) ?? "";
		expect(row).toContain("failed");
		const piped = await w.call(["ls", id], { hosts: [host] });
		expect(piped.out).toContain(actor);
		expect(piped.out).toContain(reason);
		const args = ["ls", id, "--json"];
		expect(json(await w.call(args, { terminal, hosts: [host] }))).toEqual(
			json(await w.call(args, { hosts: [host] })),
		);
		expect(
			on.out.split("\n").every((line) => Bun.stringWidth(line) <= 80),
		).toBe(true);
		expect(row.split("…").length).toBe(3);
	});

	// Seam: concert listings on a terminal, in a pipe and as JSON.
	test("ls cuts the tour only after the title is at its floor, keeps headings, tokens and disk, and hints at full values", async () => {
		const w = await world();
		const title = "a long concert title ".repeat(8).trim();
		const tour = "release-one.build-two.stage-three";
		const performed = await w.call(
			["perform", ...GREET, "--title", title, "--tour", tour],
			{ hosts: [hostOf()] },
		);
		const id = idOf(performed);
		const at = async (columns: number) =>
			(
				await w.call(["ls", "--no-color"], {
					terminal: () => ({ columns, rows: 24 }),
				})
			).out;
		const wide = await at(60);
		const [head = "", ...rest] = wide.split("\n");
		const row = rest.find((line) => line.startsWith(shortOf(id))) ?? "";
		expect(head).toContain("title");
		expect(row).toContain("…");
		expect(row).toContain("0 B");
		expect(row).toContain("demo.greet");
		expect(row).not.toContain(tour);
		expect(wide).toContain("maestro ls --limit 20 --json");
		const whole = await at(300);
		expect(whole).toContain(title);
		expect(whole).toContain(tour);
		expect(whole).not.toContain("--json");
	});

	test("ls cuts the workspace before the composition, each down to its floor", async () => {
		const w = await world();
		const name = "greet-with-a-very-long-name";
		const source = await demoSource((text) =>
			text.replace('"greet",', `"${name}",`),
		);
		await packOf(join(source, "index.ts"), w.pack);
		const cwd = join(w.root, "a-quite-long-workspace-dir");
		await mkdir(cwd);
		await Bun.write(join(cwd, ".maestro/config.yaml"), `packs: [${w.pack}]\n`);
		const performed = await w.call(["perform", `demo.${name}`, "--name", "x"], {
			cwd,
		});
		const id = idOf(performed);
		const rowAt = async (columns: number) => {
			const on = await w.call(["ls", "--no-color"], {
				terminal: () => ({ columns, rows: 24 }),
			});
			return on.out.split("\n").find((l) => l.startsWith(shortOf(id))) ?? "";
		};
		const roomy = await rowAt(100);
		expect(roomy).toContain(`demo.${name}`);
		expect(roomy).not.toContain("a-quite-long-workspace-dir");
		expect(roomy).toContain("…");
		const tight = await rowAt(70);
		expect(tight).not.toContain(`demo.${name}`);
		expect(tight.split("…").length).toBe(3);
	});

	// Seam: the commands in ls's terminal hints when a listing and a cell are cut.
	test("ls hints preserve shell-safe filter values without quotes", async () => {
		const w = await world();
		const cwd = join(w.root, "ws%+=,");
		await mkdir(join(cwd, ".maestro"), { recursive: true });
		await Bun.write(join(cwd, ".maestro/config.yaml"), `packs: [${w.pack}]\n`);
		for (let i = 0; i < 2; i++) {
			const performed = await w.call(
				["perform", ...GREET, "--title", "a long concert title ".repeat(8)],
				{ cwd, hosts: [hostOf()] },
			);
			expect(performed.code).toBe(0);
		}
		const listed = await w.call(
			[
				"ls",
				"--no-color",
				"--limit",
				"1",
				"--status",
				"ok",
				"--workspace",
				"ws%+=,",
			],
			{ terminal: () => ({ columns: 80, rows: 24 }) },
		);
		expect(listed.code).toBe(0);
		const lines = listed.out.split("\n");
		expect([
			lines.find((line) => line.startsWith("Full values:")),
			lines.find((line) => line.startsWith("Older concerts:")),
		]).toEqual([
			"Full values: maestro ls --status ok --workspace ws%+=, --limit 1 --json",
			"Older concerts: maestro ls --status ok --workspace ws%+=, --limit 2",
		]);
	});

	test("ls hints at the listing with its filters and limit, or --all", async () => {
		const w = await world();
		const title = "a long concert title ".repeat(8).trim();
		await w.call(["perform", ...GREET, "--title", title], {
			hosts: [hostOf()],
		});
		const terminal = () => ({ columns: 80, rows: 24 });
		const all = await w.call(["ls", "--all", "--status", "ok"], { terminal });
		expect(all.out).toContain("maestro ls --status ok --all --json");
		const limited = await w.call(["ls", "--limit", "5"], { terminal });
		expect(limited.out).toContain("maestro ls --limit 5 --json");
	});

	test("ls concert cuts the agent and leaves a short reason whole", async () => {
		const w = await world();
		const actor = "agent-model-".repeat(12);
		const reason = "short reason";
		const host: Host = {
			...hostOf({ outcome: "failed", reason, enrichment: { session: "s" } }),
			text: { actor: () => actor },
		};
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const on = await w.call(["ls", id, "--no-color"], {
			terminal: () => ({ columns: 80, rows: 24 }),
			hosts: [host],
		});
		const row =
			on.out.split("\n").find((line) => line.startsWith("echo/echo")) ?? "";
		expect(row).toContain(reason);
		expect(row.split("…").length).toBe(2);
		expect(on.out).toContain(`maestro ls ${shortOf(id)} --json`);
	});

	// Seam: ls's table on a terminal and in a pipe.
	test("ls dims absent table values on a terminal and leaves piped dashes plain", async () => {
		const w = await world();
		const performed = await w.call(["perform", ...GREET], {
			hosts: [hostOf()],
		});
		expect(performed.code).toBe(0);
		const terminal = () => ({ columns: 200, rows: 24 });
		const on = await w.call(["ls", "--color"], { terminal });
		expect(on.code).toBe(0);
		const dash = RegExp.escape(`${ESC}[2m-${ESC}[22m`);
		expect(on.out).toMatch(
			new RegExp(` +${dash} +${dash} +ws +demo\\.greet +${dash}`),
		);
		const piped = await w.call(["ls"]);
		expect(piped.code).toBe(0);
		expect(piped.out).toMatch(/ - +- +/);
		expect(piped.out).not.toContain(ESC);
	});

	test("ls colors its status column on a terminal stdout only, with color on, and its table stays aligned", async () => {
		const w = await world();
		const done = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		const broke = idOf(
			await w.call(["perform", ...GREET], {
				hosts: [hostOf({ outcome: "failed", reason: "flaky" })],
			}),
		);
		const terminal = () => ({ columns: 80, rows: 24 });
		const plain = await w.call(["ls"]);
		const listed = await w.call(["ls"], { terminal });
		expect(listed.out).toContain(stateWord("failed", true));
		expect(listed.out).toContain(stateWord("ok", true));
		expect(stripVTControlCharacters(listed.out)).toBe(plain.out);
		const instances = await w.call(["ls", broke], { terminal });
		expect(instances.out).toContain(stateWord("failed", true));
		expect(stripVTControlCharacters(instances.out)).toBe(
			(await w.call(["ls", broke])).out,
		);
		const off: { args: string[]; env: Record<string, string> }[] = [
			{ args: ["--no-color"], env: {} },
			{ args: [], env: { NO_COLOR: "1" } },
			{ args: [], env: { TERM: "dumb" } },
		];
		for (const { args, env } of off)
			for (const target of [[], [done]])
				expect(
					(await w.call(["ls", ...target, ...args], { terminal, env })).out,
				).not.toContain(ESC);
		expect(
			(await w.call(["ls"], { stderrTerminal: terminal })).out,
		).not.toContain(ESC);
		expect((await w.call(["ls", "--json"], { terminal })).out).not.toContain(
			ESC,
		);
	});

	test("an error on a terminal stderr colors the severity of a diagnostic and dims the hint, off a terminal or with color off it is plain", async () => {
		const w = await world();
		const terminal = () => ({ columns: 80, rows: 24 });
		const code = `${ESC}[31merror${ESC}[39m`;
		const hint = (text: string) => `${ESC}[2m${text}${ESC}[22m`;
		const diagnosed = ["perform", ...GREET, "-c", "nope.x=1"];
		const bad = await w.call(diagnosed, { stderrTerminal: terminal });
		expect(bad.err).toStartWith(code);
		expect(bad.err).toContain(`\n  ${ESC}[2m`);
		const usage = await w.call(["ls", "--status", "bogus"], {
			stderrTerminal: terminal,
		});
		expect(usage.err).toBe(
			`${ESC}[31merror${ESC}[39m: --status takes one of running, ok, failed, rejected, not 'bogus'\n  ${hint("Pick one of those")}`,
		);
		const both = { terminal, stderrTerminal: terminal };
		expect((await w.call([], both)).err).toStartWith(
			`${code}: no command given`,
		);
		for (const off of [
			[...diagnosed, "--no-color"],
			[...diagnosed, "--json"],
			["ls", "--status", "bogus", "--no-color"],
		]) {
			const plain = await w.call(off, both);
			expect(plain.err + plain.out).not.toContain(ESC);
		}
		for (const piped of [
			{},
			{ terminal },
			{ stderrTerminal: terminal, env: { TERM: "dumb" } },
		])
			expect((await w.call(diagnosed, piped)).err).not.toContain(ESC);
		expect(
			renderDiagnostic(
				{ code: "X.y", severity: "warning", message: "m", hint: "h" },
				true,
			),
		).toBe(`${ESC}[33mwarning${ESC}[39m: m\n  ${hint("h")}`);
		expect(renderWarning("m", true)).toBe(`${ESC}[33mwarning${ESC}[39m: m`);
	});

	test("a diagnostic renders as its severity word and message, led by its file location, then the hint", () => {
		const d = { code: "X.y", message: "m", hint: "h" } as const;
		expect(renderDiagnostic({ ...d, severity: "error" }, false)).toBe(
			"error: m\n  h",
		);
		expect(renderDiagnostic({ ...d, severity: "warning" }, false)).toBe(
			"warning: m\n  h",
		);
		expect(
			renderDiagnostic(
				{ ...d, severity: "error", source: { file: "c.yaml", line: 12 } },
				false,
			),
		).toBe("c.yaml:12: error: m\n  h");
		expect(
			renderDiagnostic(
				{
					code: "CFG.yaml",
					severity: "error",
					message: "bad yaml",
					hint: "h",
					source: { file: "/w/c.yaml", line: 3 },
				},
				false,
			),
		).toBe("/w/c.yaml:3: error: bad yaml\n  h");
	});

	test("ls lists a concert's node instances in graph order, one node's expansions by their first event, whatever order the record holds them", async () => {
		const w = await world();
		const id = idOf(
			await w.call(["perform", join(GOLDEN, "fanout-fanin-loop.json")]),
		);
		const drafts = async () =>
			json(await w.call(["ls", id, "--json"])).instances.flatMap(
				(i: { node: string; expansion: string }) =>
					i.node === "topics/draft" ? [i.expansion] : [],
			);
		const first = await drafts();
		expect(first).toHaveLength(3);
		const db = new Database(join(w.root, "data/maestro/record.db"));
		db.run(
			"UPDATE instances SET rowid = rowid + 100 WHERE node = 'topics/draft' AND expansion = ?",
			[first[0] ?? ""],
		);
		db.close();
		expect(await drafts()).toEqual(first);
	});

	// Seam: the concert document and step rows printed by ls --json, not the record's columns.
	test("ls <concert> --json contains only the concert row, metrics, step rows and pending nodes", async () => {
		const w = await world();
		const notes = { Lessons: ["keep the listing small"] };
		const host: Host = {
			...hostOf({
				...ECHO,
				metrics: { tokens_in: 12, tokens_out: 3, cost: 7 },
				enrichment: { report: { summary: "full report" } },
			}),
			text: { notes: () => notes, report: () => ({ summary: "full report" }) },
		};
		const first = await w.call(["perform", ...GREET], { hosts: [host] });
		expect(first.code).toBe(0);
		const previous = idOf(first);
		const encore = await w.call(
			[
				"encore",
				previous,
				"-c",
				"concurrency=2",
				"--tour",
				"listing",
				"--title",
				"small listing",
			],
			{ hosts: [host] },
		);
		expect(encore.code).toBe(0);
		const id = idOf(encore);
		const shown = await w.call(["ls", id, "--json"], { hosts: [host] });
		expect(shown.code).toBe(0);
		expect(shown.err).toBe("");
		const doc = json(shown);
		expect(Object.keys(doc).sort()).toEqual(
			[...LIST_ROW, "metrics", "instances", "pending"].sort(),
		);
		expect(doc).toMatchObject({
			id,
			short: shortOf(id),
			status: "ok",
			pack: "demo",
			composition: "greet",
			workspace: "ws",
			tour: "listing",
			title: "small listing",
			encoreOf: previous,
			metrics: { tokens_in: 12, tokens_out: 3, cost: 7 },
			tokens: 15,
			notes: { Lessons: 1 },
		});
		expect(doc.instances.map((row: { name: string }) => row.name)).toEqual([
			"first",
			"helpers_exclaim",
			"shape",
			"echo/echo",
		]);
		const step = doc.instances.find(
			(row: { name: string }) => row.name === "echo/echo",
		);
		expect(Object.keys(step).sort()).toEqual(
			[
				"name",
				"node",
				"kind",
				"expansion",
				"status",
				"stale",
				"startedAt",
				"settledAt",
				"elapsedMs",
				"tokens",
				"notes",
			].sort(),
		);
		expect(step).toMatchObject({
			name: "echo/echo",
			node: "echo/echo",
			expansion: "",
			status: "ok",
			stale: false,
			startedAt: expect.any(Number),
			settledAt: expect.any(Number),
			elapsedMs: expect.any(Number),
			tokens: 15,
			notes,
		});
		const code = doc.instances.find(
			(row: { name: string }) => row.name === "shape",
		);
		expect(Object.keys(code).sort()).toEqual(
			[
				"name",
				"node",
				"kind",
				"expansion",
				"status",
				"stale",
				"startedAt",
				"settledAt",
				"elapsedMs",
				"tokens",
			].sort(),
		);
	});

	// Seam: the JSON documents and exit codes of ls on a performed concert and one of its instances.
	async function loopFanConcert() {
		const w = await world();
		const done = {
			outcome: "ok",
			outputs: { text: "done" },
			enrichment: { summary: "reviewed" },
		} as const;
		const host: Host = {
			...fakeHost({
				steps: {
					init: [done],
					"rounds/fan/worker": [done],
					"rounds/finish": [done],
				},
			}),
			text: { report: (e) => ({ summary: e.summary }) },
		};
		const performed = await w.call(["perform", join(FIXTURES, "loop-fan.ts")], {
			hosts: [host],
		});
		expect(performed.code).toBe(0);
		return { w, host, id: idOf(performed) };
	}

	test("ls <concert> --json gives each instance its recorded node kind", async () => {
		const { w, host, id } = await loopFanConcert();
		const shown = await w.call(["ls", id, "--json"], { hosts: [host] });
		expect(shown.code).toBe(0);
		expect(json(shown).instances).toMatchObject([
			{ node: "init", kind: "fake.task" },
			{ node: "rounds", kind: "loop" },
			{ node: "rounds/fan", kind: "parMap" },
			{ node: "rounds/fan/worker", kind: "fake.task" },
			{ node: "rounds/fan/worker", kind: "fake.task" },
			{ node: "rounds/firstOk", kind: "code" },
			{ node: "rounds/firstOk_text", kind: "code" },
			{ node: "rounds/finish", kind: "fake.task" },
			{ node: "rounds/finish_not", kind: "code" },
		]);
		expect(json(shown).pending).toEqual([]);
	});

	test("ls <concert> --json lists uninstantiated nodes in recorded IR order, or an empty array", async () => {
		const w = await world();
		const failed = await w.call(["perform", join(FIXTURES, "loop-fan.ts")]);
		expect(failed.code).toBe(1);
		const partial = await w.call(["ls", idOf(failed), "--json"]);
		expect(partial.code).toBe(0);
		const doc = json(partial);
		expect(doc.instances).toMatchObject([
			{ node: "init", status: "failed" },
			{ node: "rounds", status: "skipped" },
		]);
		expect(doc.pending).toEqual([
			{ id: "rounds/fan", kind: "parMap" },
			{ id: "rounds/fan/worker", kind: "fake.task" },
			{ id: "rounds/firstOk", kind: "code" },
			{ id: "rounds/firstOk_text", kind: "code" },
			{ id: "rounds/finish", kind: "fake.task" },
			{ id: "rounds/finish_not", kind: "code" },
		]);

		const completed = await w.call(["perform", ...GREET], {
			hosts: [hostOf()],
		});
		expect(completed.code).toBe(0);
		const shown = await w.call(["ls", idOf(completed), "--json"]);
		expect(shown.code).toBe(0);
		expect(json(shown).pending).toEqual([]);
	});

	test("ls <concert> <instance> --json gives the same node kind as its listing row", async () => {
		const { w, host, id } = await loopFanConcert();
		const listing = await w.call(["ls", id, "--json"], { hosts: [host] });
		expect(listing.code).toBe(0);
		const instances = json(listing).instances;
		for (const [name, kind] of [
			["rounds", "loop"],
			["rounds[0]/fan", "parMap"],
			["rounds[0]/fan[lens]/worker", "fake.task"],
			["rounds[0]/firstOk", "code"],
		] as const) {
			const row = instances.find((i: { name: string }) => i.name === name);
			const result = await w.call(["ls", id, name, "--json"], {
				hosts: [host],
			});
			expect(result.code).toBe(0);
			expect(json(result).kind).toBe(kind);
			expect(row.kind).toBe(kind);
		}
	});

	test("ls --json names each instance as ls <concert> <instance> takes it, including a fan-out inside a loop", async () => {
		const { w, host, id } = await loopFanConcert();
		const result = await w.call(["ls", id, "--json"], { hosts: [host] });
		expect(result.code).toBe(0);
		const doc = json(result);
		const workers = doc.instances.filter(
			(i: { node: string }) => i.node === "rounds/fan/worker",
		);
		expect(
			workers.map((i: { expansion: string }) => i.expansion).sort(),
		).toEqual(["[0][lens]", "[0][risk]"]);
		for (const name of [
			"rounds[0]/fan[lens]/worker",
			"rounds[0]/fan[risk]/worker",
		]) {
			const detail = json(
				await w.call(["ls", id, name, "--json"], { hosts: [host] }),
			);
			expect(detail.report).toEqual({ summary: "reviewed" });
			expect(detail.outputs).toEqual({ text: "done" });
		}
		expect(workers.map((i: { name: string }) => i.name).sort()).toEqual([
			"rounds[0]/fan[lens]/worker",
			"rounds[0]/fan[risk]/worker",
		]);
		// The two parallel workers sit together at graph position 3, in either order;
		// every other instance keeps its graph order.
		expect(
			doc.instances.slice(3, 5).map((i: { node: string }) => i.node),
		).toEqual(["rounds/fan/worker", "rounds/fan/worker"]);
		expect(
			doc.instances.filter(
				(i: { node: string }) => i.node !== "rounds/fan/worker",
			),
		).toMatchObject([
			{ node: "init", name: "init" },
			{ node: "rounds", name: "rounds" },
			{ node: "rounds/fan", name: "rounds[0]/fan" },
			{ node: "rounds/firstOk", name: "rounds[0]/firstOk" },
			{ node: "rounds/firstOk_text", name: "rounds[0]/firstOk_text" },
			{ node: "rounds/finish", name: "rounds[0]/finish" },
			{ node: "rounds/finish_not", name: "rounds[0]/finish_not" },
		]);
	});

	test("ls --json accepts an instance name from the listing and details only that named instance", async () => {
		const { w, host, id } = await loopFanConcert();
		const doc = json(await w.call(["ls", id, "--json"], { hosts: [host] }));
		const worker = doc.instances.find(
			(i: { node: string; expansion: string }) =>
				i.node === "rounds/fan/worker" && i.expansion === "[0][lens]",
		);
		expect(worker.name).toBe("rounds[0]/fan[lens]/worker");
		const result = await w.call(["ls", id, worker.name, "--json"], {
			hosts: [host],
		});
		expect(result.code).toBe(0);
		const detail = json(result);
		expect(detail).toMatchObject(worker);
		expect(detail.report).toEqual({ summary: "reviewed" });
		expect(detail.outputs).toEqual({ text: "done" });
	});

	test("ls <concert> <instance> --json gives an instance's wired inputs, and leaves the field out for one that has none", async () => {
		const w = await world();
		const id = idOf(
			await w.call(["perform", join(GOLDEN, "fanout-fanin-loop.json")]),
		);
		const instances = json(await w.call(["ls", id, "--json"])).instances;
		const detail = async (node: string) => {
			const { name } = instances.find((i: { node: string }) => i.node === node);
			return json(await w.call(["ls", id, name, "--json"]));
		};
		expect((await detail("topics/draft")).inputs).toEqual({
			prompt: expect.any(String),
		});
		expect(await detail("topics")).not.toHaveProperty("inputs");
	});

	test("ls shows the disk a concert held as it settled, and none for one the record holds no size for", async () => {
		const w = await world();
		let usage = 2048;
		const host = hostOf(ECHO, { usage: () => usage });
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const diskUse = async () =>
			json(await w.call(["ls", "--json"], { hosts: [host] }))[0].diskUse;
		const settled = await diskUse();
		expect(settled).toBeGreaterThanOrEqual(2048);
		expect((await w.call(["ls"], { hosts: [host] })).out).toMatch(
			/ok\s.*\s-\s+2\.\d KiB$/m,
		);
		await Bun.write(
			join(w.env.XDG_DATA_HOME, "maestro/concerts", id, "artifacts/a.txt"),
			"x".repeat(100),
		);
		usage = 0;
		expect(await diskUse()).toBe(settled);
		unmeasured(w, id);
		expect(await diskUse()).toBeUndefined();
		expect((await w.call(["ls"], { hosts: [host] })).out).toMatch(
			/ok\s.*\s-\s+-$/m,
		);
	});

	test("a host that cannot measure a concert leaves ls and prune working, and prune says why", async () => {
		const w = await world();
		const host = hostOf(ECHO, {
			usage: () => Promise.reject(new Error("record '/x' is malformed")),
		});
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const listed = await w.call(["ls"], { hosts: [host] });
		expect(listed).toMatchObject({ code: 0, err: "" });
		expect(listed.out).toContain(shortOf(id));
		const pruned = await w.call(["prune", id, "--yes"], { hosts: [host] });
		expect(pruned).toMatchObject({ code: 0 });
		expect(pruned.err).toContain(
			`warning: host 'fake' cannot measure concert ${id}: record '/x' is malformed`,
		);
	});

	test("wait exits with the concert's outcome and prints its result's outputs, and 0 for one that is already settled", async () => {
		const w = await world();
		const done = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		const broke = idOf(
			await w.call(["perform", ...GREET], {
				hosts: [hostOf({ outcome: "failed", reason: "flaky" })],
			}),
		);
		const refused = idOf(
			await w.call(["perform", ...GREET], {
				hosts: [
					hostOf({
						outcome: "rejected",
						reason: "no",
						outputs: { text: "draft" },
					}),
				],
			}),
		);
		expect(await w.call(["wt", done])).toMatchObject({
			code: 0,
			out: "text       done",
			err: expect.stringMatching(closingOf(done, "ok")),
		});
		expect(json(await w.call(["wait", done, "--json"]))).toMatchObject({
			status: "ok",
			outputs: { text: "done" },
		});
		expect(await w.call(["wait", broke])).toMatchObject({
			code: 1,
			out: "",
			err: expect.stringMatching(
				closingOf(broke, "failed", ["at", "echo/echo"], ["reason", "flaky"]),
			),
		});
		expect(await w.call(["wait", refused, "--timeout", "5s"])).toMatchObject({
			code: 3,
			out: "text       draft",
			err: expect.stringMatching(
				closingOf(refused, "rejected", ["at", "echo/echo"], ["reason", "no"]),
			),
		});
		expect(json(await w.call(["wait", refused, "--json"]))).toEqual({
			id: refused,
			status: "rejected",
			resultNode: "echo/echo",
			resultExpansion: "",
			reason: "no",
			outputs: { text: "draft" },
			metrics: {},
			tokens: 0,
			artifacts: join(w.root, "data/maestro/concerts", refused, "artifacts"),
		});
	});

	test("spend: ls and ls <concert> show the agent and its tokens, ls the concert's total, and the --json documents the metrics and their total", async () => {
		const w = await world();
		const agent = {
			...ECHO,
			metrics: { tokens_in: 12_000, tokens_out: 3_500, cost: 7 },
			enrichment: {
				session: "s",
				harness: "pi",
				model: "github-copilot/claude-haiku-5.5",
				thinking: "medium",
			},
		};
		const host: Host = {
			...hostOf(agent),
			text: {
				actor: () => "pi · claude-haiku-5.5 · medium",
			},
		};
		const spent = await w.call(["perform", ...GREET, "--json"], {
			hosts: [host],
		});
		const metrics = { cost: 7, tokens_in: 12_000, tokens_out: 3_500 };
		expect(json(spent)).toMatchObject({ metrics, tokens: 15_500 });
		const id = json(spent).id;
		const bare = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		expect(json(await w.call(["wait", id, "--json"]))).toMatchObject({
			metrics,
			tokens: 15_500,
		});
		expect((await w.call(["wait", id])).err).toMatch(/ · 15\.5k tok$/m);
		expect((await w.call(["wait", bare])).err).not.toMatch(/ · [\d.]+k? tok$/m);
		const row = json(await w.call(["ls", "--json"])).find(
			(r: { id: string }) => r.id === id,
		);
		expect(row).toMatchObject({ tokens: 15_500 });
		expect(row.elapsedMs).toBe(row.settledAt - row.startedAt);
		const single = json(await w.call(["ls", id, "--json"]));
		expect(single).toMatchObject({ metrics, tokens: 15_500 });
		expect(single.elapsedMs).toBe(row.elapsedMs);
		const listed = (await w.call(["ls"])).out.split("\n");
		expect(listed[0]).toMatch(
			/^id +status +time +title +tour +workspace +composition +tokens +disk$/,
		);
		expect(listed.find((l) => l.startsWith(shortOf(id)))).toMatch(
			/ok .* 15\.5k +/,
		);
		expect(listed.find((l) => l.startsWith(shortOf(bare)))).toMatch(
			/ok +\S+ +- +/,
		);
		expect((await w.call(["ls", id], { hosts: [host] })).out).toContain(
			"pi · claude-haiku-5.5 · medium  15.5k tok",
		);
	});

	// Seam: notes in a concert listing on a narrow terminal.
	test("ls cuts notes entries without cutting instance names", async () => {
		const w = await world();
		const notes = { Lessons: ["an entry that needs cutting"] };
		const host: Host = {
			...hostOf({ ...ECHO, enrichment: { notes } }),
			text: { notes: (e) => (e.notes ?? {}) as Record<string, string[]> },
		};
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const result = await w.call(["ls", id, "--color"], {
			hosts: [host],
			terminal: () => ({ columns: 8, rows: 24 }),
		});
		expect(result.code).toBe(0);
		const lines = result.out.split("\n");
		const heading = lines.indexOf(`${ESC}[1mLessons${ESC}[22m`);
		expect(heading).toBeGreaterThanOrEqual(0);
		expect(lines[heading + 1]?.startsWith("echo/echo")).toBe(true);
		expect(lines[heading + 1]).not.toContain(notes.Lessons[0]);
		expect(result.out).toContain(
			`Full notes: maestro ls ${shortOf(id)} <instance> --json | jq .notes`,
		);
	});

	test("ls <concert> lists its instances' notes under their headings, cut to a terminal's width, and ls marks and counts them", async () => {
		const w = await world();
		const lesson = `the lesson ${"is long ".repeat(10)}`.trim();
		const notes = { Obstacles: ["no rg on PATH"], Lessons: [lesson] };
		const host: Host = {
			...hostOf({ ...ECHO, enrichment: { notes } }),
			text: {
				notes: (e) => (e.notes ?? {}) as Record<string, string[]>,
				report: (e) => (e.notes ? { summary: "s", ...e } : undefined),
				reportFields: { summary: "what it did" },
			},
		};
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const bare = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		const sections = `\n\nObstacles\necho/echo  no rg on PATH\n\nLessons\necho/echo  ${lesson}`;
		expect((await w.call(["ls", id], { hosts: [host] })).out).toEndWith(
			sections,
		);
		const one = await w.call(["ls", id, "echo"], { hosts: [host] });
		expect(one.code).toBe(0);
		expect(one.out).toEndWith(sections);
		expect(one.out.split("\n")[0]).toMatch(/^instance +status/);
		expect(
			json(await w.call(["ls", id, "echo", "--json"], { hosts: [host] })).name,
		).toBe("echo/echo");
		const missing = await w.call(["ls", id, "zzz"], { hosts: [host] });
		expect(missing.code).toBe(2);
		expect(missing.err).toContain(`no instance 'zzz' in concert ${id}`);
		const narrow = () => ({ columns: 40, rows: 24 });
		const full = `Full notes: maestro ls ${shortOf(id)} <instance> --json | jq .notes`;
		const cut = (
			await w.call(["ls", id], {
				hosts: [host],
				terminal: narrow,
				env: { NO_COLOR: "1" },
			})
		).out.split("\n");
		expect(
			(await w.call(["ls", id], { hosts: [host], terminal: narrow })).out,
		).toEndWith(`${ESC}[2m${full}${ESC}[22m`);
		expect(cut.slice(-6)).toEqual([
			"Obstacles",
			"echo/echo  no rg on PATH",
			"",
			"Lessons",
			`echo/echo  ${lesson.slice(0, 28)}…`,
			full,
		]);
		const detail = (hosts: Host[]) =>
			w.call(["ls", id, "echo", "--json"], { hosts }).then(json);
		expect((await detail([host])).report).toEqual({ summary: "s", notes });
		const doc = json(await w.call(["ls", id, "--json"], { hosts: [host] }));
		expect(doc.instances[0]).not.toHaveProperty("notes");
		expect(await detail([hostOf()])).not.toHaveProperty("report");
		expect((await w.call(["ls", "--help"], { hosts: [host] })).out).toContain(
			"\n\nReports\n  maestro ls <concert> <instance> --json | jq .report\n  summary  what it did\n\nExamples:",
		);
		const rows = json(await w.call(["ls", "--json"], { hosts: [host] }));
		expect(rows.map((r: { notes: object }) => r.notes)).toEqual([
			{},
			{ Obstacles: 1, Lessons: 1 },
		]);
		const piped = (await w.call(["ls"], { hosts: [host] })).out;
		expect(piped).not.toContain("•");
		const listed = (
			await w.call(["ls"], {
				hosts: [host],
				terminal: narrow,
				env: { NO_COLOR: "1" },
			})
		).out.split("\n");
		expect(listed.find((l) => l.startsWith(shortOf(id)))).toContain(" ok • ");
		expect(listed.find((l) => l.startsWith(shortOf(bare)))).not.toContain("•");
		expect(
			(await w.call(["ls"], { hosts: [host], terminal: narrow })).out,
		).toContain(stateWord("ok", true, "ok •"));
		expect((await w.call(["ls", "--help"], { hosts: [host] })).out).toContain(
			"• after a status: its instances left notes ('maestro ls <concert>' shows them)",
		);
		const db = new Database(join(w.root, "data/maestro/record.db"));
		db.run("UPDATE instances SET stale = 1");
		db.close();
		expect(await detail([host])).not.toHaveProperty("report");
	});

	test("an ambiguous prefix of the id or of the short id lists at most five short ids, then how many more", async () => {
		const w = await world();
		const ids: string[] = [];
		for (let i = 0; i < 7; i++)
			ids.push(
				idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] })),
			);
		const { code, err } = await w.call(["wait", "0"]);
		expect(code).toBe(2);
		expect(err.split("\n")).toEqual([
			`error: '0' starts 7 concerts: ${ids.slice(0, 5).map(shortOf).join(", ")} and 2 more`,
			"  Give more characters of the id",
		]);
		// Copies of a performed concert under ids whose short ids share all but their last letter.
		const twins = [
			"01a10000-0000-7000-8000-000000000001",
			"01a10000-0000-7000-8000-000000000002",
		];
		const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
		for (const twin of twins)
			db.run(
				`INSERT INTO concerts (id, composition, pack, ir, pid, status, started_at, settled_at, result_node, result_expansion, reason, workspace, tour, title, module_dir, file, profile, config, params, encore_of, fingerprint, limits, disk_use, snapshot)
				SELECT ?, composition, pack, ir, pid, status, started_at, settled_at, result_node, result_expansion, reason, workspace, tour, title, module_dir, file, profile, config, params, encore_of, fingerprint, limits, disk_use, snapshot FROM concerts WHERE id = ?`,
				[twin, ids[0] ?? ""],
			);
		db.close();
		expect((await w.call(["wait", "zzzz"])).err.split("\n")).toEqual([
			`error: 'zzzz' starts 2 concerts: ${twins.map(shortId).join(", ")}`,
			"  Give more characters of the id",
		]);
		expect(twins.map(shortId)).toEqual(["zzzzzzzzzzzzzzy", "zzzzzzzzzzzzzzx"]);
	});

	test("every command takes a unique prefix of a concert id; an ambiguous one is a usage error naming the matches, an unknown one is refused", async () => {
		const w = await world();
		const a = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const b = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const shared = [...a].findIndex((c, i) => c !== b[i]);
		const ambiguous = a.slice(0, shared);
		expect(await w.call(["wait", ambiguous])).toEqual({
			code: 2,
			out: "",
			err: `error: '${ambiguous}' starts 2 concerts: ${shortOf(a)}, ${shortOf(b)}\n  Give more characters of the id`,
		});
		expect(await w.call(["wait", "nope"])).toMatchObject({
			code: 2,
			err: "error: no concert 'nope' in the record\n  Check the id with 'maestro ls'",
		});
		const prefix = a.slice(0, shared + 1);
		expect(json(await w.call(["wait", prefix, "--json"])).id).toBe(a);
		expect(json(await w.call(["ls", prefix, "--json"])).id).toBe(a);
		expect(json(await w.call(["wait", shortOf(a), "--json"])).id).toBe(a);
		expect(json(await w.call(["ls", shortId(a), "--json"])).id).toBe(a);
		expect((await w.call(["watch", prefix])).code).toBe(0);
		expect(await w.call(["kill", prefix])).toMatchObject({
			code: 0,
			err: `concert ${a} already settled ok`,
		});
		expect(json(await w.call(["kill", prefix, "--json"]))).toMatchObject({
			id: a,
			status: "ok",
		});
		expect(await w.call(["resume", prefix])).toMatchObject({
			err: expect.stringContaining(`concert ${a} finished ok`),
		});
		expect(await w.call(["tour", "set", "t1", prefix, a])).toMatchObject({
			err: `t1: ${a}`,
		});
		expect(
			await w.call(["prune", prefix, a.slice(0, shared + 2), "--yes"]),
		).toMatchObject({ code: 0 });
		expect(
			json(await w.call(["ls", "--json"])).map((r: { id: string }) => r.id),
		).toEqual([b]);
	});
});

// Seam: every command on a recorded concert opens the record store alone, so broken config files cannot stop it.
test("wait, watch, kill, tour, artifact and prune run on a recorded concert when the config files are broken", async () => {
	const w = await world();
	const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
	await Bun.write(join(w.cwd, ".maestro/config.yaml"), "[broken YAML");
	await Bun.write(
		join(w.env.XDG_CONFIG_HOME, "maestro/config.yaml"),
		"[broken YAML",
	);
	for (const args of [
		["wait", id],
		["watch", id],
		["kill", id],
		["tour", "set", "t", id],
		["artifact", "ls", id],
		["prune", id, "--yes"],
	])
		expect([args[0], (await w.call(args, { hosts: [hostOf()] })).code]).toEqual(
			[args[0], 0],
		);
});

describe("prune", () => {
	// Seam: prune output and exit codes, confirmation, and the concerts still visible through ls.
	test("prune --all deletes every settled concert and skips running concerts", async () => {
		const w = await world();
		const settled: string[] = [];
		for (const echo of [
			ECHO,
			{ outcome: "failed", reason: "flaky" },
			{ outcome: "rejected", reason: "no" },
		]) {
			const performed = await w.call(["perform", ...GREET], {
				hosts: [hostOf(echo)],
			});
			settled.push(idOf(performed));
		}
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<typeof ECHO>();
		const performing = w.call(["perform", ...GREET], {
			hosts: [
				hostOf(ECHO, {
					steps: {
						first: () => {
							started.resolve();
							return finish.promise;
						},
					},
				}),
			],
		});
		try {
			await started.promise;
			const before: { id: string; status: string }[] = json(
				await w.call(["ls", "--json"]),
			);
			const running = before.filter((row) => row.status === "running");
			expect(running).toHaveLength(1);
			const pruned = await w.call(["prune", "--all", "--yes", "--json"]);
			expect(pruned.code).toBe(0);
			expect(json(pruned)).toMatchObject({
				pruned: expect.arrayContaining(settled),
				failures: [],
			});
			expect(json(pruned).pruned).toHaveLength(3);
			const after: { id: string; status: string }[] = json(
				await w.call(["ls", "--json"]),
			);
			expect(after.map((row) => ({ id: row.id, status: row.status }))).toEqual(
				running.map((row) => ({ id: row.id, status: "running" })),
			);
		} finally {
			finish.resolve(ECHO);
			await performing;
		}
	});

	test("prune --all asks before deleting and a declined confirmation keeps every concert", async () => {
		const w = await world();
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const asked: string[] = [];
		const declined = await w.call(["prune", "--all"], {
			confirm: async (question) => {
				asked.push(question);
				return false;
			},
		});
		expect(declined.code).toBe(0);
		expect(asked).toHaveLength(1);
		expect(asked[0]).not.toBe("");
		expect(json(await w.call(["ls", "--json"]))).toMatchObject([{ id }]);
		const accepted = await w.call(["prune", "--all"], {
			confirm: async () => true,
		});
		expect(accepted.code).toBe(0);
		expect(accepted.out).toBe(id);
		expect(json(await w.call(["ls", "--json"]))).toEqual([]);
	});

	test("prune --all --yes reports an unreleasable concert as kept and deletes the others", async () => {
		const w = await world();
		const gone = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		const kept = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		const host = hostOf(ECHO, {
			release: (id: string) => {
				if (id === kept) throw new Error("release unavailable");
			},
		});
		const pruned = await w.call(["prune", "--all", "--yes", "--json"], {
			hosts: [host],
		});
		expect(pruned.code).toBe(1);
		const doc = json(pruned);
		expect(doc.pruned).toEqual([gone]);
		expect(doc.failures).toEqual([{ id: kept, reason: expect.any(String) }]);
		expect(doc.failures[0].reason).not.toBe("");
		expect(json(await w.call(["ls", "--json"]))).toMatchObject([{ id: kept }]);
	});

	const ids = async (w: Awaited<ReturnType<typeof world>>) =>
		json(await w.call(["ls", "--json"])).map((r: { id: string }) => r.id);

	test("deletes the record, the directory and what the hosts hold, after a yes", async () => {
		const w = await world();
		const released: string[] = [];
		const host = hostOf(ECHO, {
			release: (id: string) => void released.push(id),
		});
		const perform = async () =>
			idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const [a, b] = [await perform(), await perform()];
		const dir = join(w.env.XDG_DATA_HOME, "maestro/concerts", a);
		await Bun.write(join(dir, "artifacts/a.txt"), "x".repeat(10));
		unmeasured(w, a);
		const asked: string[] = [];
		const answer = (yes: boolean) => ({
			hosts: [host],
			confirm: async (question: string) => {
				asked.push(question);
				return yes;
			},
		});

		expect(await w.call(["prune", a], { hosts: [host] })).toMatchObject({
			code: 2,
			err: "error: prune asks before it deletes, and there is no terminal to ask on\n  Pass --yes",
		});
		expect(await w.call(["prune", a], answer(false))).toMatchObject({
			code: 0,
			err: "nothing pruned",
		});
		expect(await ids(w)).toEqual([b, a]);
		expect(json(await w.call(["prune", a, "--json"], answer(false)))).toEqual({
			pruned: [],
			freed: 0,
			failures: [],
		});

		const pruned = await w.call(["prune", a], answer(true));
		expect(asked).toEqual(Array(3).fill("Prune 1 concert, freeing 10 B?"));
		expect(pruned).toMatchObject({
			code: 0,
			out: a,
			err: "pruned 1, freed 10 B",
		});
		expect(await ids(w)).toEqual([b]);
		expect(released).toEqual([a]);
		expect(await Bun.file(join(dir, "artifacts/a.txt")).exists()).toBe(false);
		expect(json(await w.call(["prune", b, "--yes", "--json"]))).toEqual({
			pruned: [b],
			freed: 0,
			failures: [],
		});
	});

	// Seam: the setup prune hands a host, and prune's refusal of a concert whose config snapshot cannot be read.
	test("releases what the hosts hold under the recorded config, and keeps a concert whose snapshot cannot be read", async () => {
		const w = await world();
		const seen: unknown[] = [];
		const host: Host = {
			...hostOf(ECHO, {
				release: (_id: string, setup: HostSetup) =>
					void seen.push(setup.config),
			}),
			config: { mode: { type: "object" } },
		};
		const config = join(w.cwd, ".maestro/config.yaml");
		await Bun.write(config, `packs: [${w.pack}]\nmode: { tag: recorded }\n`);
		const perform = async () =>
			idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const [kept, unread, gone] = [
			await perform(),
			await perform(),
			await perform(),
		];
		await Bun.write(config, `packs: [${w.pack}]\nmode: { tag: current }\n`);
		const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
		db.run("UPDATE concerts SET snapshot = NULL WHERE id = ?", [kept]);
		db.run("UPDATE concerts SET snapshot = ? WHERE id = ?", ["[", unread]);
		db.close();

		for (const id of [kept, unread])
			expect(
				await w.call(["prune", id, "--yes"], { hosts: [host] }),
			).toMatchObject({
				code: 1,
			});
		expect(await ids(w)).toEqual(expect.arrayContaining([kept, unread]));
		expect(seen).toEqual([]);

		expect(
			await w.call(["prune", gone, "--yes"], { hosts: [host] }),
		).toMatchObject({ code: 0 });
		expect(seen).toEqual([{ mode: { tag: "recorded" } }]);
	});

	test("a refused snapshot names the v0.3.0 cleanup script", async () => {
		const w = await world();
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
		for (const snapshot of [null, "["]) {
			db.run("UPDATE concerts SET snapshot = ? WHERE id = ?", [snapshot, id]);
			const refused = await w.call(["prune", id, "--yes"], {
				hosts: [hostOf()],
			});
			expect(refused.code).not.toBe(0);
			expect(refused.err).toContain("v0.3.0 maestro skill");
		}
		db.close();
	});

	test("--before takes the settled concerts older than it, narrowed by --tour", async () => {
		const w = await world();
		const perform = async (tour: string) =>
			idOf(
				await w.call(["perform", ...GREET, "--tour", tour], {
					hosts: [hostOf()],
				}),
			);
		const [x, y] = [await perform("t1"), await perform("t2")];
		expect(
			json(await w.call(["prune", "--before", "1d", "--yes", "--json"])),
		).toMatchObject({ pruned: [] });
		await Bun.sleep(1100);
		expect(
			json(
				await w.call([
					"prune",
					"--before",
					"1s",
					"--tour",
					"t1",
					"--yes",
					"--json",
				]),
			),
		).toMatchObject({
			pruned: [x],
		});
		expect(await ids(w)).toEqual([y]);
	});

	test("--tour alone takes that tour's settled concerts, after a yes", async () => {
		const w = await world();
		const perform = async (tour: string) =>
			idOf(
				await w.call(["perform", ...GREET, "--tour", tour], {
					hosts: [hostOf()],
				}),
			);
		const [x, y] = [await perform("t1"), await perform("t2")];
		expect(await w.call(["prune", "--tour", "t1"])).toMatchObject({
			code: 2,
			err: "error: prune asks before it deletes, and there is no terminal to ask on\n  Pass --yes",
		});
		expect(
			json(await w.call(["prune", "--tour", "t1", "--yes", "--json"])),
		).toMatchObject({ pruned: [x] });
		expect(await ids(w)).toEqual([y]);
	});

	test("--status and --composition take the settled concerts that match, with the other filters", async () => {
		const w = await world();
		const perform = async (host: Host) =>
			idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const failed = await perform(hostOf({ outcome: "failed", reason: "x" }));
		const ok = await perform(hostOf());
		const prune = async (...flags: string[]) =>
			json(await w.call(["prune", ...flags, "--yes", "--json"])).pruned;
		expect(await prune("--composition", "other.greet")).toEqual([]);
		expect(await prune("--status", "failed", "--workspace", "none")).toEqual(
			[],
		);
		expect(await prune("--status", "failed")).toEqual([failed]);
		expect(await ids(w)).toEqual([ok]);
		expect(await prune("--composition", "demo.greet")).toEqual([ok]);
	});

	test("a concert that is running by the time it is released stays, and the rest are pruned", async () => {
		const w = await world();
		const db = join(w.env.XDG_DATA_HOME, "maestro/record.db");
		let flipped: string | undefined;
		const host = hostOf(ECHO, {
			usage: (id: string) => {
				if (id !== flipped) return 0;
				const database = new Database(db);
				database.exec("UPDATE concerts SET status = 'running' WHERE id = ?", [
					id,
				]);
				database.close();
				return 0;
			},
		});
		const perform = async () =>
			idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const [a, b] = [await perform(), await perform()];
		unmeasured(w, a, b);
		flipped = a;
		const pruned = await w.call(["prune", a, b, "--yes", "--json"], {
			hosts: [host],
		});
		expect(pruned.code).toBe(1);
		expect(json(pruned)).toEqual({
			pruned: [b],
			freed: 0,
			failures: [{ id: a, reason: `it is running in process ${process.pid}` }],
		});
	});

	test("a host that cannot release a concert keeps it, names the host and exits 1", async () => {
		const w = await world();
		const host = hostOf(ECHO, {
			release: () => Promise.reject(new Error("boom")),
		});
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const pruned = await w.call(["prune", id, "--yes"], { hosts: [host] });
		expect(pruned).toMatchObject({ code: 1, out: "" });
		expect(pruned.err).toContain(
			`concert ${id} kept: host 'fake' could not release it: boom\nFix that, then prune it again`,
		);
		expect(await ids(w)).toEqual([id]);
	});

	test("a release failure that ends in its own fix gets no second one", async () => {
		const w = await world();
		const host = hostOf(ECHO, {
			release: () =>
				Promise.reject(new Error("cannot prune\nCheck x, then retry")),
		});
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const pruned = await w.call(["prune", id, "--yes"], { hosts: [host] });
		expect(pruned.err).toContain(
			"could not release it: cannot prune\nCheck x, then retry",
		);
		expect(pruned.err).not.toContain("Fix that");
	});
});

describe("prune --dry-run", () => {
	test("prune -n colors statuses on a terminal while keeping its scripted layout", async () => {
		const w = await world();
		const done = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		const broke = idOf(
			await w.call(["perform", ...GREET], {
				hosts: [hostOf({ outcome: "failed", reason: "flaky" })],
			}),
		);
		const terminal = () => ({ columns: 120, rows: 24 });
		const args = ["prune", done, broke, "-n"];
		const piped = await w.call(args);
		const shown = await w.call(args, { terminal });
		expect(piped.code).toBe(0);
		expect(shown.code).toBe(0);
		const lines = shown.out.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines.find((line) => line.startsWith(done))).toContain(
			`${ESC}[32mok${ESC}[39m`,
		);
		expect(lines.find((line) => line.startsWith(broke))).toContain(
			`${ESC}[31mfailed${ESC}[39m`,
		);
		expect(stripVTControlCharacters(shown.out)).toBe(piped.out);
		expect(piped.out).not.toContain(ESC);
	});

	// Seam: the dry-run listing and the unchanged store as read through ls.
	test("prune --all --dry-run lists every selected concert and deletes none", async () => {
		const w = await world();
		const a = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const b = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const dry = await w.call(["prune", "--all", "--dry-run"]);
		expect(dry.code).toBe(0);
		expect(
			dry.out
				.split("\n")
				.map((line) => line.split(/\s+/)[0])
				.sort(),
		).toEqual([a, b].sort());
		const after: { id: string }[] = json(await w.call(["ls", "--json"]));
		expect(after.map((row) => row.id)).toEqual([b, a]);
	});

	// Seam: prune's measured wouldFree and freed under a recorded config.
	test("prune measures the disk use under the recorded config outside the recorded workspace", async () => {
		const w = await world();
		const host: Host = {
			...hostOf(ECHO, {
				usage: (
					_id: string,
					setup: { config: { mode?: { bytes?: number } } },
				) => setup.config.mode?.bytes ?? 0,
			}),
			config: { mode: { type: "object" } },
		};
		const performed = await w.call(
			["perform", ...GREET, "-c", "mode.bytes=10000"],
			{ hosts: [host] },
		);
		expect(performed.code).toBe(0);
		const id = idOf(performed);
		await Bun.write(
			join(w.env.XDG_DATA_HOME, "maestro/concerts", id, "artifacts/a.txt"),
			"1234567",
		);
		const cwd = await scratch();
		await Bun.write(join(cwd, ".maestro/config.yaml"), "mode: { bytes: 37 }\n");
		const outside = { cwd, hosts: [host] };
		unmeasured(w, id);
		const dry = await w.call(["prune", id, "--dry-run", "--json"], outside);
		expect(dry.code).toBe(0);
		expect(json(dry)).toMatchObject({
			pruned: [],
			freed: 0,
			failures: [],
			wouldPrune: [{ id, bytes: 10007 }],
			wouldFree: 10007,
		});
		unmeasured(w, id);
		const pruned = await w.call(["prune", id, "--yes", "--json"], outside);
		expect(pruned.code).toBe(0);
		expect(json(pruned)).toEqual({ pruned: [id], freed: 10007, failures: [] });
	});

	test("lists each concert it would prune with its status, time and size, then the total, and prunes nothing", async () => {
		const w = await world();
		const done = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		const broke = idOf(
			await w.call(["perform", ...GREET], {
				hosts: [hostOf({ outcome: "failed", reason: "flaky" })],
			}),
		);
		await Bun.write(
			join(w.env.XDG_DATA_HOME, "maestro/concerts", done, "artifacts/a.txt"),
			"x".repeat(100),
		);
		unmeasured(w, done);
		const dry = await w.call(["prune", "--status", "ok", "-n"]);
		expect(dry.code).toBe(0);
		expect(dry.out).toMatch(new RegExp(`^${done} +ok +\\S+ +100 B$`));
		expect(dry.err).toBe("would prune 1 concert, freeing 100 B");
		const both = await w.call(["prune", done, broke, "--dry-run"]);
		expect(both.out.split("\n")).toHaveLength(2);
		expect(both.out).toMatch(new RegExp(`^${broke}|\\n${broke} +failed `));
		expect(both.err).toStartWith("would prune 2 concerts, freeing ");
		expect(
			json(await w.call(["ls", "--json"])).map((r: { id: string }) => r.id),
		).toHaveLength(2);
		expect(
			existsSync(join(w.env.XDG_DATA_HOME, "maestro/concerts", done)),
		).toBe(true);
	});
});

test("tour set usage points to help without repeating its usage lines", async () => {
	const w = await world();
	const stderrTerminal = () => ({ columns: 120, rows: 24 });
	const shown = await w.call(["tour", "set", "slug"], { stderrTerminal });
	const piped = await w.call(["tour", "set", "slug"]);
	expect(shown.code).toBe(2);
	expect(piped.code).toBe(2);
	const lines = shown.err.split("\n");
	const hint = lines.at(-1) ?? "";
	expect(hint.startsWith(`  ${ESC}[2m`)).toBe(true);
	expect(hint.endsWith(`${ESC}[22m`)).toBe(true);
	expect(stripVTControlCharacters(hint)).toContain("maestro tour --help");
	expect(stripVTControlCharacters(hint)).not.toContain(
		"maestro tour set <slug> <concert>",
	);
	expect(stripVTControlCharacters(hint)).not.toContain(
		"maestro tour clear <concert>",
	);
	expect(piped.err).not.toContain(ESC);
});

describe("prune --dry-run edges", () => {
	test("--json gives wouldPrune and wouldFree with pruned empty, and prunes nothing", async () => {
		const w = await world();
		const id = idOf(await w.call(["perform", ...GREET]));
		const doc = json(await w.call(["prune", id, "-n", "--json"]));
		expect(doc).toMatchObject({
			pruned: [],
			wouldPrune: [{ id, bytes: expect.any(Number) }],
			freed: 0,
			wouldFree: expect.any(Number),
			failures: [],
		});
		expect(json(await w.call(["ls", "--json"]))).toHaveLength(1);
	});

	test("selecting nothing prints nothing on stdout and would prune 0 concerts", async () => {
		const w = await world();
		await w.call(["perform", ...GREET]);
		expect(await w.call(["prune", "--status", "rejected", "-n"])).toEqual({
			code: 0,
			out: "",
			err: "would prune 0 concerts, freeing 0 B",
		});
	});
});

describe("diagnostics by who set the value", () => {
	// Seam: config refusals in CLI JSON; only diagnostic kinds and identifiers are pinned.
	test("dataRoot is an unknown key in files presets and flags with XDG_DATA_HOME as the fix", async () => {
		const cases = [
			{
				flags: ["-c", "dataRoot=x"],
				file: ".maestro/config.yaml",
				yaml: "",
				code: 2,
			},
			{
				flags: [],
				file: ".maestro/config.yaml",
				yaml: "dataRoot: x\n",
				code: 1,
			},
			{
				flags: ["--preset", "moved"],
				file: ".maestro/presets/moved.yaml",
				yaml: "dataRoot: x\n",
				code: 1,
			},
		];
		for (const scenario of cases) {
			const w = await world();
			await Bun.write(
				join(w.cwd, scenario.file),
				`packs: [${w.pack}]\n${scenario.yaml}`,
			);
			const refused = await w.call([
				"compose",
				...GREET,
				"--json",
				...scenario.flags,
			]);
			expect(refused.code).toBe(scenario.code);
			const document = json(refused);
			expect(document.ok).toBe(false);
			const diagnostics: {
				code: string;
				severity: string;
				message: string;
				hint?: string;
			}[] = document.diagnostics;
			expect(
				diagnostics.map((d) => ({
					code: d.code,
					severity: d.severity,
					words: d.message.match(/[A-Za-z_$][A-Za-z_0-9$]*/g),
					variables: d.hint?.match(/\$[A-Z_]+/g),
				})),
			).toContainEqual({
				code: "CFG.unclaimed",
				severity: "error",
				words: expect.arrayContaining(["dataRoot"]),
				variables: expect.arrayContaining(["$XDG_DATA_HOME"]),
			});
		}
	});

	test("a param a config file or a deleted core key leaves bad exits 1, and the same fault on the command line exits 2", async () => {
		const w = await world();
		const config = join(w.cwd, ".maestro/config.yaml");
		const base = await Bun.file(config).text();
		const missing = await w.call(["perform", "demo.ticket"]);
		expect(missing.code).toBe(2);
		await Bun.write(config, `${base}workspace: !delete\n`);
		const deleted = await w.call(["perform", ...GREET]);
		expect(deleted.code).toBe(1);
		await Bun.write(config, `${base}demo:\n  ticket:\n    handle: nonsense\n`);
		const set = await w.call(["perform", "demo.ticket"]);
		expect(set.code).toBe(1);
		expect(set.err).toContain("config.yaml");
		await Bun.write(config, base);
		expect(
			(await w.call(["perform", "demo.ticket", "--handle", "nonsense"])).code,
		).toBe(2);
	});
});

describe("exit codes and error states", () => {
	test("an error that is neither a CliError nor a diagnostic is reported as a bug and exits 1, with its stack under --debug", async () => {
		const w = await world();
		await w.call(["perform", ...GREET]);
		const boom = {
			stdout: () => {
				throw new Error("boom\nsecond line");
			},
		};
		const outcome = await w.call(["ls"], boom);
		expect(outcome.code).toBe(1);
		expect(outcome.err).toBe(
			"error: unexpected: boom second line\n  This is a bug in maestro. Rerun with --debug and report it upstream with the output",
		);
		expect((await w.call(["ls", "--debug"], boom)).err).toContain(
			"Error: boom",
		);
	});

	test("a perform cancelled by Ctrl-C exits 130 and hints maestro resume, and SIGTERM exits 143", async () => {
		const w = await world();
		const stopped = (signal: "SIGINT" | "SIGTERM") =>
			w.call(["perform", ...GREET], {
				hosts: [
					hostOf(ECHO, {
						steps: {
							first: () => {
								setTimeout(() => process.emit(signal), 20);
								return new Promise<never>(() => {});
							},
						},
					}),
				],
			});
		const interrupted = await stopped("SIGINT");
		expect(interrupted.code).toBe(130);
		expect(interrupted.err).toEndWith(
			`\nResume it: maestro resume ${shortOf(idOf(interrupted))}`,
		);
		const terminated = await stopped("SIGTERM");
		expect(terminated.code).toBe(143);
		expect(terminated.err).not.toContain("Resume it");
		const quiet = await w.call(["perform", ...GREET, "--json"], {
			hosts: [
				hostOf(ECHO, {
					steps: {
						first: () => {
							setTimeout(() => process.emit("SIGINT"), 20);
							return new Promise<never>(() => {});
						},
					},
				}),
			],
		});
		expect(quiet.code).toBe(130);
		expect(quiet.err).toBe(`concert ${json(quiet).id}`);
	});

	test("ls with no concerts says so on stderr with what to do, and under --json prints [] and nothing on stderr", async () => {
		const w = await world();
		expect(await w.call(["ls"])).toEqual({
			code: 0,
			out: "",
			err: "no concerts\nPerform one with 'maestro perform <pack>.<composition>'",
		});
		expect(await w.call(["ls", "--status", "failed"])).toEqual({
			code: 0,
			out: "",
			err: "no concerts match\nDrop a filter, or run 'maestro ls --all' for all",
		});
		expect(await w.call(["ls", "--json"])).toEqual({
			code: 0,
			out: "[]",
			err: "",
		});
	});

	test("artifact ls with no artifacts says so on stderr with what to do, and under --json prints [] and nothing on stderr", async () => {
		const w = await world();
		const id = idOf(await w.call(["perform", ...GREET]));
		expect(await w.call(["artifact", "ls", id])).toEqual({
			code: 0,
			out: "",
			err: `no artifacts in concert ${shortOf(id)}\nIts instances wrote no files; 'maestro ls ${shortOf(id)}' shows what ran`,
		});
		expect(await w.call(["artifact", "ls", id, "--json"])).toEqual({
			code: 0,
			out: "[]",
			err: "",
		});
	});

	test("artifact ls prints the artifacts directory once, then each path relative to it, as ~ on a terminal and whole when piped, and --json keeps absolute paths", async () => {
		const w = await world();
		await Bun.write(join(w.root, "write.ts"), WRITE);
		const file = join(w.root, "write.json");
		await Bun.write(file, JSON.stringify(writeIr(codeHashOf(WRITE))));
		const id = idOf(await w.call(["perform", file]));
		await w.call(["wait", id]);
		const area = join(w.root, "data/maestro/concerts", id, "artifacts");
		const absolute = json(await w.call(["artifact", "ls", id, "--json"]));
		const relative = absolute.map((a: { path: string }) =>
			a.path.slice(area.length + 1),
		);
		expect(relative).toEqual([
			expect.stringMatching(/^[^/]+\/a\.txt$/),
			expect.stringMatching(/^[^/]+\/b\.txt$/),
		]);
		expect(absolute.map((a: { path: string }) => a.path)).toEqual(
			relative.map((r: string) => join(area, r)),
		);

		const piped = await w.call(["artifact", "ls", id]);
		const [head, columns, ...rows] = piped.out.split("\n");
		expect(head).toBe(`artifacts  ${area}`);
		expect(columns).toBe("instance  port    stale  path");
		expect(rows.map((r) => r.split(/\s+/).at(-1))).toEqual(relative);

		const env = { HOME: w.root };
		const wide = await w.call(["artifact", "ls", id], {
			terminal: () => ({ columns: 120, rows: 24 }),
			env,
		});
		expect(wide.out).toContain(`${ESC}[2martifacts${ESC}[22m  `);
		const wideLines = stripVTControlCharacters(wide.out).split("\n");
		expect(wideLines[0]).toBe(
			`artifacts  ~/data/maestro/concerts/${id}/artifacts`,
		);
		expect(wideLines.some((l) => l.startsWith("Full paths"))).toBe(false);
	});

	test("artifact ls on a terminal cuts a long path alone, keeping the header whole, and adds the full-paths hint", async () => {
		const w = await world();
		const long = WRITE.replaceAll("a.txt", `${"a".repeat(60)}.txt`).replaceAll(
			"b.txt",
			`${"b".repeat(60)}.txt`,
		);
		await Bun.write(join(w.root, "write.ts"), long);
		const file = join(w.root, "write.json");
		await Bun.write(file, JSON.stringify(writeIr(codeHashOf(long))));
		const id = idOf(await w.call(["perform", file]));
		await w.call(["wait", id]);
		const shown = await w.call(["artifact", "ls", id], {
			terminal: () => ({ columns: 81, rows: 24 }),
			env: { HOME: w.root },
		});
		const lines = stripVTControlCharacters(shown.out).split("\n");
		expect(lines[0]).toBe(`artifacts  ~/data/maestro/concerts/${id}/artifacts`);
		expect(lines[1]).toMatch(/^instance +port +stale +path$/);
		for (const l of lines.slice(2, 4)) {
			expect(l).toEndWith("…");
			expect(Bun.stringWidth(l)).toBe(81);
		}
		expect(lines.at(-1)).toBe(
			`Full paths: maestro artifact ls ${shortOf(id)} --json`,
		);
	});

	test("perform leaves the follow hint out when stderr is piped and under --json", async () => {
		const w = await world();
		const stderrTerminal = () => ({ columns: 80 });
		expect((await w.call(["perform", ...GREET])).err).not.toContain(
			"Follow it",
		);
		expect(
			(await w.call(["perform", ...GREET, "--json"], { stderrTerminal })).err,
		).not.toContain("Follow it");
	});

	describe("paging", () => {
		const terminal = () => ({ columns: 1000, rows: 24 });
		const env = { TERM: "xterm" };
		/** A pager that keeps what it is given, and the command and `LESS` it was started with, and exits with `code`. */
		const fakePager = (code = 0) => {
			const seen = {
				started: [] as string[],
				less: [] as string[],
				text: "",
				closed: 0,
			};
			const startPager = (
				command: string,
				pagerEnv: Readonly<Record<string, string>>,
			) => {
				seen.started.push(command);
				seen.less.push(pagerEnv.LESS ?? "");
				return {
					write: (bytes: Uint8Array) => {
						seen.text += new TextDecoder().decode(bytes);
					},
					close: async () => {
						seen.closed++;
						return code;
					},
				};
			};
			return { seen, startPager };
		};

		test("a finished document goes whole to the pager, `less -FRX` by default and `PAGER` as a shell command, with LESS set only when unset", async () => {
			const w = await world();
			const piped = await w.call(["repertoire"]);
			const a = fakePager();
			const out = await w.call(["repertoire", "--no-color"], {
				terminal,
				env,
				...a,
			});
			expect(out).toEqual({ code: 0, out: "", err: "" });
			expect(a.seen.text.trimEnd()).toBe(piped.out);
			expect(a.seen).toMatchObject({
				started: ["less -FRX"],
				less: ["FRX"],
				closed: 1,
			});
			const b = fakePager();
			await w.call(["repertoire", "--no-color"], {
				terminal,
				...b,
				env: { ...env, PAGER: "cat | bat -p", LESS: "-i" },
			});
			expect(b.seen).toMatchObject({ started: ["cat | bat -p"], less: ["-i"] });
			const help = fakePager();
			await w.call(["--help"], { terminal, env, ...help });
			expect(help.seen.text).toContain("Commands:");
		});

		test("nothing pages off a terminal, under --json, for a streaming command, for PAGER empty or cat, for TERM unset or dumb, or for a command that prints nothing", async () => {
			const w = await world();
			const a = fakePager();
			await w.call(["repertoire"], { env, ...a });
			await w.call(["repertoire", "--json"], { terminal, env, ...a });
			await w.call(["perform", ...GREET], { terminal, env, ...a });
			const offs: Record<string, string>[] = [
				{ PAGER: "" },
				{ PAGER: "cat" },
				{ TERM: "dumb" },
				{ TERM: "" },
			];
			for (const over of offs)
				await w.call(["repertoire"], {
					terminal,
					...a,
					env: { ...env, ...over },
				});
			await w.call(["artifact", "ls", "0"], { terminal, env, ...a });
			expect(a.seen.started).toEqual([]);
		});

		test("only the commands that print a finished document and nothing after it page", async () => {
			const w = await world();
			const a = fakePager();
			const call = (args: string[]) => w.call(args, { terminal, env, ...a });
			await call(["compose", "demo.greet", "--out", join(w.root, "out.json")]);
			await call(["changeset", "apply", "0"]);
			await call(["agent", "ls"]);
			expect(a.seen.started).toEqual([]);
			await call(["compose", "demo.greet"]);
			await call(["agent", "show", "nothing"]);
			expect(a.seen.started.length).toBeGreaterThan(0);
		});

		test("output goes straight through when the pager cannot start", async () => {
			const w = await world();
			const piped = await w.call(["repertoire"]);
			const startPager = () => {
				throw new Error("ENOENT");
			};
			expect(
				await w.call(["repertoire", "--no-color"], {
					terminal,
					env,
					startPager,
				}),
			).toEqual(piped);
		});

		test("a pager the shell cannot find is named on stderr and the output is printed as it is", async () => {
			const w = await world();
			const piped = await w.call(["repertoire"]);
			const missing = fakePager(127);
			const out = await w.call(["repertoire", "--no-color"], {
				terminal,
				...missing,
				env: { ...env, PAGER: "nonexistent" },
			});
			expect(out.out).toBe(piped.out);
			expect(out.code).toBe(0);
			expect(out.err).toContain("PAGER=nonexistent: command not found");
			expect(out.err.trimEnd().split("\n").at(-1)).toContain("Set PAGER");
		});

		test("the real pager gets the output on its stdin and is waited for", async () => {
			const w = await world();
			const sink = join(w.root, "paged.txt");
			const piped = await w.call(["repertoire"]);
			const out = await w.call(["repertoire", "--no-color"], {
				terminal,
				startPager,
				env: { ...env, PAGER: `cat | dd status=none of=${sink}` },
			});
			expect(out.out).toBe("");
			expect(await Bun.file(sink).text()).toBe(`${piped.out}\n`);
		});
	});

	test("diffColored colors a patch's headers, hunk lines and hunks, and leaves its mail header and context", () => {
		const patch =
			"Subject: x\n---\n+not a hunk line\ndiff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n ctx\n--- gone\n-old\n+new\n\\ No newline\n";
		const lines = diffColored(patch).split("\n");
		expect(lines.map((l) => stripVTControlCharacters(l)).join("\n")).toBe(
			patch,
		);
		expect(lines.map((l) => l.startsWith(ESC))).toEqual([
			false,
			false,
			false,
			true,
			true,
			true,
			true,
			false,
			true,
			true,
			true,
			false,
			false,
		]);
		expect(lines[4]).toBe(`${ESC}[1m--- a/f${ESC}[22m`);
		expect(lines[6]).toBe(`${ESC}[36m@@ -1,2 +1,2 @@${ESC}[39m`);
		expect(lines[8]).toBe(`${ESC}[31m--- gone${ESC}[39m`);
		expect(lines[10]).toBe(`${ESC}[32m+new${ESC}[39m`);
	});

	test("diffColored colors a plain diff -u, and a mail start in a series ends the hunks before it", () => {
		const plain = diffColored("--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-x\n+y\n");
		expect(plain.split("\n").map((l) => l.startsWith(ESC))).toEqual([
			true,
			true,
			true,
			true,
			true,
			false,
		]);
		const from = `From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001`;
		const series = `${from}\nSubject: one\n---\ndiff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+y\n-- \n2.0\n\n${from}\nSubject: two\n\n- not removed\n+ not added\n---\n`;
		const second = diffColored(series).split("\n").slice(12);
		expect(second.some((l) => l.startsWith(ESC))).toBe(false);
	});
});
