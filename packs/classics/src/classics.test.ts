import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reject, type Settled } from "@maestro/sdk";
import { pack } from "../../../scripts/pack";
import { BASE, PROFILES, profilesOn, setup } from "../acceptance/setup";
import { briefOf, heldOf, tallyOf } from "./code";
import { EXAMPLE_REQUEST } from "./repair";

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
async function maestro(...args: string[]) {
	const run = Bun.spawn([process.execPath, MAESTRO, ...args], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			XDG_DATA_HOME: join(root, "data"),
			XDG_CONFIG_HOME: join(root, "config"),
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
		const { out, code } = await maestro("compose", ...REVIEW, "--json");
		expect(code).toBe(0);
		const { plan } = JSON.parse(out);
		expect(plan.bounds).toMatchObject({
			instances: { exact: 17 },
			counts: { "repo.agent": { exact: 7 } },
		});
		const profileOf = (id: string) =>
			plan.ir.nodes.find((n: { id: string }) => n.id === id)?.config.profile;
		expect(profileOf("lenses/lens")).toBe("classics/lens");
		expect(profileOf("lenses/skeptic")).toBe("classics/skeptic");
	});

	test("--revs reviews target commits through one commits node; both or neither of --change and --revs is refused", async () => {
		const revs = ["--revs", "main..feature"];
		const { out, code } = await maestro(
			"compose",
			...REVIEW.slice(0, 3),
			...revs,
			"--json",
		);
		expect(code).toBe(0);
		const { plan } = JSON.parse(out);
		expect(plan.bounds).toMatchObject({ instances: { exact: 18 } });
		expect(
			plan.ir.nodes.filter((n: { kind: string }) => n.kind === "repo.commits"),
		).toEqual([
			expect.objectContaining({
				id: "commits",
				config: { revs: "main..feature" },
			}),
		]);
		expect(await maestro("compose", ...REVIEW, ...revs)).toMatchObject({
			code: 2,
			err: "error: classics.panel_review takes --change or --revs, not both\n  Drop one of --change and --revs\n",
		});
		// perform takes no example set, so it alone can give neither.
		expect(await maestro("perform", ...REVIEW.slice(0, 3))).toMatchObject({
			code: 2,
			err: "error: classics.panel_review needs --change or --revs\n  Pass --revs main..feature, or --change <concert id>.<node instance id>\n",
		});
	});

	test("names a misspelt config key and the param it meant", async () => {
		await configure({ classics: { panel_review: { lense: ["spec"] } } });
		const { err, code } = await maestro("compose", ...REVIEW).finally(() =>
			configure(),
		);
		expect(code).toBe(1);
		expect(err).toContain("error: config key 'classics.panel_review.lense'");
		expect(err).toContain("Did you mean 'classics.panel_review.lenses'?");
	});

	test("graphs the lens fan-out, the skeptic's guard and the collect into heldOf", async () => {
		const { out } = await maestro("compose", ...REVIEW, "--graph");
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

describe("build_then_repair", () => {
	test("plans its repairs as a loop of 0 to maxRepairs steps, each agent on the bundle's builder profile", async () => {
		const { out } = await maestro("compose", ...BUILD, "--plan");
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
		const { err, code } = await maestro(
			"perform",
			...BUILD,
			...green,
			"--preset",
			"stub",
		);
		expect(code).toBe(0);
		expect(err).toMatch(/^concert +\S+ +ok( |$)/m);
	});

	test("gives the repair agent the checks configured for repair_until_green", async () => {
		await configure({
			classics: { repair_until_green: { checks: ["test"] } },
		});
		const { out, code } = await maestro("compose", ...BUILD, "--json");
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
			const { err } = await maestro(
				"perform",
				...BUILD,
				"--preset",
				"stub",
			).finally(() => configure());
			const id = /^concert +(\S+)/m.exec(err)?.[1] ?? "";
			const { out } = await maestro("ls", id);
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
		const { out } = await maestro("compose", ...BUILD, "--graph");
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
	const { out, err, code } = await maestro(
		"agent",
		"show",
		`classics/${name}`,
		"--json",
	);
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

test("the scout seat carries the answers reply field and no outbox file", async () => {
	const file = join(root, "scouted.ts");
	symlinkSync(
		join(import.meta.dir, "../../../node_modules"),
		join(root, "node_modules"),
	);
	writeFileSync(
		file,
		`import { scout } from "@maestro/classics";
import { fresh } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const scouted = composition("scouted", { examples: [{}] }, () =>
	scout({ task: "answer", lane: fresh() }),
);
`,
	);
	const { out, code } = await maestro("compose", file, "--json");
	expect(code).toBe(0);
	const agent = JSON.parse(out).plan.ir.nodes.find(
		(n: { config?: { seat?: string } }) => n.config?.seat === "scout",
	);
	expect(Object.keys(agent.config.reply)).toEqual(["answers"]);
	expect(agent.config.out).toBeUndefined();
});

test.each([
	["maxRepairs", [...BUILD, "--max-repairs", "0"]],
	["lenses", [...REVIEW, "--lenses", "spec", "--lenses", "spec"]],
])("an out-of-range %s is refused by its name", async (param, args) => {
	const { err, code } = await maestro("compose", ...args);
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
