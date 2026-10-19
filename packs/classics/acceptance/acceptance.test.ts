import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeEntry } from "@maestro/core/node";
import { concertDirs, openRecord, perform } from "@maestro/core/perform";
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
import {
	dossierOf,
	riskKey,
	survivorsOf,
	toMarkdown,
	traceOf,
} from "../src/code";
import builderIdentity from "../src/prompts/builder.md" with { type: "text" };
import consolidatorIdentity from "../src/prompts/consolidator.md" with {
	type: "text",
};
import documenterIdentity from "../src/prompts/documenter.md" with {
	type: "text",
};
import lensIdentity from "../src/prompts/lens.md" with { type: "text" };
import plannerIdentity from "../src/prompts/planner.md" with { type: "text" };
import scoutIdentity from "../src/prompts/scout.md" with { type: "text" };
import { buildThenRepair } from "../src/repair";
import { panelReview } from "../src/review";
import { vModel } from "../src/v-model";
import { diff, maestroTrace, sssfTrace } from "./compare";
import { BASE, git, rolesOn, setup } from "./setup";
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
const DONE = replying({ report: "done" });
const APPROVED = replying({ outcome: "ok", report: "done" });
/** The final reply that settles the agent of `req` ok, for its kind. */
const done = (req: HarnessRequest) => (req.verdict ? APPROVED : DONE);
const FIX: StubStep[] = [{ write: "greet.sh", content: RIGHT }, DONE];
const BLOCKED = replying({
	report: "tried",
	blocked: "the checks ask for two greetings at once",
});
const ROLE = { harness: "stub", model: "none" };
const CODE: Readonly<
	Record<string, (inputs: never, context: CodeContext) => unknown>
