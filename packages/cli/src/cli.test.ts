import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Host } from "@maestro/core/host";
import { openRecord } from "@maestro/core/perform";
import { IR_VERSION } from "@maestro/ir";
import { shortId, shortIds, stateWord } from "@maestro/render-text/live";
import { SDK_VERSION, STDLIB_HASH } from "@maestro/sdk/loader";
import { fakeHost } from "@maestro/testkit";
import pkg from "../package.json";
import { cleanup, FIXTURES } from "./fixtures/packs";
import {
	closingOf,
	ECHO,
	GREET,
	hostOf,
	idOf,
	json,
	shortOf,
	world,
} from "./fixtures/world";
import { codeHashOf } from "./loader";
import { renderDiagnostic, renderWarning } from "./output";
import { olderHint } from "./records";

const GOLDEN = join(FIXTURES, "../../../ir/fixtures");
const HELLO = join(FIXTURES, "hello.ts");
const CLASH = join(FIXTURES, "clash.ts");
const CLASH_OUT = join(FIXTURES, "clash-out.ts");
const CLASH_NO = join(FIXTURES, "clash-no.ts");
const LOUD = join(FIXTURES, "loud.ts");
const ESC = "\u001b";

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

describe("compose and config", () => {
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
		expect(json(await w.call(["compose", ...GREET, "--json"]))).toMatchObject({
			ok: true,
			plan: { bounds: { instances: { exact: 4 } } },
		});
	});

	test("a composition that cannot be built exits 2 with its diagnostics, no location inside its bundle, or one document with --json", async () => {
		const w = await world();
		const file = join(FIXTURES, "twice.ts");
		const human = await w.call(["compose", file]);
		expect(human.code).toBe(2);
		expect(human.err).toMatch(/^error: /);
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
				code: 2,
				err: expect.stringContaining(
					"error: config key 'hello' is claimed by no installed host, pack or core\n  Remove 'hello' from the config, or install the pack or host that claims it. To configure a composition file, make it a pack",
				),
			});
		},
	);

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

	test("config names each preset layer by its own name", async () => {
		const w = await world();
		const presets = join(w.cwd, ".maestro/presets");
		await Bun.write(join(presets, "risky.yaml"), "concurrency: 4\n");
		await Bun.write(join(presets, "stub.yaml"), "dataRoot: data\n");
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
		expect(text).toMatch(/^dataRoot +preset stub +.*stub\.yaml:1$/m);
	});

	test("--out of a pack writes an IR that performs, and of a bare file writes its bundle beside it", async () => {
		const w = await world();
		const dir = join(w.root, "out");
		for (const target of [GREET, [HELLO]])
			expect(
				await w.call([
					"compose",
					...target,
					"--out",
					join(dir, `${target[0] === HELLO ? "hello" : "greet"}.json`),
				]),
			).toMatchObject({ code: 0, err: expect.stringContaining("wrote") });
		expect((await readdir(dir)).sort()).toEqual([
			"greet.json",
			"hello.bundle.js",
			"hello.json",
		]);
		for (const [name, hosts] of [
			["greet", [hostOf()]],
			["hello", []],
		] as const)
			expect(
				await w.call(["perform", join(dir, `${name}.json`)], { hosts }),
			).toMatchObject({
				code: 0,
				err: expect.stringMatching(/ {2}ok {2}\S+$/),
			});
	});
});

