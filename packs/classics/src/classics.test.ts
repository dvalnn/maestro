import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeset, fresh } from "@maestro/host-repo-sdk";
import {
	code,
	composition,
	List,
	literal,
	Markdown,
	type Ref,
	reject,
	type Settled,
	Struct,
	Text,
	use,
} from "@maestro/sdk";
import { buildIr } from "@maestro/testkit";
import { pack } from "../../../scripts/pack";
import { BASE, PROFILES, profilesOn, setup } from "../acceptance/setup";
import { briefOf, heldOf, tallyOf, toMarkdown } from "./code";
import { challenge, fix, tally } from "./moves";
import { EXAMPLE_REQUEST } from "./repair";
import { panel } from "./review";
import { builder, consolidator, lens } from "./seats";
import { Brief, Upheld } from "./types";

const MAESTRO = join(import.meta.dir, "../../../packages/cli/src/maestro.ts");
const RUNTIME = { harness: "pi", model: "none" };
const REVIEW = [
	"classics.panel_review",
	"--request",
	EXAMPLE_REQUEST,
	"--change",
	"c.x",
];
const BUILD = ["classics.build_then_repair", "--request", EXAMPLE_REQUEST];
let root: string;
let config: Record<string, unknown>;

/** Writes the workspace config, the built pack's and the toy target's, with `over` on top. */
const configure = (over: Record<string, unknown> = {}) =>
	Bun.write(
		join(root, ".maestro/config.yaml"),
		JSON.stringify({ ...config, ...over }),
	);

/** Writes the preset that runs each seated profile on the stub harness. */
const stubPreset = () =>
	Bun.write(
		join(root, ".maestro/presets/stub.yaml"),
		`profiles:\n${PROFILES.map((p) => `  ${p}: { runtime: !replace { harness: stub, model: none } }\n`).join("")}`,
	);

/** Runs the real `maestro` in the workspace, with its data and config homes inside it. */
async function maestro(args: string[], env: Record<string, string> = {}) {
	const run = Bun.spawn([process.execPath, MAESTRO, ...args], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			XDG_DATA_HOME: join(root, "data"),
			XDG_CONFIG_HOME: join(root, "config"),
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(run.stdout).text(),
		new Response(run.stderr).text(),
		run.exited,
	]);
	return { out, err, code };
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "classics-cli-"));
	const { target } = await setup("t1", root, RUNTIME);
	config = {
		packs: [await pack(join(import.meta.dir, ".."), join(root, "pack"))],
		target: {
			repo: target,
			base: BASE,
			checks: { test: { run: "sh test.sh", hint: "the tests" } },
		},
		profiles: profilesOn(RUNTIME),
	};
	await configure();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("panel_review", () => {
	test("composes to an exact count for three lenses", async () => {
		const { out, code } = await maestro(["compose", ...REVIEW, "--json"]);
		expect(code).toBe(0);
		const { plan } = JSON.parse(out);
		expect(plan.bounds).toMatchObject({
			instances: { exact: 19 },
			counts: { "repo.agent": { exact: 7 } },
		});
		const profileOf = (id: string) =>
			plan.ir.nodes.find((n: { id: string }) => n.id === id)?.config.profile;
		expect(profileOf("panel/lenses/lens")).toBe("classics/lens");
		expect(profileOf("panel/lenses/skeptic")).toBe("classics/skeptic");
	});

	test("--revs reviews target commits through one commits node; both or neither of --change and --revs is refused", async () => {
		const revs = ["--revs", "main..feature"];
		const { out, code } = await maestro([
			"compose",
			...REVIEW.slice(0, 3),
			...revs,
			"--json",
		]);
		expect(code).toBe(0);
		const { plan } = JSON.parse(out);
		expect(plan.bounds).toMatchObject({ instances: { exact: 20 } });
		expect(
			plan.ir.nodes.filter((n: { kind: string }) => n.kind === "repo.commits"),
		).toEqual([
			expect.objectContaining({
				id: "commits",
				config: { revs: "main..feature" },
			}),
		]);
		expect(await maestro(["compose", ...REVIEW, ...revs])).toMatchObject({
			code: 2,
			err: "error: classics.panel_review takes --change or --revs, not both\n  Drop one of --change and --revs\n",
		});
		// perform takes no example set, so it alone can give neither.
		expect(await maestro(["perform", ...REVIEW.slice(0, 3)])).toMatchObject({
			code: 2,
			err: "error: classics.panel_review needs --change or --revs\n  Pass --revs main..feature, or --change <concert id>.<node instance id>\n",
		});
	});

	test("names a misspelt config key and the param it meant", async () => {
		await configure({ classics: { panel_review: { lense: ["spec"] } } });
		const { err, code } = await maestro(["compose", ...REVIEW]).finally(() =>
			configure(),
		);
		expect(code).toBe(1);
		expect(err).toContain("error: config key 'classics.panel_review.lense'");
		expect(err).toContain("Did you mean 'classics.panel_review.lenses'?");
	});

	test("graphs the lens fan-out, the skeptic's guard and the collect into heldOf", async () => {
		const { out } = await maestro(["compose", ...REVIEW, "--graph"]);
		for (const line of [
			'subgraph gn2["lenses"]',
			'n2[["parMap<br/>correctness, spec, tests"]]',
			'n7["heldOf<br/>code"]',
			'n2 ==>|"collect"| n7',
			'n6(["skeptic<br/>repo.agent"])',
			'f5 -.->|"when value, else skip"| j6',
			'f4 -.->|"after, tolerates rejected"| j6',
			"j6 --> n6",
		])
			expect(out).toContain(`  ${line}\n`);
	});
});