> = {
	...stdlib,
	toMarkdown,
	survivorsOf,
	dossierOf,
	traceOf,
	riskKey,
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
	const { target } = await setup(name, dir, ROLE);
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
		roles: rolesOn(ROLE),
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
	const run = await stubConcert(ir, { hosts, config, code: CODE, dir });
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
			for (const attachment of ["/in/logs", "/in/spec"])
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

test("a review keeps the findings its skeptics upheld, and notes a lens that did not settle", async () => {
	const { dir, config, lane } = await performedTask("t1");
	const SKEPTIC = "lab-b/skeptic";
	const write = (file: string, value: unknown): StubStep => ({
		write: `${OUTBOX}/${file}`,
		content: JSON.stringify(value),
	});
	const finding = (id: string, issue: string) => ({
		id,
		where: "greet.sh:2",
		issue,
		blocking: true,
	});
	const replies: [string, StubStep[]][] = [
		[
			"lens only: correctness",
			[
				write("findings.json", {
					clean: false,
					findings: [
						finding("F1", "upheld issue"),
						finding("F2", "overturned issue"),
					],
				}),
			],
		],
		[
			"lens only: the spec",
			[write("findings.json", { clean: true, findings: [] })],
		],
		["lens only: the tests", []],
		[
			"Independent lenses",
			[
				{ write: `${OUTBOX}/review.md`, content: "Approved.\n" },
				write("verdict.json", { approved: true, criteria: [], blocking: [] }),
			],
		],
	];
	const verdicts = write("verdicts.json", [
		{ id: "F1", holds: true, why: "the code shows it" },
		{ id: "F2", holds: false, why: "the code refutes it" },
	]);
	const reviewer = stubHarness((req) => [
		...(req.role.model === SKEPTIC
			? [verdicts]
			: (replies.find(([task]) => req.prompt.includes(task))?.[1] ?? [])),
		done(req),
	]);
	const ir = buildIr(
		panelReview,
		{ request: TASKS.t1.request, change: lane },
		{ toMarkdown, survivorsOf },
	);
	const run = await stubConcert(ir, {
		hosts: [repoHost({ harnesses: [reviewer] })],
		config: {
			...config,
			roles: { ...config.roles, skeptic: { ...ROLE, model: SKEPTIC } },
		},
		code: CODE,
		dir,
	});
	const kept = run.record
		.instances(run.id)
		.find((i) => i.node === "survivorsOf")?.outputs?.survivors;
	await run.close();
	expect(run.result).toMatchObject({ outcome: "ok", node: "consolidator" });
	const survivors = await Bun.file(
		join(concertDirs(dir, run.id).artifacts, String(Object(kept).path)),
	).text();
	expect(survivors).toContain(
		"## correctness\n\n- F1, greet.sh:2 (blocking): upheld issue\n  Upheld: the code shows it",
	);
	expect(survivors).not.toContain("F2");
	expect(survivors).toContain("## tests\n\nunverified: ");
	expect(survivors).not.toContain("## spec");
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
		config: { values: { ...config, dataRoot: dir }, sources: [] },
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

	const run = await stubConcert(concert.id, { hosts, config, code: CODE, dir });
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

describe("v_model", () => {
	const IDENTITIES = {
		scout: scoutIdentity,
		planner: plannerIdentity,
		builder: builderIdentity,
		lens: lensIdentity,
		consolidator: consolidatorIdentity,
		documenter: documenterIdentity,
	};
	const SEATS = [
		"scout",
		"planner",
		"builder",
		"lens",
		"consolidator",
		"documenter",
	] as const;
	type Seat = (typeof SEATS)[number];
	const A1 = "Read the name from the first argument.";
	const A2 = "Default the name to the world.";
	const A3 = "Rewrite greet.sh from scratch.";
	const PLAN = "Greet the first argument, else the world.\n";
	const RISK = "greet.sh ignores its argument";
	const out = (file: string, value: unknown): StubStep => ({
		write: `${OUTBOX}/${file}`,
		content: typeof value === "string" ? value : JSON.stringify(value),
	});
	const met = (id: string) => ({
		id,
		met: true,
		evidence: "sh test.sh passes",
	});

	type Script = {
		/** The approaches the planner gives. */
		approaches?: string[];
		/** The greet.sh the build of `approach` writes. */
		build?: (approach: string) => string;
		/** The criteria the documenter rules on. */
		accepted?: string[];
	};

	/** The steps of each seat. */
	const seats = ({
		approaches = [A1, A2],
		build = () => RIGHT,
		accepted = ["C1", "C2"],
	}: Script): Record<Seat, (req: HarnessRequest) => StubStep[]> => ({
		scout: () => [
			out("evidence.json", {
				summary: "greet.sh prints a fixed greeting",
				facts: [{ where: "greet.sh:2", note: "echoes a fixed string" }],
				risks: [{ risk: RISK, where: "greet.sh:2" }],
			}),
		],
		planner: () => [
			out("plan.md", PLAN),
			out("design.json", {
				criteria: ["C1", "C2"].map((id) => ({
					id,
					criterion: id,
					proof: "sh test.sh",
				})),
				approaches: approaches.map((approach, i) => ({
					id: `A${i + 1}`,
					approach,
				})),
			}),
		],
		builder: (req) => {
			const approach = approaches.find((a) => req.prompt.startsWith(a));
			return approach === undefined
				? []
				: [{ write: "greet.sh", content: build(approach) }];
		},
		lens: () => [out("findings.json", { clean: true, findings: [] })],
		consolidator: () => [
			out("review.md", "Approved.\n"),
			out("verdict.json", {
				approved: true,
				criteria: [met("C1"), met("C2")],
				blocking: [],
			}),
		],
		documenter: () => [
			out("notes.md", "greet.sh greets its argument.\n"),
			out("acceptance.json", accepted.map(met)),
		],
	});

	/** The seat whose identity the agent of `req` was given. */
	function seatOf(req: HarnessRequest): Seat {
		const identity = readFileSync(req.identity ?? "", "utf8");
		const seat = SEATS.find((name) => IDENTITIES[name] === identity);
		if (!seat) throw new Error("an agent has no identity of the pack's seats");
		return seat;
	}

	/** Performs v_model on T1 with every seat stubbed by `script`, and each seat's requests in order. */
	async function performed(script: Script = {}) {
		const dir = tmp();
		const { target } = await setup("t1", dir, ROLE);
		const asked = new Map<Seat, HarnessRequest[]>();
		const steps = seats(script);
		const harness = stubHarness((req) => {
			const seat = seatOf(req);
			asked.set(seat, [...(asked.get(seat) ?? []), req]);
			return [...steps[seat](req), done(req)];
		});
		const ir = buildIr(
			vModel,
			{ request: TASKS.t1.request },
			{ toMarkdown, dossierOf, survivorsOf, traceOf, riskKey },
		);
		const run = await stubConcert(ir, {
			hosts: [repoHost({ harnesses: [harness] })],
			config: {
				target: { repo: target, base: BASE, checks: TASKS.t1.checks },
				roles: rolesOn(ROLE),
			},
			code: CODE,
			dir,
		});
		const instances = run.record.instances(run.id);
		await run.close();
		const prompts = (seat: Seat) =>
			(asked.get(seat) ?? []).map((req) => req.prompt);
		return { ...run, dir, asked, prompts, instances };
	}

	/** The content of attachment `name` as the agent of `req` was given it. */
	const attached = (req: HarnessRequest | undefined, name: string) => {
		const bind = req?.readOnly?.find((b) => b.dst === `/in/${name}`);
		return bind && readFileSync(bind.src, "utf8");
	};

	test("delivers the changeset when every level holds", async () => {
		const run = await performed();
		expect(run.result).toMatchObject({ outcome: "ok", node: "result" });
		const [plan] = run.prompts("planner");
		for (const attachment of ["/in/request", "/in/dossier"])
			expect(plan).toContain(attachment);
		const [build, ...repairs] = run.prompts("builder");
		expect(build).toStartWith(A1);
		for (const attachment of ["/in/request", "/in/plan"])
			expect(build).toContain(attachment);
		expect(repairs).toEqual([]);
		const lenses = run.instances.filter((i) => i.node === "lenses/lens");
		expect(lenses.map((i) => i.expansion)).toEqual(["[R1]"]);
		const [lens] = run.asked.get("lens") ?? [];
		expect(lens?.prompt).toStartWith(RISK);
		expect(attached(lens, "spec")).toBe(PLAN);
		expect(run.prompts("consolidator")[0]).toContain("/in/design");
		for (const attachment of ["/in/design", "/in/review", "/in/patches"])
			expect(run.prompts("documenter")[0]).toContain(attachment);
		const traced = run.instances.find((i) => i.node === "traceOf");
		expect(traced?.status).toBe("ok");
	});

	test("is rejected at the trace when the documenter leaves a criterion out", async () => {
		const run = await performed({ accepted: ["C1"] });
		expect(run.result).toMatchObject({
			outcome: "rejected",
			node: "traceOf",
			reason: expect.stringContaining(
				"trace gaps: C2 has no acceptance ruling (trace.md has the matrix).",
			),
		});
	});

	test("takes the second approach when the first stays red after its repairs", async () => {
		const run = await performed({
			build: (approach) => (approach === A1 ? WRONG : RIGHT),
		});
		expect(run.result).toMatchObject({ outcome: "ok", node: "result" });
		const built = run
			.prompts("builder")
			.flatMap((p) => [A1, A2].filter((a) => p.startsWith(a)));
		expect(built).toEqual([A1, A2]);
		const repairs = run.instances.filter(
			(i) => i.node === "approaches/repair_until_green/loop/repair",
		);
		expect(repairs).toHaveLength(TASKS.t1.maxRepairs);
		const series = String(Object(run.result.outputs?.changeset).path);
		const patches = join(concertDirs(run.dir, run.id).artifacts, series);
		const text = readdirSync(patches)
			.map((f) => readFileSync(join(patches, f), "utf8"))
			.join("");
		expect(text).toContain("name=world");
	});

	test("fails at the planner, before any build, when it gives more approaches than maxApproaches", async () => {
		const run = await performed({ approaches: [A1, A2, A3] });
		expect(run.result).toMatchObject({
			outcome: "failed",
			node: "plan",
			reason: expect.stringContaining("/out/design.json"),
		});
		expect(run.asked.get("builder")).toBeUndefined();
	});
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
		await setup("t1", dir, ROLE);
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
