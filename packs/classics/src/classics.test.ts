import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "../../../scripts/pack";
import { BASE, PROFILES, profilesOn, setup } from "../acceptance/setup";
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
			instances: { exact: 23 },
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
		expect(plan.bounds).toMatchObject({ instances: { exact: 24 } });
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

	test("graphs the lens fan-out, the skeptic's guard and the collect into survivorsOf", async () => {
		const { out } = await maestro("compose", ...REVIEW, "--graph");
		for (const line of [
			'subgraph gn2["lenses"]',
			'n2[["parMap<br/>correctness, spec, tests"]]',
			'n9["survivorsOf<br/>code"]',
			'n2 ==>|"collect"| n9',
			'n8(["skeptic<br/>repo.agent"])',
			'f7 -.->|"when value, else skip"| j8',
			'f4 -.->|"after, tolerates rejected"| j8',
			"j8 --> n8",
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
			/\nagents:\n {2}build +classics\/builder +pi +none +-\n/,
		);
		expect(out).toMatch(
			/ {2}repair_until_green\/loop\/repair +classics\/builder +pi +none +-\n/,
		);
	});

	test("performs on the stub harness under a --preset that sets the runtime of each seated profile by name", async () => {
		await Bun.write(
			join(root, ".maestro/presets/stub.yaml"),
			`profiles:\n${PROFILES.map((p) => `  ${p}: { runtime: !replace { harness: stub, model: none } }\n`).join("")}`,
		);
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

	test("graphs the loop's bound and its next edge", async () => {
		const { out } = await maestro("compose", ...BUILD, "--graph");
		for (const line of ['n3[["loop<br/>0 to 2"]]', 'n6 -.->|"next"| n3'])
			expect(out).toContain(`${line}\n`);
	});
});

test.each([
	["maxRepairs", [...BUILD, "--max-repairs", "0"]],
	["lenses", [...REVIEW, "--lenses", "spec", "--lenses", "spec"]],
])("an out-of-range %s is refused by its name", async (param, args) => {
	const { err, code } = await maestro("compose", ...args);
	expect(code).toBe(2);
	expect(err).toContain(`error: param '${param}'`);
});
