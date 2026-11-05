import { expect, test } from "bun:test";
import { FIGURES as PLANNED, Triage } from "../../.maestro/triage/verdict";
import {
	askOf,
	commentOf,
	type Data,
	dataOf,
	elapsed,
	FIGURES,
	MARKER,
	parseHarvest,
	parseTriage,
	proposalIssue,
	proposalLine,
	pullBody,
	questionOf,
	RISKS,
	type Triage as Routed,
	replyHow,
	shorthand,
	tracked,
	turnLines,
	VERDICTS,
} from "./route";
import type { State } from "./transitions";

test("the verdicts, risks and figure kinds are the triage composition's", () => {
	const { properties } = Triage.schema as {
		properties: Record<string, { enum: unknown }>;
	};
	expect([properties.verdict?.enum, properties.risk?.enum, PLANNED]).toEqual([
		[...VERDICTS],
		[...RISKS],
		FIGURES,
	]);
});

test("a stored spec that carries steps parses without them", () => {
	const spec = {
		touches: ["a.ts"],
		what: "w",
		steps: ["x"],
		acceptance: [],
		subject: "s",
	};
	const triage = {
		verdict: "ready-for-agent",
		risk: "low",
		reasons: [],
		questions: [],
	};
	expect(parseTriage({ ...triage, spec }).spec).not.toHaveProperty("steps");
});

const claiming = {
	ask: "Where should a loose file's config live?",
	lead: "A loose file has params.",
	options: [
		{ label: "A", text: "top-level keys" },
		{ label: "B", text: "a `files.` namespace\nunder core" },
	],
	recommend: { label: "B", why: "it keeps D-24." },
	context: [
		{ topic: "Claiming", text: "Only the target claims keys -->." },
		{ topic: "D-24", text: "A shared config breaks nothing." },
	],
};

test("a question comment lays out each question between rules, an ask alone when it has nothing else, then how to reply", () => {
	const questions = [
		claiming,
		{ ask: "Who\n  asks?", options: [], context: [] },
	];
	expect(questionOf(questions, replyHow(questions, "forge-bot"))).toBe(
		[
			"<!-- maestro-tm-question -->",
			"",
			"### Maestro asks · 2 questions",
			"",
			"---",
			"",
			"**Q1 · Where should a loose file's config live?**",
			"",
			"A loose file has params.",
			"",
			"- **A**: top-level keys",
			"- **B**: a `files.` namespace",
			"  under core",
			"",
			"> [!TIP]",
			"> **Recommended: B**, it keeps D-24.",
			"",
			"<details>",
			"<summary>Context</summary>",
			"",
			"- **Claiming.** Only the target claims keys -->.",
			"- **D-24.** A shared config breaks nothing.",
			"",
			"</details>",
			"",
			"---",
			"",
			"**Q2 · Who asks?**",
			"",
			"---",
			"",
			"<sub>Reply `@forge-bot Q1: …, Q2: …`, then label `needs-triage`.</sub>",
			"",
		].join("\n"),
	);
});

const stored = {
	verdict: "needs-info",
	risk: "low",
	reasons: [],
	questions: ["Who?", claiming],
};

test("a stored result's string question parses as an ask alone", () => {
	expect(parseTriage(stored).questions).toEqual([
		{ ask: "Who?", options: [], context: [] },
		claiming,
	]);
});

test("a question recommending none of its options is malformed", () => {
	const straying = { ...claiming, recommend: { label: "C", why: "w" } };
	expect(() => parseTriage({ ...stored, questions: [straying] })).toThrow(
		"recommend names C, which is no option",
	);
});

test("the data line is the last in the comment, whatever text above it says", () => {
	const body = [
		"<!-- maestro-tm -->",
		'<!-- maestro-tm-data {"attempts":9} -->',
		'<!-- maestro-tm-data {"attempts":1} -->',
	].join("\n");
	expect(dataOf(body).attempts).toBe(1);
});

