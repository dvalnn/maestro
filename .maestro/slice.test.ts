import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ArtifactRef,
	type CodeContext,
	reject,
	type Settled,
} from "@maestro/sdk";
import { requirePatch, upheldOf } from "./slice";
import {
	call,
	classics,
	maestro,
	scratch,
	stubbed,
	stubOutputs,
	targetRepo,
} from "./stub";

const ctx = { scratch } as CodeContext;

const finding = (id: string, blocking: boolean) => ({
	id,
	where: "a.ts:1",
	issue: "breaks CODING_STANDARDS.md Shape",
	blocking,
});
const found = {
	clean: false,
	findings: [finding("F1", true), finding("F2", true), finding("F3", false)],
};
const held = (...ids: string[]) =>
	["F1", "F2", "F3"].map((id) => ({ id, holds: ids.includes(id), why: "" }));
const verdict = (blocking: string[]) => ({
	approved: !blocking.length,
	criteria: [],
	blocking,
});

const lane = "c.gate";
const session = "c.build";
const cases: [string, Parameters<typeof upheldOf>[0], string[]][] = [
	[
		"a clean lens",
		{ lane, session, lens: "c.reviewer", findings: { ...found, clean: true } },
		[],
	],
	["no skeptic", { lane, session, findings: found }, ["F1", "F2"]],
	[
		"a skeptic's holds",
		{
			lane,
			session,
			findings: found,
			verdicts: [{ outcome: "ok", value: held("F2", "F3") }],
		},
		["F2"],
	],
	[
		"a failed skeptic",
		{
			lane,
			session,
			findings: found,
			verdicts: [{ outcome: "failed", reason: "x" }],
		},
		["F1", "F2"],
	],
	[
		"a skipped skeptic",
		{ lane, session, findings: found, verdicts: [{ outcome: "skipped" }] },
		["F1", "F2"],
	],
	[
		"a malformed skeptic's verdicts",
		{
			lane,
			session,
			findings: found,
			verdicts: [{ outcome: "rejected", reason: "schema" }],
		},
		["F1", "F2"],
	],
	[
		"a consolidator's blocking list",
		{ lane, session, verdict: verdict(["F9"]) },
		["F9"],
	],
	["an approving consolidator", { lane, session, verdict: verdict([]) }, []],
];

const granular = ["format", "lint", "types", "test"].flatMap((name) => [
	"-c",
	`target.checks.${name}={run: "true", hint: ${name}}`,
]);

test.each(cases)(
	"upheldOf keeps the upheld blocking findings after %s, and carries the lane and sessions",
	(_, rulings, ids) => {
		const out = upheldOf(rulings, ctx);
		expect(out).toMatchObject({ lane, session, clean: !ids.length });
		expect(out.lens).toBe(rulings.lens);
		const upheld: string[] =
			readFileSync(out.upheld, "utf8").match(/F\d/g) ?? [];
		expect(upheld).toEqual(ids);
	},
);

test("upheldOf hands the fixer the skeptic's why under each upheld finding", () => {
	const verdicts = held("F2").map((v) =>
		v.holds ? { ...v, why: "a.ts:1 returns before the write" } : v,
	);
	const out = upheldOf(
		{
			lane,
			session,
			findings: found,
			verdicts: [{ outcome: "ok", value: verdicts }],
		},
		ctx,
	);
	expect(readFileSync(out.upheld, "utf8")).toContain(
		"- F2, a.ts:1: breaks CODING_STANDARDS.md Shape\n  Upheld: a.ts:1 returns before the write",
	);
});

test("upheldOf marks each finding unverified when no skeptic ruled on it", () => {
	const out = upheldOf(
		{
			lane,
			session,
			findings: found,
			verdicts: [{ outcome: "failed", reason: "x" }],
		},
		ctx,
	);
	const upheld = readFileSync(out.upheld, "utf8");
	for (const id of ["F1", "F2"])
		expect(upheld).toContain(
			`- ${id}, a.ts:1: breaks CODING_STANDARDS.md Shape\n  Unverified: no skeptic ruled on it`,
		);
	expect(upheld).not.toContain("Upheld:");
});

