import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
import { renderDiagnostic } from "./output";

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
		expect(human.err).toMatch(/^SCOPE\.export: /);
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
					"CFG.unclaimed: config key 'hello' is claimed by no installed host, pack or core\n  Remove 'hello' from the config, or install the pack or host that claims it. To configure a composition file, make it a pack",
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
		expect(text).toMatch(/^packs .*workspace .*config\.yaml:1$/m);
		expect(text).toMatch(/^concurrency +3 +flag +-c concurrency=3$/m);
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
		["no command", [], /^no command given\nUsage: maestro/],
		[
			"an unknown command",
			["frobnicate"],
			/^unknown command 'frobnicate'\nPick one of the commands in 'maestro --help'$/,
		],
		["no composition", ["perform"], /^perform takes a composition first/],
		[
			"an unknown composition",
			["perform", "demo.nope"],
			/^pack 'demo' has no composition 'nope'\nName one of: echo, greet, ticket$/,
		],
		[
			"a mistyped composition",
			["rep", "demo.gret"],
			/^pack 'demo' has no composition 'gret'\nDid you mean 'greet'\?$/,
		],
		[
			"a mistyped pack",
			["perform", "dmeo.greet"],
			/^no pack 'dmeo' is installed\nDid you mean 'demo'\?$/,
		],
		[
			"an uninstalled pack",
			["perform", "other.greet"],
			/^no pack 'other' is installed/,
		],
		[
			"an unknown flag",
			["perform", ...GREET, "--nmae", "x"],
			/^Unknown option '--nmae'\nDid you mean --name\?$/,
		],
		[
			"a mistyped verb flag",
			["perform", ...GREET, "--titie", "x"],
			/^Unknown option '--titie'\nDid you mean --title\?$/,
		],
		[
			"an unknown flag with no near name",
			["perform", ...GREET, "--zzzzzz", "x"],
			/^Unknown option '--zzzzzz'\nFlags are perform's/,
		],
		[
			"a tour that is not a slug",
			["perform", ...GREET, "--tour", "Bad Slug"],
			/^--tour takes a slug of at most 64 characters, not 'Bad Slug'/,
		],
		[
			"a tour too long",
			["perform", ...GREET, "--tour", "a".repeat(65)],
			/^--tour takes a slug/,
		],
		[
			"a bad duration",
			["wait", "nope", "--timeout", "5x"],
			/^--timeout takes a positive whole number and one unit, not '5x'\nWrite it as 500ms, 90s, 15m, 12h or 7d$/,
		],
		[
			"an unknown concert",
			["wait", "nope"],
			/^no concert 'nope' in the record\nCheck the id with 'maestro ls'$/,
		],
		["kill without a concert", ["kill"], /^expected one concert, got 0/],
		[
			"watch without a concert",
			["watch"],
			/^expected one concert, got 0\nName the concert to watch$/,
		],
		[
			"watch of an unknown concert",
			["wt", "nope"],
			/^no concert 'nope' in the record\nCheck the id with 'maestro ls'$/,
		],
		[
			"prune with no selection",
			["prune"],
			/^prune needs concert ids, --before, --tour or --workspace\nName concerts, .*--tour <slug> or --workspace <name>$/,
		],
		[
			"prune with ids and --before",
			["prune", "a", "--before", "1d"],
			/^prune takes concert ids or filters, not both/,
		],
		[
			"a bad --before",
			["prune", "--before", "1x"],
			/^--before takes a positive whole number/,
		],
		[
			"tour with no concert",
			["tour", "slug"],
			/^tour takes a slug and at least one concert/,
		],
		[
			"tour with a bad slug",
			["tour", "BAD", "x"],
			/^the tour slug takes a slug/,
		],
		[
			"a status that is none",
			["ls", "--status", "bogus"],
			/^--status takes one of running, ok, failed, rejected, not 'bogus'/,
		],
		[
			"a limit of zero",
			["ls", "--limit", "0"],
			/^--limit takes a positive whole number/,
		],
		[
			"--resume with a composition",
			["perform", "--resume", "x", "demo.greet"],
			/^--resume takes no composition, --tour or --title/,
		],
		[
			"--resume of an unknown concert",
			["perform", "--resume", "nope"],
			/^no concert 'nope'/,
		],
		[
			"a -c without '='",
			["perform", ...GREET, "-c", "concurrency"],
			/^CFG\.flag: -c concurrency takes <key>=<value>\n {2}Write it as -c <key>=<value>/,
		],
		[
			"a -c with an empty key",
			["ls", "--config", "=4"],
			/^CFG\.flag: -c =4: '' is not a key path\n/,
		],
		[
			"a -c key nothing claims",
			["perform", ...GREET, "-c", "nope.x=1"],
			/^CFG\.unclaimed: -c nope\.x=1: config key 'nope' /,
		],
		[
			"a -c value off its key's schema",
			["compose", ...GREET, "-c", "concurrency=x"],
			/^CFG\.schema: -c concurrency=x: config 'concurrency' must be integer\n/,
		],
		[
			"param flags on an IR file",
			["compose", join(GOLDEN, "minimal.json"), "--name", "x"],
			/^Unknown option '--name'\nAn IR file is already built/,
		],
		[
			"a param whose flag is a command's",
			["perform", CLASH],
			/^param 'tour' of 'clash\.clash' takes --tour, which the command takes too\nRename/,
		],
		[
			"a param whose flag is one of compose's, for compose",
			["compose", CLASH_OUT],
			/^param 'out' of 'clash-out\.clash-out' takes --out, which the command takes too\nRename/,
		],
		[
			"a boolean param whose --no- flag negates a common flag",
			["perform", CLASH_NO],
			/^param 'noColor' of 'clash-no\.clash-no' takes --no-color, which the command takes too\nRename/,
		],
		[
			"a param whose flag is one of perform's, for compose",
			["compose", CLASH],
			/^param 'tour' of 'clash\.clash' takes --tour, which the command takes too\nRename/,
		],
		[
			"a composition file whose name is not a pack id",
			["compose", join(FIXTURES, "Shout.ts")],
			/^composition file \S+\/Shout\.ts is named 'Shout', which is not a pack id\nRename it/,
		],
		[
			"a composition file named as an installed pack",
			["perform", join(FIXTURES, "demo.ts")],
			/^composition file \S+\/demo\.ts is named 'demo', the id of the pack at \S+\nRename the file$/,
		],
		[
			"a composition file that declares no example input set",
			["compose", join(FIXTURES, "bare.ts")],
			/^CFG\.examples: composition 'bare' declares no example input set\n/,
		],
		[
			"a composition file that is not there",
			["compose", "missing.ts"],
			/^no such file: missing\.ts\nCheck the path$/,
		],
		[
			"an IR file that is not there",
			["perform", "missing.json"],
			/^no such file: missing\.json\nCheck the path$/,
		],
		[
			"a missing required param",
			["perform", "demo.ticket"],
			/^CFG\.required: param 'handle' \(--handle\)/,
		],
		[
			"a malformed typed param",
			["perform", "demo.ticket", "--handle", "nonsense"],
			/^HOST\.param: param 'handle' \(--handle\) of 'demo\.ticket': 'nonsense'/,
		],
	];

	test.each(USAGE)(
		"%s exits 2 and says what to do",
		async (_what, args, message) => {
			const w = await world();
			const outcome = await w.call(args);
			expect(outcome.out).toBe("");
			expect(outcome.err).toMatch(message);
			expect(outcome.code).toBe(2);
		},
	);

	test.each(USAGE.filter(([, args]) => args.length > 0))(
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
		for (const args of [["--help"], ["p", "-h"], ["wt", "-h"]])
			expect(await w.call(args)).toMatchObject({
				code: 0,
				out: expect.stringContaining("Usage: maestro"),
				err: "",
			});
		expect((await w.call(["--help"])).out).toMatch(/^ {2}watch +\(wt\) +\S/m);
		const verbs = [
			...(await w.call(["--help"])).out.matchAll(/^ {2}([a-z]+) /gm),
		].map(([, verb = ""]) => verb);
		expect(verbs).toContain("tour");
		for (const verb of verbs) {
			const { out } = await w.call([verb, "--help"]);
			expect(out).toMatch(/^ {2}-c, --config <key=value> +\S/m);
			expect(out).toMatch(/^ {6}--color +.*--no-color turns it off/m);
		}
	});

	test("--help given a composition adds its params after the flags, and not without one", async () => {
		const w = await world();
		const PARAMS =
			/\n\nParams\n {2}--name <text> +required\n {2}--loud <integer> +0$/;
		expect((await w.call(["compose", "demo.greet", "--help"])).out).toMatch(
			PARAMS,
		);
		expect((await w.call(["p", HELLO, "-h"])).out).toMatch(/\n\nParams\n/);
		expect((await w.call(["compose", "--help"])).out).not.toContain("Params");
		expect(await w.call(["compose", "demo.nope", "--help"])).toMatchObject({
			code: 0,
			out: expect.stringMatching(
				/^Usage: maestro compose[\s\S]*--graph +\S[^\n]*$/,
			),
			err: "params not shown: pack 'demo' has no composition 'nope'",
		});
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
		const b = await perform([], { MAESTRO_TOUR: "from-env" });
		const c = await perform(["--tour", "release-1"], {
			MAESTRO_TOUR: "from-env",
		});
		const rows = async (...flags: string[]) =>
			json(await w.call(["ls", "--json", ...flags])).map(
				(r: { id: string }) => r.id,
			);
		expect(await rows("--tour", "release-1")).toEqual([c, a]);
		expect(await rows("--tour", "from-env")).toEqual([b]);
		expect(
			json(await w.call(["ls", "--json", "--tour", "release-1"]))[1],
		).toMatchObject({
			title: "first try",
			workspace: "ws",
		});

		const moved = await w.call(["tour", "release-2", a, b]);
		expect(moved).toMatchObject({
			out: "",
			err: `release-2: ${a} ${b}`,
		});
		expect(await rows("--tour", "release-2")).toEqual([b, a]);
		expect(json(await w.call(["t", "--clear", a, "--json"]))).toEqual({
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
			err: "--composition takes <pack>.<composition>, not 'greet'\nWrite it as greet.hello",
		});
		expect((await w.call(["ls"])).out).toMatch(/\sdemo\.greet\s+failed\s/);
		expect(await rows("--limit", "1")).toEqual([broke]);
		const table = await w.call(["ls", broke]);
		expect(table.out).toMatch(/^echo\/echo\s+failed\s+flaky$/m);
		expect(json(await w.call(["ls", broke, "--json"]))).toMatchObject({
			id: broke,
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

	test("an error on a terminal stderr colors the code of a diagnostic and dims the hint, off a terminal or with color off it is plain", async () => {
		const w = await world();
		const terminal = () => ({ columns: 80, rows: 24 });
		const code = `${ESC}[31mCFG.unclaimed${ESC}[39m`;
		const hint = (text: string) => `${ESC}[2m${text}${ESC}[22m`;
		const diagnosed = ["perform", ...GREET, "-c", "nope.x=1"];
		const bad = await w.call(diagnosed, { stderrTerminal: terminal });
		expect(bad.err).toStartWith(code);
		expect(bad.err).toContain(`\n  ${ESC}[2m`);
		const usage = await w.call(["ls", "--status", "bogus"], {
			stderrTerminal: terminal,
		});
		expect(usage.err).toBe(
			`--status takes one of running, ok, failed, rejected, not 'bogus'\n${hint("Pick one of those")}`,
		);
		const both = { terminal, stderrTerminal: terminal };
		expect((await w.call([], both)).err).not.toContain(ESC);
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
		).toBe(`${ESC}[33mwarning X.y${ESC}[39m: m\n  ${hint("h")}`);
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
			/ok\s+-\s+2\.1 KiB$/m,
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
			`host 'fake' cannot measure concert ${id}: record '/x' is malformed`,
		);
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
		expect(await w.call(["w", done])).toMatchObject({
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
		expect((await w.call(["wait", id])).err).toMatch(/ · 15\.5k tokens$/m);
		expect((await w.call(["wait", bare])).err).not.toContain("tokens");
		expect(
			json(await w.call(["ls", "--json"])).find(
				(r: { id: string }) => r.id === id,
			).metrics,
		).toEqual(metrics);
		const listed = (await w.call(["ls"])).out.split("\n");
		expect(listed[0]).toMatch(/status +tokens +disk$/);
		expect(listed.find((l) => l.startsWith(shortOf(id)))).toMatch(
			/ok +15\.5k +/,
		);
		expect(listed.find((l) => l.startsWith(shortOf(bare)))).toMatch(/ok +- +/);
		expect((await w.call(["ls", id], { hosts: [host] })).out).toContain(
			"pi · claude-haiku-5.5 · medium  15.5k tok",
		);
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
			`'0' starts 7 concerts: ${ids.slice(0, 5).map(shortOf).join(", ")} and 2 more`,
			"Give more characters of the id",
		]);
		// Copies of a performed concert under ids whose short ids share all but their last letter.
		const twins = [
			"01a10000-0000-7000-8000-000000000001",
			"01a10000-0000-7000-8000-000000000002",
		];
		const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
		for (const twin of twins)
			db.run(
				"INSERT INTO concerts SELECT ?, composition, pack, ir, pid, status, started_at, settled_at, result_node, result_expansion, reason, workspace, tour, title, module_dir, file, profile, config FROM concerts WHERE id = ?",
				[twin, ids[0] ?? ""],
			);
		db.close();
		expect((await w.call(["wait", "zzzz"])).err.split("\n")).toEqual([
			`'zzzz' starts 2 concerts: ${twins.map(shortId).join(", ")}`,
			"Give more characters of the id",
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
			err: `'${ambiguous}' starts 2 concerts: ${shortOf(a)}, ${shortOf(b)}\nGive more characters of the id`,
		});
		expect(await w.call(["wait", "nope"])).toMatchObject({
			code: 2,
			err: "no concert 'nope' in the record\nCheck the id with 'maestro ls'",
		});
		const prefix = a.slice(0, shared + 1);
		expect(json(await w.call(["wait", prefix, "--json"])).id).toBe(a);
		expect(json(await w.call(["ls", prefix, "--json"])).id).toBe(a);
		expect(json(await w.call(["wait", shortOf(a), "--json"])).id).toBe(a);
		expect(json(await w.call(["ls", shortId(a), "--json"])).id).toBe(a);
		expect((await w.call(["watch", prefix])).code).toBe(0);
		expect(await w.call(["kill", prefix])).toMatchObject({
			err: `concert ${a} is not running, it settled ok\nSee 'maestro ls ${a}'`,
		});
		expect(await w.call(["perform", "--resume", prefix])).toMatchObject({
			err: expect.stringContaining(`concert ${a} finished ok`),
		});
		expect(await w.call(["tour", "t1", prefix, a])).toMatchObject({
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
			err: "prune asks before it deletes, and there is no terminal to ask on\nPass --yes",
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
			err: "prune asks before it deletes, and there is no terminal to ask on\nPass --yes",
		});
		expect(
			json(await w.call(["prune", "--tour", "t1", "--yes", "--json"])),
		).toMatchObject({ pruned: [x] });
		expect(await ids(w)).toEqual([y]);
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
