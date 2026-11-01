import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef, CodeContext, Type } from "@maestro/sdk";
import { readJson } from "@maestro/sdk/stdlib";
import {
	call,
	classics,
	maestro,
	scratch,
	stubbed,
	stubOutputs,
	targetRepo,
} from "./stub";
import {
	answersOf,
	classify,
	Proposal,
	Ruling,
	settle,
	type Triage,
} from "./triage";

const CONTRACT = "touches packages/ir/src/a.ts, which set a contract";
const LOW = "touches only docs and tests, 3 paths or fewer";
const many = (n: number) =>
	Array.from({ length: n }, (_, i) => `packages/cli/src/f${i}.ts`);

const risks: [string, string[], boolean, string, string[]][] = [
	["a contract path", ["packages/ir/src/a.ts"], false, "high", [CONTRACT]],
	[
		"a contract path given as ./",
		["./packages/ir/src/a.ts"],
		false,
		"high",
		[CONTRACT],
	],
	[
		"a contract directory given bare",
		["packages/ir"],
		false,
		"high",
		["touches packages/ir, which set a contract"],
	],
	[
		"a manifest",
		["packs/classics/package.json"],
		false,
		"high",
		["touches packs/classics/package.json, which set a contract"],
	],
	["8 paths", many(8), false, "high", ["touches 8 paths, 8 or more"]],
	[
		"the planner's flag",
		["packages/cli/src/a.ts"],
		true,
		"high",
		["the planner flags a contract it sets"],
	],
	[
		"3 docs and tests",
		["docs/a.md", "docs/b.md", "packages/cli/src/a.test.ts"],
		false,
		"low",
		[LOW],
	],
	[
		"4 docs",
		["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"],
		false,
		"medium",
		[],
	],
	["a source file", ["packages/cli/src/a.ts"], false, "medium", []],
	["no paths", [], false, "medium", []],
];

test.each(risks)("classify rules %s", (_, touches, contract, risk, reasons) => {
	expect(classify(touches, contract)).toMatchObject({ risk, reasons });
});

const areas: [string, string[], Triage["area"]][] = [
	[
		"core, on a tie with cli",
		["packages/sdk/a.ts", "packages/cli/a.ts"],
		"core",
	],
	[
		"cli, on a tie with host",
		["packages/render-text/a.ts", "packages/harness-pi/a.ts"],
		"cli",
	],
	[
		"host, on a tie with packs",
		["packages/host-repo-sdk/a.ts", "packs/classics/a.ts"],
		"host",
	],
	["packs, on a tie with docs", ["packs/classics/a.ts", "docs/a.md"], "packs"],
	[
		"docs, holding most paths",
		["packages/core/a.ts", "docs/a.md", "docs/b.md"],
		"docs",
	],
	["absent, when no path is in an area", ["README.md"], undefined],
];

test.each(areas)("classify's area is %s", (_, touches, area) => {
	expect(classify(touches, false).area).toBe(area);
});

const askAlone = (ask: string) => ({ ask, options: [], context: [] });

const spec = {
	what: "Make greet.sh greet by name.",
	steps: ["Read the first argument", "Print it"],
	acceptance: ["bun test packages/cli/src/a.test.ts"],
	subject: "feat(cli): greet by name",
};
const unspecified = {
	touches: ["packages/cli/src/a.ts"],
	contract: false,
	questions: [],
};
const ready: Proposal = { verdict: "ready-for-agent", ...unspecified, spec };
const medium: Pick<Triage, "risk" | "area" | "reasons"> = {
	risk: "medium",
	area: "cli",
	reasons: [],
};

const groups = [
	{ id: "G1", area: "the flag", questions: ["Where are flags parsed?"] },
	{ id: "G2", area: "the tests", questions: ["Which test covers greet?"] },
];
const planning: Ruling = {
	verdict: "plan",
	files: ["packages/cli/src/a.ts"],
	groups,
	questions: [],
};
const planned = (proposal: Proposal) => ({
	ruling: planning,
	proposal: [{ outcome: "ok" as const, value: proposal }],
});

