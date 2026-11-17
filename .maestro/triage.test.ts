import { expect, test } from "bun:test";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Answers } from "@maestro/classics";
import type { ArtifactRef, CodeContext, Type, ValueOf } from "@maestro/sdk";
import { readJson } from "@maestro/sdk/stdlib";
import {
	call,
	classics,
	maestro,
	root,
	scratch,
	stubbed,
	stubOutputs,
	targetRepo,
} from "./testing/stub";
import { answersOf, climbedAnswersOf, sketchesOf } from "./triage";
import {
	askAlone,
	bugIssue,
	CONTRACT,
	claiming,
	diagnosing,
	failed,
	grounded,
	groups,
	medium,
	planning,
	premiseFinding,
	ready,
	spec,
	unspecified,
	unsure,
	yagniFinding,
} from "./triage/fixtures";
import { Checked, Proposal, Question, Ruling, Triage } from "./triage/schemas";

// Seam: the compiler's diagnostics for the triage port fixtures.
function rejectsExtraField(file: string) {
	const dir = mkdtempSync(join(scratch, "fixture-types-"));
	cpSync(join(root, ".maestro"), join(dir, ".maestro"), {
		recursive: true,
		verbatimSymlinks: true,
	});
	for (const entry of [
		"node_modules",
		"packages",
		"packs",
		"scripts",
		"tsconfig.json",
		"md.d.ts",
	])
		symlinkSync(join(root, entry), join(dir, entry));

	const path = join(dir, file);
	const source = readFileSync(path, "utf8");
	const grounded = [
		...source.matchAll(
			/\{[^{}]*\bstate\s*:\s*["']grounded["'](?:\s+as\s+const)?\s*,[^{}]*\}/g,
		),
	];
	expect(grounded).toHaveLength(1);
	const object = grounded[0];
	if (!object || object.index === undefined)
		throw new Error("grounded fixture not found");
	const missing = /\bmissing\s*:/.exec(object[0]);
	const position = object.index + (missing?.index ?? 1);
	const changed = missing
		? source
		: `${source.slice(0, position)}\nmissing: "",${source.slice(position)}`;
	writeFileSync(path, changed);
	const line =
		changed.slice(0, position).split("\n").length + (missing ? 0 : 1);
	const run = Bun.spawnSync(
		[
			process.execPath,
			join(root, "node_modules/typescript/bin/tsc"),
			"--noEmit",
			"--pretty",
			"false",
		],
		{ cwd: dir },
	);
	expect(run.exitCode).not.toBe(0);
	expect(
		run.stdout
			.toString()
			.split("\n")
			.some(
				(diagnostic) =>
					diagnostic.startsWith(`${file}(${line},`) &&
					diagnostic.includes("error TS2353:"),
			),
	).toBe(true);
}

test("the compiler rejects a grounded fixture carrying missing", () => {
	for (const file of [".maestro/triage.test.ts", ".maestro/triage/fixtures.ts"])
		rejectsExtraField(file);
}, 60_000);

test("sketchesOf gathers each sketch in order, marking one whose designer failed as missing", () => {
	const dir = mkdtempSync(join(scratch, "sketches-"));
	const sketch = join(dir, "sketch.md");
	writeFileSync(sketch, "greet(name)\n");
	const ctx = {
		scratch: dir,
		path: (ref: ArtifactRef) => ref.path,
	} as CodeContext;
	const gathered = sketchesOf(
		{
			sketches: [
				{ outcome: "failed", reason: "timed out" },
				{ outcome: "ok", value: { path: sketch } as ArtifactRef },
			],
		},
		ctx,
	);
	expect(readFileSync(gathered.sketches, "utf8")).toBe(
		[
			"# The designers' sketches",
			"",
			"## Sketch 1",
			"",
			"Missing: the designer failed: timed out.",
			"",
			"## Sketch 2",
			"",
			"greet(name)",
			"",
		].join("\n"),
	);
});

test("answersOf merges each group's answers in order, marking an unsure answer and a group whose scout failed", () => {
	const dir = mkdtempSync(join(scratch, "answers-"));
	const ctx = { scratch: dir } as CodeContext;
	const answers: ValueOf<typeof Answers> = [
		{
			question: "Where are flags parsed?",
			state: "grounded",
			answer: "In flags.ts:12.",
		},
		{
			question: "Who calls it?",
			state: "unsure",
			missing: "the caller outside src/",
			answer: "Probably cli.ts.",
		},
	];
	const merged = answersOf(
		{
			groups,
			scouts: [
				{ outcome: "ok", value: { answers } },
				{ outcome: "failed", reason: "timed out" },
			],
		},
		ctx,
	);
	expect(readFileSync(merged.answers, "utf8")).toBe(
		[
			"# The scouts' answers",
			"",
			"## G1: the flag",
			"",
			"1. Where are flags parsed?",
			"",
			"### Where are flags parsed?",
			"",
			"In flags.ts:12.",
			"",
			"### Who calls it?",
			"",
			"Probably cli.ts.",
			"",
			"Unsure, missing: the caller outside src/",
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

const reproduction = "the reproduction: greet.sh does not exist in the lane";

test("climbedAnswersOf keys each exhausted answer by its group's slot and question number, unique across groups sharing a question", () => {
	const ctx = {
		scratch: mkdtempSync(join(scratch, "climbed-")),
	} as CodeContext;
	const asked = [grounded.question, unsure.question];
	const twin = { id: "G1", area: "twin", questions: asked };
	const climb = (slot: string) => ({
		slot,
		id: "G1",
		area: "twin",
		unsure: [{ question: unsure.question, missing: reproduction }],
	});
	const scouted = {
		outcome: "ok" as const,
		value: { answers: [grounded, unsure] },
	};
	const climbed = climbedAnswersOf(
		{
			groups: [twin, twin],
			scouts: [scouted, scouted],
			climbs: [climb("G1"), climb("G2")],
			deeps: [
				{
					outcome: "ok",
					value: {
						answers: [
							{ ...unsure, state: "unsure" as const, missing: "the cause" },
						],
					},
				},
				{ outcome: "failed", reason: "timed out" },
			],
		},
		ctx,
	);
	expect(climbed.exhausted).toEqual([
		{ key: "G1.2", question: unsure.question, missing: "the cause" },
		{ key: "G2.2", question: unsure.question, missing: reproduction },
	]);
	const file = readFileSync(climbed.answers, "utf8");
	expect(file).toContain("Exhausted (G1.2), missing: the cause");
	expect(file).toContain(`Exhausted (G2.2), missing: ${reproduction}`);
	expect(file.split(grounded.answer)).toHaveLength(3);
});

test("climbedAnswersOf takes a later group's scout-deep answer when an earlier group is wholly grounded", () => {
	const ctx = {
		scratch: mkdtempSync(join(scratch, "climbed-")),
	} as CodeContext;
	const resolved = {
		...grounded,
		question: unsure.question,
		answer: "The cause is greet.sh:3.",
	};
	const climbed = climbedAnswersOf(
		{
			groups: [
				{ id: "G1", area: "known", questions: [grounded.question] },
				{ id: "G2", area: "unknown", questions: [unsure.question] },
			],
			scouts: [
				{ outcome: "ok", value: { answers: [grounded] } },
				{ outcome: "ok", value: { answers: [unsure] } },
			],
			climbs: [
				{
					slot: "G2",
					id: "G2",
					area: "unknown",
					unsure: [{ question: unsure.question, missing: reproduction }],
				},
			],
			deeps: [{ outcome: "ok", value: { answers: [resolved] } }],
		},
		ctx,
	);
	expect(climbed.exhausted).toEqual([]);
	const file = readFileSync(climbed.answers, "utf8");
	expect(file).toContain(resolved.answer);
	expect(file).not.toContain(reproduction);
});

test("climbedAnswersOf keys an exhausted answer that rephrases its question apart from the group's questions", () => {
	const ctx = {
		scratch: mkdtempSync(join(scratch, "climbed-")),
	} as CodeContext;
	const rephrased = { ...unsure, question: "Where does greet.sh break?" };
	const climbed = climbedAnswersOf(
		{
			groups: [
				{
					id: "G1",
					area: "twin",
					questions: [grounded.question, unsure.question],
				},
			],
			scouts: [{ outcome: "ok", value: { answers: [rephrased] } }],
			climbs: [
				{
					slot: "G1",
					id: "G1",
					area: "twin",
					unsure: [{ question: rephrased.question, missing: reproduction }],
				},
			],
			deeps: [{ outcome: "failed", reason: "timed out" }],
		},
		ctx,
	);
	const keys = climbed.exhausted.map((e) => e.key);
	expect(keys).toHaveLength(1);
	expect(keys).not.toContain("G1.1");
	expect(keys).not.toContain("G1.2");
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

/** `args` with the value of `--issue` replaced by `issue`. */
const withIssue = (args: string[], issue: string) =>
	args.map((a, i) => (args[i - 1] === "--issue" ? issue : a));

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
	extra: Record<string, unknown> = {},
	issue = "#1 Greet by name",
) {
	const outputs = stubOutputs({
		"triager/ruling.json": ruling,
		"triager/backlog.md": "- #7 Greet: it greets too\n",
		...(proposal && {
			"planner/plan.json": proposal,
			"checker/check.json": check,
		}),
		...(revision && { "revise/plan.json": revision }),
		...extra,
	});
	const data = mkdtempSync(join(scratch, "data-"));
	const concert = JSON.parse(
		await maestro(
			[
				...withIssue(await triage("perform", "--backlog", backlog), issue),
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
		expect(answers.indexOf("## G1")).toBeLessThan(answers.indexOf("## G2"));
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

test.each([
	[
		"a premise finding, with the false claim corrected",
		premiseFinding,
		{ ...spec, what: "Greet.sh greets by name already; keep it so." },
	],
	[
		"a YAGNI finding, with the deferred item moved to excluded",
		yagniFinding,
		{
			...spec,
			excluded: [{ lead: "Flags", points: ["Not asked for"] }],
		},
	],
])(
	"a stub perform proposes the revised spec for %s",
	async (_, finding, revisedSpec) => {
		const { concert, artifact } = await performed(
			planning,
			ready,
			{ findings: [finding] },
			{ ...ready, spec: revisedSpec },
		);
		expect(concert.status).toBe("ok");
		expect(artifact("revisable", "findings")).toContain(finding);
		expect(concert.outputs.triage.spec).toMatchObject(revisedSpec);
	},
);

const bugProposal: Proposal = {
	...ready,
	spec: {
		...spec,
		what: "greet.sh crashes without a name; `sh greet.sh` fails at greet.sh:3.",
	},
};
const askingCause = { ...ready, questions: [claiming] };

test("a stub perform of a bug runs its diagnose group's scout and hands the answers to the planner", async () => {
	const { concert, statuses, artifact } = await performed(
		diagnosing,
		bugProposal,
		{ findings: [] },
		undefined,
		{ "scouts/scout/answers.json": [grounded] },
		bugIssue,
	);
	expect(concert.status).toBe("ok");
	expect(statuses("scouts/scout")).toEqual(["ok"]);
	const answers = artifact("answers", "answers");
	expect(answers).toContain("## G1: Diagnose: greet.sh crashes without a name");
	expect(answers).toContain("unbound variable");
	expect(concert.outputs.triage).toMatchObject({ verdict: "ready-for-agent" });
});

test.each([
	[
		"an unsure diagnose answer",
		{ "scouts/scout/answers.json": [unsure] },
		"the reproduction: greet.sh does not exist in the lane",
	],
	[
		"a diagnose scout that failed",
		{ "scouts/scout/answers.json": "not json" },
		"Unanswered: the scout failed",
	],
])(
	"a stub perform settles needs-info with the planner's question for %s",
	async (_, extra, shown) => {
		const { concert, artifact } = await performed(
			diagnosing,
			askingCause,
			{ findings: [] },
			undefined,
			extra,
			bugIssue,
		);
		expect(concert.status).toBe("ok");
		expect(artifact("answers", "answers")).toContain(shown);
		expect(concert.outputs.triage).toMatchObject({
			verdict: "needs-info",
			questions: [claiming],
		});
	},
);

test("a stub perform settles needs-info when the revision keeps the diagnose question", async () => {
	const { concert, statuses } = await performed(
		diagnosing,
		ready,
		{ findings: [failed] },
		askingCause,
		{ "scouts/scout/answers.json": [unsure] },
		bugIssue,
	);
	expect(statuses("revise")).toEqual(["ok"]);
	expect(concert.outputs.triage).toMatchObject({
		verdict: "needs-info",
		questions: [claiming],
	});
});

// Seam: triage's CLI and the attachments exposed by its composed plan.
test("triage accepts --sightings and attaches the file to the planner only", async () => {
	const sightings = join(
		mkdtempSync(join(scratch, "sightings-")),
		"sightings.md",
	);
	writeFileSync(sightings, "- a.ts · R1 · Drops a name.\n");
	const result = await call(
		await triage("compose", "--backlog", backlog, "--sightings", sightings),
	);
	expect(result.code).toBe(0);
	const { plan } = JSON.parse(result.out);
	const nodes = plan.ir.nodes as TriageNode[];
	const planner = nodes.find((node) => node.id === "planner");
	expect(planner?.config.attachments?.sightings?.type).toBe("core.markdown");
	for (const id of ["triager", "checker"])
		expect(
			nodes.find((node) => node.id === id)?.config.attachments?.sightings,
		).toBeUndefined();
});

test("triage feeds parameter-file attachments from code nodes", async () => {
	const sightings = join(
		mkdtempSync(join(scratch, "sightings-")),
		"sightings.md",
	);
	writeFileSync(sightings, "- a sighting\n");
	const { plan } = JSON.parse(
		await maestro(
			await triage("compose", "--backlog", backlog, "--sightings", sightings),
		),
	);
	const nodes = plan.ir.nodes as (TriageNode & { kind: string })[];
	const edges = plan.ir.edges as TriageEdge[];
	for (const [id, port, hint] of [
		[
			"triager",
			"backlog",
			"for the open and recently closed issues, to cut down to those that matter",
		],
		[
			"planner",
			"sightings",
			"for the known defects and smells no masterclass has read yet, to see the debt around the change",
		],
	] as const) {
		const attachment = nodes.find((node) => node.id === id)?.config
			.attachments?.[port];
		expect(attachment).toEqual({ type: "core.markdown", hint });
		const sources = edges.filter(
			(edge) => edge.to.node === id && edge.to.port === port,
		);
		expect(sources).toHaveLength(1);
		expect(nodes.find((node) => node.id === sources[0]?.from.node)?.kind).toBe(
			"code",
		);
	}
});

test("an encore records the triager's current backlog snapshot", async () => {
	const dir = mkdtempSync(join(scratch, "encore-backlog-"));
	const snapshot = join(dir, "snapshot.md");
	const data = join(dir, "data");
	writeFileSync(snapshot, "# Backlog\n\n- first snapshot\n");
	const env = {
		MAESTRO_STUB_OUTPUTS: stubOutputs({
			"triager/ruling.json": planning,
			"triager/backlog.md": "- #7 Greet: it greets too\n",
			"planner/plan.json": ready,
			"checker/check.json": { findings: [] },
		}),
	};
	const first = await call(
		[
			...(await triage("perform", "--backlog", snapshot)),
			"-c",
			`target.repo=${targetRepo()}`,
			"-c",
			'target.prepare="true"',
			...stubbed(["triager", "classics/scout", "classics/planner", "checker"]),
		],
		data,
		env,
	);
	expect(first.code).toBe(0);
	const firstConcert = JSON.parse(first.out);
	expect(firstConcert.status).toBe("ok");
	const recorded = async (id: string) => {
		const listed = await call(["ls", id, "--json"], data);
		expect(listed.code).toBe(0);
		const {
			instances,
		}: {
			instances: (Instance & { inputs?: Record<string, { path?: string }> })[];
		} = JSON.parse(listed.out);
		const path = instances.find((instance) => instance.node === "triager")
			?.inputs?.backlog?.path;
		expect(path).toBeDefined();
		expect(basename(path ?? "")).toBe("snapshot.md");
		return readFileSync(
			join(data, "maestro/concerts", id, "artifacts", path ?? ""),
			"utf8",
		);
	};
	expect(await recorded(firstConcert.id)).toBe(
		"# Backlog\n\n- first snapshot\n",
	);
	writeFileSync(snapshot, "# Backlog\n\n- second snapshot\n");
	const encore = await call(["encore", firstConcert.id, "--json"], data, env);
	expect(encore.code).toBe(0);
	const nextConcert = JSON.parse(encore.out);
	expect(nextConcert.status).toBe("ok");
	expect(await recorded(nextConcert.id)).toBe(
		"# Backlog\n\n- second snapshot\n",
	);
	expect(await recorded(firstConcert.id)).toBe(
		"# Backlog\n\n- first snapshot\n",
	);
}, 60_000);

test("an encore rereads the sightings file recorded by its first triage", async () => {
	const dir = mkdtempSync(join(scratch, "encore-sightings-"));
	const sightings = join(dir, "sightings.md");
	const data = join(dir, "data");
	writeFileSync(sightings, "- a.ts · R1 · Drops a name.\n");
	const env = {
		MAESTRO_STUB_OUTPUTS: stubOutputs({
			"triager/ruling.json": planning,
			"triager/backlog.md": "- #7 Greet: it greets too\n",
			"planner/plan.json": ready,
			"checker/check.json": { findings: [] },
		}),
	};
	const first = await call(
		[
			...(await triage(
				"perform",
				"--backlog",
				backlog,
				"--sightings",
				sightings,
			)),
			"-c",
			`target.repo=${targetRepo()}`,
			"-c",
			'target.prepare="true"',
			...stubbed(["triager", "classics/scout", "classics/planner", "checker"]),
		],
		data,
		env,
	);
	expect(first.code).toBe(0);
	const firstConcert = JSON.parse(first.out);
	expect(firstConcert.status).toBe("ok");
	const attached = async (id: string) => {
		const listed = await call(["ls", id, "--json"], data);
		expect(listed.code).toBe(0);
		const {
			instances,
		}: {
			instances: (Instance & { inputs?: Record<string, { path?: string }> })[];
		} = JSON.parse(listed.out);
		const path = instances.find((instance) => instance.node === "planner")
			?.inputs?.sightings?.path;
		expect(path).toBeDefined();
		return readFileSync(
			join(data, "maestro/concerts", id, "artifacts", path ?? ""),
			"utf8",
		);
	};
	expect(await attached(firstConcert.id)).toBe("- a.ts · R1 · Drops a name.\n");
	writeFileSync(sightings, "- b.ts · R2 · Drops the result.\n");
	const encore = await call(
		[
			"encore",
			firstConcert.id,
			"--issue",
			"#1 Greet by name\n\nKeep the greeting plain.",
			"--json",
		],
		data,
		env,
	);
	expect(encore.code).toBe(0);
	const nextConcert = JSON.parse(encore.out);
	expect(nextConcert.status).toBe("ok");
	expect(await attached(nextConcert.id)).toBe(
		"- b.ts · R2 · Drops the result.\n",
	);
}, 60_000);

test("triage without --sightings keeps the planner's issue, answers and backlog attachments only", async () => {
	const { node } = await handoffs();
	expect(Object.keys(node("planner")?.config.attachments ?? {}).sort()).toEqual(
		["answers", "backlog", "issue"],
	);
});

/** The composed plan of the triage, with `--backlog`. */
const composed = async () =>
	JSON.parse(await maestro(await triage("compose", "--backlog", backlog)));

type TriageNode = {
	id: string;
	config: {
		reply?: Record<string, unknown>;
		out?: Record<string, { file: string; format: string }>;
		relay?: { name: string }[];
		attachments?: Record<string, { type?: string; hint?: string }>;
	};
	literals?: { prompt?: string };
};
type TriageEdge = {
	from: { node: string; port: string };
	to: { node: string; port: string };
};

/** The seats and their data hand-offs as the composed plan exposes them. */
async function handoffs() {
	const { plan } = await composed();
	const nodes = plan.ir.nodes as TriageNode[];
	const edges = plan.ir.edges as TriageEdge[];
	const node = (id: string) => nodes.find((n) => n.id === id);
	const from = (id: string, port: string) =>
		edges
			.filter((e) => e.to.node === id && e.to.port === port)
			.map((e) => e.from);
	return { node, from };
}

test("the triage seats return typed reply fields instead of JSON outbox files", async () => {
	const { node } = await handoffs();
	for (const [id, field, schema] of [
		["triager", "ruling", Ruling(4).schema],
		["planner", "plan", Proposal.schema],
		["revise", "plan", Proposal.schema],
		["checker", "check", Checked.schema],
	] as const) {
		expect(node(id)?.config.reply?.[field]).toEqual(schema);
		expect(
			Object.values(node(id)?.config.out ?? {}).filter(
				(out) => out.format === "json",
			),
		).toEqual([]);
	}
});

test("the triager hands on its cut backlog as a Markdown outbox file", async () => {
	const { node } = await handoffs();
	expect(node("triager")?.config.out?.backlog).toEqual({
		file: "backlog.md",
		format: "markdown",
	});
});

test("the planner receives the triager's ruling as a relay", async () => {
	const { node, from } = await handoffs();
	const relays = node("planner")?.config.relay ?? [];
	expect(
		relays.filter(({ name }) =>
			from("planner", name).some(
				(source) => source.node === "triager" && source.port === "ruling",
			),
		),
	).toHaveLength(1);
});

test("the checker receives the planner's plan as a relay", async () => {
	const { node, from } = await handoffs();
	const relays = node("checker")?.config.relay ?? [];
	expect(
		relays.filter(({ name }) =>
			from("checker", name).some(
				(source) => source.node === "planner" && source.port === "plan",
			),
		),
	).toHaveLength(1);
});

test("the planner and checker receive the scouts' answers as a file attachment", async () => {
	const { node, from } = await handoffs();
	for (const id of ["planner", "checker"]) {
		expect(node(id)?.config.attachments?.answers?.type).toBe("core.markdown");
		expect(from(id, "answers")).toEqual([{ node: "answers", port: "answers" }]);
	}
});

test("no triage task names a ruling, plan or check JSON file", async () => {
	const { node } = await handoffs();
	for (const id of [
		"triager",
		"scouts/scout",
		"planner",
		"checker",
		"revise",
	]) {
		const prompt = node(id)?.literals?.prompt;
		expect(typeof prompt).toBe("string");
		for (const file of ["ruling.json", "plan.json", "check.json"])
			expect(prompt).not.toContain(file);
	}
});

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

test("the triager's and the revision's tasks hold no JSON example of a question", async () => {
	const { plan } = await composed();
	const keys = ["ask", "options", "context"];
	for (const id of ["triager", "revise"]) {
		const node = (plan.ir.nodes as { id: string }[]).find((n) => n.id === id);
		const text = JSON.stringify(node)
			.replace(/\\n/g, "\n")
			.replace(/\\"/g, '"');
		const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)];
		const found = (v: unknown): boolean =>
			Array.isArray(v)
				? v.some(found)
				: typeof v === "object" && v !== null
					? keys.every((k) => k in v) || Object.values(v).some(found)
					: false;
		for (const [, body] of blocks) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(body ?? "");
			} catch {
				continue;
			}
			expect(found(parsed)).toBe(false);
		}
	}
});

test("the Question schema describes itself and each of its fields, nested ones too", () => {
	const missing = (schema: unknown, path: string): string[] => {
		const s = schema as {
			description?: string;
			properties?: Record<string, unknown>;
			items?: unknown;
		};
		return [
			...(s.description ? [] : [path]),
			...Object.entries(s.properties ?? {}).flatMap(([k, v]) =>
				missing(v, `${path}.${k}`),
			),
			...(s.items ? missing(s.items, `${path}[]`) : []),
		];
	};
	expect(missing(Question.schema, "Question")).toEqual([]);
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
	const source = (plan.ir.edges as Edge[]).find(
		(e) => e.to.node === "triager" && e.to.port === "backlog",
	)?.from.node;
	const snapshot = Object.values(node(source ?? "")?.literals ?? {}).find(
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

const duplicateRuling = {
	...planning,
	verdict: "duplicate",
	groups: [],
	duplicateOf: 7,
};
const rulingsOffDuplicate = [
	planning,
	direct,
	{ ...planning, verdict: "needs-info", questions: [askAlone("Who?")] },
];
const rulingsOffDirect = [
	planning,
	duplicateRuling,
	{ ...planning, verdict: "needs-info", questions: [askAlone("Who?")] },
];
const directFields = [
	["what", spec.what],
	["requirements", spec.requirements],
	["subject", spec.subject],
] as const;

const triages = [
	{
		verdict: "ready-for-agent",
		...medium,
		questions: [],
		spec: { touches: [], ...spec },
	},
	{
		verdict: "needs-approval",
		...medium,
		questions: [],
		spec: { touches: [], ...spec },
	},
	{
		verdict: "needs-info",
		...medium,
		questions: [askAlone("Who?")],
		spec: { touches: [], ...spec },
	},
	{
		verdict: "split",
		...medium,
		questions: [],
		children,
		spec: { touches: [], ...spec },
	},
	{
		verdict: "duplicate",
		...medium,
		questions: [],
		duplicateOf: 7,
		spec: { touches: [], ...spec },
	},
];

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
		"a needs-info ruling with ahead",
		Ruling(4),
		{
			...planning,
			verdict: "needs-info",
			questions: [askAlone("Who?")],
			ahead: "Next round: ask where.",
		},
		true,
	],
	...[planning, direct, duplicateRuling].map(
		(ruling): [string, Type<unknown>, object, boolean] => [
			`a ${ruling.verdict} ruling with ahead`,
			Ruling(4),
			{ ...ruling, ahead: "Next round: ask where." },
			false,
		],
	),
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
	["a duplicate ruling", Ruling(4), duplicateRuling, true],
	...rulingsOffDuplicate.map(
		(ruling): [string, Type<unknown>, object, boolean] => [
			`a ${ruling.verdict} ruling with duplicateOf`,
			Ruling(4),
			{ ...ruling, duplicateOf: 7 },
			false,
		],
	),
	["a direct ruling", Ruling(4), direct, true],
	[
		"a direct ruling with acceptance",
		Ruling(4),
		{ ...direct, acceptance: ["bun test"] },
		false,
	],
	...rulingsOffDirect.flatMap((ruling) =>
		directFields.map(
			([field, value]): [string, Type<unknown>, object, boolean] => [
				`a ${ruling.verdict} ruling with ${field}`,
				Ruling(4),
				{ ...ruling, [field]: value },
				false,
			],
		),
	),
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
		"a ready proposal whose spec carries acceptance",
		Proposal,
		{ ...ready, spec: { ...spec, acceptance: ["bun test"] } },
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
	...triages.map((triage): [string, Type<unknown>, object, boolean] => [
		`a ${triage.verdict} triage`,
		Triage,
		triage,
		true,
	]),
	...triages.map((triage): [string, Type<unknown>, object, boolean] => [
		`a ${triage.verdict} triage with ahead`,
		Triage,
		{ ...triage, ahead: "Next round: ask where." },
		triage.verdict === "needs-info",
	]),
	...triages
		.filter((triage) => triage.verdict !== "duplicate")
		.map((triage): [string, Type<unknown>, object, boolean] => [
			`a ${triage.verdict} triage with duplicateOf`,
			Triage,
			{ ...triage, duplicateOf: 7 },
			false,
		]),
	...triages
		.filter((triage) => triage.verdict !== "split")
		.map((triage): [string, Type<unknown>, object, boolean] => [
			`a ${triage.verdict} triage with children`,
			Triage,
			{ ...triage, children },
			false,
		]),
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

// Seams: triage compose --json (graph, attachments, sessions and runtimes),
// and perform/encore/ls --json (executed seats, their inputs and the settled verdict).
type DesignsPlan = {
	plan: {
		ir: {
			nodes: (TriageNode & {
				kind: string;
				config: { profile?: string; seat?: string; encore?: boolean };
			})[];
			edges: TriageEdge[];
		};
	};
	agents: { node: string; profile: string; model: string; thinking: string }[];
};

async function designsComposed(...flags: string[]): Promise<DesignsPlan> {
	const run = await call(
		await triage("compose", "--backlog", backlog, ...flags),
	);
	expect(run.code).toBe(0);
	return JSON.parse(run.out);
}

const designerNodes = (shape: DesignsPlan) =>
	shape.plan.ir.nodes.filter((node) => node.config?.profile === "designer");

const sourcesOf = (shape: DesignsPlan, node: string, port: string) =>
	shape.plan.ir.edges
		.filter((edge) => edge.to.node === node && edge.to.port === port)
		.map((edge) => edge.from);

type DesignsInstance = {
	node: string;
	expansion: string;
	status: string;
	inputs?: { session?: string; plan?: Proposal; sketches?: ArtifactRef };
	outputs?: { session?: string };
	enrichment?: { harness?: string };
};

async function designsListed(id: string, data: string) {
	const listed = await call(["ls", id, "--json"], data);
	expect(listed.code).toBe(0);
	const { instances }: { instances: DesignsInstance[] } = JSON.parse(
		listed.out,
	);
	return instances;
}

const firstDesignPlan: Proposal = {
	verdict: "split",
	...unspecified,
	children,
};
const mergedPlan: Proposal = {
	...ready,
	spec: { ...spec, what: "The merged contract shape." },
};

async function designsPerformed(
	shape: DesignsPlan,
	{
		ruling = planning,
		proposal = firstDesignPlan,
		merge = mergedPlan,
		revision = ready,
		extra = {},
	}: {
		ruling?: Ruling;
		proposal?: Proposal;
		merge?: Proposal;
		revision?: Proposal;
		extra?: Record<string, unknown>;
	} = {},
) {
	const sketches = Object.fromEntries(
		designerNodes(shape).flatMap((node) =>
			Object.values(node.config.out ?? {}).map((out) => [
				`${node.id}/${out.file}`,
				"A rival contract: greet(name).\n",
			]),
		),
	);
	const env = {
		MAESTRO_STUB_OUTPUTS: stubOutputs({
			"triager/ruling.json": ruling,
			"triager/backlog.md": "- #7 Greet: it greets too\n",
			"planner/plan.json": proposal,
			"merge/plan.json": merge,
			"checker/check.json": { findings: [] },
			"revise/plan.json": revision,
			...sketches,
			...extra,
		}),
	};
	const data = mkdtempSync(join(scratch, "designs-data-"));
	const run = await call(
		[
			...(await triage("perform", "--backlog", backlog, "--designs")),
			"--preset",
			"stub",
			"-c",
			`target.repo=${targetRepo()}`,
			"-c",
			'target.prepare="true"',
		],
		data,
		env,
	);
	expect(run.code).toBe(0);
	const concert: { id: string; status: string; outputs: { triage: Triage } } =
		JSON.parse(run.out);
	const instances = await designsListed(concert.id, data);
	const sketchesRead = () => {
		const path = instances.find((instance) => instance.node === "merge")?.inputs
			?.sketches?.path;
		expect(path).toBeDefined();
		return readFileSync(
			join(data, "maestro/concerts", concert.id, "artifacts", path ?? ""),
			"utf8",
		);
	};
	return { concert, instances, data, env, sketchesRead };
}

const ranDesigners = (shape: DesignsPlan, instances: DesignsInstance[]) =>
	instances.filter((instance) =>
		designerNodes(shape).some((node) => node.id === instance.node),
	);

test("--designs is opt-in and --no-designs keeps the default graph and seats", async () => {
	const baseline = await designsComposed();
	const off = await designsComposed("--no-designs");
	expect(off.plan.ir.nodes).toEqual(baseline.plan.ir.nodes);
	expect(off.plan.ir.edges).toEqual(baseline.plan.ir.edges);
	expect(off.agents).toEqual(baseline.agents);
	const on = await designsComposed("--designs");
	expect(designerNodes(baseline)).toEqual([]);
	expect(
		baseline.plan.ir.nodes.find((node) => node.id === "merge"),
	).toBeUndefined();
	expect(designerNodes(on).length).toBeGreaterThan(0);
	expect(on.plan.ir.nodes.find((node) => node.id === "merge")).toBeDefined();
});

test("designers compose fresh on Sonnet at medium with the planner's evidence, never its plan or sightings", async () => {
	const sightings = join(
		mkdtempSync(join(scratch, "designs-sightings-")),
		"sightings.md",
	);
	writeFileSync(sightings, "- a.ts · R1 · Drops a name.\n");
	const shape = await designsComposed("--designs", "--sightings", sightings);
	const designers = designerNodes(shape);
	expect(designers.length).toBeGreaterThan(0);
	for (const node of designers) {
		expect(node.config.encore).toBe(false);
		for (const port of ["issue", "answers", "backlog"]) {
			expect(node.config.attachments?.[port]?.type).toBe("core.markdown");
			expect(sourcesOf(shape, node.id, port)).toEqual(
				sourcesOf(shape, "planner", port),
			);
		}
		expect(node.config.attachments?.sightings).toBeUndefined();
		expect(
			shape.plan.ir.edges.filter(
				(edge) => edge.to.node === node.id && edge.from.node === "planner",
			),
		).toEqual([]);
		expect(
			Object.values(node.config.out ?? {}).map((out) => out.format),
		).toEqual(["markdown"]);
		expect(shape.agents.find((agent) => agent.node === node.id)).toMatchObject({
			profile: "designer",
			model: "claude-sonnet-5-5",
			thinking: "medium",
		});
	}
});

test("merge continues the planner's seat and session and hands its whole plan to checking and revision", async () => {
	const shape = await designsComposed("--designs");
	const node = (id: string) =>
		shape.plan.ir.nodes.find((entry) => entry.id === id);
	expect(node("merge")?.config.seat).toBe(node("planner")?.config.seat);
	expect(node("merge")?.config.reply?.plan).toEqual(Proposal.schema);
	expect(node("merge")?.config.attachments?.sketches?.type).toBe(
		"core.markdown",
	);
	expect(sourcesOf(shape, "merge", "session")).toEqual([
		{ node: "planner", port: "session" },
	]);
	expect(sourcesOf(shape, "checker", "plan")).toEqual([
		{ node: "merge", port: "plan" },
	]);
	expect(sourcesOf(shape, "revise", "session")).toEqual([
		{ node: "merge", port: "session" },
	]);
});

test("a designs stub perform runs both designers and settles the merge plan rather than the first plan", async () => {
	const shape = await designsComposed("--designs");
	const { concert, instances, sketchesRead } = await designsPerformed(shape);
	expect(concert.status).toBe("ok");
	expect(
		ranDesigners(shape, instances).map((instance) => instance.status),
	).toEqual(["ok", "ok"]);
	expect(sketchesRead().split("A rival contract: greet(name).")).toHaveLength(
		3,
	);
	const merge = instances.find((instance) => instance.node === "merge");
	expect(merge?.status).toBe("ok");
	for (const instance of [...ranDesigners(shape, instances), merge])
		expect(instance?.enrichment?.harness).toBe("stub");
	expect(merge?.inputs?.session).toBe(
		instances.find((instance) => instance.node === "planner")?.outputs?.session,
	);
	expect(
		instances.find((instance) => instance.node === "checker")?.inputs?.plan,
	).toEqual(mergedPlan);
	expect(concert.outputs.triage).toEqual({
		verdict: "ready-for-agent",
		...medium,
		questions: [],
		spec: {
			touches: ready.touches,
			...spec,
			what: "The merged contract shape.",
		},
	});
});

test("a designs stub perform revises findings in the merge plan even when the first plan was valid", async () => {
	const shape = await designsComposed("--designs");
	const { concert, instances } = await designsPerformed(shape, {
		proposal: ready,
		merge: { ...ready, spec: { ...spec, requirements: [offShape] } },
		revision: {
			...ready,
			spec: { ...spec, what: "The revised merged contract." },
		},
	});
	const revision = instances.find((instance) => instance.node === "revise");
	expect(revision?.status).toBe("ok");
	expect(revision?.inputs?.session).toBe(
		instances.find((instance) => instance.node === "merge")?.outputs?.session,
	);
	expect(concert.outputs.triage.spec?.what).toBe(
		"The revised merged contract.",
	);
});

test("a failed designer does not prevent merging the surviving sketch", async () => {
	const shape = await designsComposed("--designs");
	const first = await designsPerformed(shape);
	const designer = ranDesigners(shape, first.instances)[0];
	expect(designer?.outputs?.session).toBeDefined();
	const id = designer?.outputs?.session?.slice(first.concert.id.length + 1);
	const { concert, instances, sketchesRead } = await designsPerformed(shape, {
		extra: {
			[`${id}/events.jsonl`]: `${JSON.stringify({ type: "fault", reason: "designer unavailable" })}\n`,
		},
	});
	expect(
		ranDesigners(shape, instances)
			.map((instance) => instance.status)
			.sort(),
	).toEqual(["failed", "ok"]);
	expect(instances.find((instance) => instance.node === "merge")?.status).toBe(
		"ok",
	);
	expect(sketchesRead().split("A rival contract: greet(name).")).toHaveLength(
		2,
	);
	expect(concert.outputs.triage.spec?.what).toBe("The merged contract shape.");
}, 60_000);

test("an encore with designs starts both designers in new sessions", async () => {
	const shape = await designsComposed("--designs");
	const first = await designsPerformed(shape);
	const encore = await call(
		[
			"encore",
			first.concert.id,
			"--issue",
			"#1 Greet by name\n\nKeep the greeting plain.",
			"--json",
		],
		first.data,
		first.env,
	);
	expect(encore.code).toBe(0);
	const next = JSON.parse(encore.out);
	expect(next.status).toBe("ok");
	const designers = ranDesigners(
		shape,
		await designsListed(next.id, first.data),
	);
	expect(designers.map((instance) => instance.status)).toEqual(["ok", "ok"]);
	const sessions = ranDesigners(shape, first.instances).map(
		(instance) => instance.outputs?.session,
	);
	for (const designer of designers) {
		expect(designer.outputs?.session).toBeDefined();
		expect(sessions).not.toContain(designer.outputs?.session);
	}
}, 60_000);

test.each<Ruling>([
	direct,
	{ ...planning, verdict: "duplicate", groups: [], duplicateOf: 7 },
	{
		...planning,
		verdict: "needs-info",
		groups: [],
		questions: [askAlone("Who?")],
	},
])(
	"a designs stub perform runs no designers or merge when the ruling bypasses planning: %j",
	async (ruling) => {
		const shape = await designsComposed("--designs");
		const { concert, instances } = await designsPerformed(shape, { ruling });
		expect(concert.status).toBe("ok");
		expect(
			ranDesigners(shape, instances).filter(
				(instance) => instance.status !== "skipped",
			),
		).toEqual([]);
		expect(
			instances
				.filter((instance) => instance.node === "merge")
				.map((instance) => instance.status),
		).toEqual(["skipped"]);
	},
);

// Seams: compose --json exposes the opt-in graph and runtime; perform/ls --json
// exposes which seats ran, their attached evidence and the final owner questions.
const deepNodes = (shape: DesignsPlan) =>
	shape.plan.ir.nodes.filter(
		(node) => node.config?.profile === "classics/scout-deep",
	);

async function deepComposed(...flags: string[]): Promise<DesignsPlan> {
	const run = await call(
		await triage("compose", "--backlog", backlog, ...flags),
	);
	expect(run.code).toBe(0);
	return JSON.parse(run.out);
}

test("scoutDeep is opt-in and seats scout-deep on Sonnet at high only in the on graph", async () => {
	const baseline = await deepComposed();
	const off = await deepComposed("--no-scout-deep");
	expect(off.plan.ir.nodes).toEqual(baseline.plan.ir.nodes);
	expect(off.plan.ir.edges).toEqual(baseline.plan.ir.edges);
	expect(off.agents).toEqual(baseline.agents);
	expect(deepNodes(off)).toEqual([]);
	const on = await deepComposed("--scout-deep");
	expect(deepNodes(on)).toHaveLength(1);
	const deep = deepNodes(on)[0];
	expect(on.agents.find((agent) => agent.node === deep?.id)).toMatchObject({
		profile: "classics/scout-deep",
		model: "claude-sonnet-5-5",
		thinking: "high",
	});
});

type DeepInstance = Instance & {
	inputs?: Record<string, unknown>;
};

const deepMissing = "the reproduction: greet.sh does not exist in the lane";

async function deepPerformed(
	shape: DesignsPlan,
	ruling: Ruling,
	first: ValueOf<typeof Answers>,
	second: ValueOf<typeof Answers> | string,
) {
	const deep = deepNodes(shape)[0];
	expect(deep).toBeDefined();
	const data = mkdtempSync(join(scratch, "scout-deep-data-"));
	const run = await call(
		[
			...(await triage("perform", "--backlog", backlog, "--scout-deep")),
			"-c",
			`target.repo=${targetRepo()}`,
			"-c",
			'target.prepare="true"',
			...stubbed([
				"triager",
				"classics/scout",
				"classics/scout-deep",
				"classics/planner",
				"checker",
			]),
		],
		data,
		{
			MAESTRO_STUB_OUTPUTS: stubOutputs({
				"triager/ruling.json": ruling,
				"triager/backlog.md": "- #7 Greet: it greets too\n",
				"scouts/scout/answers.json": first,
				[`${deep?.id}/answers.json`]: second,
				"planner/plan.json": ready,
				"checker/check.json": { findings: [] },
			}),
		},
	);
	expect(run.code).toBe(0);
	const concert = JSON.parse(run.out);
	expect(concert.status).toBe("ok");
	const listed = await call(["ls", concert.id, "--json"], data);
	expect(listed.code).toBe(0);
	const { instances }: { instances: DeepInstance[] } = JSON.parse(listed.out);
	const attached = (instance: DeepInstance | undefined, port: string) => {
		const ref = instance?.inputs?.[port] as ArtifactRef | undefined;
		expect(ref?.path).toBeDefined();
		return readFileSync(
			join(data, "maestro/concerts", concert.id, "artifacts", ref?.path ?? ""),
			"utf8",
		);
	};
	return {
		concert,
		instances,
		deep: instances.filter(
			(instance) => instance.node === deep?.id && instance.status !== "skipped",
		),
		attached,
	};
}

test("scout-deep answers only the unsure group's questions and replaces its unsure answer for planning and checking", async () => {
	const shape = await deepComposed("--scout-deep");
	const resolved = {
		...grounded,
		question: unsure.question,
		answer: "The cause is greet.sh:3; reproduced in the sealed base.",
	};
	const oneGroup = {
		...planning,
		groups: [
			{
				id: "G8",
				area: "unknown",
				questions: [grounded.question, unsure.question],
			},
		],
	};
	const result = await deepPerformed(
		shape,
		oneGroup,
		[grounded, unsure],
		[resolved],
	);
	expect(result.deep.map((instance) => instance.status)).toEqual(["ok"]);
	const climbed = result.deep[0];
	const group = result.attached(climbed, "group");
	expect(group).toContain(unsure.question);
	expect(group).toContain(deepMissing);
	expect(group).not.toContain(grounded.question);
	expect(result.attached(climbed, "issue")).toContain("#1 Greet by name");
	expect(result.attached(climbed, "backlog")).toBe(
		"- #7 Greet: it greets too\n",
	);
	for (const node of ["planner", "checker"]) {
		const answers = result.attached(
			result.instances.find((instance) => instance.node === node),
			"answers",
		);
		expect(answers).toContain(resolved.answer);
		expect(answers).toContain(grounded.answer);
		expect(answers).not.toContain(unsure.answer);
		expect(answers).not.toContain(deepMissing);
	}
	expect(result.concert.outputs.triage).toMatchObject({
		verdict: "ready-for-agent",
		questions: [],
	});
});

test("scout-deep runs no seat for a group whose scout is wholly grounded", async () => {
	const shape = await deepComposed("--scout-deep");
	const result = await deepPerformed(
		shape,
		{
			...planning,
			groups: [{ id: "G1", area: "known", questions: [grounded.question] }],
		},
		[grounded],
		"not json",
	);
	expect(result.deep).toEqual([]);
	expect(result.concert.outputs.triage).toMatchObject({
		verdict: "ready-for-agent",
		questions: [],
	});
});

test.each([
	["still unsure", [unsure]],
	["missing from the reply", []],
	["failed", "not json"],
] as [string, ValueOf<typeof Answers> | string][])(
	"an answer %s after scout-deep is exhausted in each group and asks the owner while keeping the ready spec",
	async (_, reply) => {
		const shape = await deepComposed("--scout-deep");
		const result = await deepPerformed(
			shape,
			{
				...planning,
				groups: [
					{
						id: "G9",
						area: "first",
						questions: [grounded.question, unsure.question],
					},
					{
						id: "G9",
						area: "second",
						questions: [grounded.question, unsure.question],
					},
				],
			},
			[grounded, unsure],
			reply,
		);
		expect(result.deep.map((instance) => instance.status)).toEqual([
			typeof reply === "string" ? "failed" : "ok",
			typeof reply === "string" ? "failed" : "ok",
		]);
		const answers = result.attached(
			result.instances.find((instance) => instance.node === "planner"),
			"answers",
		);
		expect(answers).toContain(grounded.answer);
		expect(answers).toContain(deepMissing);
		const output = result.concert.outputs.triage;
		expect(output.verdict).toBe("needs-info");
		expect(output.spec).toEqual({ touches: ready.touches, ...spec });
		expect(output.questions).toHaveLength(2);
		for (const question of output.questions) {
			const text = JSON.stringify(question);
			expect(text).toContain(unsure.question);
			expect(text).toContain(deepMissing);
		}
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