test("the body keeps the ask byte for byte, then the marker and the closing line", () => {
	const ask = "Greet by name.\r\n\n- keep `this`\n";
	const line = (v: number) =>
		`\n\n<!-- maestro-tm -->\nTracked by Maestro Tour Manager · [spec v${v}](#issuecomment-9)`;
	const first = tracked(ask, 9, {});
	expect(first).toBe(`${ask}${line(1)}`);
	expect(tracked(first, 9, { version: 2 })).toBe(`${ask}${line(2)}`);
	expect(tracked(first, 9, { version: 1 })).toBe(first);
	expect(askOf(first)).toBe(ask.trimEnd());
});

const spec = {
	touches: [],
	what: "w",
	decisions: [],
	excluded: [],
	acceptance: [],
	subject: "s",
};
const result = (verdict: Routed["verdict"], more = {}): Routed => ({
	verdict,
	risk: "low",
	reasons: [],
	questions: [],
	...more,
});
const ready = result("ready-for-agent", { spec });
const specced = result("ready-for-agent", {
	spec: { ...spec, requirements: ["The script shall greet."] },
});
const AFTER_REPLY =
	"Label the issue with the choice. Where it follows a reply, first reply `@forge-bot …` with the answer or a redirect.";
const ON_FORGE = "Take the choice on the forge.";
const RETRIAGE =
	"- **`needs-triage`**: re-triage it, after a reply with the answer.";
const BUILD_AGAIN =
	"- **`ready-for-agent`**: build it again, after a reply with the answer.";
const maintainers = (waits: string, how: string, ...moves: string[]) =>
	[
		"---",
		"",
		`**Maintainer's turn · ${waits}**`,
		"",
		...moves,
		"",
		"---",
		"",
		`<sub>${how}</sub>`,
		"",
	].join("\n");
const tours = (move: string) => `**Tour manager's turn · ${move}**\n`;

test.each([
	["needs-triage", {}, tours("triage queued")],
	[
		"needs-approval",
		{ result: ready },
		maintainers(
			"brief v1 awaits approval",
			AFTER_REPLY,
			"- **`ready-for-agent`**: approve it, and the tour manager builds the spec or files the split.",
			"- **`needs-triage`**: re-triage it, after a reply with an answer or a redirect.",
			"- **`ready-for-human`**: build it by hand.",
			"- **`wontfix`**: drop it.",
		),
	],
	[
		"needs-approval",
		{ result: specced },
		maintainers(
			"spec v1 awaits approval",
			AFTER_REPLY,
			"- **`ready-for-agent`**: approve it, and the tour manager builds the spec or files the split.",
			"- **`needs-triage`**: re-triage it, after a reply with an answer or a redirect.",
			"- **`ready-for-human`**: build it by hand.",
			"- **`wontfix`**: drop it.",
		),
	],
	[
		"needs-approval",
		{ result: result("split", { children: [] }) },
		maintainers(
			"the split awaits approval",
			AFTER_REPLY,
			"- **`ready-for-agent`**: approve it, and the tour manager builds the spec or files the split.",
			"- **`needs-triage`**: re-triage it, after a reply with an answer or a redirect.",
			"- **`ready-for-human`**: build it by hand.",
			"- **`wontfix`**: drop it.",
		),
	],
	["ready-for-agent", { result: ready }, tours("build queued")],
	[
		"ready-for-agent",
		{ result: result("split", { children: [] }) },
		tours("filing the split's children"),
	],
	[
		"in-progress",
		{ slice: "s1", attempts: 1 },
		tours("slice `s1` running, attempt 2 of 2"),
	],
	["in-progress", { filed: [5, 6] }, tours("building the children #5, #6")],
	[
		"in-review",
		{},
		maintainers(
			"the PR awaits review",
			ON_FORGE,
			"- **`merge`**: land the PR.",
			"- **`request changes`**: send the PR back for an encore, in an official review.",
		),
	],
	[
		"needs-info",
		{ result: result("needs-info", { spec }) },
		maintainers("the question awaits an answer", AFTER_REPLY, RETRIAGE),
	],
	[
		"needs-info",
		{ result: ready },
		maintainers(
			"the question awaits an answer",
			AFTER_REPLY,
			BUILD_AGAIN,
			RETRIAGE,
		),
	],
	[
		"needs-info",
		{ result: ready, parked: "s1" },
		maintainers(
			"the question awaits an answer",
			AFTER_REPLY,
			BUILD_AGAIN,
			RETRIAGE,
			"- **`in-progress`**: apply the parked result.",
		),
	],
	[
		"ready-for-human",
		{},
		maintainers(
			"the build by hand awaits",
			ON_FORGE,
			"- **`close`**: close it once built.",
		),
	],
	[
		"wontfix",
		{},
		maintainers("closing awaits", ON_FORGE, "- **`close`**: close it."),
	],
	["duplicate", {}, tours("closing it")],
] as [State, Data, string][])(
	"the turn of %s for %j is %s",
	(state, data, turn) => {
		expect(turnLines(state, data, "forge-bot").join("\n")).toBe(turn);
	},
);