type Ir = ReturnType<typeof buildIr>;

describe("panel", () => {
	const LENSES = { a: "task a", b: "task b" };

	/** The IR of a build that uses `panel` over `lenses` with `ports` and `params` on top of its builder's lane. */
	function panelIr(
		params: Partial<Parameters<typeof panel.build>[0]> = {},
		ports: (session: Ref<string>) => object = () => ({}),
	): Ir {
		const root = composition("probe", { examples: [{}] }, () => {
			const b = builder({ label: "b", task: "t", lane: fresh() });
			const spec = code(toMarkdown, {
				in: { text: "x" },
				out: { file: Markdown() },
			});
			return use(
				panel,
				{ change: b.out.lane, spec: spec.out.file, ...ports(b.out.session) },
				{ params: { lenses: LENSES, ...params } },
			);
		});
		return buildIr(root, {}, { heldOf, tallyOf, toMarkdown });
	}
	const ids = (ir: Ir) => ir.nodes.map((n) => n.id);
	const agents = (ir: Ir, tail: string) =>
		ir.nodes.filter((n) => n.id.endsWith(`/${tail}`));
	const relays = (ir: Ir, id: string) =>
		(
			ir.nodes.find((n) => n.id === id) as
				| { config: { relay?: { name: string }[] } }
				| undefined
		)?.config.relay?.map((r) => r.name) ?? [];
	const sessionInto = (ir: Ir, node: string) =>
		ir.edges.find(
			(e) => e.to.node === node && "port" in e.to && e.to.port === "session",
		)?.from;

	test("names narrows the lenses to those it lists", () => {
		const ir = panelIr({}, () => ({ names: ["b"] }));
		expect(ir.nodes.find((n) => n.id === "panel/lenses")).toMatchObject({
			items: ["b"],
		});
	});

	test("earlier relays upheld to every lens, and brief relays builder to every review seat", () => {
		const bare = panelIr();
		expect(relays(bare, "panel/lenses/lens")).toEqual([]);
		const ir = panelIr({}, () => ({
			earlier: literal([], List(Upheld)),
			brief: literal({ summary: "s", gaps: [] }, Brief),
		}));
		expect(relays(ir, "panel/lenses/lens")).toEqual(["upheld", "builder"]);
		expect(relays(ir, "panel/lenses/skeptic")).toEqual(["findings", "builder"]);
		expect(relays(ir, "panel/consolidator")).toEqual([
			"findings",
			"unreviewed",
			"builder",
		]);
	});

	test("skeptics: false seats no skeptic, and consolidate: false no consolidator", () => {
		expect(agents(panelIr(), "skeptic")).toHaveLength(1);
		expect(agents(panelIr({ skeptics: false }), "skeptic")).toEqual([]);
		const bare = panelIr({ consolidate: false }, (session) => ({ session }));
		expect(ids(bare)).not.toContain("panel/consolidator");
		expect(ids(bare).at(-1)).toBe("panel/upheld");
	});

	test("the tally carries the session given, else the consolidator's", () => {
		expect(
			sessionInto(
				panelIr({}, (session) => ({ session })),
				"panel/upheld",
			),
		).toEqual({ node: "b", port: "session" });
		expect(sessionInto(panelIr(), "panel/upheld")).toEqual({
			node: "panel/consolidator",
			port: "session",
		});
	});

	test("neither a session nor a consolidator is refused", () => {
		expect(() => panelIr({ consolidate: false })).toThrow(
			"classics.panel needs a session or consolidate",
		);
	});
});

