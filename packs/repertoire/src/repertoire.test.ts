import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeContext, Settled } from "@maestro/sdk";
import { buildIr } from "@maestro/testkit";
import { pack } from "../../../scripts/pack";
import { BASE, rolesOn, setup } from "../acceptance/setup";
import { dossierOf, survivorsOf, toMarkdown, traceOf } from "./code";
import { EXAMPLE_REQUEST } from "./repair";
import { review } from "./review";

const MAESTRO = join(import.meta.dir, "../../../packages/cli/src/maestro.ts");
const ROLE = { harness: "pi", model: "none" };
const REVIEW = [
	"repertoire.review",
	"--request",
	EXAMPLE_REQUEST,
	"--change",
	"c.x",
	"--lens-model",
	"lab-a/lens",
	"--skeptic-model",
	"lab-b/skeptic",
];
const BUILD = ["repertoire.build_then_repair", "--request", EXAMPLE_REQUEST];
const SAME_FAMILY = ["--lens-model", "x/a", "--skeptic-model", "x/b"];
const ASSERT_FAILED =
	"skeptic model 'x/b' is of the family of lens model 'x/a'";

/** Builds `review` with a lens and a skeptic on these models. */
const reviewOn = (lensModel: string, skepticModel: string) =>
	buildIr(
		review,
		{ request: EXAMPLE_REQUEST, change: "c.x", lensModel, skepticModel },
		{ toMarkdown, survivorsOf },
	);

let root: string;
let config: Record<string, unknown>;