const reviewed = {
	touches: ["a.ts", "b.ts"],
	what: "Greet by name.",
	requirements: ["When given a name, greet.sh shall greet it.", "Bare\nstays."],
	figures: [
		{
			kind: "seams" as const,
			caption: "Green: an edge it adds.",
			source: 'flowchart LR\n  a["greet.sh"] -->|"name ¹"| b["args"]',
			notes: ["The first argument", "In greet.sh"],
		},
		{
			kind: "pseudocode" as const,
			caption: "",
			source: "+ greet(name)",
			notes: [],
		},
	],
	consequences: "Callers may pass a name.",
	decisions: [
		{ lead: "Source", points: ["The first argument", "In greet.sh"] },
		{ lead: "Bare", points: [] },
	],
	excluded: [
		{ lead: "Others", points: ["No greeting by title", "In greet.sh"] },
	],
	acceptance: ["bun test"],
	subject: "feat: greet",
};

test("a spec comment reads in order: heading, Context, Requirements, Shape, Decisions, Consequences, Left out, Acceptance, folded Touches, one foot line, then the turn", () => {
	const data: Data = {
		concert: "c1",
		version: 2,
		result: result("needs-approval", {
			risk: "high",
			area: "cli",
			spec: reviewed,
			reasons: ["touches a contract"],
			related: [4],
		}),
	};
	const shown = commentOf(data, "needs-approval", "forge-bot");
	expect(shown.split("\n<!-- maestro-tm-data")[0]).toBe(
		[
			"<!-- maestro-tm -->",
			"",
			"### Spec v2 · risk high · area cli",
			"",
			"#### Context",
			"",
			"Greet by name.",
			"",
			"Subject: `feat: greet`",
			"",
			"#### Requirements",
			"",
			"- **R1** When given a name, greet.sh shall greet it.",
			"- **R2** Bare",
			"  stays.",
			"",
			"#### Shape",
			"",
			"Green: an edge it adds.",
			"",
			"```mermaid",
			'flowchart LR\n  a["greet.sh"] -->|"name ¹"| b["args"]',
			"```",
			"",
			"1. The first argument",
			"2. In greet.sh",
			"",
			"```diff",
			"+ greet(name)",
			"```",
			"",
			"#### Decisions",
			"",
			"- **Source**",
			"  - The first argument",
			"  - In greet.sh",
			"- **Bare**",
			"",
			"#### Consequences",
			"",
			"Callers may pass a name.",
			"",
			"#### Left out",
			"",
			"- **Others**",
			"  - No greeting by title",
			"  - In greet.sh",
			"",
			"#### Acceptance",
			"",
			"- [ ] bun test",
			"",
			"<details><summary><b>Touches</b> · 2 files</summary>",
			"",
			"- `a.ts`",
			"- `b.ts`",
			"",
			"</details>",
			"",
			"Reasons: touches a contract · Relates to #4 · Last concert: `c1`",
			"",
			turnLines("needs-approval", data, "forge-bot").join("\n"),
		].join("\n"),
	);
	expect(dataOf(shown)).toEqual(data);
});