describe("build_then_repair", () => {
	test("plans its repairs as a loop of 0 to maxRepairs steps, each agent on the bundle's builder profile", async () => {
		const { out } = await maestro(["compose", ...BUILD, "--plan"]);
		expect(out).toContain("repair_until_green/loop expands to 0 to 2");
		expect(out).toContain(
			"build_then_repair: up to 11 node instances, up to 3 repo.agent",
		);
		expect(out).toMatch(
			/\nagents:\n {2}node +seat +profile +harness +model +thinking\n {2}build +classics\/build_then_repair\/builder +classics\/builder +pi +none +-\n/,
		);
		expect(out).toMatch(
			/ {2}repair_until_green\/loop\/repair +classics\/repair_until_green\/builder +classics\/builder +pi +none +-\n/,
		);
	});

	test("performs on the stub harness under a --preset that sets the runtime of each seated profile by name", async () => {
		await stubPreset();
		const green = ["-c", 'target.checks=!replace {test: "true"}'];
		const { err, code } = await maestro([
			"perform",
			...BUILD,
			...green,
			"--preset",
			"stub",
		]);
		expect(code).toBe(0);
		expect(err).toMatch(/^concert +\S+ +ok( |$)/m);
	});

	test("gives the repair agent the checks configured for repair_until_green", async () => {
		await configure({
			classics: { repair_until_green: { checks: ["test"] } },
		});
		const { out, code } = await maestro(["compose", ...BUILD, "--json"]);
		await configure();
		expect(code).toBe(0);
		const { plan } = JSON.parse(out);
		const repair = plan.ir.nodes.find((n: { id: string }) =>
			n.id.endsWith("/loop/repair"),
		);
		expect(repair.config.checks).toEqual(["test"]);
	});

	describe("the fix param", () => {
		/** Performs a build under `checks` and `fix`, and lists each fix and check instance with its status. */
		async function ran(checks: Record<string, string>, fix: string) {
			await configure({
				classics: { repair_until_green: { fix } },
				target: {
					...(config.target as object),
					checks: Object.fromEntries(
						Object.entries(checks).map(([k, run]) => [k, { run, hint: k }]),
					),
				},
			});
			const { err } = await maestro([
				"perform",
				...BUILD,
				"--preset",
				"stub",
			]).finally(() => configure());
			const id = /^concert +(\S+)/m.exec(err)?.[1] ?? "";
			const { out } = await maestro(["ls", id]);
			return out
				.split("\n")
				.map((l) => l.split(/ +/))
				.filter(([name]) => /(fix|check)$/.test(name ?? ""))
				.map(([name, status]) => `${name?.split("/").pop()} ${status}`);
		}

		beforeAll(stubPreset);

		test.each([
			[
				"runs before the check and before each recheck",
				"fmt",
				[
					"fix ok",
					"check rejected",
					"refix ok",
					"recheck rejected",
					"refix ok",
					"recheck rejected",
				],
			],
			[
				"empty runs no fix",
				"",
				["check rejected", "recheck rejected", "recheck rejected"],
			],
		])("%s", async (_, fix, rows) => {
			expect(await ran({ test: "false", fmt: "true" }, fix)).toEqual(rows);
		});

		test("a failed fix is red and the check still runs", async () => {
			expect(await ran({ test: "true", fmt: "false" }, "fmt")).toEqual([
				"fix rejected",
				"check rejected",
				"refix rejected",
				"recheck rejected",
				"refix rejected",
				"recheck rejected",
			]);
		});
	});

	test("graphs the loop's bound and its next edge", async () => {
		const { out } = await maestro(["compose", ...BUILD, "--graph"]);
		for (const line of ['n3[["loop<br/>0 to 2"]]', 'n6 -.->|"next"| n3'])
			expect(out).toContain(`${line}\n`);
	});
});