/** Writes the workspace config, the built pack's and the toy target's, with `over` on top. */
const configure = (over: Record<string, unknown> = {}) =>
	Bun.write(
		join(root, ".maestro/config.yaml"),
		JSON.stringify({ ...config, ...over }),
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
	root = mkdtempSync(join(tmpdir(), "repertoire-cli-"));
	const { target } = await setup("t1", root, ROLE);
	config = {
		packs: [await pack(join(import.meta.dir, ".."), join(root, "pack"))],
		target: { repo: target, base: BASE, checks: { test: "sh test.sh" } },
		roles: rolesOn(ROLE),
	};
	await configure();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("review", () => {
	test("composes to an exact count for three lenses", async () => {
		const { out, code } = await maestro("compose", ...REVIEW, "--json");
		expect(code).toBe(0);
		const { plan } = JSON.parse(out);
		expect(plan.bounds).toMatchObject({
			instances: { exact: 23 },
			counts: { "repo.agent": { exact: 7 } },
		});
		const modelOf = (id: string) =>
			plan.ir.nodes.find((n: { id: string }) => n.id === id)?.config.role.model;
		expect(modelOf("lenses/lens")).toBe("lab-a/lens");
		expect(modelOf("lenses/skeptic")).toBe("lab-b/skeptic");
	});

	test("refuses a skeptic of the lens's model family before any concert", async () => {
		const composed = await maestro("compose", ...REVIEW, ...SAME_FAMILY);
		expect(composed).toMatchObject({ code: 2 });
		expect(composed.err).toContain(
			`ASSERT.failed: assert failed: ${ASSERT_FAILED}`,
		);
		expect(() => reviewOn("x/a", "x/b")).toThrow(ASSERT_FAILED);
	});

	test("names a misspelt config key and the param it meant", async () => {
		await configure({ repertoire: { review: { lensModle: "x/a" } } });
		const { err, code } = await maestro("compose", ...REVIEW).finally(() =>
			configure(),
		);
		expect(code).toBe(2);
		expect(err).toContain(
			"CFG.unclaimed: config key 'repertoire.review.lensModle'",
		);
		expect(err).toContain("Did you mean 'repertoire.review.lensModel'?");
	});

	test("graphs the lens fan-out, the skeptic's guard and the collect into survivorsOf", async () => {
		const { out } = await maestro("compose", ...REVIEW, "--graph");
		for (const line of [
			'subgraph gn2["lenses"]',
			'n2[["parMap<br/>correctness, spec, tests"]]',
			'n9["survivorsOf<br/>code"]',
			'n2 ==>|"collect"| n9',
			'n8(["skeptic<br/>repo.agent"])',
			'n7 -.->|"when value, else skip"| j8',
			"j8 --> n8",
		])
			expect(out).toContain(`  ${line}\n`);
	});
});

describe("build_then_repair", () => {
	test("plans its repairs as a loop of 0 to maxRepairs steps", async () => {
		const { out } = await maestro("compose", ...BUILD, "--plan");
		expect(out).toContain("repair_until_green/loop expands to 0 to 2");
		expect(out).toContain(
			"build_then_repair: up to 11 node instances, up to 3 repo.agent",
		);
	});

	test("graphs the loop's bound and its next edge", async () => {
		const { out } = await maestro("compose", ...BUILD, "--graph");
		for (const line of ['n3[["loop<br/>0 to 2"]]', 'n6 -.->|"next"| n3'])
			expect(out).toContain(`${line}\n`);
	});
});

describe("v_model", () => {
	const V_MODEL = "repertoire.v_model";
	const BOUNDED = [
		V_MODEL,
		"--request",
		EXAMPLE_REQUEST,
		"--lens-model",
		"lab-c/lens",
		"--skeptic-model",
		"lab-d/skeptic",
		"--max-approaches",
		"3",
		"--max-risks",
		"2",
		"--max-repairs",
		"1",
	];

	test("composes from its example set, its approaches and its lenses each up to their bound", async () => {
		const { out, code } = await maestro("compose", V_MODEL, "--plan");
		expect(code).toBe(0);
		for (const line of [
			"v_model: up to 67 node instances, up to 20 repo.agent",
			"scouts expands to map, proof, risk",
			"approaches expands to up to 2",
			"lenses expands to up to 4",
		])
			expect(out).toContain(line);
		expect(out).toMatch(
			/approaches\/repair_until_green\/loop\/repair +repo\.agent +up to 4\n/,
		);
	});

	test("bounds every level by its own param, and runs lenses and skeptics on theirs", async () => {
		const planned = await maestro("compose", ...BOUNDED, "--plan");
		for (const line of [
			"v_model: up to 56 node instances, up to 16 repo.agent",
			"approaches expands to up to 3",
			"lenses expands to up to 2",
		])
			expect(planned.out).toContain(line);
		expect(planned.out).toMatch(
			/approaches\/repair_until_green\/loop\/repair +repo\.agent +up to 3\n/,
		);
		const { plan } = JSON.parse(
			(await maestro("compose", ...BOUNDED, "--json")).out,
		);
		// 3 scouts, a planner, 3 builds, a repair each, 2 lenses, 2 skeptics, a consolidator and a documenter.
		expect(plan.bounds.counts["repo.agent"]).toEqual({ upTo: 16 });
		const node = (id: string) =>
			plan.ir.nodes.find((n: { id: string }) => n.id === id);
		expect(node("lenses/lens").config.role.model).toBe("lab-c/lens");
		expect(node("lenses/skeptic").config.role.model).toBe("lab-d/skeptic");
		expect(node("plan").literals.prompt).toContain("up to 3 approaches");
		expect(
			node("plan").config.out.design.schema.properties.approaches,
		).toMatchObject({ minItems: 1, maxItems: 3 });
		expect(node("dossierOf").literals.maxRisks).toBe(2);
	});

	test("graphs the scouts' collect, the find over approaches and the trace's gate on the result", async () => {
		const { out } = await maestro("compose", V_MODEL, "--graph");
		for (const line of [
			'subgraph gn2["scouts"]',
			'n2 ==>|"collect"| n5',
			'subgraph gn9["approaches"]',
			'n9[["find<br/>up to 2"]]',
			'subgraph gn18["lenses"]',
			'n18[["parMap<br/>up to 4"]]',
			'f5 -->|"risks to items"| n18',
			'n30 -.->|"when ok, else skip"| j31',
		])
			expect(out).toContain(`  ${line}\n`);
	});
});

/** A new directory `name` in the workspace, as a code function's scratch directory that also holds its artifacts. */
function contextIn(name: string): { dir: string; ctx: CodeContext } {
	const dir = join(root, name);
	mkdirSync(dir);
	return {
		dir,
		ctx: {
			concert: "c",
			clock: 0,
			path: (ref) => join(dir, ref.path),
			scratch: dir,
			env: {},
			log: () => {},
		},
	};
}

/** A scout that settled ok with these facts and risks, its evidence written in `dir`. */
function scouted(
	dir: string,
	name: string,
	facts: [string, string][],
	risks: [string, string][],
): Settled<{ evidence: { path: string; contentHash: string } }> {
	const path = `${name}.json`;
	writeFileSync(
		join(dir, path),
		JSON.stringify({
			summary: name,
			facts: facts.map(([where, note]) => ({ where, note })),
			risks: risks.map(([where, risk]) => ({ where, risk })),
		}),
	);
	return { outcome: "ok", value: { evidence: { path, contentHash: "" } } };
}

describe("dossierOf", () => {
	test("merges facts by where, ranks risks by the scouts raising them, and keeps maxRisks", () => {
		const { dir, ctx } = contextIn("dossier");
		const scouts = [
			scouted(
				dir,
				"map",
				[["greet.sh:2", "prints the greeting"]],
				[
					["greet.sh:2", "greet.sh ignores its argument."],
					["greet.sh:2", "Greet.sh  ignores its argument!"],
				],
			),
			{ outcome: "failed", reason: "timed out" } as const,
			scouted(
				dir,
				"risk",
				[["greet.sh:2", "takes no argument"]],
				[
					["test.sh:3", "No test for an empty name"],
					["greet.sh:1", "a third risk"],
				],
			),
			scouted(dir, "proof", [], [["test.sh:1", "no test for an empty name"]]),
		];
		const angles = ["map", "lost", "risk", "proof"];
		expect(dossierOf({ scouts, angles, maxRisks: 2 }, ctx)).toEqual({
			dossier: join(dir, "dossier.md"),
			risks: [
				{ id: "R1", risk: "No test for an empty name" },
				{ id: "R2", risk: "greet.sh ignores its argument." },
			],
		});
		const dossier = readFileSync(join(dir, "dossier.md"), "utf8");
		expect(dossier).toContain(
			"- greet.sh:2: prints the greeting; takes no argument\n",
		);
		expect(dossier).toContain("- R3, greet.sh:1: a third risk\n");
	});

	const FIX = ". Check the 'scout' role's harness and model";
	test.each([
		[
			"each scout by its angle",
			[
				{ outcome: "failed", reason: "timed out" },
				{ outcome: "skipped" },
			] as const,
			`no scout delivered evidence: map: timed out; proof: skipped${FIX}`,
		],
		["no scouts", [] as const, `no scout delivered evidence${FIX}`],
	])("rejects naming %s when none settled ok", (name, scouts, reason) => {
		const out = dossierOf(
			{ scouts: [...scouts], angles: ["map", "proof"], maxRisks: 4 },
			contextIn(`undelivered ${name}`).ctx,
		);
		expect(out).toEqual({ outcome: "rejected", reason });
	});
});

describe("traceOf", () => {
	const FIX =
		" (trace.md has the matrix). Have the planner name criteria, and the review and the documenter each rule once on every one";
	const ruling = (id: string, met = true) => ({
		id,
		met,
		evidence: `${id} | ok`,
	});
	const design = {
		criteria: ["C1", "C2"].map((id) => ({
			id,
			criterion: `${id} holds`,
			proof: "sh test.sh",
		})),
		approaches: [],
	};
	const verdict = {
		approved: true,
		criteria: [ruling("C1"), ruling("C2")],
		blocking: [],
	};
	const acceptance = [ruling("C1"), ruling("C2")];

	test("traces every criterion to its proof and both rulings, a missing one shown as such", () => {
		const { dir, ctx } = contextIn("trace");
		const lines = { ...ruling("C2"), evidence: "C2 | ok\n  on two lines" };
		expect(
			traceOf({ design, verdict, acceptance: [ruling("C1"), lines] }, ctx),
		).toEqual({ trace: join(dir, "trace.md") });
		const matrix = () => readFileSync(join(dir, "trace.md"), "utf8");
		expect(matrix()).toContain(
			"| C2: C2 holds | sh test.sh | met: C2 \\| ok | met: C2 \\| ok on two lines |\n",
		);
		traceOf({ design, verdict, acceptance: [ruling("C1")] }, ctx);
		expect(matrix()).toContain("| met: C2 \\| ok | missing |\n");
	});

	test.each([
		[
			"no criteria",
			{ design: { ...design, criteria: [] } },
			"the plan names no criteria",
		],
		[
			"no approval",
			{ verdict: { ...verdict, approved: false } },
			"the review did not approve",
		],
		[
			"a missing review ruling",
			{ verdict: { ...verdict, criteria: [ruling("C1")] } },
			"C2 has no review ruling",
		],
		[
			"a missing acceptance ruling",
			{ acceptance: [ruling("C1")] },
			"C2 has no acceptance ruling",
		],
		[
			"a repeated review ruling",
			{
				verdict: {
					...verdict,
					criteria: [ruling("C1"), ruling("C2"), ruling("C2", false)],
				},
			},
			"C2 has 2 review rulings",
		],
		[
			"an unmet review ruling",
			{
				verdict: { ...verdict, criteria: [ruling("C1"), ruling("C2", false)] },
			},
			"C2 is unmet in review",
		],
		[
			"an unmet acceptance ruling",
			{ acceptance: [ruling("C1", false), ruling("C2")] },
			"C1 is unmet in acceptance",
		],
		[
			"several gaps",
			{
				verdict: { ...verdict, approved: false },
				acceptance: [ruling("C1"), ruling("C1")],
			},
			"the review did not approve; C1 has 2 acceptance rulings; C2 has no acceptance ruling",
		],
	])("rejects with the matrix on %s", (name, over, gap) => {
		const { dir, ctx } = contextIn(`trace ${name}`);
		expect(traceOf({ design, verdict, acceptance, ...over }, ctx)).toEqual({
			outcome: "rejected",
			reason: `trace gaps: ${gap}${FIX}`,
			outputs: { trace: join(dir, "trace.md") },
		});
	});
});

describe("a model's family", () => {
	test.each([
		["anthropic/claude-x", "anthropic"],
		["claude-sonnet-4", "anthropic"],
		["gpt-5", "openai"],
		["o3", "openai"],
		["gemini-2", "google"],
		["github-copilot/gpt-x", "openai"],
		["github-copilot/claude-x", "anthropic"],
		["openrouter/anthropic/claude-x", "anthropic"],
		["mistral/large", "mistral"],
		["local-model", "local-model"],
	])("of %p is %p", (model, family) => {
		expect(() => reviewOn(model, `${family}/x`)).toThrow(
			`is of the family of lens model '${model}'`,
		);
	});

	test("is not its gateway's", () => {
		expect(() =>
			reviewOn("github-copilot/gpt-x", "github-copilot/claude-x"),
		).not.toThrow();
	});
});

test.each([
	["maxRepairs", [...BUILD, "--max-repairs", "0"]],
	["lenses", [...REVIEW, "--lenses", "spec", "--lenses", "spec"]],
])("an out-of-range %s is refused by its name", async (param, args) => {
	const { err, code } = await maestro("compose", ...args);
	expect(code).toBe(2);
	expect(err).toContain(`CFG.schema: param '${param}'`);
});