const overrides: [string, Proposal, Triage][] = [
	[
		"no paths into needs-info",
		{ ...ready, touches: [] },
		{
			verdict: "needs-info",
			risk: "medium",
			reasons: [],
			questions: [askAlone("Which paths does the change create or edit?")],
		},
	],
	[
		"paths outside the repo into needs-info",
		{ ...ready, touches: ["../x.ts", "/etc/y"] },
		{
			verdict: "needs-info",
			risk: "medium",
			reasons: [],
			questions: [
				askAlone(
					"Which repo-relative paths does the change touch in place of ../x.ts, /etc/y?",
				),
			],
		},
	],
	[
		"no runnable acceptance into needs-info",
		{ ...ready, spec: { ...spec, acceptance: ["greet.sh greets by name"] } },
		{
			verdict: "needs-info",
			...medium,
			questions: [
				askAlone(
					"Which command proves the change done? Acceptance commands start with bun, bunx, just, mise.",
				),
			],
		},
	],
	[
		"a high-risk ready into needs-approval",
		{ ...ready, contract: true },
		{
			verdict: "needs-approval",
			risk: "high",
			area: "cli",
			reasons: ["the planner flags a contract it sets"],
			questions: [],
			spec: { touches: ready.touches, ...spec },
		},
	],
	[
		"a split whose child depends on a later one or itself into needs-info",
		{
			verdict: "split",
			...unspecified,
			children: [
				{ title: "a", body: "first", dependsOn: [1] },
				{ title: "b", body: "second", dependsOn: [1] },
			],
		},
		{
			verdict: "needs-info",
			...medium,
			questions: [
				askAlone(
					'Child 0 ("a") depends on 1, which is not an earlier child: which child does it need?',
				),
				askAlone(
					'Child 1 ("b") depends on 1, which is not an earlier child: which child does it need?',
				),
			],
		},
	],
];

test.each(overrides)("settle turns %s", (_, proposal, triage) => {
	expect(settle(planned(proposal))).toEqual({ triage });
});

test.each([
	["low", ["docs/a.md"]],
	["medium", ["packages/cli/src/a.ts"]],
	["high", ["packages/ir/src/a.ts"]],
])(
	"settle sends a ready proposal with a question to needs-info at %s risk",
	(risk, touches) => {
		const { triage } = settle(
			planned({ ...ready, touches, questions: [askAlone("Greet whom?")] }),
		);
		expect(triage).toMatchObject({
			verdict: "needs-info",
			risk,
			questions: [askAlone("Greet whom?")],
		});
		expect(triage.spec).toBeUndefined();
	},
);

const claiming: Proposal["questions"][number] = {
	ask: "Where should a loose file's config live?",
	lead: "A loose file has params.",
	options: [
		{ label: "A", text: "top-level keys" },
		{ label: "B", text: "a files. namespace" },
	],
	recommend: { label: "B", why: "it keeps D-24." },
	context: [{ topic: "D-24", text: "A shared config breaks nothing." }],
};
const straying = { ...claiming, recommend: { label: "C", why: "no reason" } };

test("settle fails when the triager handed the issue on and the planner gave nothing", () => {
	expect(() =>
		settle({ ruling: planning, proposal: [{ outcome: "skipped" }] }),
	).toThrow("the planner gave no proposal");
});

test("settle drops a recommendation naming none of its question's options, keeping the rest", () => {
	const { recommend: _, ...kept } = straying;
	const { triage } = settle(
		planned({
			...unspecified,
			verdict: "needs-info",
			questions: [straying, claiming],
		}),
	);
	expect(triage.questions).toStrictEqual([kept, claiming]);
});

test("answersOf merges each group's answer in order, marking one whose scout failed unanswered", () => {
	const dir = mkdtempSync(join(scratch, "answers-"));
	mkdirSync(join(dir, "a"));
	writeFileSync(join(dir, "a/answer.md"), "In flags.ts:12.\n");
	const ctx = {
		scratch: dir,
		path: (ref: ArtifactRef) => join(dir, ref.path),
	} as CodeContext;
	const answer = { path: "a/answer.md", contentHash: "sha256:0" };
	const { answers } = answersOf(
		{
			groups,
			scouts: [
				{ outcome: "ok", value: { evidence: answer } },
				{ outcome: "failed", reason: "timed out" },
			],
		},
		ctx,
	);
	expect(readFileSync(answers, "utf8")).toBe(
		[
			"# The scouts' answers",
			"",
			"## G1: the flag",
			"",
			"1. Where are flags parsed?",
			"",
			"In flags.ts:12.",
			"",
			"## G2: the tests",
			"",
			"1. Which test covers greet?",
			"",
			"Unanswered: the scout failed: timed out.",
			"",
		].join("\n"),
	);
});

const children = [
	{ title: "a", body: "first", dependsOn: [] },
	{ title: "b", body: "second", dependsOn: [0] },
];

const backlog = join(scratch, "backlog.md");
writeFileSync(backlog, "# Backlog\n\n- #7 Greet\n");