test.each([
	[
		"builder",
		[
			"tdd",
			"good-tests",
			"codebase-design",
			"code-smells",
			"domain-modeling",
			"writing-for-agents",
		],
	],
	[
		"lens",
		["good-tests", "codebase-design", "code-smells", "writing-for-agents"],
	],
	["skeptic", ["good-tests", "codebase-design", "code-smells"]],
	["consolidator", ["good-tests", "codebase-design", "code-smells"]],
	["tester", ["tdd", "good-tests", "codebase-design"]],
	["scout", ["codebase-design"]],
	[
		"planner",
		[
			"codebase-design",
			"codebase-deepening",
			"design-it-twice",
			"domain-modeling",
			"writing-for-agents",
		],
	],
])("the %s attaches the skills %j from the pack", async (name, skills) => {
	const { out, err, code } = await maestro([
		"agent",
		"show",
		`classics/${name}`,
		"--json",
	]);
	expect(err).toBe("");
	expect(code).toBe(0);
	const listed = Object.keys(JSON.parse(out).sources).filter((k) =>
		/^skills\.\d+$/.test(k),
	);
	expect(listed).toHaveLength(skills.length);
	const file = JSON.parse(out).sources.skills.file;
	const named = readFileSync(file, "utf8").match(/^skills: \[(.*)\]/m)?.[1];
	expect(named?.split(", ")).toEqual(skills.map((s) => `classics/${s}`));
});

/** Writes `source` as `<name>.ts` in the workspace, beside the `node_modules` its imports resolve through, and returns its path. */
function compositionFile(name: string, source: string) {
	const modules = join(root, "node_modules");
	if (!existsSync(modules))
		symlinkSync(join(import.meta.dir, "../../../node_modules"), modules);
	const file = join(root, `${name}.ts`);
	writeFileSync(file, source);
	return file;
}

test("the scout seat carries the answers reply field and no outbox file", async () => {
	const file = compositionFile(
		"scouted",
		`import { scout } from "@maestro/classics";
import { fresh } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const scouted = composition("scouted", { examples: [{}] }, () =>
	scout({ task: "answer", lane: fresh() }),
);
`,
	);
	const { out, code } = await maestro(["compose", file, "--json"]);
	expect(code).toBe(0);
	const agent = JSON.parse(out).plan.ir.nodes.find(
		(n: { config?: { seat?: string } }) => n.config?.seat === "scout",
	);
	expect(Object.keys(agent.config.reply)).toEqual(["answers"]);
	expect(agent.config.out).toBeUndefined();
});