test.each([
	["a direct ruling's", ready, "Brief", "brief"],
	["a planner's", specced, "Spec", "spec"],
])(
	"%s spec heads its comment and its link by its kind",
	(_, result, heading, link) => {
		const shown = commentOf({ result }, "needs-approval", "forge-bot");
		expect(shown).toContain(`### ${heading} v1 · risk low`);
		expect(tracked("Greet.", 9, { result })).toContain(`[${link} v1]`);
	},
);

test("a spec stored without decisions or exclusions reads them as empty, renders and round-trips", () => {
	const { decisions, excluded, ...old } = reviewed;
	const stored = {
		version: 1,
		result: result("needs-approval", { spec: old }),
	};
	const body = `<!-- maestro-tm -->\n<!-- maestro-tm-data ${JSON.stringify(stored)} -->`;
	const data = dataOf(body);
	expect(data.result?.spec).toEqual({ ...old, decisions: [], excluded: [] });
	const shown = commentOf(data, "needs-approval", "forge-bot");
	expect(shown).toContain("### Spec v1 · risk low\n\n#### Context");
	expect(shown).not.toContain("#### Decisions");
	expect(shown).not.toContain("#### Left out");
	expect(dataOf(shown)).toEqual(data);
});

test("a split's spec comment draws its children's order, quotes in a title as entities", () => {
	const children = [
		{ title: 'Say "hi"', body: "b", dependsOn: [] },
		{ title: "Two", body: "b", dependsOn: [0] },
	];
	const data: Data = { result: result("split", { children }) };
	expect(commentOf(data, "needs-approval", "forge-bot")).toContain(
		[
			"#### Children",
			"",
			'1. Say "hi"',
			"2. Two (after 1)",
			"",
			"```mermaid",
			"flowchart LR",
			'  c1["1 · Say #quot;hi#quot;"]',
			'  c2["2 · Two"]',
			"  c1 --> c2",
			"```",
			"",
		].join("\n"),
	);
	const apart = {
		result: result("split", {
			children: [children[0], { ...children[1], dependsOn: [] }],
		}),
	};
	expect(commentOf(apart, "needs-approval", "forge-bot")).not.toContain(
		"mermaid",
	);
});

test("a spec comment leaves out a Touches with no items, fold and all", () => {
	const bare = { ...reviewed, touches: [] };
	const data: Data = { result: result("needs-approval", { spec: bare }) };
	const shown = commentOf(data, "needs-approval", "forge-bot");
	expect(shown).not.toContain("<details>");
	expect(shown).not.toContain("<summary>");
	expect(shown).toContain("- [ ] bun test\n\n---");
});

test.each([
	[0, "0"],
	[999, "999"],
	[1_000, "1k"],
	[1_500, "1.5k"],
	[957_100, "957k"],
	[999_499, "999k"],
	[999_500, "1M"],
	[1_370_000, "1.37M"],
	[12_345_678, "12.3M"],
])("shows %d tokens as %s", (n, shown) => {
	expect(shorthand(n)).toBe(shown);
});

test.each([
	[0, "0s"],
	[45_000, "45s"],
	[59_600, "1m"],
	[720_000, "12m"],
	[3_900_000, "1h5m"],
])("shows %d ms as %s", (ms, shown) => {
	expect(elapsed(ms)).toBe(shown);
});

const SPENT = {
	short: "01a1",
	elapsedMs: 60_000,
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	encore: false,
};

test("a PR body with nothing to add holds no relates-to, gaps or door, and says the review upheld none", () => {
	const body = pullBody({
		issue: 5,
		spend: [SPENT],
		tier: "ordinary",
		risk: "medium",
		gaps: [],
		result: ready,
	});
	expect(body).toStartWith("Closes #5\n\n## Summary\n\ns\n\n## Evidence");
	expect(body).toContain(
		"- Gate: green\n- Review: ordinary review, upheld 0\n  - None.\n",
	);
	expect(body).toContain("## Merge Danger\n\n**Risk:** medium\n\n## Spend");
	expect(body).not.toContain("Gaps");
});

