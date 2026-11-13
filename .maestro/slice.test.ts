import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ArtifactRef,
	type CodeContext,
	reject,
	type Settled,
} from "@maestro/sdk";
import { JUDGED } from "./shared";
import { requirePatch } from "./slice";
import { call, classics, maestro, scratch, targetRepo } from "./testing/stub";

const finding = (id: string) => ({
	id,
	where: "a.ts:1",
	issue: "breaks CODING_STANDARDS.md Shape",
	cites: "Shape",
});

/** The checks a script can always fix, which no agent is offered (ADR 0016). */
const FORMAT_TOOLS = ["format", "fmt"];

/** Every check of the project's own config but the format tools: those an agent that works on the lane may run. */
const projectConfig = Bun.YAML.parse(
	readFileSync(".maestro/config.yaml", "utf8"),
) as { target: { checks: Record<string, unknown> } };
const projectChecks = Object.keys(projectConfig.target.checks).filter(
	(name) => !FORMAT_TOOLS.includes(name),
);

const granular = ["format", "lint", "types", "test", "fmt"].flatMap((name) => [
	"-c",
	`target.checks.${name}={run: "true", hint: ${name}}`,
]);

type Runtime = [string, string, string];
const LENSES: Record<string, Runtime> = {
	"classics/lens": ["claude", "claude-haiku-5-5", "medium"],
	"classics/deep-lens": ["claude", "claude-sonnet-5-5", "medium"],
	"classics/top-lens": ["claude", "claude-opus-5-5", "medium"],
	"classics/cross-lens": ["pi", "github-copilot/gpt-6.1-sol", "medium"],
};
const WRITER: Runtime = ["claude", "claude-haiku-5-5", "high"];

/** The runtime of each profile a risk preset seats, as `.maestro/presets/<risk>.yaml` and the config set it. */
const seated: [string, Record<string, Runtime>][] = [
	[
		"low",
		{
			...LENSES,
			"classics/builder": ["claude", "claude-sonnet-5-5", "low"],
			"classics/consolidator": ["claude", "claude-sonnet-5-5", "medium"],
			writer: WRITER,
		},
	],
	[
		"medium",
		{
			...LENSES,
			"classics/builder": ["claude", "claude-sonnet-5-5", "medium"],
			"classics/consolidator": ["claude", "claude-opus-5-5", "medium"],
			"classics/tester": ["pi", "github-copilot/gpt-6.1-terra", "medium"],
			writer: WRITER,
		},
	],
	[
		"high",
		{
			...LENSES,
			"classics/builder": ["claude", "claude-opus-5-5", "medium"],
			"classics/consolidator": ["claude", "claude-opus-5-5", "high"],
			"classics/tester": ["pi", "github-copilot/gpt-6.1-sol", "medium"],
			writer: WRITER,
		},
	],
];

/** The arguments that run `verb` on `.maestro/slice.ts` under the `presets`, with the packed classics. */
const slice = async (verb: string, ...presets: string[]) => [
	verb,
	".maestro/slice.ts",
	...presets.flatMap((p) => ["--preset", p]),
	"--request",
	"x",
	"--json",
	"-c",
	`packs=[${await classics}]`,
];

type Node = {
	id: string;
	config: {
		checks?: string[];
		check?: string;
		attachments?: Record<string, unknown>;
	};
	literals?: { floor?: string };
	out?: Record<string, unknown>;
};
type Edge = {
	from: { node: string; port?: string };
	to: { node: string; port?: string };
};

/** The plan and agents of `.maestro/slice.ts` composed under the `presets`, with `flags` after its request. */
async function composed(presets: string[], ...flags: string[]) {
	const out = await maestro([
		...(await slice("compose", ...presets)),
		...flags,
	]);
	const { plan, agents } = JSON.parse(out);
	return {
		nodes: plan.ir.nodes as Node[],
		edges: plan.ir.edges as Edge[],
		agents: agents as {
			node: string;
			profile: string;
			harness: string;
			model: string;
			thinking: string;
		}[],
	};
}

const from = (edges: Edge[], node: string, port: string) =>
	edges
		.filter((e) => e.to.node === node && e.to.port === port)
		.map((e) => e.from);

test.each(seated)(
	"under --preset %s, each agent runs its profile's runtime, and every agent that works on the lane may run the project's checks",
	async (risk, runtimes) => {
		const { nodes, agents } = await composed([risk]);
		for (const a of agents)
			expect([a.harness, a.model, a.thinking]).toEqual(
				runtimes[a.profile] ?? [],
			);
		expect(new Set(agents.map((a) => a.profile))).toEqual(
			new Set(Object.keys(runtimes)),
		);
		const workers = agents.filter(
			(a) => a.profile !== "writer" && a.profile !== "classics/consolidator",
		);
		for (const a of workers)
			expect(nodes.find((n) => n.id === a.node)?.config.checks).toEqual(
				projectChecks,
			);
		const fixes = nodes.filter((n) =>
			/gate\/(loop\[\d+\]\/)?(fix|refix)$/.test(n.id),
		);
		expect(fixes.length).toBeGreaterThan(0);
		for (const n of fixes) expect(n.config.check).toBe("fmt");
	},
);