test("test_first pins the spec in a fresh tester lane, then builds in a lane extending it with the map relayed, both under the given checks", async () => {
	const file = compositionFile(
		"tested",
		`import { testFirst } from "@maestro/classics";
import { composition, Markdown, code, use } from "@maestro/sdk";
import { toMarkdown } from "@maestro/classics/code";

export * from "@maestro/classics/code";
export const tested = composition("tested", { examples: [{}] }, () => {
	const spec = code(toMarkdown, { in: { text: "spec" }, out: { file: Markdown() } }).out.file;
	return use(testFirst, { spec }, { params: { request: "build", checks: ["test"] } }).built;
});
`,
	);
	const { out, code } = await maestro(["compose", file, "--json"]);
	expect(code).toBe(0);
	const { edges, nodes } = JSON.parse(out).plan.ir;
	const node = (id: string) => nodes.find((n: { id: string }) => n.id === id);
	const into = (to: string, port: string) =>
		edges
			.filter(
				(e: { to: { node: string; port: string } }) =>
					e.to.node === to && e.to.port === port,
			)
			.map((e: { from: unknown }) => e.from);
	expect(node("test_first/tester").config.lane.mode).toBe("fresh");
	expect(node("test_first/tester").config.checks).toEqual(["test"]);
	expect(node("test_first/build").config.checks).toEqual(["test"]);
	expect(Object.keys(node("test_first/build").config.reply)).toEqual([
		"overrules",
	]);
	expect(into("test_first/tester", "spec")).toHaveLength(1);
	expect(into("test_first/build", "lane")).toEqual([
		{ node: "test_first/tester", port: "lane" },
	]);
	expect(into("test_first/build", "map")).toEqual([
		{ node: "test_first/tester", port: "map" },
	]);
});

describe("fix_until_clean", () => {
	const green = ["-c", 'target.checks=!replace {test: "true"}'];
	let file: string;
	beforeAll(() => {
		file = compositionFile(
			"cleaned",
			`import { fixUntilClean } from "@maestro/classics";
import { toMarkdown } from "@maestro/classics/code";
import { builder } from "@maestro/classics";
import { fresh } from "@maestro/host-repo-sdk";
import { code, composition, Markdown, use } from "@maestro/sdk";

export * from "@maestro/classics/code";
export const cleaned = composition("cleaned", { examples: [{}] }, () => {
	const spec = code(toMarkdown, { in: { text: "spec" }, out: { file: Markdown() } }).out.file;
	const built = builder({ label: "build", task: "build", lane: fresh() });
	return use(
		fixUntilClean,
		{ lane: built.out.lane, session: built.out.session, spec },
		{ params: { maxFixes: 3, lenses: { a: "task a", b: "task b" }, skeptics: false, consolidate: false } },
	);
});
`,
		);
	});

	test("loops while the panel's tally is not ok, up to maxFixes, each round gating then reviewing", async () => {
		const { out, code } = await maestro(["compose", file, "--json"]);
		expect(code).toBe(0);
		const { plan } = JSON.parse(out);
		const node = (id: string) =>
			plan.ir.nodes.find((n: { id: string }) => n.id === id);
		expect(node("fix_until_clean/fixes")).toMatchObject({
			kind: "loop",
			cardinality: { upTo: 3 },
			tolerate: "rejected",
			test: { port: { node: "fix_until_clean/fixes/fixes_not" } },
		});
	});

	/** The fix instances of a performed `cleaned`, with each lens of each panel round rejecting on `scripted` findings. */
	async function fixes(scripted: Record<string, unknown>) {
		await stubPreset();
		const outputs = mkdtempSync(join(root, "outputs-"));
		for (const [path, value] of Object.entries(scripted)) {
			mkdirSync(join(outputs, path, ".."), { recursive: true });
			writeFileSync(
				join(outputs, path),
				typeof value === "string" ? value : JSON.stringify(value),
			);
		}
		const { err, code } = await maestro(
			["perform", file, ...green, "--preset", "stub"],
			{ MAESTRO_STUB_OUTPUTS: outputs },
		);
		const id = /^concert +(\S+)/m.exec(err)?.[1] ?? "";
		const { out } = await maestro(["ls", id]);
		return {
			code,
			fixes: out.split("\n").filter((l) => /fixes\[\d+\]\/fix /.test(l)),
		};
	}

	test("performs one round when no finding is upheld", async () => {
		const ran = await fixes({});
		expect(ran.code).toBe(0);
		expect(ran.fixes).toEqual([]);
	});

	test("performs maxFixes fix rounds when every round upholds a finding", async () => {
		const lens = {
			"findings.json": [{ ...F1 }],
			verdict: "rejected F1",
		};
		const rounds = ["", "fixes/"].flatMap((p) =>
			Object.entries(lens).map(([f, v]) => [
				`fix_until_clean/${p}panel/lenses/lens/${f}`,
				v,
			]),
		);
		const ran = await fixes(Object.fromEntries(rounds));
		expect(ran.code).toBe(3);
		expect(ran.fixes).toHaveLength(3);
	});
});