/** The runtime of each profile a tier seats, as `.maestro/presets/<tier>.yaml` sets it, and the writer's profile. */
const seated: [string, Record<string, [string, string]>][] = [
	[
		"small",
		{
			"classics/builder": ["claude-sonnet-5-5", "low"],
			"classics/lens": ["claude-opus-5-5", "medium"],
			"classics/skeptic": ["claude-sonnet-5-5", "low"],
			writer: ["claude-haiku-5-5", "high"],
		},
	],
	[
		"ordinary",
		{
			"classics/builder": ["claude-sonnet-5-5", "medium"],
			"classics/lens": ["claude-opus-5-5", "medium"],
			"classics/consolidator": ["claude-opus-5-5", "medium"],
			writer: ["claude-haiku-5-5", "high"],
		},
	],
	[
		"risky",
		{
			"classics/builder": ["claude-opus-5-5", "medium"],
			"classics/lens": ["claude-sonnet-5-5", "high"],
			"classics/consolidator": ["claude-opus-5-5", "high"],
			writer: ["claude-haiku-5-5", "high"],
		},
	],
];

/** The arguments that run `verb` on `.maestro/slice.ts` under `--preset tier` with the packed classics. */
const slice = async (verb: string, tier: string) => [
	verb,
	".maestro/slice.ts",
	"--preset",
	tier,
	"--request",
	"x",
	"--tier",
	tier,
	"--json",
	"-c",
	`packs=[${await classics}]`,
];

test.each(seated)(
	"under --preset %s, the gate's repair agent may run the target's check, and each agent runs its tier's classics profile",
	async (tier, runtimes) => {
		const out = await maestro(await slice("compose", tier));
		const { plan, agents } = JSON.parse(out);
		const repairs = plan.ir.nodes.filter((n: { id: string }) =>
			n.id.startsWith("gate/loop/repair"),
		);
		expect(repairs.length).toBeGreaterThan(0);
		for (const n of repairs) expect(n.config.checks).toEqual(["all"]);
		type Agent = {
			profile: string;
			harness: string;
			model: string;
			thinking: string;
		};
		for (const a of agents as Agent[])
			expect([a.harness, a.model, a.thinking]).toEqual([
				"claude",
				...(runtimes[a.profile] ?? []),
			]);
		expect(new Set((agents as Agent[]).map((a) => a.profile))).toEqual(
			new Set(Object.keys(runtimes)),
		);
	},
);

test.each([
	[true, "ok"],
	[false, "rejected"],
])(
	"a stub perform under --preset small continues the builder and the lens in their sessions across review rounds, and changing files %s settles %s, returning the last round's upheld findings",
	async (changes) => {
		const tier = "small";
		const target = targetRepo();
		const flagged = {
			clean: false,
			findings: [finding("F1", true)],
		};
		const outputs = stubOutputs({
			"reviewer/findings.json": flagged,
			"fixes[0]/reviewer/findings.json": flagged,
			"skeptic/verdicts.json": held("F1"),
			"fixes/skeptic/verdicts.json": held("F1"),
		});
		const data = mkdtempSync(join(scratch, "data-"));
		const ran = await call(
			[
				...(await slice("perform", tier)),
				"-c",
				`target.repo=${target}`,
				"-c",
				'target.prepare="true"',
				"-c",
				`target.checks.all={run: ${JSON.stringify(changes ? "echo x > b.ts" : "true")}, hint: all}`,
				...granular,
				...stubbed(Object.keys(new Map(seated).get(tier) ?? {})),
			],
			data,
			{ MAESTRO_STUB_OUTPUTS: outputs },
		);
		const performed = JSON.parse(ran.out);
		expect([performed.status, performed.reason]).toEqual(
			changes ? ["ok", undefined] : ["rejected", "the slice changed nothing"],
		);
		if (changes) {
			expect(
				await maestro(["cs", "show", performed.id, "-C", target], data),
			).toContain("b.ts");
			const upheld = join(performed.artifacts, performed.outputs.upheld.path);
			expect(readFileSync(upheld, "utf8")).toContain("None.");
		}
		type Instance = {
			node: string;
			expansion: string;
			outputs?: { session?: string };
		};
		const { instances }: { instances: Instance[] } = JSON.parse(
			await maestro(["ls", performed.id, "--json"], data),
		);
		const sessions = (node: string) =>
			instances
				.filter((i) => i.node === node)
				.map((i) => [i.expansion, i.outputs?.session]);
		const { id } = performed;
		expect(sessions("fixes/fix")).toEqual([
			["[0]", `${id}.build`],
			["[1]", `${id}.build`],
		]);
		expect(sessions("fixes/reviewer")).toEqual([
			["[0]", `${id}.reviewer`],
			["[1]", `${id}.reviewer`],
		]);
	},
);