test.each([
	["low", false, "small"],
	["medium", true, "small"],
	["high", true, "large"],
])(
	"under --preset %s, a tester is composed: %s, the build extends its lane, and the writer and the lenses read the build's spec; the review's floor is %s",
	async (risk, tested, floor) => {
		const { nodes, edges } = await composed([risk]);
		const ids = nodes.map((n) => n.id);
		expect(ids.includes("build/test_first/tester")).toBe(tested);
		if (tested)
			expect(from(edges, "build/test_first/build", "lane")).toEqual([
				{ node: "build/test_first/tester", port: "lane" },
			]);
		else {
			expect(ids).toContain("build/build");
			expect(nodes.find((n) => n.id === "build/build")?.config.checks).toEqual(
				projectChecks,
			);
		}
		const spec = [{ node: "build/spec", port: "file" }];
		expect(from(edges, "writer", "spec")).toEqual(spec);
		const lenses = ids.filter((id) => /tiered_review\/[^/]+\/lens$/.test(id));
		expect(lenses.length).toBeGreaterThan(0);
		for (const id of lenses) expect(from(edges, id, "spec")).toEqual(spec);
		for (const n of nodes.filter((n) => n.id.endsWith("/tieredOf")))
			expect(n.literals?.floor).toBe(floor);
	},
);

test("with only the stub preset, no tester is composed", async () => {
	const { nodes } = await composed(["stub"]);
	expect(nodes.map((n) => n.id)).not.toContain("build/test_first/tester");
});

test.each(["--risk", "--tier", "--max-fixes", "--max-repairs"])(
	"slice refuses %s as an unknown flag",
	async (flag) => {
		const ran = await call([...(await slice("compose", "low")), flag, "1"]);
		expect(ran.code).toBe(2);
		expect(ran.out).toContain(`unknown flag ${flag}`);
	},
);

test.each([
	[[], ["patches", "spec"]],
	[
		["--revises", "HEAD^!"],
		["patches", "revised", "spec"],
	],
])(
	"under --revises, the writer and the result node take the prior patches: flags %j attach %j, and the result is told how many lenses delivered and leaves the count as an output",
	async (flags, attached) => {
		const { nodes, edges } = await composed(["low"], ...flags);
		expect(from(edges, "result", "revised")).toEqual(
			from(edges, "writer", "revised"),
		);
		expect(from(edges, "result", "revised").length).toBe(
			attached.includes("revised") ? 1 : 0,
		);
		expect(from(edges, "result", "delivered")).toEqual([
			{ node: "fix_until_clean/fixes", port: "delivered" },
		]);
		expect(nodes.find((n) => n.id === "result")?.out).toHaveProperty(
			"delivered",
		);
		const writer = nodes.find((n) => n.id === "writer");
		expect(Object.keys(writer?.config.attachments ?? {}).sort()).toEqual(
			attached,
		);
	},
);

test.each(["low", "medium", "high"])(
	"under --preset %s, the consolidator rules by the slice's grounds",
	async (risk) => {
		const { nodes } = await composed([risk]);
		const judges = nodes.filter((n) => n.id.endsWith("/consolidator"));
		expect(judges.length).toBeGreaterThan(0);
		for (const n of judges)
			expect(JSON.stringify(n)).toContain(JSON.stringify(JUDGED).slice(1, -1));
	},
);

