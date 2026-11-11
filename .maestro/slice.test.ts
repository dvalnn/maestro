import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ArtifactRef,
	type CodeContext,
	reject,
	type Settled,
} from "@maestro/sdk";
import { requirePatch, reviewedOf } from "./slice";
import { JUDGED } from "./slice/lenses";
import {
	call,
	classics,
	maestro,
	scratch,
	stubbed,
	stubOutputs,
	targetRepo,
} from "./testing/stub";

const _ctx = { scratch } as CodeContext;

const finding = (id: string, blocking: boolean) => ({
	id,
	where: "a.ts:1",
	issue: "breaks CODING_STANDARDS.md Shape",
	cites: "Shape",
	blocking,
});
const found = [finding("F1", true), finding("F2", true), finding("F3", false)];
const held = (...ids: string[]) =>
	["F1", "F2", "F3"].map((id) => ({ id, holds: ids.includes(id), why: "" }));

const lane = "c.gate";
const session = "c.build";
const reviewer = "c.reviewer";
type Rulings = Parameters<typeof reviewedOf>[0]["rulings"];
const cases: [string, Rulings, string[]][] = [
	["a skeptic's holds", [{ outcome: "ok", value: held("F2", "F3") }], ["F2"]],
	["a failed skeptic", [{ outcome: "failed", reason: "x" }], ["F1", "F2"]],
	["a skipped skeptic", [{ outcome: "skipped" }], ["F1", "F2"]],
	[
		"a skeptic that rejected with rulings",
		[{ outcome: "rejected", reason: "x", value: held("F2") }],
		["F2"],
	],
	[
		"a malformed skeptic's rulings",
		[{ outcome: "rejected", reason: "schema" }],
		["F1", "F2"],
	],
];

/** The checks of the project's own config, every one of which an agent that works on the lane may run. */
const projectConfig = Bun.YAML.parse(
	readFileSync(".maestro/config.yaml", "utf8"),
) as { target: { checks: Record<string, unknown> } };
const projectChecks = Object.keys(projectConfig.target.checks);

const granular = ["format", "lint", "types", "test", "fmt"].flatMap((name) => [
	"-c",
	`target.checks.${name}={run: "true", hint: ${name}}`,
]);

test.each(cases)(
	"reviewedOf upholds the blocking findings that survive %s, and carries the lane and sessions",
	(_, rulings, ids) => {
		const out = reviewedOf({
			lane,
			session,
			reviewer,
			findings: found,
			rulings,
		});
		expect(out).toMatchObject({
			outcome: "rejected",
			outputs: { lane, session, reviewer },
		});
		const upheld = "outputs" in out ? (out.outputs?.upheld ?? []) : [];
		expect(upheld.map((f) => f.id)).toEqual(ids);
	},
);

test("reviewedOf tallies a reviewer with no findings clean, and still carries the reviewer's session", () => {
	expect(
		reviewedOf({
			lane,
			session,
			reviewer,
			findings: [],
			rulings: [{ outcome: "skipped" }],
		}),
	).toEqual({ lane, session, reviewer, upheld: [] });
});