test.each([
	["maxRepairs", [...BUILD, "--max-repairs", "0"]],
	["lenses", [...REVIEW, "--lenses", "spec", "--lenses", "spec"]],
])("an out-of-range %s is refused by its name", async (param, args) => {
	const { err, code } = await maestro(["compose", ...args]);
	expect(code).toBe(2);
	expect(err).toContain(`error: param '${param}'`);
});

const finding = (id: string, blocking: boolean) => ({
	id,
	where: "a.ts:1",
	issue: "breaks Reuse",
	cites: "Reuse",
	blocking,
});
const [F1, F2, F3] = [
	finding("F1", true),
	finding("F2", true),
	finding("F3", false),
];
const found = [F1, F2, F3];
const rulings = (...holds: string[]) =>
	found.map(({ id }) => ({ id, holds: holds.includes(id), why: `why ${id}` }));
const ok = <T>(value: T): Settled<T> => ({ outcome: "ok", value });
const idsOf = (held: { lens: string; id: string }[]) =>
	held.map((f) => `${f.lens}/${f.id}`);

test("briefOf gives the report's summary and gaps, no gaps when it left them out", () => {
	expect(
		briefOf({ report: { summary: "done", gaps: ["no test"] } }).brief,
	).toEqual({ summary: "done", gaps: ["no test"] });
	expect(briefOf({ report: { summary: "done" } }).brief).toEqual({
		summary: "done",
		gaps: [],
	});
});

describe("heldOf", () => {
	const held = (results: Parameters<typeof heldOf>[0]["results"]) =>
		heldOf({ results, names: ["correctness", "spec"] });

	test("holds every finding of a member without a skeptic, with no why", () => {
		const { held: kept } = held([ok({ findings: found })]);
		expect(idsOf(kept)).toEqual([
			"correctness/F1",
			"correctness/F2",
			"correctness/F3",
		]);
		expect(kept.every((f) => f.why === undefined)).toBe(true);
	});

	test("holds the findings its skeptic's rulings hold, each with that why", () => {
		const { held: kept } = held([
			ok({
				lens: { findings: found },
				skeptic: { rulings: rulings("F2", "F3") },
			}),
		]);
		expect(kept).toEqual([
			{ ...F2, lens: "correctness", why: "why F2" },
			{ ...F3, lens: "correctness", why: "why F3" },
		]);
	});

	test("takes a rejected member's value, skips a skipped one and lists one that delivered nothing as unreviewed", () => {
		const out = held([
			{ outcome: "rejected", reason: "F1 blocks", value: { findings: found } },
			{ outcome: "skipped" },
		]);
		expect(idsOf(out.held)).toHaveLength(3);
		expect(out.unreviewed).toEqual([]);
		expect(
			held([{ outcome: "skipped" }, { outcome: "failed", reason: "boom" }])
				.unreviewed,
		).toEqual([{ lens: "spec", reason: "boom" }]);
	});
});