test("under --tier small, the reviewer may run every check, and a later round's reviewer is attached the findings upheld before", async () => {
	const out = await maestro(await slice("compose", "small"));
	type Edge = {
		from: { node: string; port?: string };
		to: { node: string; port?: string };
	};
	type Node = {
		id: string;
		config: { checks?: string[]; attachments: Record<string, unknown> };
	};
	const { nodes, edges }: { nodes: Node[]; edges: Edge[] } =
		JSON.parse(out).plan.ir;
	const into = (node: string, port: string) =>
		edges.filter((e) => e.to.node === node && e.to.port === port);
	const reviewers = nodes.filter((n) => /(^|\/)reviewer$/.test(n.id));
	expect(reviewers.length).toBeGreaterThan(1);
	for (const n of reviewers) expect(n.config.checks).toEqual(["all"]);
	const first = reviewers.find((n) => n.id === "reviewer");
	const later = reviewers.find((n) => n.id === "fixes/reviewer");
	expect(Object.keys(first?.config.attachments ?? {}).sort()).toEqual([
		"patches",
		"spec",
	]);
	expect(Object.keys(later?.config.attachments ?? {}).sort()).toEqual([
		"patches",
		"spec",
		"upheld",
	]);
	expect(into("fixes/reviewer", "upheld").map((e) => e.from)).toEqual([
		{ node: "fixes", port: "upheld" },
	]);
});

test.each(["small", "ordinary", "risky"])(
	"under --tier %s, every skeptic and the consolidator rule by the slice's grounds",
	async (tier) => {
		const { plan } = JSON.parse(await maestro(await slice("compose", tier)));
		const judges = (plan.ir.nodes as { id: string }[]).filter((n) =>
			/(^|\/)(skeptic|consolidator)$/.test(n.id),
		);
		expect(judges.length).toBeGreaterThan(0);
		for (const n of judges)
			for (const ground of [
				"its subject and closing line",
				"A test must pull weight",
			])
				expect(JSON.stringify(n)).toContain(ground);
	},
);

/** Per tier, the stub outputs of a review whose lenses reject with F1, and the node of the skeptic that clears it, if the tier has one. */
const rejecting: [
	string,
	string | undefined,
	string[],
	Record<string, unknown>,
][] = [
	[
		"small",
		"skeptic",
		["classics/builder", "classics/lens", "classics/skeptic", "writer"],
		{
			"reviewer/findings.json": {
				clean: false,
				findings: [finding("F1", true)],
			},
			"reviewer/verdict": "rejected F1",
			"skeptic/verdicts.json": held(),
		},
	],
	...["ordinary", "risky"].map(
		(tier): [string, undefined, string[], Record<string, unknown>] => [
			tier,
			undefined,
			["classics/builder", "classics/lens", "classics/consolidator", "writer"],
			{
				"lenses/lens/findings.json": {
					clean: false,
					findings: [finding("F1", true)],
				},
				"lenses/lens/verdict": "rejected F1",
				"consolidator/verdict.json": verdict([]),
			},
		],
	),
];