/** The arguments that run `verb` on `.maestro/triage.ts` under `--preset triage` with the packed classics. */
const triage = async (verb: string, ...flags: string[]) => [
	verb,
	".maestro/triage.ts",
	"--preset",
	"triage",
	"--issue",
	"#1 Greet by name",
	...flags,
	"--json",
	"-c",
	`packs=[${await classics}]`,
];

type Instance = {
	node: string;
	expansion: string;
	status: string;
	outputs?: Record<string, { path?: string }>;
};

/** A stub perform of the triage, the triager ruling `ruling` and the planner proposing `proposal`. */
async function performed(ruling: Ruling, proposal?: Proposal) {
	const outputs = stubOutputs({
		"triager/ruling.json": ruling,
		"triager/backlog.md": "- #7 Greet: it greets too\n",
		"scouts[G1]/scout/answer.md": "G1: in flags.ts:12.\n",
		"scouts[G2]/scout/answer.md": "G2: in greet.test.ts:3.\n",
		...(proposal && { "planner/plan.json": proposal }),
	});
	const data = mkdtempSync(join(scratch, "data-"));
	const concert = JSON.parse(
		await maestro(
			[
				...(await triage("perform", "--backlog", backlog)),
				"-c",
				`target.repo=${targetRepo()}`,
				"-c",
				'target.prepare="true"',
				...stubbed(["triager", "classics/scout", "classics/planner"]),
			],
			data,
			{ MAESTRO_STUB_OUTPUTS: outputs },
		),
	);
	const { instances }: { instances: Instance[] } = JSON.parse(
		await maestro(["ls", concert.id, "--json"], data),
	);
	const statuses = (node: string) =>
		instances.filter((i) => i.node === node).map((i) => i.status);
	const artifact = (node: string, port: string) => {
		const path = instances.find((i) => i.node === node)?.outputs?.[port]?.path;
		const area = join(data, "maestro/concerts", concert.id, "artifacts");
		return readFileSync(join(area, path ?? ""), "utf8");
	};
	return { concert, statuses, artifact };
}

/** Each verdict a stub perform settles: the triager's ruling, the planner's proposal if it plans, and the output. */
const verdicts: [string, Ruling, Proposal | undefined, Triage][] = [
	[
		"ready-for-agent",
		planning,
		{ ...ready, related: [7] },
		{
			verdict: "ready-for-agent",
			...medium,
			questions: [],
			spec: { touches: ready.touches, ...spec },
			related: [7],
		},
	],
	[
		"needs-approval",
		planning,
		{ ...ready, touches: ["packages/ir/src/a.ts"] },
		{
			verdict: "needs-approval",
			risk: "high",
			area: "core",
			reasons: [CONTRACT],
			questions: [],
			spec: { touches: ["packages/ir/src/a.ts"], ...spec },
		},
	],
	[
		"needs-info from the planner",
		planning,
		{
			...unspecified,
			verdict: "needs-info",
			questions: [askAlone("Greet whom?")],
		},
		{ verdict: "needs-info", ...medium, questions: [askAlone("Greet whom?")] },
	],
	[
		"split",
		planning,
		{ verdict: "split", ...unspecified, children },
		{ verdict: "split", ...medium, questions: [], children },
	],
	[
		"an early duplicate",
		{ ...planning, verdict: "duplicate", groups: [], duplicateOf: 7 },
		undefined,
		{ verdict: "duplicate", ...medium, questions: [], duplicateOf: 7 },
	],
	[
		"needs-info from an early duplicate that asks a question",
		{
			...planning,
			verdict: "duplicate",
			groups: [],
			questions: [askAlone("Is #7 the same?")],
			duplicateOf: 7,
		},
		undefined,
		{
			verdict: "needs-info",
			...medium,
			questions: [askAlone("Is #7 the same?")],
		},
	],
	[
		"an early needs-info",
		{
			...planning,
			verdict: "needs-info",
			groups: [],
			questions: [askAlone("Greet whom?")],
			related: [7],
		},
		undefined,
		{
			verdict: "needs-info",
			...medium,
			questions: [askAlone("Greet whom?")],
			related: [7],
		},
	],
];

test.each(verdicts)(
	"a stub perform settles ok as %s, with a triage output of that shape, and a planner and a scout per group only when the triager plans",
	async (_, ruling, proposal, expected) => {
		const { concert, statuses, artifact } = await performed(ruling, proposal);
		expect(concert.status).toBe("ok");
		expect(concert.outputs.triage).toEqual(expected);
		const ran = proposal ? "ok" : "skipped";
		expect([statuses("scouts"), statuses("planner")]).toEqual([[ran], [ran]]);
		if (!proposal) return;
		expect(statuses("scouts/scout")).toEqual(["ok", "ok"]);
		const answers = artifact("answers", "answers");
		expect(answers).toContain("## G1: the flag");
		expect(answers.indexOf("G1: in flags.ts:12.")).toBeLessThan(
			answers.indexOf("G2: in greet.test.ts:3."),
		);
	},
);

