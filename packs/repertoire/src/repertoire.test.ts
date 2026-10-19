import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIr } from "@maestro/testkit";
import { pack } from "../../../scripts/pack";
import { BASE, setup } from "../acceptance/setup";
import { survivorsOf, toMarkdown } from "./code";
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
		roles: { builder: ROLE, reviewer: ROLE, skeptic: ROLE },
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
		expect(modelOf("parMap/lens")).toBe("lab-a/lens");
		expect(modelOf("parMap/skeptic")).toBe("lab-b/skeptic");
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
		for (const line of [
			'n3[["loop<br/>0 to 2"]]',
			'n6 -.->|"next"| n3',
			'f5 -.->|"after, tolerates rejected"| j6',
		])
			expect(out).toContain(`${line}\n`);
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