describe("tallyOf", () => {
	const carried = { lane: "c.gate", session: "c.build" };
	const heldAll = found.map((f) => ({ ...f, lens: "correctness" }));
	const verdict = (...upholds: string[]) => ({ criteria: [], upholds });

	test("upholds the blocking held findings when there is no verdict, and rejects naming them", () => {
		expect<unknown>(tallyOf({ ...carried, held: heldAll })).toEqual(
			reject("2 upheld: correctness/F1, correctness/F2", {
				...carried,
				upheld: heldAll.slice(0, 2),
			}),
		);
		expect(tallyOf({ ...carried, held: [] })).toEqual({
			...carried,
			upheld: [],
		});
	});

	test("upholds the held findings a verdict names by lens and id", () => {
		const out = tallyOf({
			...carried,
			held: heldAll,
			verdict: [ok(verdict("correctness/F2", "spec/F1"))],
		});
		expect(out).toMatchObject({
			outcome: "rejected",
			outputs: { upheld: [{ ...F2, lens: "correctness" }] },
		});
	});

	test("tallies a consolidator clean when nothing is upheld, whether it approved or rejected", () => {
		expect(
			tallyOf({ ...carried, held: heldAll, verdict: [ok(verdict())] }),
		).toEqual({ ...carried, upheld: [] });
		expect(
			tallyOf({
				...carried,
				held: heldAll,
				verdict: [
					{ outcome: "rejected", reason: "C1 unmet", value: verdict() },
				],
			}),
		).toEqual({ ...carried, upheld: [] });
	});

	test("throws when the consolidator failed", () => {
		expect(() =>
			tallyOf({
				...carried,
				held: heldAll,
				verdict: [{ outcome: "failed", reason: "boom" }],
			}),
		).toThrow("boom");
	});
});

describe("moves", () => {
	const moved = composition("moved", { examples: [{}] }, () => {
		const found = lens({ label: "lens", task: "look", lane: fresh() });
		const patches = changeset(found.out.lane, { label: "patches" }).out
			.changeset;
		const attached = {
			patches: { artifact: patches, hint: "patches" },
			spec: { artifact: patches, hint: "spec" },
		};
		challenge(found, { change: found.out.lane, attached });
		const held = code(heldOf, {
			in: { results: [], names: [] },
			out: {
				held: List(Upheld),
				unreviewed: List(Struct({ lens: Text(), reason: Text() })),
			},
		});
		const ruling = consolidator({
			label: "ruling",
			task: "rule",
			lane: fresh(),
		});
		const upheld = tally({
			lane: found.out.lane,
			session: found.out.session,
			held: held.out.held,
			verdict: ruling.out.verdict,
		});
		return fix(upheld.out, patches).out.lane;
	});
	let ir: ReturnType<typeof buildIr>;
	beforeAll(() => {
		ir = buildIr(moved, {}, { heldOf, tallyOf });
	});
	const wired = (from: string, port: string, to: string, into = port) =>
		ir.edges.some(
			(e) =>
				e.kind === "data" &&
				e.from.node === from &&
				e.from.port === port &&
				e.to.node === to &&
				e.to.port === into,
		);

	test("challenge guards the skeptic on its lens's ok and relays the lens's findings", () => {
		expect(wired("lens", "ok", "lens_not", "value")).toBe(true);
		expect(wired("lens", "findings", "skeptic")).toBe(true);
	});

	test("tally settles over the held findings and the verdict, tolerating a rejected upstream", () => {
		expect(wired("heldOf", "held", "upheld")).toBe(true);
		expect(wired("allSettled", "value", "upheld", "verdict")).toBe(true);
		expect(
			ir.edges.some(
				(e) =>
					e.to.node === "upheld" &&
					e.kind === "control" &&
					e.tolerate === "rejected",
			),
		).toBe(true);
	});

	test("fix extends the tally's lane in its session and relays what it upheld", () => {
		const node = ir.nodes.find((n) => n.id === "fix");
		expect(node).toMatchObject({ config: { lane: { mode: "extend" } } });
		for (const port of ["lane", "session", "upheld"])
			expect(wired("upheld", port, "fix")).toBe(true);
	});
});
