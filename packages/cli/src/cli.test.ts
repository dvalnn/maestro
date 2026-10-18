import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { openRecord } from "@maestro/core/perform";
import { STDLIB_HASH } from "@maestro/sdk/loader";
import { fakeHost } from "@maestro/testkit";
import { cleanup, FIXTURES } from "./fixtures/packs";
import { ECHO, GREET, hostOf, idOf, json, world } from "./fixtures/world";
import { codeHashOf } from "./loader";

const GOLDEN = join(FIXTURES, "../../../ir/fixtures");
const HELLO = join(FIXTURES, "hello.ts");
const CLASH = join(FIXTURES, "clash.ts");
const CLASH_OUT = join(FIXTURES, "clash-out.ts");
const LOUD = join(FIXTURES, "loud.ts");

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

	test("config lists every value with the layer and the file and line it came from", async () => {
		const w = await world();
		const rows = json(await w.call(["cfg", ...GREET, "--json"])).values;
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
		expect((await w.call(["config", ...GREET])).out).toMatch(
			/^packs .*workspace .*config\.yaml:1$/m,
		);
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
				err: expect.stringMatching(/ok$/),
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

	test("prints each output on a line, an artifact as its path, and keys a stdlib node on this engine's stdlib", async () => {
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
			`file    ${a}`,
			`nested  {"files":["${b}"]}`,
			"n       2",
			"s       a b",
			'multi   "a\\nb"',
			'tab     "a\\tb"',
			'cr      "a\\rb"',
			'sep     "a\\u2028b"',
			"none    null",
		];
		expect(performed.out.split("\n")).toEqual(lines);
		const waited = await w.call(["wait", id]);
		expect(waited.out.split("\n")).toEqual(lines);
		expect(waited.err).toBe(`concert ${id} ok`);
		const record = openRecord(join(w.root, "data/maestro/record.db"));
		const [get] = record.find(id)?.ir.nodes ?? [];
		record.close();
		expect(get?.kind === "code" && get.worker.codeHash).toBe(STDLIB_HASH);
	});

	test.each([
		["ok", ECHO, 0, /ok$/, ["text  done"]],
		[
			"failed",
			{ outcome: "failed", reason: "flaky" },
			1,
			/failed at echo\/echo: flaky$/,
			[],
		],
		[
			"rejected",
			{ outcome: "rejected", reason: "not today", outputs: { text: "draft" } },
			3,
			/rejected at echo\/echo: not today$/,
			["text  draft"],
		],
	])(
		"a concert that settles %s prints only its outputs on stdout, its id and closing line on stderr, and exits %d",
		async (status, echo, code, report, outputs) => {
			const w = await world();
			const performed = await w.call(["p", ...GREET], {
				hosts: [hostOf(echo)],
			});
			expect(performed.code).toBe(code);
			const id = idOf(performed);
			expect(performed.err).toMatch(report);
			expect(performed.err.split("\n")[0]).toBe(`concert ${id}`);
			expect(performed.out === "" ? [] : performed.out.split("\n")).toEqual(
				outputs,
			);
			const [, closing = ""] = performed.err.split("\n");
			expect((await w.call(["wait", id])).err).toBe(closing);
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
			err: expect.stringMatching(/ok$/),
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

	test("--help prints a command's flags on stdout and exits 0", async () => {
		const w = await world();
		for (const args of [["--help"], ["p", "-h"]])
			expect(await w.call(args)).toMatchObject({
				code: 0,
				out: expect.stringContaining("Usage: maestro"),
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
			/ok\s+2\.1 KiB$/m,
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
		expect(listed.out).toContain(id);
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
			out: "text  done",
			err: `concert ${done} ok`,
		});
		expect(json(await w.call(["wait", done, "--json"]))).toMatchObject({
			status: "ok",
			outputs: { text: "done" },
		});
		expect(await w.call(["wait", broke])).toMatchObject({
			code: 1,
			out: "",
			err: `concert ${broke} failed at echo/echo: flaky`,
		});
		expect(await w.call(["wait", refused, "--timeout", "5s"])).toMatchObject({
			code: 3,
			out: "text  draft",
			err: `concert ${refused} rejected at echo/echo: no`,
		});
		expect(json(await w.call(["wait", refused, "--json"]))).toEqual({
			id: refused,
			status: "rejected",
			resultNode: "echo/echo",
			resultExpansion: "",
			reason: "no",
			outputs: { text: "draft" },
		});
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
});