describe("perform", () => {
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

	test("prints each output on a line, an artifact as its absolute path when piped, and keys a stdlib node on this engine's stdlib", async () => {
		const w = await world();
		await Bun.write(join(w.root, "write.ts"), WRITE);
		const file = join(w.root, "write.json");
		await Bun.write(file, JSON.stringify(writeIr(codeHashOf(WRITE))));
		const performed = await w.call(["perform", file]);
		expect(performed.code).toBe(0);
		const id = idOf(performed);
		const { outputs } = json(await w.call(["wait", id, "--json"]));
		const area = join(w.root, "data/maestro/concerts", id, "artifacts");
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
				expect(plain.err + plain.out).not.toContain(ESC);
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
		expect(performed.code).toBe(2);
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
			"--flow without --graph",
			["compose", ...GREET, "--flow"],
			/^error: --flow draws the graph, and --graph is not set\n {2}Pass both: maestro compose <composition> --graph --flow$/,
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
			"prune with no selection",
			["prune"],
			/^error: prune needs concert ids, --before, --tour, --workspace, --status or --composition\n {2}Name concerts, or pick them with a filter from 'maestro prune --help'$/,
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
			["ls", "a", "b"],
			/^error: maestro ls takes at most one concert, got 2\nUsage: maestro ls \[<concert>\]\n/,
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
			["ls", "--config", "=4"],
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

	test.each(USAGE)(
		"%s exits 2 and says what to do",
		async (_what, args, message) => {
			const w = await world();
			const outcome = await w.call(args);
			expect(outcome.out).toBe("");
			expect(outcome.err).toMatch(message);
			expect(outcome.code).toBe(2);
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
			expect(outcome.code).toBe(2);
			const doc = json(outcome);
			expect(doc.ok).toBe(false);
			expect(doc.error ?? doc.diagnostics).toBeDefined();
		},
	);

	test("--help prints a command's flags on stdout and exits 0, -c and --no-color among every verb's", async () => {
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
		for (const verb of verbs) {
			const { out } = await w.call([verb, "--help"]);
			expect(out).toEndWith(
				"\n\nCommon flags: --preset, -c/--config, --color, --debug, -h/--help (see 'maestro --help')",
			);
			expect(out).not.toContain("--config <key=value>");
		}
		const { out: root } = await w.call(["--help"]);
		expect(root).toMatch(/^ {2}-c, --config <key=value> +\S/m);
		expect(root).toMatch(/^ {6}--color +.*--no-color turns it off/m);
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
				/^Build a composition[\s\S]*--graph +\S[^\n]*\n +--flow +\S[^\n]*\(experimental\)\n\nCommon flags: /,
			),
			err: "params not shown: pack 'demo' has no composition 'nope'",
		});
	});
});

