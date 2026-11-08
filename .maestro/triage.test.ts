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
import { answersOf } from "./triage";
import {
	askAlone,
	CONTRACT,
	claiming,
	failed,
	groups,
	medium,
	planning,
	ready,
	spec,
	unspecified,
} from "./triage/fixtures";
import { type Checked, Proposal, Ruling, type Triage } from "./triage/verdict";

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
				{ outcome: "ok", value: { answer } },
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
async function performed(
	ruling: Ruling,
	proposal?: Proposal,
	check: Checked = { findings: [] },
	revision?: Proposal,
) {
	const outputs = stubOutputs({
		"triager/ruling.json": ruling,
		"triager/backlog.md": "- #7 Greet: it greets too\n",
		"scouts[G1]/scout/answer.md": "G1: in flags.ts:12.\n",
		"scouts[G2]/scout/answer.md": "G2: in greet.test.ts:3.\n",
		...(proposal && {
			"planner/plan.json": proposal,
			"checker/check.json": check,
		}),
		...(revision && { "revise/plan.json": revision }),
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
				...stubbed([
					"triager",
					"classics/scout",
					"classics/planner",
					"checker",
				]),
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

const direct: Ruling = {
	...planning,
	verdict: "direct",
	groups: [],
	what: spec.what,
	requirements: spec.requirements,
	acceptance: spec.acceptance,
	subject: spec.subject,
};

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
			tier: "ordinary",
			area: "core",
			reasons: [CONTRACT],
			questions: [],
			spec: { touches: ["packages/ir/src/a.ts"], ...spec },
		},
	],
	[
		"ready-for-agent from a direct ruling",
		direct,
		undefined,
		{
			verdict: "ready-for-agent",
			...medium,
			questions: [],
			spec: {
				touches: direct.files,
				what: spec.what,
				requirements: spec.requirements,
				decisions: [],
				excluded: [],
				acceptance: [...spec.acceptance, "just check"],
				subject: spec.subject,
				brief: true,
			},
		},
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
	"a stub perform settles ok as %s, with a triage output of that shape, a planner and a scout per group only when the triager plans, and the checker only on a ready proposal",
	async (_, ruling, proposal, expected) => {
		const { concert, statuses, artifact } = await performed(ruling, proposal);
		expect(concert.status).toBe("ok");
		expect(concert.outputs.triage).toEqual(expected);
		const ran = proposal ? "ok" : "skipped";
		expect([statuses("scouts"), statuses("planner")]).toEqual([[ran], [ran]]);
		const checked = proposal?.verdict === "ready-for-agent" ? "ok" : "skipped";
		expect(statuses("checker")).toEqual([checked]);
		expect(statuses("revise")).toEqual(["skipped"]);
		if (!proposal) return;
		expect(statuses("scouts/scout")).toEqual(["ok", "ok"]);
		const answers = artifact("answers", "answers");
		expect(answers).toContain("## G1: the flag");
		expect(answers.indexOf("G1: in flags.ts:12.")).toBeLessThan(
			answers.indexOf("G2: in greet.test.ts:3."),
		);
	},
);

const offShape = "Greet.sh shall greet the name.";

test.each([
	["a failing check's findings", ready, [failed], failed],
	[
		"a requirement off the EARS shape",
		{ ...ready, spec: { ...spec, requirements: [offShape] } },
		[],
		"R1 breaks the EARS shape",
	],
])(
	"a stub perform has the planner revise a ready spec by %s, asking its questions",
	async (_, proposal, findings, finding) => {
		const revised = { ...ready, spec: { ...spec, what: "revised" } };
		const { concert, statuses, artifact } = await performed(
			planning,
			proposal,
			{ findings },
			{ ...revised, questions: [claiming] },
		);
		expect(concert.status).toBe("ok");
		expect(statuses("revise")).toEqual(["ok"]);
		expect(artifact("revisable", "findings")).toContain(finding);
		expect(concert.outputs.triage).toMatchObject({
			verdict: "needs-info",
			questions: [claiming],
		});
		expect(concert.outputs.triage.spec.what).toBe("revised");
	},
);

/** The composed plan of the triage, with `--backlog`. */
const composed = async () =>
	JSON.parse(await maestro(await triage("compose", "--backlog", backlog)));

test("compose seats the triager on sonnet, the scouts on haiku, the planner and its revision on opus at high and the spec checker on terra at medium", async () => {
	const { agents } = await composed();
	const seated = (
		agents as { profile: string; model: string; thinking: string }[]
	)
		.map((a) => [a.profile, a.model, a.thinking])
		.sort();
	expect(seated).toEqual([
		["checker", "github-copilot/gpt-6.1-terra", "medium"],
		["classics/planner", "claude-opus-5-5", "high"],
		["classics/planner", "claude-opus-5-5", "high"],
		["classics/scout", "claude-haiku-5-5", "medium"],
		["triager", "claude-sonnet-5-5", "medium"],
	]);
});

test("only the triager is given the question format", async () => {
	const { plan } = await composed();
	const task = (id: string) =>
		JSON.stringify(
			(plan.ir.nodes as { id: string }[]).find((n) => n.id === id),
		);
	expect(task("triager")).toContain("## Questions for the owner");
	for (const id of ["planner", "checker"])
		expect(task(id)).not.toContain("## Questions for the owner");
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

test("an encore starts the planner and the checker fresh, and continues the triager and scouts", async () => {
	const { plan } = await composed();
	const encoreOf = (id: string) =>
		(plan.ir.nodes as { id: string; config?: { encore?: boolean } }[]).find(
			(n) => n.id === id,
		)?.config?.encore;
	expect(encoreOf("planner")).toBe(false);
	expect(encoreOf("checker")).toBe(false);
	expect(encoreOf("triager")).toBeUndefined();
	expect(encoreOf("scouts/scout")).toBeUndefined();
});

/** A JSON output per conditional rule of the schemas, and whether the engine's readJson takes it. */
const outputs: [string, Type<unknown>, object, boolean][] = [
	["a ready proposal", Proposal, ready, true],
	[
		"a ready proposal whose spec has no decisions",
		Proposal,
		{ ...ready, spec: { ...spec, decisions: undefined } },
		false,
	],
	[
		"a ready proposal whose decision has no points",
		Proposal,
		{ ...ready, spec: { ...spec, decisions: [{ lead: "Name source" }] } },
		false,
	],
	[
		"a split proposal with a spec",
		Proposal,
		{
			...unspecified,
			verdict: "split",
			children: [{ title: "a", body: "b", dependsOn: [] }],
			spec,
		},
		false,
	],
	[
		"a ready proposal with children",
		Proposal,
		{ ...ready, children: [{ title: "a", body: "b", dependsOn: [] }] },
		false,
	],
	["a planning ruling", Ruling(4), planning, true],
	[
		"a needs-info ruling asking with options, a recommendation and context",
		Ruling(4),
		{
			...planning,
			verdict: "needs-info",
			questions: [claiming, askAlone("Who?")],
		},
		true,
	],
	[
		"a needs-info ruling asking a string",
		Ruling(4),
		{ ...planning, verdict: "needs-info", questions: ["Who?"] },
		false,
	],
	["a direct ruling", Ruling(4), direct, true],
	[
		"a direct ruling with no subject",
		Ruling(4),
		{ ...direct, subject: undefined },
		false,
	],
	[
		"a direct ruling with no requirements",
		Ruling(4),
		{ ...direct, requirements: [] },
		false,
	],
	[
		"a direct ruling with more requirements than a brief holds",
		Ruling(4),
		{ ...direct, requirements: ["R1", "R2", "R3", "R4"] },
		false,
	],
	[
		"a direct ruling with no acceptance",
		Ruling(4),
		{ ...direct, acceptance: undefined },
		false,
	],
	["a direct ruling with no files", Ruling(4), { ...direct, files: [] }, false],
	[
		"a direct ruling with more files than a direct build takes",
		Ruling(4),
		{ ...direct, files: ["a.ts", "b.ts", "c.ts", "d.ts"] },
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
		"a ready proposal whose spec carries steps",
		Proposal,
		{ ...ready, spec: { ...spec, steps: ["Print it"] } },
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
		"a needs-info proposal",
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

test("compose needs no --backlog from another directory: the example set names a sample beside the composition", async () => {
	const args = (await triage("compose")).map((a) =>
		a === ".maestro/triage.ts" ? join(import.meta.dir, "triage.ts") : a,
	);
	const { code, err } = await call(
		args,
		undefined,
		{},
		join(import.meta.dir, "../packages"),
	);
	expect(err).toBe("");
	expect(code).toBe(0);
});