test("a PR body labels a spend row an encore only when its concert was one", () => {
	const body = pullBody({
		issue: 5,
		spend: [
			SPENT,
			{ ...SPENT, short: "02b2" },
			{ ...SPENT, short: "03c3", encore: true },
		],
		tier: "small",
		risk: "low",
		gaps: [],
		result: ready,
	});
	expect(body).toContain("`01a1` build");
	expect(body).toContain("`02b2` build");
	expect(body).toContain("`03c3` encore");
});

test("a PR body names the planner's contract as the one-way door", () => {
	const body = pullBody({
		issue: 5,
		spend: [SPENT],
		tier: "risky",
		risk: "high",
		gaps: [],
		result: { ...ready, contract: "the --json flag" },
	});
	expect(body).toContain("**Risk:** high\n\n**One-way door:** the --json flag");
});

test("a PR body from the writer keeps its sections, then the gaps, risk and review, the spend folded, and closes last", () => {
	const body = pullBody({
		issue: 5,
		spend: [SPENT],
		tier: "small",
		risk: "low",
		gaps: ["no Windows run"],
		result: { ...ready, related: [7] },
		pr: "## Summary\n\nx",
	});
	expect(body).toStartWith(
		"## Summary\n\nx\n\n<details><summary>Gaps (1)</summary>",
	);
	expect(body).toContain(
		"**Risk:** low · **Review:** small\n\n<details><summary>Spend: 1m, 10 tokens</summary>",
	);
	expect(body).toEndWith("</details>\n\nCloses #5 · relates to #7");
	expect(body).not.toContain("## Evidence");
});

const PROPOSAL = {
	target: "docs/agents/factory.md",
	title: "Say to run just fmt first",
	body: "Add a line to the Rules.\n",
	lessons: ["run just fmt first", "format before the checks"],
};

test("a harvest output parses, an empty list of proposals too", () => {
	expect(parseHarvest({ proposals: [PROPOSAL] })).toEqual({
		proposals: [PROPOSAL],
	});
	expect(parseHarvest({ proposals: [] })).toEqual({ proposals: [] });
});

test("a harvest output that is not an object is malformed", () => {
	expect(() => parseHarvest("proposals")).toThrow(
		"the harvest output is not an object",
	);
});

test.each([
	["missing its lessons", { ...PROPOSAL, lessons: undefined }],
	["with a target that is no string", { ...PROPOSAL, target: 3 }],
])("a harvest with a proposal %s is malformed", (_, proposal) => {
	expect(() => parseHarvest({ proposals: [proposal] })).toThrow("proposals");
});

test("a proposal's issue asks its target, body, lessons and fingerprint, then gives the maintainer's turn", () => {
	const proposal = {
		...PROPOSAL,
		title: "Format <!-- first",
		body: "Add <!-- this --> to the Rules.",
	};
	const { title, body } = proposalIssue(proposal);
	expect(title).toBe("Format <! -- first");
	const ask = askOf(body);
	expect(ask).toStartWith(
		"Target: `docs/agents/factory.md`\n\nAdd <! -- this --> to the Rules.",
	);
	expect(ask).toContain("- run just fmt first\n- format before the checks");
	expect(ask).toEndWith(proposalLine(proposal));
	expect(body).toEndWith(
		[
			MARKER,
			"",
			"---",
			"",
			"**Maintainer's turn · the proposal awaits approval**",
			"",
			"- **`needs-triage`**: specify and build it.",
			"- **`wontfix`**: drop it.",
			"",
			"---",
			"",
			"<sub>Label the issue with the choice.</sub>",
		].join("\n"),
	);
});

test("a proposal's fingerprint changes with its title and ignores case and folded whitespace", () => {
	expect(proposalLine({ ...PROPOSAL, title: "Other" })).not.toBe(
		proposalLine(PROPOSAL),
	);
	expect(
		proposalLine({
			...PROPOSAL,
			title: "say  to RUN just fmt first",
			body: "Add a line   to the Rules.",
		}),
	).toBe(proposalLine(PROPOSAL));
});