/** The runtime of each profile a tier seats, as `.maestro/presets/<tier>.yaml` sets it, and the writer's profile. */
const seated: [string, Record<string, [string, string, string]>][] = [
	[
		"small",
		{
			"classics/builder": ["claude", "claude-sonnet-5-5", "low"],
			"classics/lens": ["claude", "claude-opus-5-5", "medium"],
			"classics/skeptic": ["claude", "claude-sonnet-5-5", "low"],
			writer: ["claude", "claude-haiku-5-5", "high"],
		},
	],
	[
		"ordinary",
		{
			"classics/builder": ["claude", "claude-sonnet-5-5", "medium"],
			"classics/lens": ["claude", "claude-opus-5-5", "medium"],
			"classics/consolidator": ["claude", "claude-opus-5-5", "medium"],
			"classics/tester": ["pi", "github-copilot/gpt-6.1-terra", "medium"],
			writer: ["claude", "claude-haiku-5-5", "high"],
		},
	],
	[
		"risky",
		{
			"classics/builder": ["claude", "claude-opus-5-5", "medium"],
			"classics/lens": ["claude", "claude-sonnet-5-5", "high"],
			"classics/consolidator": ["claude", "claude-opus-5-5", "high"],
			"classics/tester": ["pi", "github-copilot/gpt-6.1-sol", "medium"],
			writer: ["claude", "claude-haiku-5-5", "high"],
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
	"under --preset %s, the gate's repair agent may run every check of the project's config, and each agent runs its tier's classics profile",
	async (tier, runtimes) => {
		const out = await maestro(await slice("compose", tier));
		const { plan, agents } = JSON.parse(out);
		const repairs = plan.ir.nodes.filter((n: { id: string }) =>
			n.id.startsWith("gate/loop/repair"),
		);
		expect(repairs.length).toBeGreaterThan(0);
		for (const n of repairs) expect(n.config.checks).toEqual(projectChecks);
		const fixes = plan.ir.nodes.filter((n: { id: string }) =>
			/^gate\/(loop\[\d+\]\/)?(fix|refix)$/.test(n.id),
		);
		expect(fixes.length).toBeGreaterThan(0);
		for (const n of fixes) expect(n.config.check).toBe("fmt");
		type Agent = {
			profile: string;
			harness: string;
			model: string;
			thinking: string;
		};
		for (const a of agents as Agent[])
			expect([a.harness, a.model, a.thinking]).toEqual(
				runtimes[a.profile] ?? [],
			);
		expect(new Set((agents as Agent[]).map((a) => a.profile))).toEqual(
			new Set(Object.keys(runtimes)),
		);
	},
);

test.each([
	[true, "ok"],
	[false, "rejected"],
])(
	"a stub perform under --preset small continues the builder and the reviewer in their sessions across review rounds, and changing files %s settles %s, shipping the findings still upheld at the fix cap",
	async (changes) => {
		const tier = "small";
		const target = targetRepo();
		const flagged = [finding("F1", true)];
		const outputs = stubOutputs({
			"reviewer/findings.json": flagged,
			"reviewer/verdict": "rejected F1",
			"fixes[0]/reviewer/findings.json": flagged,
			"fixes[0]/reviewer/verdict": "rejected F1",
			"fixes[1]/reviewer/findings.json": flagged,
			"fixes[1]/reviewer/verdict": "rejected F1",
			"skeptic/rulings.json": held("F1"),
			"fixes/skeptic/rulings.json": held("F1"),
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
			expect(readFileSync(upheld, "utf8")).toContain("- reviewer/F1, a.ts:1:");
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

test("under --tier small, the reviewer may run every check of the project's config, and a later round's reviewer is relayed the findings upheld before", async () => {
	const out = await maestro(await slice("compose", "small"));
	type Edge = {
		from: { node: string; port?: string };
		to: { node: string; port?: string };
	};
	type Node = {
		id: string;
		config: {
			checks?: string[];
			attachments: Record<string, unknown>;
			relay?: { name: string }[];
		};
	};
	const { nodes, edges }: { nodes: Node[]; edges: Edge[] } =
		JSON.parse(out).plan.ir;
	const into = (node: string, port: string) =>
		edges.filter((e) => e.to.node === node && e.to.port === port);
	const reviewers = nodes.filter((n) => /(^|\/)reviewer$/.test(n.id));
	expect(reviewers.length).toBeGreaterThan(1);
	for (const n of reviewers) expect(n.config.checks).toEqual(projectChecks);
	const first = reviewers.find((n) => n.id === "reviewer");
	const later = reviewers.find((n) => n.id === "fixes/reviewer");
	expect(Object.keys(first?.config.attachments ?? {}).sort()).toEqual([
		"patches",
		"spec",
	]);
	expect(Object.keys(later?.config.attachments ?? {}).sort()).toEqual([
		"patches",
		"spec",
	]);
	expect(first?.config.relay?.map((r) => r.name)).toEqual(["builder"]);
	expect(later?.config.relay?.map((r) => r.name)).toEqual([
		"upheld",
		"builder",
	]);
	expect(into("fixes/reviewer", "upheld").map((e) => e.from)).toEqual([
		{ node: "fixes", port: "upheld" },
	]);
});

test("under --tier ordinary, the build extends the tester's lane, and the build and the writer read the tester's map as a relay", async () => {
	const out = await maestro(await slice("compose", "ordinary"));
	type Edge = {
		from: { node: string; port?: string };
		to: { node: string; port?: string };
	};
	const { edges }: { edges: Edge[] } = JSON.parse(out).plan.ir;
	const from = (node: string, port: string) =>
		edges
			.filter((e) => e.to.node === node && e.to.port === port)
			.map((e) => e.from);
	expect(from("tested/build", "lane")).toEqual([
		{ node: "tested/tester", port: "lane" },
	]);
	for (const seat of ["tested/build", "writer"]) {
		expect(from(seat, "map")).toEqual([{ node: "tested/tester", port: "map" }]);
	}
});

test.each([
	[[], ["patches", "spec"]],
	[
		["--revises", "HEAD^!"],
		["patches", "revised", "spec"],
	],
])("the writer is attached, with %j, %j", async (flags, attached) => {
	const out = await maestro([...(await slice("compose", "small")), ...flags]);
	const {
		nodes,
	}: { nodes: { id: string; config: { attachments: object } }[] } =
		JSON.parse(out).plan.ir;
	const writer = nodes.find((n) => n.id === "writer");
	expect(Object.keys(writer?.config.attachments ?? {}).sort()).toEqual(
		attached,
	);
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
			expect(JSON.stringify(n)).toContain(JSON.stringify(JUDGED).slice(1, -1));
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
			"reviewer/findings.json": [finding("F1", true)],
			"reviewer/verdict": "rejected F1",
			"skeptic/rulings.json": held(),
		},
	],
	...["ordinary", "risky"].map(
		(tier): [string, undefined, string[], Record<string, unknown>] => [
			tier,
			undefined,
			[
				"classics/builder",
				"classics/lens",
				"classics/consolidator",
				"classics/tester",
				"writer",
			],
			{
				"panel/lenses/lens/findings.json": [finding("F1", true)],
				"panel/lenses/lens/verdict": "rejected F1",
				"panel/consolidator/verdict.json": { criteria: [], upholds: [] },
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

test("requirePatch returns a changeset that holds a patch, the writer's body unchanged, an empty body when the writer failed, and rejects one that holds none; it renders the upheld findings once, grouped by cite", () => {
	const made = (...files: string[]) => {
		const dir = mkdtempSync(join(scratch, "changeset-"));
		for (const f of files) writeFileSync(join(dir, f), "x");
		return dir;
	};
	const ref = { path: "c", contentHash: "sha256:0" };
	const pr = { path: "p", contentHash: "sha256:2" };
	const ctx = mkdtempSync(join(scratch, "result-"));
	const upheldFile = join(ctx, "upheld.md");
	const run = (
		dir: string,
		written: Settled<ArtifactRef>[],
		upheld: Parameters<typeof requirePatch>[0]["upheld"] = [],
	) =>
		requirePatch({ changeset: ref, upheld, written }, {
			path: () => dir,
			scratch: ctx,
		} as unknown as CodeContext);
	const patched = made("base", "0001.patch");
	expect(run(patched, [{ outcome: "ok", value: pr }])).toEqual({
		changeset: ref,
		upheld: upheldFile,
		pr,
	});
	expect(readFileSync(upheldFile, "utf8")).toBe("# Upheld findings\n\nNone.\n");
	const failed = run(patched, [{ outcome: "failed", reason: "x" }]);
	expect(failed).toEqual({
		changeset: ref,
		upheld: upheldFile,
		pr: join(ctx, "pr.md"),
	});
	expect(readFileSync(join(ctx, "pr.md"), "utf8")).toBe("");
	expect(run(made("base"), [])).toEqual(reject("the slice changed nothing"));

	run(
		patched,
		[],
		[
			{ ...finding("F1", true), lens: "correctness", why: "a.ts:1 shows it" },
			{ ...finding("F2", true), lens: "spec" },
			{ ...finding("F3", true), lens: "spec", cites: "R3" },
		],
	);
	expect(readFileSync(upheldFile, "utf8")).toBe(
		[
			"# Upheld findings",
			"",
			"### Shape",
			"",
			"- correctness/F1, a.ts:1: breaks CODING_STANDARDS.md Shape",
			"  Upheld: a.ts:1 shows it",
			"- spec/F2, a.ts:1: breaks CODING_STANDARDS.md Shape",
			"  Unverified: no skeptic ruled on it",
			"",
			"### R3",
			"",
			"- spec/F3, a.ts:1: breaks CODING_STANDARDS.md Shape",
			"  Unverified: no skeptic ruled on it",
			"",
		].join("\n"),
	);
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

test.each(["small", "ordinary", "risky"])(
	"under --tier %s, every review seat is relayed the builder's brief from a briefOf node",
	async (tier) => {
		const { nodes, edges } = JSON.parse(
			await maestro(await slice("compose", tier)),
		).plan.ir as {
			nodes: {
				id: string;
				type?: string;
				config: { seat?: string; relay?: { name: string }[] };
			}[];
			edges: {
				from: { node: string; port?: string };
				to: { node: string; port?: string };
			}[];
		};
		const seats = nodes.filter((n) =>
			/(^|\/)(reviewer|skeptic|lens|consolidator)$/.test(n.id),
		);
		expect(seats.length).toBeGreaterThan(1);
		for (const n of seats) {
			expect(n.config.relay?.map((r) => r.name).at(-1)).toBe("builder");
			const from = edges.filter(
				(e) => e.to.node === n.id && e.to.port === "builder",
			);
			expect(from.length).toBeGreaterThan(0);
			expect(from.every((e) => e.from.node.endsWith("brief"))).toBe(true);
		}
	},
);