describe("help and color", () => {
	const TERMINAL = () => ({ columns: 80, rows: 24 });
	const COMMON_LINE =
		"Common flags: --preset, -c/--config, --color, --debug, -h/--help (see 'maestro --help')";

	test("a command's help is its summary, usage, arguments, flags, examples and the common flags, in that order", async () => {
		const { out } = await (await world()).call(["artifact", "--help"]);
		const at = [
			"List a concert's artifacts",
			"Usage: maestro artifact",
			"Arguments:",
			"  <concert>   A concert, as 'maestro ls' lists it",
			"Flags:",
			"Examples:",
			"  # Read the review the consolidator wrote\n  maestro artifact show 7f3c2a consolidator review.md",
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
		expect(out).toContain("Common flags (every command):");
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
		expect((await w.call(["ls", "-c"])).err).toStartWith(
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
		expect((await w.call(["ls"])).out).toMatch(/\sdemo\.greet\s+failed\s/);
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

	test("ls --json gives an instance's wired inputs, and leaves the field out of a row that has none", async () => {
		const w = await world();
		const id = idOf(
			await w.call(["perform", join(GOLDEN, "fanout-fanin-loop.json")]),
		);
		const instances = json(await w.call(["ls", id, "--json"])).instances;
		const draft = instances.find(
			(i: { node: string }) => i.node === "topics/draft",
		);
		expect(draft.inputs).toEqual({ prompt: expect.any(String) });
		const group = instances.find((i: { node: string }) => i.node === "topics");
		expect(group).not.toHaveProperty("inputs");
	});

	test("ls shows the disk a concert holds: its directory and what its hosts report", async () => {
		const w = await world();
		const host = hostOf(ECHO, { usage: () => 2048 });
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		await Bun.write(
			join(w.env.XDG_DATA_HOME, "maestro/concerts", id, "artifacts/a.txt"),
			"x".repeat(100),
		);
		expect(
			json(await w.call(["ls", "--json"], { hosts: [host] }))[0].diskUse,
		).toBe(2148);
		expect((await w.call(["ls"], { hosts: [host] })).out).toMatch(
			/ok\s+\S+\s+-\s+2\.1 KiB$/m,
		);
	});

	test("a host that cannot measure a concert leaves ls and prune working, and ls says why", async () => {
		const w = await world();
		const host = hostOf(ECHO, {
			usage: () => Promise.reject(new Error("record '/x' is malformed")),
		});
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const listed = await w.call(["ls"], { hosts: [host] });
		expect(listed).toMatchObject({ code: 0 });
		expect(listed.out).toContain(shortOf(id));
		expect(listed.err).toBe(
			`warning: host 'fake' cannot measure concert ${id}: record '/x' is malformed`,
		);
		expect((await w.call(["ls", "--json"], { hosts: [host] })).err).toBe("");
		expect(
			await w.call(["prune", id, "--yes"], { hosts: [host] }),
		).toMatchObject({ code: 0 });
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
		});
	});

	test("spend: ls and ls <concert> show the agent and its tokens, ls the concert's total, and the --json documents the metrics", async () => {
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
		expect(json(spent).metrics).toEqual(metrics);
		const id = json(spent).id;
		const bare = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		expect(json(await w.call(["wait", id, "--json"])).metrics).toEqual(metrics);
		expect((await w.call(["wait", id])).err).toMatch(/ · 15\.5k tok$/m);
		expect((await w.call(["wait", bare])).err).not.toMatch(/ · [\d.]+k? tok$/m);
		const row = json(await w.call(["ls", "--json"])).find(
			(r: { id: string }) => r.id === id,
		);
		expect(row.metrics).toEqual(metrics);
		expect(row.elapsedMs).toBe(row.settledAt - row.startedAt);
		const single = json(await w.call(["ls", id, "--json"]));
		expect(single.metrics).toEqual(metrics);
		expect(single.elapsedMs).toBe(row.elapsedMs);
		const listed = (await w.call(["ls"])).out.split("\n");
		expect(listed[0]).toMatch(/status +time +tokens +disk$/);
		expect(listed.find((l) => l.startsWith(shortOf(id)))).toMatch(
			/ok +\S+ +15\.5k +/,
		);
		expect(listed.find((l) => l.startsWith(shortOf(bare)))).toMatch(
			/ok +\S+ +- +/,
		);
		expect((await w.call(["ls", id], { hosts: [host] })).out).toContain(
			"pi · claude-haiku-5.5 · medium  15.5k tok",
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
		const narrow = () => ({ columns: 40, rows: 24 });
		const full = `Full reports: maestro ls ${shortOf(id)} --json | jq .reports`;
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
		const doc = json(await w.call(["ls", id, "--json"], { hosts: [host] }));
		expect(doc.reports).toEqual({ "echo/echo": { summary: "s", notes } });
		expect(doc.instances[0]).not.toHaveProperty("notes");
		expect(
			json(await w.call(["ls", id, "--json"], { hosts: [hostOf()] })).reports,
		).toEqual({});
		expect((await w.call(["ls", "--help"], { hosts: [host] })).out).toContain(
			"\n\nReports\n  --json | jq .reports\n  summary  what it did\n\nExamples:",
		);
		const rows = json(await w.call(["ls", "--json"], { hosts: [host] }));
		expect(rows.map((r: { notes: object }) => r.notes)).toEqual([
			{},
			{ Obstacles: 1, Lessons: 1 },
		]);
		const listed = (await w.call(["ls"], { hosts: [host] })).out.split("\n");
		expect(listed.find((l) => l.startsWith(shortOf(id)))).toContain(" ok • ");
		expect(listed.find((l) => l.startsWith(shortOf(bare)))).not.toContain("•");
		expect(
			(await w.call(["ls"], { hosts: [host], terminal: narrow })).out,
		).toContain(stateWord("ok", true, "ok •"));
		const db = new Database(join(w.root, "data/maestro/record.db"));
		db.run("UPDATE instances SET stale = 1");
		db.close();
		expect(
			json(await w.call(["ls", id, "--json"], { hosts: [host] })).reports,
		).toEqual({});
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
				"INSERT INTO concerts SELECT ?, composition, pack, ir, pid, status, started_at, settled_at, result_node, result_expansion, reason, workspace, tour, title, module_dir, file, profile, config, params, encore_of, fingerprint, limits FROM concerts WHERE id = ?",
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
			err: `error: concert ${a} is not running, it settled ok\n  See 'maestro ls ${a}'`,
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

describe("prune", () => {
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
		).toMatchObject({ pruned: [x] });
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
