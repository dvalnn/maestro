import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valuesLayer } from "@maestro/core/config";
import type { Roots } from "@maestro/core/host";
import type { CodeEntry } from "@maestro/core/node";
import { openRecord, perform } from "@maestro/core/perform";
import { repoHost } from "@maestro/host-repo";
import {
	type HarnessRequest,
	OUTBOX,
	SESSION_DIR,
	type StubStep,
	stubHarness,
} from "@maestro/host-repo/harness";
import type { CodeContext } from "@maestro/sdk";
import * as stdlib from "@maestro/sdk/stdlib";
import { buildIr, stubConcert } from "@maestro/testkit";
import { heldOf, tallyOf, toMarkdown } from "../src/code";
import { buildThenRepair } from "../src/repair";
import { panelReview } from "../src/review";
import { diff, maestroTrace, sssfTrace } from "./compare";
import { BASE, git, profilesOn, setup } from "./setup";
import { TASKS, type TaskName } from "./tasks";

const dirs: string[] = [];
const tmp = () => {
	const dir = mkdtempSync(join(tmpdir(), "classics-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const WRONG = '#!/bin/sh\necho "Hello, $1!"\n';
const RIGHT =
	'#!/bin/sh\nname="$1"\n[ -n "$name" ] || name=world\necho "Hello, $name!"\n';
/** An agent's final reply, `envelope` as JSON. */
const replying = (envelope: object): StubStep => ({
	emit: { type: "text", text: JSON.stringify(envelope) },
});
const DONE = replying({ report: { summary: "done" } });
const APPROVED = replying({ outcome: "ok", report: { summary: "done" } });
/** The final reply that settles the agent of `req` ok, for its kind. */
const done = (req: HarnessRequest) => (req.verdict ? APPROVED : DONE);
const FIX: StubStep[] = [{ write: "greet.sh", content: RIGHT }, DONE];
const BLOCKED = replying({
	report: { summary: "tried" },
	blocked: "the checks ask for two greetings at once",
});
const RUNTIME = { harness: "stub", model: "none" };
/** The pack's source tree, laid out as its bundle is. */
const PACK = join(import.meta.dir, "..");
const ROOTS: Roots = { user: "/nonexistent", packs: { classics: PACK } };
const CODE: Readonly<
	Record<string, (inputs: never, context: CodeContext) => unknown>
> = {
	...stdlib,
	toMarkdown,
	heldOf,
	tallyOf,
};
const POLL_MS = 20;

/** The greet.sh each task's build writes, so T1 goes red and T2 is `RIGHT` but still red. */
const BUILT: Record<TaskName, string> = { t1: WRONG, t2: RIGHT };

/** Each task's repair: T1's writes `RIGHT`, and T2's, seeing an unsatisfiable check, reports blocked. */
const REPAIRED: Record<TaskName, StubStep[]> = { t1: FIX, t2: [BLOCKED] };

/** A task's target and workspace, and a stub harness that builds `BUILT[name]` and repairs with `repair`. */
async function stubbed(
	name: TaskName,
	repair: (req: HarnessRequest) => StubStep[] = () => REPAIRED[name],
) {
	const task = TASKS[name];
	const dir = tmp();
	const { target } = await setup(name, dir, RUNTIME);
	const builds: HarnessRequest[] = [];
	const repairs: HarnessRequest[] = [];
	const hosts = [
		repoHost({
			harnesses: [
				stubHarness((req) => {
					if (!req.prompt.startsWith(task.request)) {
						repairs.push(req);
						return repair(req);
					}
					builds.push(req);
					return [{ write: "greet.sh", content: BUILT[name] }, DONE];
				}),
			],
		}),
	];
	const config = {
		target: { repo: target, base: BASE, checks: task.checks },
		profiles: profilesOn(RUNTIME),
	};
	const ir = buildIr(
		buildThenRepair,
		{ request: task.request, maxRepairs: task.maxRepairs },
		{ toMarkdown },
	);
	return { dir, target, hosts, config, ir, builds, repairs };
}

/** Performs task `name` with stubbed agents, and its trace as `compare maestro` extracts it. */
async function performedTask(
	name: TaskName,
	repair?: (req: HarnessRequest) => StubStep[],
) {
	const stub = await stubbed(name, repair);
	const { dir, hosts, config, ir } = stub;
	const run = await stubConcert(ir, {
		hosts,
		config,
		code: CODE,
		dir,
		roots: ROOTS,
	});
	const lane = run.record
		.instances(run.id)
		.findLast((i) => typeof i.outputs?.lane === "string")?.outputs?.lane;
	await run.close();
	const extract = () => maestroTrace(join(dir, "record.db"), run.id, dir);
	return { ...stub, trace: await extract(), extract, lane: String(lane) };
}

describe("the stub runs match their expected traces", () => {
	for (const name of ["t1", "t2"] as const)
		test(name, async () => {
			const expected = await Bun.file(
				join(import.meta.dir, "expected", `${name}.json`),
			).json();
			const { trace, repairs } = await performedTask(name);
			expect(diff(trace, expected)).toEqual([]);
			for (const attachment of ["── logs", "── spec"])
				expect(repairs[0]?.prompt).toContain(attachment);
		});
});

test("a trace's files are its last check's, and its target is clean only as setup left it", async () => {
	const { trace, extract, target } = await performedTask("t1", () => [
		{ write: "greet.sh", content: RIGHT },
		{ write: "NOTES.md", content: "repaired\n" },
		DONE,
	]);
	expect(trace).toMatchObject({ files: ["NOTES.md", "greet.sh"], clean: true });
	writeFileSync(join(target, "stray"), "");
	expect((await extract()).clean).toBe(false);
	rmSync(join(target, "stray"));
	git(target, "branch", "stray");
	expect((await extract()).clean).toBe(false);
});

test("a review relays the findings its skeptics upheld to its consolidator, and notes a lens that did not settle", async () => {
	const { dir, config, lane } = await performedTask("t1");
	const SKEPTIC = "lab-b/skeptic";
	const report = { summary: "done" };
	const finding = (id: string, issue: string) => ({
		id,
		where: "greet.sh:2",
		issue,
		cites: "Reuse",
		blocking: true,
	});
	const replies: [string, StubStep[]][] = [
		[
			"lens only: correctness",
			[
				replying({
					outcome: "rejected",
					reason: "F1 blocks",
					report,
					findings: [
						finding("F1", "upheld issue"),
						finding("F2", "overturned issue"),
					],
				}),
			],
		],
		[
			"lens only: the spec",
			[replying({ outcome: "ok", report, findings: [] })],
		],
		["lens only: the tests", []],
		[
			"Independent lenses",
			[
				{ write: `${OUTBOX}/review.md`, content: "Approved.\n" },
				replying({
					outcome: "ok",
					report,
					verdict: { criteria: [], upholds: [] },
				}),
			],
		],
	];
	const rulings = replying({
		outcome: "ok",
		report,
		rulings: [
			{ id: "F1", holds: true, why: "the code shows it" },
			{ id: "F2", holds: false, why: "the code refutes it" },
		],
	});
	const prompts: string[] = [];
	const reviewer = stubHarness((req) => {
		if (req.prompt.startsWith("Independent lenses")) prompts.push(req.prompt);
		return req.runtime.model === SKEPTIC
			? [rulings]
			: (replies.find(([task]) => req.prompt.includes(task))?.[1] ?? [
					done(req),
				]);
	});
	const ir = buildIr(
		panelReview,
		{ request: TASKS.t1.request, change: lane },
		{ toMarkdown, heldOf, tallyOf },
	);
	const run = await stubConcert(ir, {
		hosts: [repoHost({ harnesses: [reviewer] })],
		config: {
			...config,
			profiles: {
				...config.profiles,
				"classics/skeptic": { runtime: { ...RUNTIME, model: SKEPTIC } },
			},
		},
		roots: ROOTS,
		code: CODE,
		dir,
	});
	await run.close();
	expect(run.result).toMatchObject({ outcome: "ok", node: "panel/upheld" });
	const [task] = prompts;
	expect(task).toContain("## findings");
	expect(task).toContain("lens: correctness");
	expect(task).toContain("why: the code shows it");
	expect(task).not.toContain("overturned issue");
	expect(task).toMatch(/## unreviewed\n[^#]*lens: tests/);
});

test("a concert cancelled during its first repair resumes without rebuilding, and ends ok", async () => {
	let hung = false;
	const { dir, hosts, config, ir, builds } = await stubbed("t1", () => {
		if (hung) return FIX;
		hung = true;
		return [{ write: `${SESSION_DIR}/hanging`, content: "" }, { hang: true }];
	});
	const recordPath = join(dir, "record.db");
	const concert = await perform({
		ir,
		config: {
			values: { ...config, dataRoot: dir },
			sources: [],
			layers: [valuesLayer(config, { layer: "workspace" })],
		},
		roots: ROOTS,
		hosts,
		loadCode: async (ref) => CODE[ref.export] as CodeEntry,
		recordPath,
		dir,
		concurrency: 1,
	});
	const hanging = () =>
		builds[0] && Bun.file(join(builds[0].session.dir, "hanging")).exists();
	while (!(await hanging())) await Bun.sleep(POLL_MS);
	await concert.cancel();
	expect((await concert.done).outcome).toBe("failed");

	const run = await stubConcert(concert.id, {
		hosts,
		config,
		code: CODE,
		dir,
		roots: ROOTS,
	});
	await run.close();
	expect(run.result).toMatchObject({ outcome: "ok", node: "result" });
	expect(builds).toHaveLength(1);
	const record = openRecord(recordPath);
	const reused = record
		.events(concert.id)
		.filter((e) => e.type === "reused")
		.map((e) => e.node);
	record.close();
	expect(reused).toContain("build");
});

describe("compare", () => {
	test("diff names each differing field, and nothing for equal traces", () => {
		const a = { runs: ["agent"], outcome: "accepted", files: [], clean: true };
		expect(diff(a, { ...a })).toEqual([]);
		expect(diff(a, { ...a, runs: ["agent", "check"], clean: false })).toEqual([
			'runs: ["agent"] != ["agent","check"]',
			"clean: true != false",
		]);
	});

	test("sssf: legs by stage, the last leg's outcome, the series' files", async () => {
		const dir = tmp();
		await setup("t1", dir, RUNTIME);
		const series = join(dir, "series");
		mkdirSync(series);
		const patch = (file: string) =>
			`From 0 Mon Sep 17 00:00:00 2001\n---\ndiff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`;
		writeFileSync(join(series, "0001.patch"), patch("greet.sh"));
		writeFileSync(
			join(series, "0002.patch"),
			patch("greet.sh") + patch("README"),
		);
		writeFileSync(join(series, "notes.txt"), patch("ignored"));
		const leg = (n: number, stage: string, state: string) => ({
			ref: `p1.${n}`,
			performance_id: "p1",
			n,
			stage,
			edge: n === 1 ? "open" : "join",
			state,
			models: [],
			produced: {},
		});
		const view = {
			run_id: "r1",
			status: "success",
			run_dir: dir,
			series_dir: series,
			legs: [
				leg(1, "build", "accepted"),
				leg(2, "quality", "rejected"),
				leg(3, "fix", "accepted"),
				leg(4, "quality", "accepted"),
			],
		};
		expect(sssfTrace(view, dir)).toEqual({
			runs: ["agent", "check", "agent", "check"],
			outcome: "accepted",
			files: ["README", "greet.sh"],
			clean: true,
		});
		expect(() =>
			sssfTrace({ ...view, legs: [leg(1, "build", "running")] }, dir),
		).toThrow("leg p1.1 is running\nCompare a run that has ended");
	});
});