/** The composed plan of the triage, with `--backlog`. */
const composed = async () =>
	JSON.parse(await maestro(await triage("compose", "--backlog", backlog)));

test("compose seats the triager on sonnet, the scouts on haiku and the planner on opus at high, the rest at medium", async () => {
	const { agents } = await composed();
	const seated = (
		agents as { profile: string; model: string; thinking: string }[]
	)
		.map((a) => [a.profile, a.model, a.thinking])
		.sort();
	expect(seated).toEqual([
		["classics/planner", "claude-opus-5-5", "high"],
		["classics/scout", "claude-haiku-5-5", "medium"],
		["triager", "claude-sonnet-5-5", "medium"],
	]);
});

test("the scouts and the planner are attached the triager's cut of the backlog, never the snapshot", async () => {
	const { plan } = await composed();
	type Node = { id: string; literals?: Record<string, unknown> };
	type Edge = {
		from: { node: string; port: string };
		to: { node: string; port: string };
	};
	const node = (id: string) =>
		(plan.ir.nodes as Node[]).find((n) => n.id === id);
	const snapshot = Object.values(node("triager")?.literals ?? {}).find(
		(v) => typeof v === "object",
	);
	expect(snapshot).toBeDefined();
	for (const id of ["scouts/scout", "planner"]) {
		expect(JSON.stringify(node(id))).not.toContain(JSON.stringify(snapshot));
		const fed = (plan.ir.edges as Edge[]).find(
			(e) => e.to.node === id && e.to.port === "backlog",
		);
		expect(fed?.from).toEqual({ node: "triager", port: "backlog" });
	}
});

/** A JSON output per conditional rule of the schemas, and whether the engine's readJson takes it. */
const outputs: [string, Type<unknown>, object, boolean][] = [
	["a ready proposal", Proposal, ready, true],
	["a planning ruling", Ruling(4), planning, true],
	[
		"a needs-info proposal asking with options, a recommendation and context",
		Proposal,
		{
			...unspecified,
			verdict: "needs-info",
			questions: [claiming, askAlone("Who?")],
		},
		true,
	],
	[
		"a needs-info proposal asking a string",
		Proposal,
		{ ...unspecified, verdict: "needs-info", questions: ["Who?"] },
		false,
	],
	[
		"a needs-info ruling whose recommendation has no why",
		Ruling(4),
		{
			...planning,
			verdict: "needs-info",
			questions: [{ ...claiming, recommend: { label: "B" } }],
		},
		false,
	],
	[
		"a ready proposal whose spec has no steps",
		Proposal,
		{ ...ready, spec: { ...spec, steps: undefined } },
		false,
	],
	[
		"a ready proposal with no spec",
		Proposal,
		{ ...unspecified, verdict: "ready-for-agent" },
		false,
	],
	[
		"a split proposal with no children",
		Proposal,
		{ ...unspecified, verdict: "split" },
		false,
	],
	[
		"a split proposal with empty children",
		Proposal,
		{ ...unspecified, verdict: "split", children: [] },
		false,
	],
	[
		"a needs-info proposal with no question",
		Proposal,
		{ ...unspecified, verdict: "needs-info" },
		false,
	],
	[
		"a duplicate ruling with no duplicateOf",
		Ruling(4),
		{ ...planning, verdict: "duplicate" },
		false,
	],
	[
		"a needs-info ruling with no question",
		Ruling(4),
		{ ...planning, verdict: "needs-info" },
		false,
	],
	["a ruling with more groups than maxGroups", Ruling(1), planning, false],
];

test.each(outputs)(
	"readJson of %s takes it: %p",
	async (_, type, value, ok) => {
		const file = join(mkdtempSync(join(scratch, "off-")), "off.json");
		writeFileSync(file, JSON.stringify(value));
		const ctx = { path: (ref: ArtifactRef) => ref.path } as CodeContext;
		const read = await readJson(
			{ file: { path: file, contentHash: "sha256:0" }, schema: type.schema },
			ctx,
		);
		expect("value" in read).toBe(ok);
	},
);

test("compose refuses a missing --backlog", async () => {
	const args = (await triage("compose")).filter((a) => a !== "--json");
	const { code, err } = await call(args);
	expect(code).toBe(2);
	expect(err).toContain(
		"param 'backlog' (--backlog) of 'triage.triage' is required",
	);
});