test.each(rejecting)(
	"under --tier %s, a lens that rejects meets a skeptic only where the tier seats one, and a cleared or dismissed finding calls for no fix",
	async (tier, skeptic, profiles, scripted) => {
		const data = mkdtempSync(join(scratch, "data-"));
		const ran = await call(
			[
				...(await slice("perform", tier)),
				"-c",
				`target.repo=${targetRepo()}`,
				"-c",
				'target.prepare="true"',
				"-c",
				'target.checks.all={run: "echo x > b.ts", hint: all}',
				...granular,
				...granular,
				...stubbed(profiles),
			],
			data,
			{ MAESTRO_STUB_OUTPUTS: stubOutputs(scripted) },
		);
		const { id, status } = JSON.parse(ran.out);
		expect(status).toBe("ok");
		const { instances }: { instances: { node: string; status: string }[] } =
			JSON.parse(await maestro(["ls", id, "--json"], data));
		const statusOf = (node: string) =>
			instances.filter((i) => i.node === node).map((i) => i.status);
		if (skeptic) expect(statusOf(skeptic)).not.toEqual([]);
		const seated = instances.filter((i) => i.node.endsWith("skeptic"));
		expect(seated.filter((i) => i.node !== skeptic)).toEqual([]);
		expect(seated.every((i) => i.status === "ok")).toBe(true);
		expect(statusOf("fixes/fix")).toEqual([]);
	},
);

test("requirePatch returns a changeset that holds a patch, the upheld findings and the writer's body unchanged, an empty body when the writer failed, and rejects one that holds none", () => {
	const made = (...files: string[]) => {
		const dir = mkdtempSync(join(scratch, "changeset-"));
		for (const f of files) writeFileSync(join(dir, f), "x");
		return dir;
	};
	const ref = { path: "c", contentHash: "sha256:0" };
	const upheld = { path: "u", contentHash: "sha256:1" };
	const pr = { path: "p", contentHash: "sha256:2" };
	const ctx = mkdtempSync(join(scratch, "result-"));
	const run = (dir: string, written: Settled<ArtifactRef>[]) =>
		requirePatch({ changeset: ref, upheld, written }, {
			path: () => dir,
			scratch: ctx,
		} as unknown as CodeContext);
	const patched = made("base", "0001.patch");
	expect(run(patched, [{ outcome: "ok", value: pr }])).toEqual({
		changeset: ref,
		upheld,
		pr,
	});
	const failed = run(patched, [{ outcome: "failed", reason: "x" }]);
	expect(failed).toEqual({ changeset: ref, upheld, pr: join(ctx, "pr.md") });
	expect(readFileSync(join(ctx, "pr.md"), "utf8")).toBe("");
	expect(run(made("base"), [])).toEqual(reject("the slice changed nothing"));
});

test("a stub perform under --preset ordinary --preset stub stubs every seat the presets name", async () => {
	const args = (await slice("perform", "ordinary")).toSpliced(
		4,
		0,
		"--preset",
		"stub",
	);
	const composed = JSON.parse(await maestro(["compose", ...args.slice(1)]));
	const harnesses = (composed.agents as { harness: string }[]).map(
		(a) => a.harness,
	);
	expect(harnesses.length).toBeGreaterThan(0);
	expect(new Set(harnesses)).toEqual(new Set(["stub"]));
	const target = targetRepo();
	const ran = await call(
		[
			...args,
			"-c",
			`target.repo=${target}`,
			"-c",
			'target.prepare="true"',
			"-c",
			'target.checks.all={run: "echo x > b.ts", hint: all}',
			...granular,
		],
		mkdtempSync(join(scratch, "data-")),
	);
	expect(JSON.parse(ran.out).status).toBe("ok");
});
