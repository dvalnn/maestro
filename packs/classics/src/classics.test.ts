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
import { basename, join } from "node:path";
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
import { BASE, git, PROFILES, profilesOn, setup } from "../acceptance/setup";
import {
	briefOf,
	heldAcross,
	heldOf,
	resultOf,
	specOf,
	tallyOf,
	tieredOf,
	toMarkdown,
} from "./code";
import { challenge, fix, tally } from "./moves";
import AGAIN from "./prompts/again.md" with { type: "text" };
import { EXAMPLE_REQUEST } from "./repair";
import { panel } from "./review";
import { builder, consolidator, lens } from "./seats";
import { buildChange } from "./test-first";
import { SECTIONS, tieredReview } from "./tiered-review";
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
let target: string;
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
	({ target } = await setup("t1", root, RUNTIME));
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
			instances: { exact: 18 },
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
		expect(plan.bounds).toMatchObject({ instances: { exact: 19 } });
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
	const pick = () => ({ names: ["a"] });

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
		return buildIr(root, {}, { heldOf, pick, tallyOf, toMarkdown });
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

	test("names fed from a node's output bound the fan-out by the lenses it can name", () => {
		const ir = panelIr({}, () => ({
			names: code(pick, { in: {}, out: { names: List(Text()) } }).out.names,
		}));
		expect(ir.nodes.find((n) => n.id === "panel/lenses")).toMatchObject({
			cardinality: { upTo: 2 },
		});
	});

	test("earlier relays upheld to every lens and opens its task with again.md, and brief relays builder to every review seat", () => {
		const bare = panelIr();
		const table = (ir: Ir) =>
			JSON.stringify(
				ir.nodes.find((n) => n.id === "panel/lenses/lenses_lookup"),
			);
		const prompt = JSON.stringify(AGAIN).slice(1, -1);
		expect(relays(bare, "panel/lenses/lens")).toEqual([]);
		expect(table(bare)).not.toContain(prompt);
		const ir = panelIr({}, () => ({
			earlier: literal([], List(Upheld)),
			brief: literal({ summary: "s", gaps: [] }, Brief),
		}));
		expect(relays(ir, "panel/lenses/lens")).toEqual(["upheld", "builder"]);
		expect(table(ir)).toContain(prompt);
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

	test("the consolidator is no verdict seat and writes no file: the tally renders the review", () => {
		const ir = panelIr();
		const node = ir.nodes.find((n) => n.id === "panel/consolidator");
		const lensed = ir.nodes.find((n) => n.id === "panel/lenses/lens");
		expect(lensed).toMatchObject({ config: { verdict: true } });
		expect(node).not.toMatchObject({ config: { verdict: true } });
		expect(Object.keys((node as { out: object }).out)).not.toContain("review");
		expect(ir.nodes.find((n) => n.id === "panel/upheld")?.out).toHaveProperty(
			"review",
		);
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

	test("the tally takes delivered from the held findings, so a panel no lens delivered for rejects", () => {
		const ir = panelIr();
		expect(
			ir.edges.some(
				(e) =>
					e.kind === "data" &&
					e.from.node === "panel/heldOf" &&
					e.from.port === "delivered" &&
					e.to.node === "panel/upheld" &&
					e.to.port === "delivered",
			),
		).toBe(true);
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
			"build_then_repair: up to 13 node instances, up to 3 repo.agent",
		);
		expect(out).toMatch(
			/\nagents:\n {2}node +seat +profile +harness +model +thinking\n {2}build\/build +classics\/build\/builder +classics\/builder +pi +none +-\n/,
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
		for (const line of ['n5[["loop<br/>0 to 2"]]', 'n8 -.->|"next"| n5'])
			expect(out).toContain(`${line}\n`);
	});
});

const TESTING = ["testing.md", "instructions.md"];

test.each([
	["builder", TESTING],
	["tester", TESTING],
	["lens", ["instructions.md"]],
	["skeptic", ["instructions.md"]],
	["consolidator", ["instructions.md"]],
	["scout", ["instructions.md"]],
	["planner", ["instructions.md"]],
])(
	"the %s lists the instruction files %j and attaches no guidance",
	async (name, files) => {
		const { out, err, code } = await maestro([
			"agent",
			"show",
			`classics/${name}`,
			"--json",
		]);
		expect(err).toBe("");
		expect(code).toBe(0);
		const shown = JSON.parse(out);
		expect(shown.attachments).toEqual({});
		expect(shown.instructions.map((f: string) => basename(f))).toEqual(files);
	},
);

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

test("a panel fed a lens name it has no task for delivers no review", async () => {
	await stubPreset();
	const file = compositionFile(
		"bogus_panel",
		`import { builder, panel } from "@maestro/classics";
import { fresh } from "@maestro/host-repo-sdk";
import { composition, List, Markdown, Text, code, use } from "@maestro/sdk";
import { toMarkdown } from "@maestro/classics/code";

export * from "@maestro/classics/code";
export const bogus = () => ({ names: ["bogus"] });
export const bogusPanel = composition("bogus_panel", { examples: [{}] }, () => {
	const b = builder({ label: "b", task: "t", lane: fresh() });
	const spec = code(toMarkdown, { in: { text: "x" }, out: { file: Markdown() } }).out.file;
	const names = code(bogus, { in: {}, out: { names: List(Text()) } }).out.names;
	return use(panel, { change: b.out.lane, spec, session: b.out.session, names }, { params: { consolidate: false } });
});
`,
	);
	const ran = await maestro(["perform", file, "--preset", "stub"]);
	const id = /^concert +(\S+)/m.exec(ran.err)?.[1] ?? "";
	expect(ran.code).toBe(3);
	expect((await maestro(["ls", id])).out).toContain(
		"no lens delivered a review",
	);
});

describe("fix_until_clean", () => {
	const green = ["-c", 'target.checks=!replace {test: "true"}'];
	let file: string;
	beforeAll(() => {
		file = compositionFile(
			"cleaned",
			`import { fixUntilClean } from "@maestro/classics";
import { briefOf, toMarkdown } from "@maestro/classics/code";
import { builder } from "@maestro/classics";
import { fresh } from "@maestro/host-repo-sdk";
import { code, composition, Markdown, use } from "@maestro/sdk";
import { Brief } from "@maestro/classics";

export * from "@maestro/classics/code";
export const cleaned = composition("cleaned", { examples: [{}] }, () => {
	const spec = code(toMarkdown, { in: { text: "spec" }, out: { file: Markdown() } }).out.file;
	const built = builder({ label: "build", task: "build", lane: fresh() });
	const { brief } = code(briefOf, { in: { report: built.out.report }, out: { brief: Brief } }).out;
	return use(
		fixUntilClean,
		{ lane: built.out.lane, session: built.out.session, spec, brief },
		{ params: { maxFixes: 3 } },
	);
});
`,
		);
	});

	test("loops while the review's tally is not ok, up to maxFixes, each round gating then reviewing", async () => {
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

	test("the step's lenses relay the state's upheld, and the init's relay none of it", async () => {
		const { out } = await maestro(["compose", file, "--json"]);
		const { nodes, edges } = JSON.parse(out).plan.ir;
		const lens = (round: string) =>
			nodes
				.find(
					(n: { id: string }) =>
						n.id === `fix_until_clean/${round}tiered_review/lens/lens`,
				)
				?.config.relay?.map((r: { name: string }) => r.name);
		expect(lens("")).toEqual(["builder"]);
		expect(lens("fixes/")).toEqual(["upheld", "builder"]);
		expect(
			edges.filter(
				(e: { to: { node: string; port?: string } }) =>
					e.to.node === "fix_until_clean/fixes/tiered_review/lens/lens" &&
					e.to.port === "upheld",
			),
		).toMatchObject([
			{ from: { node: "fix_until_clean/fixes", port: "upheld" } },
		]);
	});

	/** The fix instances of a performed `cleaned`, with each round's lens rejecting on `scripted` findings. */
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
			"lens/lens/findings.json": [{ ...F1 }],
			"lens/lens/verdict": "rejected F1",
			"consolidator/verdict.json": { criteria: [], upholds: ["lens/F1"] },
		};
		const rounds = ["", "fixes/"].flatMap((p) =>
			Object.entries(lens).map(([f, v]) => [
				`fix_until_clean/${p}tiered_review/${f}`,
				v,
			]),
		);
		const ran = await fixes(Object.fromEntries(rounds));
		expect(ran.code).toBe(3);
		expect(ran.fixes).toHaveLength(3);
	});
});

describe("build_then_review", () => {
	const green = ["-c", 'target.checks=!replace {test: "true"}'];

	test.each([
		["untested", []],
		["tested", ["-c", "classics.build.testFirst=true"]],
	])(
		"performs %s on the stub harness, settles ok and leaves a changeset",
		async (_, flags) => {
			await stubPreset();
			const { err, code } = await maestro([
				"perform",
				"classics.build_then_review",
				"--request",
				EXAMPLE_REQUEST,
				...flags,
				...green,
				"--preset",
				"stub",
			]);
			expect(code).toBe(0);
			expect(err).toMatch(/^concert +\S+ +ok( |$)/m);
			const id = /^concert +(\S+)/m.exec(err)?.[1] ?? "";
			const { out } = await maestro(["ls", id]);
			for (const row of ["build/spec", "result", "outcome"])
				expect(out).toMatch(new RegExp(`^${row} +ok`, "m"));
		},
	);

	test("rejects at the fix cap, still leaving the changeset", async () => {
		await stubPreset();
		const outputs = mkdtempSync(join(root, "outputs-"));
		const script = (path: string, value: unknown) => {
			const file = join(outputs, path);
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(
				file,
				typeof value === "string" ? value : JSON.stringify(value),
			);
		};
		for (const round of ["", "fixes/"]) {
			const review = `fix_until_clean/${round}tiered_review`;
			script(`${review}/lens/lens/findings.json`, [F1]);
			script(`${review}/lens/lens/verdict`, "rejected F1");
			script(`${review}/consolidator/verdict.json`, {
				criteria: [],
				upholds: ["lens/F1"],
			});
		}
		const { err, code } = await maestro(
			[
				"perform",
				"classics.build_then_review",
				"--request",
				EXAMPLE_REQUEST,
				...green,
				"--preset",
				"stub",
			],
			{ MAESTRO_STUB_OUTPUTS: outputs },
		);
		expect(code).toBe(3);
		const id = /^concert +(\S+)/m.exec(err)?.[1] ?? "";
		const { out } = await maestro(["ls", id]);
		expect(out).toMatch(/^result +ok/m);
		expect(out).toMatch(/^outcome +rejected/m);
	});
});

describe("build_then_review when no lens delivers", () => {
	test("rejects at the fix cap with the reason, though nothing is upheld", async () => {
		await stubPreset();
		const outputs = mkdtempSync(join(root, "outputs-"));
		for (const round of ["", "fixes/"]) {
			const verdict = join(
				outputs,
				`fix_until_clean/${round}tiered_review/lens/lens/verdict`,
			);
			mkdirSync(join(verdict, ".."), { recursive: true });
			writeFileSync(verdict, "garbage");
		}
		const { err, code } = await maestro(
			[
				"perform",
				"classics.build_then_review",
				"--request",
				EXAMPLE_REQUEST,
				"-c",
				'target.checks=!replace {test: "true"}',
				"--preset",
				"stub",
			],
			{ MAESTRO_STUB_OUTPUTS: outputs },
		);
		expect(code).toBe(3);
		const id = /^concert +(\S+)/m.exec(err)?.[1] ?? "";
		const { out } = await maestro(["ls", id]);
		expect(out).toMatch(/^outcome +rejected/m);
		expect(out).toContain("no lens delivered a review");
	});
});

describe("build_then_review's build and review config", () => {
	const REVIEWED = [
		"classics.build_then_review",
		"--request",
		EXAMPLE_REQUEST,
		"--json",
	];
	const composed = async (...args: string[]) => {
		const { out, code } = await maestro(["compose", ...REVIEWED, ...args]);
		expect(code).toBe(0);
		const { plan, agents } = JSON.parse(out);
		return {
			ir: plan.ir,
			profiles: new Set<string>(
				agents.map((a: { profile: string }) => a.profile),
			),
		};
	};

	test("seats the builder, the four lenses and the consolidator, and a tester under classics.build.testFirst, whose spec the lenses read", async () => {
		const lenses = new Set([
			"classics/lens",
			"classics/deep-lens",
			"classics/top-lens",
			"classics/cross-lens",
		]);
		const plain = await composed();
		expect(plain.profiles).toEqual(
			new Set(["classics/builder", "classics/consolidator", ...lenses]),
		);
		const tested = await composed("-c", "classics.build.testFirst=true");
		expect(tested.profiles).toEqual(
			new Set([...plain.profiles, "classics/tester"]),
		);
		const specs = tested.ir.edges.filter(
			(e: { to: { node: string; port?: string } }) =>
				/tiered_review\/[^/]+\/lens$/.test(e.to.node) && e.to.port === "spec",
		);
		expect(specs.length).toBeGreaterThan(0);
		for (const e of specs)
			expect(e.from).toEqual({ node: "build/spec", port: "file" });
	});

	test.each([
		["classics.fix_until_clean.lenses=[a]", "lenses", true],
		["classics.build.testFirst=maybe", "testFirst", false],
	])("refuses -c %s", async (flag, mention, unclaimed) => {
		const { out, code } = await maestro(["compose", ...REVIEWED, "-c", flag]);
		expect(code).toBe(2);
		expect(out).toContain(mention);
		if (unclaimed) expect(out).toContain("CFG.unclaimed");
	});

	test.each(["--tested", "--max-repairs"])(
		"refuses %s as unknown",
		async (flag) => {
			const { out, code } = await maestro(["compose", ...REVIEWED, flag, "1"]);
			expect(code).toBe(2);
			expect(out).toContain(`unknown flag ${flag}`);
		},
	);
});

describe("build_then_repair's build", () => {
	test("under classics.build.testFirst, a tester whose lane the builder extends, and a repair that reads build's spec", async () => {
		const { out, code } = await maestro([
			"compose",
			...BUILD,
			"-c",
			"classics.build.testFirst=true",
			"--json",
		]);
		expect(code).toBe(0);
		const { edges } = JSON.parse(out).plan.ir;
		const into = (node: string, port: string) =>
			edges
				.filter(
					(e: { to: { node: string; port?: string } }) =>
						e.to.node === node && e.to.port === port,
				)
				.map((e: { from: unknown }) => e.from);
		expect(into("build/test_first/build", "lane")).toEqual([
			{ node: "build/test_first/tester", port: "lane" },
		]);
		expect(into("repair_until_green/loop/repair", "spec")).toEqual([
			{ node: "build/spec", port: "file" },
		]);
	});
});

test("a -c key under a composition the root does not use is refused", async () => {
	const { err, code } = await maestro([
		"compose",
		...BUILD,
		"-c",
		"classics.panel.skeptics=false",
	]);
	expect(code).toBe(2);
	expect(err).toContain(
		"config key 'classics.panel' reaches no composition of this concert (from -c classics.panel.skeptics)",
	);
});

test.each([
	["maxRepairs", [...BUILD, "--max-repairs", "0"]],
	["lenses", [...REVIEW, "--lenses", "spec", "--lenses", "spec"]],
])("an out-of-range %s is refused by its name", async (param, args) => {
	const { err, code } = await maestro(["compose", ...args]);
	expect(code).toBe(2);
	expect(err).toContain(`error: param '${param}'`);
});

const finding = (id: string) => ({
	id,
	where: "a.ts:1",
	issue: "breaks Reuse",
	cites: "Reuse",
});
const [F1, F2, F3] = [finding("F1"), finding("F2"), finding("F3")];
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

describe("specOf", () => {
	const ctx = () => ({ scratch: mkdtempSync(join(root, "spec-")) }) as never;
	const specText = (inputs: Parameters<typeof specOf>[0]) =>
		readFileSync(specOf(inputs, ctx()).file, "utf8");

	test("writes the request, then the map and overrules as YAML only when given", () => {
		expect(specText({ request: "build it" })).toBe("build it\n");
		const text = specText({
			request: "build it",
			map: { pinned: [], deferred: [], untestable: [] },
			overrules: [{ test: "a.test.ts: t", why: "contradicts the spec" }],
		});
		expect(text).toBe(
			'build it\n\n## map\n\n```yaml\npinned: []\ndeferred: []\nuntestable: []\n```\n\n## overrules\n\n```yaml\n- test: "a.test.ts: t"\n  why: contradicts the spec\n```\n',
		);
	});

	test("renders a value as a relay does, a multi-line string as a block scalar", () => {
		expect(
			specText({
				request: "r",
				map: {
					pinned: [{ requirement: "r", file: "f", test: "1", misses: "a\nb" }],
					deferred: [],
					untestable: [],
				},
			}),
		).toBe(
			'r\n\n## map\n\n```yaml\npinned:\n  - requirement: r\n    file: f\n    test: "1"\n    misses: |-\n      a\n      b\ndeferred: []\nuntestable: []\n```\n',
		);
	});
});

test("resultOf rejects with the changeset and the upheld findings while any is upheld or no lens delivered", () => {
	const changeset = { path: "out", hash: "h" } as never;
	const upheld = [{ ...F1, lens: "correctness" }];
	expect<unknown>(resultOf({ changeset, upheld: [], delivered: 1 })).toEqual({
		changeset,
		upheld: [],
	});
	expect<unknown>(resultOf({ changeset, upheld, delivered: 1 })).toEqual(
		reject("1 upheld: correctness/F1", { changeset, upheld }),
	);
	expect<unknown>(resultOf({ changeset, upheld: [], delivered: 0 })).toEqual(
		reject("no lens delivered a review", { changeset, upheld: [] }),
	);
});

describe("heldOf", () => {
	const rejected = <V>(value: V) => ({
		outcome: "rejected" as const,
		reason: "F1 blocks",
		value,
	});
	const held = (results: Parameters<typeof heldOf>[0]["results"]) =>
		heldOf({ results, names: ["correctness", "spec"] });

	test("holds every finding of a member without a skeptic, with no why", () => {
		const { held: kept } = held([rejected({ findings: found })]);
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

	test("holds nothing of a member whose lens settled ok, takes a rejected member's value, delivers a skipped one with none held and lists one that delivered nothing as unreviewed", () => {
		const out = held([
			{ outcome: "rejected", reason: "F1 blocks", value: { findings: found } },
			{ outcome: "skipped" },
		]);
		expect(idsOf(out.held)).toHaveLength(3);
		expect(out.unreviewed).toEqual([]);
		expect(out.delivered).toBe(2);
		expect(held([ok({ findings: found })])).toMatchObject({
			held: [],
			delivered: 1,
		});
		expect(
			held([{ outcome: "failed", reason: "boom" }, { outcome: "skipped" }]),
		).toMatchObject({
			unreviewed: [{ lens: "correctness", reason: "boom" }],
			delivered: 1,
		});
	});
});

describe("tallyOf", () => {
	const carried = { lane: "c.gate", session: "c.build" };
	const heldAll = found.map((f) => ({ ...f, lens: "correctness" }));
	const verdict = (...upholds: string[]) => ({ criteria: [], upholds });
	const ctx = () => ({ scratch: mkdtempSync(join(root, "tally-")) }) as never;

	test("upholds every held finding when there is no verdict, and rejects naming them", () => {
		expect<unknown>(tallyOf({ ...carried, held: heldAll }, ctx())).toEqual(
			reject("3 upheld: correctness/F1, correctness/F2, correctness/F3", {
				...carried,
				upheld: heldAll,
			}),
		);
		expect(tallyOf({ ...carried, held: [] }, ctx())).toEqual({
			...carried,
			upheld: [],
		});
	});

	test("upholds the held findings a verdict names by lens and id", () => {
		const out = tallyOf(
			{
				...carried,
				held: heldAll,
				verdict: verdict("correctness/F2", "spec/F1"),
			},
			ctx(),
		);
		expect(out).toMatchObject({
			outcome: "rejected",
			outputs: { upheld: [{ ...F2, lens: "correctness" }] },
		});
	});

	test.each([
		["a finding that was held but not upheld", ["F1"], [], ["F1"]],
		["a made-up finding named in both lists", ["F9"], ["F9"], []],
	])(
		"does not hide a criterion shown only by %s",
		(_, shownBy, upholds, held) => {
			const out = tallyOf(
				{
					...carried,
					held: held.map((id) => ({ ...F1, id, lens: "correctness" })),
					verdict: {
						criteria: [
							{
								id: "C1",
								met: false,
								evidence: "unmet",
								shownBy: shownBy.map((id) => `correctness/${id}`),
							},
						],
						upholds: upholds.map((id) => `correctness/${id}`),
					},
				},
				ctx(),
			);
			expect(out).toMatchObject({
				outcome: "rejected",
				outputs: { upheld: [{ lens: "consolidator", id: "C1" }] },
			});
		},
	);

	test("tallies a consolidator clean when it upholds nothing and rules no criterion unmet", () => {
		expect(
			tallyOf({ ...carried, held: heldAll, verdict: verdict() }, ctx()),
		).toMatchObject({ ...carried, upheld: [] });
	});

	test("upholds each criterion a consolidator rules not met, and renders the review from the verdict", () => {
		const criteria = [
			{
				id: "C1",
				met: false,
				evidence: "--json prints nothing",
				shownBy: [],
			},
			{ id: "C2", met: true, evidence: "a.test.ts passes", shownBy: [] },
			{
				id: "C3",
				met: false,
				evidence: "F2 breaks it",
				shownBy: ["correctness/F2"],
			},
			{
				id: "C4",
				met: false,
				evidence: "exit code wrong",
				shownBy: ["correctness/F1"],
			},
		];
		const held = [{ ...F2, lens: "correctness", why: "reproduced" }];
		const out = tallyOf(
			{
				...carried,
				held,
				verdict: { criteria, upholds: ["correctness/F2"] },
			},
			ctx(),
		) as { outputs: { review: string } };
		expect(out.outputs).toMatchObject({
			upheld: [
				held[0],
				{
					lens: "consolidator",
					id: "C1",
					where: "spec C1",
					issue: "--json prints nothing",
					cites: "spec C1",
				},
				{
					lens: "consolidator",
					id: "C4",
					where: "spec C4",
					issue: "exit code wrong",
					cites: "spec C4",
				},
			],
		});
		expect(readFileSync(out.outputs.review, "utf8")).toBe(
			[
				"## Upheld",
				"",
				`- **correctness/F2** at \`${F2.where}\`: ${F2.issue}`,
				`  - Cites: ${F2.cites}`,
				"  - Why: reproduced",
				"- **consolidator/C1** at `spec C1`: --json prints nothing",
				"  - Cites: spec C1",
				"- **consolidator/C4** at `spec C4`: exit code wrong",
				"  - Cites: spec C4",
				"",
				"## Not met",
				"",
				"- **C3**: F2 breaks it (shown by correctness/F2)",
				"",
				"## Met",
				"",
				"- **C2**: a.test.ts passes",
				"",
			].join("\n"),
		);
	});

	test("renders no review without a verdict, and leaves an empty section out", () => {
		expect(tallyOf({ ...carried, held: [] }, ctx())).not.toHaveProperty(
			"review",
		);
		const out = tallyOf(
			{
				...carried,
				held: [],
				verdict: {
					criteria: [{ id: "C1", met: true, evidence: "ok", shownBy: [] }],
					upholds: [],
				},
			},
			ctx(),
		) as { review: string };
		expect(readFileSync(out.review, "utf8")).toBe("## Met\n\n- **C1**: ok\n");
	});

	test("rejects when no lens delivered, whatever the verdict, and not when one did", () => {
		const clean = { ...carried, held: [], verdict: verdict() };
		expect<unknown>(tallyOf({ ...clean, delivered: 0 }, ctx())).toEqual(
			reject("no lens delivered a review", {
				...carried,
				upheld: [],
				review: expect.any(String),
				delivered: 0,
			}),
		);
		expect(tallyOf({ ...clean, delivered: 1 }, ctx())).toMatchObject({
			upheld: [],
			delivered: 1,
		});
	});

	test("carries the brief given beside the tally, a rejection's included", () => {
		const brief = { summary: "built", gaps: ["g"] };
		expect<unknown>(tallyOf({ ...carried, held: [], brief }, ctx())).toEqual({
			...carried,
			upheld: [],
			brief,
		});
		expect(tallyOf({ ...carried, held: heldAll, brief }, ctx())).toMatchObject({
			outcome: "rejected",
			outputs: { brief },
		});
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
		expect(wired("ruling", "verdict", "upheld")).toBe(true);
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

describe("heldAcross", () => {
	const rejected = <V>(value: V) => ({
		outcome: "rejected" as const,
		reason: "F1 blocks",
		value,
	});
	const seats = (over: Partial<Parameters<typeof heldAcross>[0]> = {}) => ({
		lensResults: [],
		lensNames: [],
		deepLensResults: [],
		deepLensNames: [],
		topLensResults: [],
		topLensNames: [],
		crossLensResults: [],
		crossLensNames: [],
		...over,
	});

	test("joins the members of every seat in seat order and counts those that delivered a value or were skipped, none when every member failed", () => {
		const out = heldAcross(
			seats({
				lensResults: [rejected({ findings: [F1] })],
				lensNames: ["lens"],
				topLensResults: [rejected({ findings: [F2] })],
				topLensNames: ["top-lens"],
				crossLensResults: [{ outcome: "failed", reason: "boom" }],
				crossLensNames: ["cross-lens"],
				deepLensResults: [{ outcome: "skipped" }],
				deepLensNames: ["deep-lens"],
			}),
		);
		expect(idsOf(out.held)).toEqual(["lens/F1", "top-lens/F2"]);
		expect(out.unreviewed).toEqual([{ lens: "cross-lens", reason: "boom" }]);
		expect(out.delivered).toBe(3);
		expect(
			heldAcross(
				seats({
					lensResults: [{ outcome: "failed", reason: "boom" }],
					lensNames: ["lens"],
					topLensResults: [{ outcome: "failed", reason: "boom" }],
					topLensNames: ["top-lens"],
				}),
			).delivered,
		).toBe(0);
	});
});

describe("tieredOf", () => {
	const SIZES = { small: 200, medium: 800, large: 2000 };
	const IGNORE = ["**/*.lock"];
	const ctx = () =>
		({
			path: (ref: string) => ref,
			scratch: mkdtempSync(join(root, "tiered-")),
			log: () => {},
		}) as never;

	/** A `git format-patch` mail changing each path by `[added, removed]` lines, in one hunk and closed by git's signature; `[0, 0]` is a pure rename. */
	const mail = (files: Record<string, [number, number]>) =>
		`From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] x\n\n---\n${Object.entries(
			files,
		)
			.map(([path, [added, removed]]) =>
				added + removed === 0
					? `diff --git a/old/${path} b/${path}\nsimilarity index 100%\nrename from old/${path}\nrename to ${path}\n`
					: `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${removed} +1,${added} @@\n${"-x\n".repeat(removed)}${"+y\n".repeat(added)}`,
			)
			.join("")}-- \n2.43.0\n\n`;

	/** `tieredOf` over one patch of `files`, with `over` on top of the defaults. */
	function tiered(
		files: Record<string, [number, number]> | string,
		over: Partial<Parameters<typeof tieredOf>[0]> = {},
		extra: Record<string, string> = {},
	) {
		const dir = mkdtempSync(join(root, "changeset-"));
		writeFileSync(
			join(dir, "0001.patch"),
			typeof files === "string" ? files : mail(files),
		);
		for (const [name, text] of Object.entries(extra))
			writeFileSync(join(dir, name), text);
		return tieredOf(
			{
				changeset: dir as never,
				ignore: IGNORE,
				...SIZES,
				sections: SECTIONS,
				lead: "LEAD",
				close: "CLOSE",
				...over,
			},
			ctx(),
		);
	}
	const seatsOf = (out: ReturnType<typeof tiered>) => ({
		lens: out.lens,
		deepLens: out.deepLens,
		topLens: out.topLens,
		crossLens: out.crossLens,
	});

	test.each([
		[200, "small", { lens: ["lens"] }],
		[201, "medium", { deepLens: ["deep-lens"] }],
		[800, "medium", { deepLens: ["deep-lens"] }],
		[801, "large", { topLens: ["top-lens"] }],
		[2000, "large", { topLens: ["top-lens"] }],
		[2001, "xlarge", { topLens: ["top-lens"], crossLens: ["cross-lens"] }],
	])(
		"%i changed lines are %s, seating only that tier's lenses",
		(n, tier, seated) => {
			const out = tiered({ "a.txt": [n - 5, 5] });
			expect(out).toMatchObject({ lines: n, tier });
			expect(seatsOf(out)).toEqual({
				lens: [],
				deepLens: [],
				topLens: [],
				crossLens: [],
				...seated,
			});
		},
	);

	test("counts no line of an ignored path", () => {
		const out = tiered({ "bun.lock": [1500, 0], "a.txt": [30, 0] });
		expect(out).toMatchObject({ lines: 30, tier: "small" });
	});

	test("a floor lifts the tier and never lowers it", () => {
		expect(tiered({ "a.txt": [30, 0] }, { floor: "large" }).tier).toBe("large");
		expect(tiered({ "a.txt": [3000, 0] }, { floor: "small" }).tier).toBe(
			"xlarge",
		);
	});

	test.each([
		["docs/x.md", ["correctness", "spec", "docs"]],
		["CLAUDE.md", ["correctness", "spec", "docs", "agent-doc"]],
		["a.test.ts", ["correctness", "spec", "tests", "design", "smells"]],
		["a.ts", ["correctness", "spec", "design", "smells"]],
		["bun.lock", ["correctness", "spec"]],
	])("the path %s picks the sections %j", (path, names) => {
		const out = tiered({ [path]: [3, 0] });
		expect(out.sections).toEqual(names);
		const headings = [...out.checklist.matchAll(/^### (.+)$/gm)].map(
			(m) => m[1],
		);
		expect(headings).toEqual(names);
		expect(out.checklist.startsWith("LEAD\n\n### correctness\n")).toBe(true);
		expect(out.checklist.endsWith("\n\nCLOSE")).toBe(true);
	});

	/** A `git format-patch` mail whose one commit message is `message`, over the raw diff `diffs`. */
	const mailOf = (diffs: string, message = "x") =>
		`From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] x\n\n${message}\n---\n${diffs}`;
	const diffOf = (head: string, body: string) =>
		`diff --git ${head}\nindex 1..2 100644\n${body}`;
	const QUOTED = diffOf(
		'"a/docs/\\303\\274ber.ts" "b/docs/\\303\\274ber.ts"',
		'--- "a/docs/\\303\\274ber.ts"\n+++ "b/docs/\\303\\274ber.ts"\n@@ -1,2 +1,3 @@\n-x\n+y\n+z\n w\n',
	);

	test("a file whose name git quotes counts its lines under the unquoted path and picks its sections", () => {
		const out = tiered(mailOf(QUOTED));
		expect(out).toMatchObject({
			lines: 3,
			sections: ["correctness", "spec", "design", "smells"],
		});
	});

	test("an ASCII file then a quoted one are each credited their own lines", () => {
		const ascii = diffOf(
			"a/a.md b/a.md",
			"--- a/a.md\n+++ b/a.md\n@@ -1 +1,2 @@\n-x\n+y\n+z\n",
		);
		const out = tiered(mailOf(ascii + QUOTED), { ignore: ["**/*.md"] });
		expect(out.lines).toBe(3);
		expect(out.sections).toEqual(["correctness", "spec", "design", "smells"]);
	});

	test("a deleted file counts under its old path, and a removed line starting with dashes counts", () => {
		const gone = diffOf(
			"a/gone.ts b/gone.ts",
			"deleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n--- y\n",
		);
		const out = tiered(mailOf(gone));
		expect(out).toMatchObject({ lines: 2 });
		expect(out.sections).toContain("design");
	});

	test("counts only patch files, and no diff inside a commit message", () => {
		const diff =
			"diff --git a/m.ts b/m.ts\n--- a/m.ts\n+++ b/m.ts\n@@ -1 +1 @@\n-x\n+y\n";
		const out = tiered(mailOf("", diff), {}, { message: diff, base: diff });
		expect(out).toMatchObject({ lines: 0, sections: ["correctness", "spec"] });
	});

	test("a pure rename counts no line and its new path still picks the sections", () => {
		expect(tiered({ "SKILL.md": [0, 0] })).toMatchObject({
			lines: 0,
			sections: ["correctness", "spec", "docs", "agent-doc"],
		});
	});

	test("a path with spaces, which git follows with a tab, is read without it", () => {
		const spaced = diffOf(
			"a/my dir/a b.md b/my dir/a b.md",
			"--- a/my dir/a b.md\t\n+++ b/my dir/a b.md\t\n@@ -1 +1,2 @@\n-x\n+y\n+z\n",
		);
		expect(tiered(mailOf(spaced))).toMatchObject({
			lines: 3,
			sections: ["correctness", "spec", "docs"],
		});
		expect(tiered(mailOf(spaced), { ignore: ["**/*.md"] }).lines).toBe(0);
		const quoted = diffOf(
			'"a/my dir/\\303\\251 b.md" "b/my dir/\\303\\251 b.md"',
			'--- "a/my dir/\\303\\251 b.md"\t\n+++ "b/my dir/\\303\\251 b.md"\t\n@@ -1 +1,2 @@\n-x\n+y\n+z\n',
		);
		expect(tiered(mailOf(quoted))).toMatchObject({
			lines: 3,
			sections: ["correctness", "spec", "docs"],
		});
	});

	test("a change of ignored paths alone counts no line", () => {
		expect(tiered({ "bun.lock": [9, 9] })).toMatchObject({
			lines: 0,
			sections: ["correctness", "spec"],
		});
	});
});

describe("tiered_review", () => {
	/** The IR of a build that uses `tiered_review` over a builder's lane, with `ports` and `params` on top. */
	function tieredIr(
		params: Partial<Parameters<typeof tieredReview.build>[0]> = {},
		ports: () => object = () => ({}),
	): Ir {
		const root = composition("probe", { examples: [{}] }, () => {
			const b = builder({ label: "b", task: "t", lane: fresh() });
			const spec = code(toMarkdown, {
				in: { text: "x" },
				out: { file: Markdown() },
			});
			return use(
				tieredReview,
				{ change: b.out.lane, spec: spec.out.file, ...ports() },
				{ params },
			);
		});
		return buildIr(root, {}, { heldAcross, tallyOf, tieredOf, toMarkdown });
	}
	const node = (ir: Ir, id: string) => ir.nodes.find((n) => n.id === id);
	const profileOf = (ir: Ir, id: string) =>
		(node(ir, id) as unknown as { config: { profile: string } }).config.profile;
	const SEATS = {
		lens: "lens",
		deepLens: "deep-lens",
		topLens: "top-lens",
		crossLens: "cross-lens",
	};

	test("one changeset feeds the selector and every lens's patches; each seat is a parMap of at most one, on its own profile, and no skeptic runs", () => {
		const ir = tieredIr({ grounds: "THE GROUNDS" });
		expect(ir.nodes.filter((n) => n.kind === "repo.changeset")).toHaveLength(1);
		const from = (to: string, port: string) =>
			ir.edges
				.filter((e) => e.to.node === to && "port" in e.to && e.to.port === port)
				.map((e) => e.from.node);
		expect(from("tiered_review/tieredOf", "changeset")).toEqual([
			"tiered_review/patches",
		]);
		for (const name of Object.values(SEATS)) {
			const member = `tiered_review/${name}/lens`;
			expect(node(ir, `tiered_review/${name}`)).toMatchObject({
				kind: "parMap",
				cardinality: { upTo: 1 },
				onError: "continue",
			});
			expect(profileOf(ir, member)).toBe(`classics/${name}`);
			expect(from(member, "patches")).toEqual(["tiered_review/patches"]);
			expect(from(member, "prompt")).toEqual(["tiered_review/tieredOf"]);
		}
		expect(
			ir.nodes.map((n) => n.id).filter((id) => /skeptic/.test(id)),
		).toEqual([]);
		expect(
			(
				node(ir, "tiered_review/consolidator") as unknown as {
					literals: { prompt: string };
				}
			).literals.prompt,
		).toContain("THE GROUNDS");
	});

	test("earlier opens the selector's lead with again.md and relays upheld to every lens", () => {
		const lead = (ir: Ir) =>
			(
				node(ir, "tiered_review/tieredOf") as unknown as {
					literals: { lead: string };
				}
			).literals.lead;
		const relays = (ir: Ir) =>
			Object.values(SEATS).map((name) =>
				(
					node(ir, `tiered_review/${name}/lens`) as unknown as {
						config: { relay?: { name: string }[] };
					}
				).config.relay?.map((r) => r.name),
			);
		const bare = tieredIr();
		expect(lead(bare)).not.toContain(AGAIN.slice(0, 40));
		expect(relays(bare)).toEqual(Object.values(SEATS).map(() => undefined));
		const again = tieredIr({}, () => ({ earlier: literal([], List(Upheld)) }));
		expect(lead(again).startsWith(AGAIN)).toBe(true);
		expect(relays(again)).toEqual(Object.values(SEATS).map(() => ["upheld"]));
	});
});

describe("review_change", () => {
	const REVIEW_CHANGE = [
		"classics.review_change",
		"--request",
		EXAMPLE_REQUEST,
		"--revs",
		"main..feature",
	];
	beforeAll(() => {
		git(target, "checkout", "-q", "-b", "feature");
		writeFileSync(join(target, "feature.txt"), "line\n".repeat(10));
		git(target, "add", ".");
		git(target, "commit", "-q", "-m", "feature");
		git(target, "checkout", "-q", BASE);
	});
	const BEHIND = ["-c", "classics.tiered_review.small=1"];
	const XLARGE = [
		...BEHIND,
		"-c",
		"classics.tiered_review.medium=2",
		"-c",
		"classics.tiered_review.large=3",
	];

	/** Performs `review_change` on the stub harness, with `outputs` scripting what its agents deliver. */
	async function performed(flags: string[], outputs?: string) {
		await stubPreset();
		const { err, code } = await maestro(
			["perform", ...REVIEW_CHANGE, ...flags, "--preset", "stub"],
			outputs ? { MAESTRO_STUB_OUTPUTS: outputs } : {},
		);
		const id = /^concert +(\S+)/m.exec(err)?.[1] ?? "";
		return { code, id, ls: (await maestro(["ls", id])).out };
	}

	test("--revs builds one commits node feeding the selector; both or neither of --change and --revs is refused by name", async () => {
		const { out, code } = await maestro([
			"compose",
			...REVIEW_CHANGE,
			"--json",
		]);
		expect(code).toBe(0);
		const { ir } = JSON.parse(out).plan;
		expect(
			ir.nodes.filter((n: { kind: string }) => n.kind === "repo.commits"),
		).toHaveLength(1);
		expect(
			ir.edges.filter(
				(e: { from: { node: string }; to: { node: string } }) =>
					e.from.node === "commits" && e.to.node === "tiered_review/patches",
			),
		).toHaveLength(1);
		expect(
			await maestro(["compose", ...REVIEW_CHANGE, "--change", "c.x"]),
		).toMatchObject({
			code: 2,
			err: "error: classics.review_change takes --change or --revs, not both\n  Drop one of --change and --revs\n",
		});
		expect(
			await maestro(["perform", ...REVIEW_CHANGE.slice(0, 3)]),
		).toMatchObject({
			code: 2,
			err: "error: classics.review_change needs --change or --revs\n  Pass --revs main..feature, or --change <concert id>.<node instance id>\n",
		});
	});

	test("thresholds that do not rise are refused, naming all three", async () => {
		const { err, code } = await maestro([
			"compose",
			...REVIEW_CHANGE,
			"-c",
			"classics.tiered_review.medium=100",
		]);
		expect(code).toBe(2);
		expect(err).toContain("classics.tiered_review.small, medium and large");
		expect(err).toContain("got 200, 100 and 2000");
	});

	test("a small commit runs the lens alone", async () => {
		const ran = await performed([]);
		expect(ran.code).toBe(0);
		expect(ran.ls).toMatch(/^tiered_review\/lens\[lens\]\/lens +ok/m);
		expect(ran.ls).not.toMatch(/\[(deep|top|cross)-lens\]/);
	});

	test("an xlarge commit runs top-lens and cross-lens on the same task", async () => {
		const ran = await performed(XLARGE);
		expect(ran.code).toBe(0);
		expect(ran.ls).toMatch(/^tiered_review\/top-lens\[top-lens\]\/lens +ok/m);
		expect(ran.ls).toMatch(
			/^tiered_review\/cross-lens\[cross-lens\]\/lens +ok/m,
		);
		expect(ran.ls).not.toMatch(/^tiered_review\/lens\[lens\]/m);
		const prompt = async (name: string) =>
			(
				await maestro([
					"art",
					"show",
					ran.id,
					`tiered_review/${name}[${name}]/lens`,
					"staged/prompt.md",
				])
			).out;
		const top = await prompt("top-lens");
		expect(top).toContain("### correctness");
		expect(await prompt("cross-lens")).toBe(top);
	});

	test("a review no lens delivered settles rejected", async () => {
		const outputs = mkdtempSync(join(root, "outputs-"));
		mkdirSync(join(outputs, "tiered_review/lens/lens"), { recursive: true });
		writeFileSync(join(outputs, "tiered_review/lens/lens/verdict"), "garbage");
		const ran = await performed([], outputs);
		expect(ran.code).toBe(3);
		expect(ran.ls).toMatch(/^tiered_review\/lens\[lens\]\/lens +failed/m);
		expect(ran.ls).toMatch(/^tiered_review\/upheld +rejected/m);
		expect(ran.ls).toContain("no lens delivered a review");
	});
});

describe("build", () => {
	/** The IR of a build that uses `build` with `params`, and the spec as a Markdown file. */
	function buildIrOf(params: { testFirst?: boolean; checks?: string[] }) {
		const root = composition("probe", { examples: [{}] }, () => {
			const spec = code(toMarkdown, {
				in: { text: "x" },
				out: { file: Markdown() },
			});
			return use(
				buildChange,
				{ spec: spec.out.file },
				{ params: { request: "make it", ...params } },
			).brief;
		});
		return buildIr(root, {}, { briefOf, specOf, toMarkdown });
	}
	const node = (ir: Ir, id: string) =>
		ir.nodes.find((n) => n.id === id) as
			| { config: Record<string, unknown>; in?: object }
			| undefined;
	const into = (ir: Ir, to: string) =>
		ir.edges
			.filter((e) => e.to.node === to && "port" in e.to)
			.map((e) => `${e.from.node}.${"port" in e.from ? e.from.port : ""}`);

	test("untested, one builder in a fresh lane under the checks, no tester, a spec of the request alone", () => {
		const ir = buildIrOf({ checks: ["test"] });
		expect(node(ir, "build/build")?.config).toMatchObject({
			lane: { mode: "fresh" },
			checks: ["test"],
		});
		expect(ir.nodes.map((n) => n.id).filter((id) => /tester/.test(id))).toEqual(
			[],
		);
		expect(into(ir, "build/spec")).toEqual([]);
		expect(into(ir, "build/brief")).toEqual(["build/build.report"]);
	});

	test("tested, the tester and builder of test_first, a spec of the request, the map and the overrules", () => {
		const ir = buildIrOf({ testFirst: true, checks: ["test"] });
		expect(node(ir, "build/test_first/tester")).toBeDefined();
		expect(node(ir, "build/test_first/tester")?.config.checks ?? []).toEqual(
			[],
		);
		expect(into(ir, "build/spec").sort()).toEqual([
			"build/test_first/build.overrules",
			"build/test_first/tester.map",
		]);
		expect(into(ir, "build/brief")).toEqual(["build/test_first/build.report"]);
	});

	test("is no entry: it takes the spec as a port, so compose refuses it", async () => {
		const { err, code } = await maestro([
			"compose",
			"classics.build",
			"--request",
			"x",
		]);
		expect(code).toBe(1);
		expect(err).toContain("composition 'build' has ports");
	});
});

describe("recipes", () => {
	const RECIPES = join(import.meta.dir, "recipes");

	/** Performs recipe `name` on the stub harness with `scripted` outputs by instance id, and lists each instance's status. */
	async function performed(
		name: string,
		exported: string,
		scripted: Record<string, unknown> = {},
	) {
		await Bun.write(
			join(root, ".maestro/presets/recipes.yaml"),
			"profiles:\n  '*': { runtime: !replace { harness: stub } }\n",
		);
		const outputs = mkdtempSync(join(root, "outputs-"));
		for (const [path, value] of Object.entries(scripted)) {
			mkdirSync(join(outputs, path, ".."), { recursive: true });
			writeFileSync(
				join(outputs, path),
				typeof value === "string" ? value : JSON.stringify(value),
			);
		}
		const file = compositionFile(
			name,
			`export { ${exported}, joined, majority } from "${RECIPES}";\nexport * from "@maestro/classics/code";\n`,
		);
		const ran = await maestro(
			[
				"perform",
				file,
				"-c",
				'target.checks=!replace {test: "true"}',
				"--preset",
				"recipes",
			],
			{ MAESTRO_STUB_OUTPUTS: outputs },
		);
		const id = /^concert +(\S+)/m.exec(ran.err)?.[1] ?? "";
		const { out } = await maestro(["ls", id]);
		return { ...ran, ls: out };
	}

	/** The scripted outputs of the lens at `node`, which raises `F1` and rejects. */
	const raised = (node: string) => ({
		[`${node}/findings.json`]: [F1],
		[`${node}/verdict`]: "rejected F1",
	});
	const rows = (ls: string, name: string) =>
		ls.split("\n").filter((l) => l.startsWith(`${name} `));

	test.each([
		["clean, the strong seat never runs", {}, "skipped"],
		[
			"upheld, the strong seat fixes",
			{
				...raised("cheap/tiered_review/lens/lens"),
				...raised("cheap/fixes/tiered_review/lens/lens"),
				"cheap/tiered_review/consolidator/verdict.json": {
					criteria: [],
					upholds: ["lens/F1"],
				},
				"cheap/fixes/tiered_review/consolidator/verdict.json": {
					criteria: [],
					upholds: ["lens/F1"],
				},
			},
			"ok",
		],
	])("fix_ladder: %s", async (_, scripted, strong) => {
		const ran = await performed("fix_ladder", "fixLadder", scripted);
		expect(ran.code).toBe(0);
		expect(rows(ran.ls, "strong")[0]).toMatch(new RegExp(`^strong +${strong}`));
		expect(rows(ran.ls, "strong_gate/check")[0]).toMatch(
			new RegExp(`^strong_gate/check +${strong}`),
		);
	});

	test.each([
		["both families", ["a", "b"], "2 upheld: a/F1, b/F1"],
		["family a alone", ["a"], "1 upheld: a/F1"],
		["family b alone", ["b"], "1 upheld: b/F1"],
	])(
		"lens_fusion: %s raising a finding, the one tally upholds it",
		async (_, raising, reason) => {
			const ran = await performed(
				"lens_fusion",
				"lensFusion",
				Object.fromEntries(
					raising.flatMap((f) => [
						...Object.entries(raised(`${f}_lenses/lens`)),
						[
							`${f}_lenses/skeptic/rulings.json`,
							[{ id: "F1", holds: true, why: "holds" }],
						],
					]),
				),
			);
			expect(ran.code).toBe(3);
			expect(ran.ls).toContain(reason);
		},
	);

	test.each([
		["two of three hold it, it stands", ["a", "b"], 3],
		["one of three holds it, it falls", ["a"], 0],
	])("ruling_vote: %s", async (_, holders, exit) => {
		const ran = await performed("ruling_vote", "rulingVote", {
			...raised("lens"),
			...Object.fromEntries(
				["a", "b", "c"].map((v) => [
					`voters[${v}]/skeptic/rulings.json`,
					[{ id: "F1", holds: holders.includes(v), why: "vote" }],
				]),
			),
		});
		expect(ran.code).toBe(exit);
	});

	test("audit_sweep: a lens per area rules on the sealed base", async () => {
		const ran = await performed("audit_sweep", "auditSweep");
		expect(ran.code).toBe(0);
		expect(ran.ls).toMatch(/^base +ok/m);
		for (const area of ["src", "docs"])
			expect(ran.ls).toMatch(
				new RegExp(`^panel/lenses\\[${area}\\]/lens +ok`, "m"),
			);
	});

	test("plan_review: the panel rules on the planner's plan over the sealed base", async () => {
		const ran = await performed("plan_review", "planReview");
		expect(ran.code).toBe(0);
		expect(ran.ls).toMatch(/^plan +ok/m);
		expect(ran.ls).toMatch(/^panel\/lenses\[plan\]\/lens +ok/m);
	});
});