test("requirePatch returns a changeset that holds a patch, the writer's body unchanged, an empty body when the writer failed, and the delivered count given, 0 included, and rejects one that holds none; it renders the upheld findings once, grouped by cite", () => {
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
		counted: { delivered?: number } = { delivered: 1 },
	) =>
		requirePatch({ changeset: ref, upheld, ...counted, written }, {
			path: () => dir,
			scratch: ctx,
		} as unknown as CodeContext);
	const patched = made("base", "0001.patch");
	expect(run(patched, [{ outcome: "ok", value: pr }])).toEqual({
		changeset: ref,
		upheld: upheldFile,
		draft: false,
		notice: join(ctx, "notice.md"),
		pr,
		delivered: 1,
	});
	expect(readFileSync(join(ctx, "notice.md"), "utf8")).toBe("");
	expect(readFileSync(upheldFile, "utf8")).toBe("# Upheld findings\n\nNone.\n");
	const failed = run(patched, [{ outcome: "failed", reason: "x" }]);
	expect(failed).toEqual({
		changeset: ref,
		upheld: upheldFile,
		draft: false,
		notice: join(ctx, "notice.md"),
		pr: join(ctx, "pr.md"),
		delivered: 1,
	});
	expect(readFileSync(join(ctx, "pr.md"), "utf8")).toBe("");
	expect(run(patched, [], [], { delivered: 0 })).toMatchObject({
		delivered: 0,
	});
	expect(run(patched, [], [], {})).not.toHaveProperty("delivered");
	expect(run(made("base"), [])).toEqual(reject("the slice changed nothing"));

	run(
		patched,
		[],
		[
			{ ...finding("F1"), lens: "lens", why: "a.ts:1 shows it" },
			{ ...finding("F2"), lens: "deep-lens" },
			{ ...finding("F3"), lens: "deep-lens", cites: "R3" },
		],
	);
	expect(readFileSync(upheldFile, "utf8")).toBe(
		[
			"# Upheld findings",
			"",
			"### Shape",
			"",
			"- lens/F1, a.ts:1: breaks CODING_STANDARDS.md Shape",
			"  Upheld: a.ts:1 shows it",
			"- deep-lens/F2, a.ts:1: breaks CODING_STANDARDS.md Shape",
			"",
			"### R3",
			"",
			"- deep-lens/F3, a.ts:1: breaks CODING_STANDARDS.md Shape",
			"",
		].join("\n"),
	);
});

test("requirePatch drafts a change that leaves findings upheld, edits a held path or got no review, naming each reason in its notice", () => {
	const ctx = mkdtempSync(join(scratch, "draft-"));
	const dir = mkdtempSync(join(scratch, "patches-"));
	const run = (
		patch: string,
		upheld: Parameters<typeof requirePatch>[0]["upheld"],
		delivered = 1,
		revised?: string,
	) => {
		writeFileSync(join(dir, "0001.patch"), patch);
		const earlier = mkdtempSync(join(scratch, "revised-"));
		if (revised) writeFileSync(join(earlier, "0001.patch"), revised);
		const out = requirePatch(
			{
				changeset: { path: "c", contentHash: "sha256:0" },
				...(revised && { revised: { path: "r", contentHash: "sha256:1" } }),
				upheld,
				delivered,
				written: [],
			},
			{
				path: (ref: ArtifactRef) => (ref.path === "r" ? earlier : dir),
				scratch: ctx,
			} as unknown as CodeContext,
		);
		return [
			"draft" in out && out.draft,
			readFileSync(join(ctx, "notice.md"), "utf8"),
		];
	};
	const touching = (path: string) => `diff --git a/${path} b/${path}\n`;
	expect(run(touching("docs/rulings.md"), [])).toEqual([
		true,
		"Draft: this change edits `docs/rulings.md`, which the owner holds.\n",
	]);
	const quoted =
		'diff --git "a/docs/adr/\\303\\251.md" "b/docs/adr/\\303\\251.md"\n';
	expect(run(quoted, [])[1]).toBe(
		"Draft: this change edits `docs/adr/\\303\\251.md`, which the owner holds.\n",
	);
	expect(run(touching("src/a.ts"), [], 1, touching("docs/rulings.md"))[1]).toBe(
		"Draft: this change edits `docs/rulings.md`, which the owner holds.\n",
	);
	expect(run(touching("src/a.ts"), [], 0)).toEqual([
		true,
		"Draft: no lens delivered a review of this change.\n",
	]);
	expect(run(touching("docs/rulings.md"), [], 0)[1]).toBe(
		"Draft: no lens delivered a review of this change.\nDraft: this change edits `docs/rulings.md`, which the owner holds.\n",
	);
	expect(
		run(touching("src/a.ts"), [{ ...finding("F1"), lens: "spec" }]),
	).toEqual([
		true,
		"Draft: 1 finding remains upheld after the last fix round; see Unresolved review.\n",
	]);
	expect(
		run(touching("docs/adr/0001.md"), [{ ...finding("F1"), lens: "spec" }])[1],
	).toBe(
		"Draft: 1 finding remains upheld after the last fix round; see Unresolved review.\nDraft: this change edits `docs/adr/0001.md`, which the owner holds.\n",
	);
});

test.each(["low", "medium", "high"])(
	"a stub perform under --preset %s --preset stub settles ok",
	async (risk) => {
		const args = await slice("perform", risk, "stub");
		const ran = await call(
			[
				...args,
				"-c",
				`target.repo=${targetRepo()}`,
				"-c",
				'target.prepare="true"',
				"-c",
				'target.checks.all={run: "echo x > b.ts", hint: all}',
				...granular,
			],
			mkdtempSync(join(scratch, "data-")),
		);
		expect(JSON.parse(ran.out).status).toBe("ok");
	},
);
