import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { atLeastOne, scout, toMarkdown } from "@maestro/classics";
import {
	check,
	fresh,
	JsonOut,
	MarkdownOut,
	read,
	seat,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	allSettled,
	type CodeContext,
	code,
	composition,
	Enum,
	Int,
	iter,
	Json,
	List,
	literal,
	lookup,
	Markdown,
	readJson,
	type Settled,
	Struct,
	Text,
	type Type,
	type Types,
	type ValueOf,
} from "@maestro/sdk";

// ADR 0008: a code node's function must be exported by its composition file.
export { toMarkdown };

const PROPOSED = ["ready-for-agent", "split", "needs-info"] as const;
/** What the triager rules: `plan` hands the issue on to the scouts and the planner, any other settles it early. */
const RULED = ["plan", "duplicate", "needs-info"] as const;
const VERDICTS = [
	"ready-for-agent",
	"needs-approval",
	"needs-info",
	"split",
	"duplicate",
] as const;
const RISKS = ["low", "medium", "high"] as const;
const TIERS = ["small", "ordinary", "risky"] as const;
/** The areas, in the order that breaks a tie (triage-labels.md). */
const AREAS = ["core", "cli", "host", "packs", "docs", "factory"] as const;

type Ruled = (typeof RULED)[number];
type Verdict = (typeof VERDICTS)[number];
type Risk = (typeof RISKS)[number];
type Tier = (typeof TIERS)[number];
type Area = (typeof AREAS)[number];

const AREA_PATHS: Record<Area, readonly string[]> = {
	core: [
		"packages/ir/",
		"packages/core/",
		"packages/sdk/",
		"packages/testkit/",
	],
	cli: ["packages/cli/", "packages/render-text/"],
	host: ["packages/host-repo/", "packages/host-repo-sdk/", "packages/harness-"],
	packs: ["packs/"],
	docs: ["docs/"],
	factory: ["scripts/factory/", ".maestro/"],
};

/** Markdown that sets a contract: a path ending in `/` is a directory holding every path under it, any other a file. */
const CONTRACT_DOCS = [
	"docs/requirements.md",
	"docs/sdk-spec.md",
	"docs/adr/",
	"GLOSSARY.md",
];
/** Paths besides Markdown that set a contract, read as `CONTRACT_DOCS` is. */
const CONTRACT_PATHS = [
	"packages/ir/",
	"packages/sdk/",
	".forgejo/",
	"justfile",
	"mise.toml",
	".maestro/config.yaml",
	".maestro/presets/",
	"scripts/factory/transitions.ts",
];
/** File names that set a contract in any directory. */
const MANIFESTS = ["package.json", "bun.lock"];
const WIDE = 8;
const NARROW = 3;
const TEST_FILE = /\.test\.ts$/;
const MARKDOWN = /\.md$/;
/** The programs an acceptance command may start with to count as runnable. */
const RUNNERS = ["bun", "bunx", "just", "mise"];

const NO_TOUCHES = "Which paths does the change create or edit?";
const NO_ACCEPTANCE = `Which command proves the change done? Acceptance commands start with ${RUNNERS.join(", ")}.`;
const outsideRepo = (paths: string[]) =>
	`Which repo-relative paths does the change touch in place of ${paths.join(", ")}?`;
/** The most questions in one group, one scout's run. */
const GROUP_SIZE = 3;

const GATE =
	"A build must pass `just check`, which runs format, lint, types and every test, and keep to CODING_STANDARDS.md.";

/** A decision or exclusion: `lead` only titles it, each of `points` holds one fact. */
const Point = Struct({ lead: Text(), points: List(Text()) });
const SpecPart = Struct({
	what: Text(),
	decisions: List(Point),
	excluded: List(Point),
	acceptance: List(Text()),
	subject: Text(),
});
const Spec = Struct({
	touches: List(Text()),
	what: Text(),
	decisions: List(Point),
	excluded: List(Point),
	acceptance: List(Text()),
	subject: Text(),
});
const Child = Struct({
	title: Text(),
	body: Text(),
	dependsOn: List(Json<number>({ type: "integer", minimum: 0 })),
});
type Child = ValueOf<typeof Child>;
const Children = Json<Child[]>({
	type: "array",
	items: Child.schema,
	minItems: 1,
});

type Rule = Record<string, unknown>;

/** A rule that an object whose verdict is `verdict` keeps `rule`. */
const forVerdict = (verdict: Verdict | Ruled, rule: Rule): Rule => ({
	anyOf: [{ properties: { verdict: { not: { const: verdict } } } }, rule],
});

/** A rule that `field` is present when the verdict is `verdict`. */
const needs = (verdict: Verdict | Ruled, field: string) =>
	forVerdict(verdict, { required: [field] });

/** A rule that a needs-info verdict asks at least one question. */
const ASKS = forVerdict("needs-info", {
	properties: { questions: { minItems: 1 } },
});

type Shaped<R extends Types, O extends Types> = {
	[K in keyof R]: ValueOf<R[K]>;
} & { [K in keyof O]?: ValueOf<O[K]> };

/** An object with the `required` fields, any of the `optional` ones and nothing else, that keeps every rule. */
function shape<R extends Types, O extends Types>(
	required: R,
	optional: O,
	rules: Rule[] = [],
): Type<Shaped<R, O>> {
	const properties = Object.fromEntries(
		Object.entries({ ...required, ...optional }).map(([k, t]) => [k, t.schema]),
	);
	return Json<Shaped<R, O>>({
		type: "object",
		properties,
		required: Object.keys(required),
		additionalProperties: false,
		// JSON Schema refuses an empty allOf.
		...(rules.length > 0 && { allOf: rules }),
	});
}

/** A question for the owner: the ask, a lead line, short options, the option recommended and the evidence by topic. */
export const Question = shape(
	{
		ask: Text(),
		options: List(Struct({ label: Text(), text: Text() })),
		context: List(Struct({ topic: Text(), text: Text() })),
	},
	{ lead: Text(), recommend: Struct({ label: Text(), why: Text() }) },
);
export type Question = ValueOf<typeof Question>;

/** The planner's proposal: `touches` whatever the verdict, and the part each verdict needs. */
export const Proposal = shape(
	{
		verdict: Enum(PROPOSED),
		touches: List(Text()),
		contract: Text(),
		questions: List(Question),
	},
	{
		spec: SpecPart,
		children: Children,
		related: List(Int()),
	},
	[needs("ready-for-agent", "spec"), needs("split", "children"), ASKS],
);
export type Proposal = ValueOf<typeof Proposal>;

const Group = Struct({
	id: Text(),
	area: Text(),
	questions: Json<string[]>({
		type: "array",
		items: Text().schema,
		minItems: 1,
		maxItems: GROUP_SIZE,
	}),
});
type Group = ValueOf<typeof Group>;

/** The spec check's questions: one per failure of the spec against the code, none when it holds. */
export const Checked = shape({ questions: List(Question) }, {});
export type Checked = ValueOf<typeof Checked>;

/** The triager's ruling: an early verdict, or at most `maxGroups` groups of questions for the scouts and the planner. */
export const Ruling = (maxGroups: number) =>
	shape(
		{
			verdict: Enum(RULED),
			files: List(Text()),
			groups: Json<Group[]>({
				type: "array",
				items: Group.schema,
				maxItems: maxGroups,
			}),
			questions: List(Question),
		},
		{ duplicateOf: Int(), related: List(Int()) },
		[needs("duplicate", "duplicateOf"), ASKS],
	);
export type Ruling = ValueOf<ReturnType<typeof Ruling>>;

/**
 * The triage verdict the tick acts on: the part each verdict needs, `area` only when a path falls in one, and `related`
 * and `contract` only when there are any.
 */
export const Triage = shape(
	{
		verdict: Enum(VERDICTS),
		risk: Enum(RISKS),
		tier: Enum(TIERS),
		reasons: List(Text()),
		questions: List(Question),
	},
	{
		area: Enum(AREAS),
		spec: Spec,
		children: Children,
		duplicateOf: Int(),
		related: List(Int()),
		contract: Text(),
	},
	[
		needs("ready-for-agent", "spec"),
		needs("needs-approval", "spec"),
		needs("split", "children"),
		needs("duplicate", "duplicateOf"),
		ASKS,
	],
);
export type Triage = ValueOf<typeof Triage>;

/** Whether `path` is the directory `dir`, which ends in `/`, or under it. */
const under = (path: string, dir: string) =>
	path.startsWith(dir) || path === dir.slice(0, -1);

/**
 * Each of `touches` normalised to a repo-relative path, and those that are not one: absolute, or climbing out of the
 * repo, or the repo itself.
 */
function scopeOf(touches: string[]): { paths: string[]; outside: string[] } {
	const normal = touches.map((t) => posix.normalize(t.trim()));
	const isOutside = (p: string) =>
		posix.isAbsolute(p) || p === "." || p === ".." || p.startsWith("../");
	return {
		paths: normal.filter((p) => !isOutside(p)),
		outside: normal.filter(isOutside),
	};
}

const sets = (path: string) =>
	!TEST_FILE.test(path) &&
	(MANIFESTS.includes(basename(path)) ||
		(MARKDOWN.test(path) ? CONTRACT_DOCS : CONTRACT_PATHS).some((p) =>
			p.endsWith("/") ? under(path, p) : path === p,
		));

const isLow = (path: string) =>
	under(path, "docs/") || MARKDOWN.test(path) || TEST_FILE.test(path);

/** The risk and review tier of touching `touches`, and each rule that fired. */
function riskOf(
	touches: string[],
	contract: string,
): { risk: Risk; tier: Tier; reasons: string[] } {
	const reasons: string[] = [];
	const setting = touches.filter(sets);
	if (setting.length)
		reasons.push(`touches ${setting.join(", ")}, which set a contract`);
	const code = touches.filter((t) => !isLow(t));
	const wide = code.length >= WIDE;
	if (wide)
		reasons.push(
			`touches ${code.length} paths besides docs and tests, ${WIDE} or more`,
		);
	if (contract) reasons.push(`the planner names a contract: ${contract}`);
	if (reasons.length)
		return { risk: "high", tier: wide ? "risky" : "ordinary", reasons };
	// An empty list proves nothing about its paths, so it is not low.
	if (touches.length && touches.length <= NARROW && touches.every(isLow))
		return {
			risk: "low",
			tier: "small",
			reasons: [`touches only docs and tests, ${NARROW} paths or fewer`],
		};
	return { risk: "medium", tier: "ordinary", reasons };
}

/** The area holding most of `touches`, a tie going to the area first in `AREAS`, or none when no path is in one. */
function areaOf(touches: string[]): { area?: Area } {
	const inArea = (t: string, p: string) =>
		p.endsWith("/") ? under(t, p) : t.startsWith(p);
	const held = (area: Area) =>
		touches.filter((t) => AREA_PATHS[area].some((p) => inArea(t, p))).length;
	const best = AREAS.reduce((a, b) => (held(b) > held(a) ? b : a));
	return held(best) ? { area: best } : {};
}

/**
 * The risk, review tier and area of a change that touches `touches`, each normalised and those outside the repo left
 * out, and each risk rule that fired:
 * - high, when a path other than a test sets a contract, `WIDE` paths or more are neither docs nor tests, or the trimmed
 *   `contract` is not empty; its tier is `risky` when that width fired, else `ordinary`;
 * - low, when one to `NARROW` paths are all docs or tests, at tier `small`;
 * - medium, otherwise, at tier `ordinary`.
 */
export function classify(
	touches: string[],
	contract: string,
): { risk: Risk; tier: Tier; area?: Area; reasons: string[] } {
	const { paths } = scopeOf(touches);
	return { ...riskOf(paths, contract), ...areaOf(paths) };
}

const isRunnable = (command: string) =>
	RUNNERS.includes(command.trim().split(/\s+/)[0] ?? "");

/** The question for each dependency of the child at `index` that is not an earlier child. */
const orderGaps = ({ title, dependsOn }: Child, index: number) =>
	dependsOn
		.filter((d) => d >= index)
		.map(
			(d) =>
				`Child ${index} ("${title}") depends on ${d}, which is not an earlier child: which child does it need?`,
		);

/** The question for a ready proposal's scope that is missing, or holds a path outside the repo. */
function scopeGaps(touches: string[]): string[] {
	const { paths, outside } = scopeOf(touches);
	if (outside.length) return [outsideRepo(outside)];
	return paths.length ? [] : [NO_TOUCHES];
}

/**
 * The question for each gap of `proposal`:
 * - a ready one's missing or outside paths, or missing runnable acceptance command;
 * - a split's child that depends on one not before it.
 */
function gapsOf(proposal: Proposal): string[] {
	if (proposal.verdict === "split")
		return (proposal.children ?? []).flatMap(orderGaps);
	if (proposal.verdict !== "ready-for-agent") return [];
	const gaps = scopeGaps(proposal.touches);
	if (!proposal.spec?.acceptance.some(isRunnable)) gaps.push(NO_ACCEPTANCE);
	return gaps;
}

/** The verdict of `proposed`: needs-info when it asks any of `questions`, else gated when ready at high risk. */
function verdictOf(
	proposed: Verdict,
	risk: Risk,
	questions: Question[],
): Verdict {
	if (questions.length) return "needs-info";
	if (proposed === "ready-for-agent" && risk === "high")
		return "needs-approval";
	return proposed;
}

const relatedOf = (related?: number[]) => (related?.length ? { related } : {});

const askAlone = (ask: string): Question => ({ ask, options: [], context: [] });

/**
 * The triage of a planner's `proposal`, the spec check's `failures` asked of the owner besides its own questions. A
 * ready proposal's spec stays in the result whatever the verdict, for a re-triage to continue and the owner to approve.
 */
function proposed(proposal: Proposal, failures: Question[]): Triage {
	const { touches, spec, children, related } = proposal;
	const contract = proposal.contract.trim();
	const classified = classify(touches, contract);
	const questions = [
		...proposal.questions,
		...gapsOf(proposal).map(askAlone),
		...failures,
	];
	const verdict = verdictOf(proposal.verdict, classified.risk, questions);
	return {
		verdict,
		...classified,
		questions,
		...(proposal.verdict === "ready-for-agent" &&
			spec && { spec: { touches: scopeOf(touches).paths, ...spec } }),
		...(verdict === "split" && { children }),
		...relatedOf(related),
		...(contract && { contract }),
	};
}

/** The triage of a ruling the triager settled early as `verdict`. */
function ruled(
	{ files, questions, duplicateOf, related }: Ruling,
	ruledAs: Exclude<Ruled, "plan">,
): Triage {
	const classified = classify(files, "");
	const verdict = verdictOf(ruledAs, classified.risk, questions);
	return {
		verdict,
		...classified,
		questions,
		...(verdict === "duplicate" && { duplicateOf }),
		...relatedOf(related),
	};
}

/** `question` without a recommendation that names none of its options, a rule its schema cannot express. */
function recommendable({ recommend, ...question }: Question): Question {
	const named = question.options.some((o) => o.label === recommend?.label);
	return named ? { ...question, recommend } : question;
}

/** The spec check's questions: those it found, none when it was skipped, or the one asking about a check that failed to run. */
function failuresOf(check: Settled<Checked>[]): Question[] {
	const [checked] = check;
	if (checked?.outcome === "ok") return checked.value.questions;
	if (!checked || checked.outcome === "skipped") return [];
	return [
		askAlone(
			`The spec check did not run: ${checked.reason}. Approve the spec as is, or re-triage.`,
		),
	];
}

/** The triage of `ruling`, or of the planner's proposal when the triager handed the issue on. */
function triageOf(
	ruling: Ruling,
	proposal: Settled<Proposal>[],
	check: Settled<Checked>[],
): Triage {
	if (ruling.verdict !== "plan") return ruled(ruling, ruling.verdict);
	const [planned] = proposal;
	if (planned?.outcome !== "ok")
		throw new Error("the planner gave no proposal");
	return proposed(planned.value, failuresOf(check));
}

/**
 * The triage verdict: the triager's early ruling or the planner's proposal, which it only ever downgrades or gates,
 * never upgrades. A failure the spec check found, or a check that failed to run, is a question to the owner.
 * @throws Error when the triager handed the issue on and the planner gave no proposal.
 */
export function settle({
	ruling,
	proposal,
	check,
}: {
	ruling: Ruling;
	proposal: Settled<Proposal>[];
	check: Settled<Checked>[];
}): { triage: Triage } {
	const triage = triageOf(ruling, proposal, check);
	return {
		triage: { ...triage, questions: triage.questions.map(recommendable) },
	};
}

const Slot = Struct({ slot: Text(), group: Group });
type Slot = ValueOf<typeof Slot>;

/** Each of `groups` with its slot, `G1` on by position, which names its scout whatever id the triager gave it. */
export function slotsOf({ groups }: { groups: Group[] }): { slots: Slot[] } {
	return { slots: groups.map((group, i) => ({ slot: `G${i + 1}`, group })) };
}

export function slotKey({ slot }: Slot): string {
	return slot;
}

const numbered = (lines: string[]) => lines.map((l, i) => `${i + 1}. ${l}`);

/** The group of `slot` as a Markdown file, for its scout. */
export function groupOf(
	{ slot: { group } }: { slot: Slot },
	ctx: CodeContext,
): { file: string } {
	const file = join(ctx.scratch, "group.md");
	const { id, area, questions } = group;
	writeFileSync(
		file,
		[`# ${id}: ${area}`, "", ...numbered(questions), ""].join("\n"),
	);
	return { file };
}

type Answered = { answer: ArtifactRef };

/** The body of a group's section: its scout's answer, or why it has none. */
function answerOf(scout: Settled<Answered> | undefined, ctx: CodeContext) {
	if (scout?.outcome === "ok")
		return readFileSync(ctx.path(scout.value.answer), "utf8").trim();
	const why = scout && "reason" in scout ? scout.reason : undefined;
	return `Unanswered: the scout ${scout?.outcome ?? "did not run"}${why ? `: ${why}` : ""}.`;
}

/** The scouts' answers as one Markdown file, a section per group in order, marking a group whose scout failed. */
export function answersOf(
	{ groups, scouts }: { groups: Group[]; scouts: Settled<Answered>[] },
	ctx: CodeContext,
): { answers: string } {
	const sections = groups.flatMap((g, i) => [
		`## ${g.id}: ${g.area}`,
		"",
		...numbered(g.questions),
		"",
		answerOf(scouts[i], ctx),
		"",
	]);
	const answers = join(ctx.scratch, "answers.md");
	const body = sections.length ? sections : ["No questions.", ""];
	writeFileSync(answers, ["# The scouts' answers", "", ...body].join("\n"));
	return { answers };
}

const PLANS: Record<Ruled, boolean> = {
	plan: true,
	duplicate: false,
	"needs-info": false,
};

const ASKING = `Each question is {"ask": "the question, one line", "lead": "a sentence of background", "options": [{"label": "A", "text": "one option, a line or two"}], "recommend": {"label": "A", "why": "the reason, read on from 'Recommended: A,'"}, "context": [{"topic": "Cost", "text": "one point of evidence, with its file:line"}]}. The owner reads it as a comment: keep the options short and put the evidence in context, one point per item under a one- or two-word topic such as Claiming, D-24 or Cost. Leave out lead when the ask says it all, options when the answer is open, and recommend unless you have a reason for one; recommend.label is the label of one of the options.`;

/** The proposals whose spec the checker checks. */
const CHECKS: Record<(typeof PROPOSED)[number], boolean> = {
	"ready-for-agent": true,
	split: false,
	"needs-info": false,
};

const triageTask = (
	maxGroups: number,
) => `Triage the attached issue against the attached backlog snapshot. ${GATE}
First write backlog.md: only the backlog issues that matter to this one, open or recently closed, each with its number, title and why, or "None.". A closed issue matters when this one builds on it, links it or reworks what it changed; the snapshot lists those under "Recently closed" by title alone.
Then write ruling.json in exactly this shape, leaving out duplicateOf and related where the verdict does not need them:
{"verdict": "plan", "files": ["path/to/file.ts"], "groups": [{"id": "G1", "area": "the line of inquiry", "questions": ["a question the target's code answers"]}], "questions": [], "duplicateOf": 12, "related": [7]}
- verdict: duplicate when a backlog issue already asks this one, with duplicateOf; needs-info when it cannot be planned without the owner's answer, with those questions; plan otherwise.
- files: the repo-relative paths you expect the change to create or edit.
- groups, for plan: at most ${maxGroups}, one per line of inquiry, the most decisive first, numbered G1 on, each of at most ${GROUP_SIZE} questions. Ask only what changes the plan, and settle yourself what one line settles; no group when nothing needs asking.
- questions, for needs-info: ${ASKING}
- related: the backlog issues it relates to.`;

const SCOUT_TASK = `Answer each question of the attached group in answer.md.
answer.md holds one section per question, in order, headed "## <the question>", its answer below, every claim with its file:line. Where the target holds no answer, say so.`;

const PLAN_TASK = `Triage the attached issue: propose its verdict from the scouts' answers, the triager's ruling, the cut backlog and the target's code. ${GATE}
Write plan.json in exactly this shape, leaving out spec, children and related where the verdict does not need them:
{"verdict": "ready-for-agent", "touches": ["path/to/file.ts"], "contract": "", "questions": [], "spec": {"what": "the change to make", "decisions": [{"lead": "a title", "points": ["one fact", "In path/to/file.ts"]}], "excluded": [{"lead": "a title", "points": ["one fact"]}], "acceptance": ["bun test path/to/file.test.ts"], "subject": "feat(scope): imperative summary"}, "children": [{"title": "a child issue's title", "body": "its ask", "dependsOn": [0]}], "related": [7]}
- verdict: ready-for-agent when one change builds the issue as asked, split when it needs several, needs-info when it cannot be specified without an answer.
- touches: every repo-relative path the change creates or edits, whatever the verdict; empty when you cannot tell.
- contract: the one-way door the change sets or changes, named in a few words, or "" when it sets none. A one-way door cannot change after release without breaking a user: an IR field, a public CLI flag or exit code, a key of the user's config, an id or path format users type, or the pack manifest. Internal tooling, an environment variable only the tour manager reads and a new standalone composition are not.
- spec, for ready-for-agent: what to change in one paragraph, the decisions the change makes, what it leaves out, the shell commands that prove it done, each starting with ${RUNNERS.join(", ")}, and the commit subject as <type>(<scope>): <summary>. The owner approves the spec from its decisions and what it leaves out. Hold the spec to about 3,000 to 5,000 characters.
- decisions and excluded: each item a lead and its points. The lead only titles its points; every fact, reference and reason belongs in a point, one fact each, and a reference is a plain last point "In <path>". what names the change, and the facts behind it go in the decisions. A decision is a choice where another option was live, or a fact the owner has to approve; leave out calls, statement order and shell lines, which the builder works out. Either list may be empty.
- children, for split: the parts in order, each with the 0-based indexes of the earlier parts it depends on. Split only when each part lands and is reviewable on its own; an issue one change can build stays whole, however long.
- related: the backlog issues it relates to.
- Codebase health comes before the feature. Before deciding, read the parts of docs/architecture.md and CODING_STANDARDS.md for the packages the change touches. what names the module that owns the change; the change extends what is there, never a parallel path.
- When the ask can only be met by a shortcut, such as a special case in a shared module, a flag threaded through calls, a second route around an existing seam or domain logic in a domain-free package, do not decide it: split, the first part the refactor the feature needs, when that refactor is clear; needs-info, a question naming the clean option and its cost, when it is the owner's choice.
- When the issue carries the spec the last triage proposed, start from it: change what the replies below it ask, and keep the rest.
- questions: what only the owner can answer. Any question sends the issue to needs-info whatever the verdict, so settle yourself what the code settles. Ask only what hangs on no other question asked now; a dependent question waits for the re-triage. ${ASKING}`;

const CHECK_TASK = `Check the attached spec against the code. Its spec is in the attached plan.json.
Write check.json in exactly this shape:
{"questions": [{"ask": "the failure and what the owner should say about it, one line", "options": [], "context": [{"topic": "Claim", "text": "what the spec says and what the code shows, with its file:line"}]}]}
- A claim the spec makes about the base holds: every function, file, flag, behaviour and call site it names exists and behaves as stated, and so does everything it says a change must also update.
- The spec misses no place the change must touch: the uninstall path beside an install, each other caller of a changed function, each test or doc that states the old behaviour.
- The spec fits the architecture. Ask a question, with its file:line, for each of: a duplicate of a helper or pattern the codebase already has (grep for one); a module, abstraction or flag nothing in the ask needs; a public interface wider than the ask; a package boundary crossed, such as domain words in a domain-free package; a decision with lasting weight and no ADR or owner ruling behind it.
- questions: one per failure. Write "questions": [] when nothing fails.`;

const triager = seat("triager");
/** The classics planner, fresh in an encore: a re-triage hands it the last spec rather than its grown session. */
const planner = seat("planner", { profile: "classics/planner", encore: false });

/** The checker, fresh in an encore: a re-triage rewrites the spec it checks. */
const checker = seat("checker", { encore: false });

export const triage = composition(
	"triage",
	{
		doc: "Triage an issue against the backlog: a triager cuts the backlog and rules early or asks groups of questions, a scout answers each group, a planner proposes a verdict, a checker checks a ready spec against the code, and settle classifies its risk, review tier and area and gates the verdict. Read-only: it leaves no changeset.",
		params: {
			issue: Text({
				description: "The issue to triage: its number, title and body",
			}),
			backlog: Markdown({
				description:
					"The backlog snapshot: the open and recently closed issues to check it against",
			}),
			maxGroups: atLeastOne(
				4,
				"The most question groups the triager writes, one scout each",
			),
		},
		examples: [
			{
				issue:
					"#1 Greet by name\n\nMake greet.sh greet the name given as its first argument.",
			},
		],
	},
	({ issue, backlog, maxGroups }) => {
		const issued = {
			artifact: code(toMarkdown, {
				in: { text: issue },
				out: { file: Markdown() },
				label: "issue",
			}).out.file,
			hint: "first, for the issue to triage",
		};
		// A no-op check seals one base version that every seat reads.
		const base = check(fresh(), { run: "true" }, { label: "base" });
		const triaged = triager({
			label: "triager",
			task: triageTask(maxGroups),
			lane: read(base.out.lane),
			attachments: {
				issue: issued,
				backlog: {
					artifact: literal(backlog, Markdown()),
					hint: "for the open and recently closed issues, to cut down to those that matter",
				},
			},
			out: {
				ruling: JsonOut("ruling.json", Ruling(maxGroups)),
				backlog: MarkdownOut("backlog.md"),
			},
		});
		const ruling = readJson(triaged.out.ruling);
		const plans = lookup(PLANS, ruling.get("verdict"));
		const groups = ruling.get("groups");
		const cut = {
			artifact: triaged.out.backlog,
			hint: "for the backlog issues that matter to this one, each with why",
		};
		const slots = code(slotsOf, {
			in: { groups },
			out: { slots: List(Slot) },
			label: "slots",
		}).out.slots;
		const scouts = iter.parMap(
			slots,
			(slot) => {
				const asked = code(groupOf, {
					in: { slot },
					out: { file: Markdown() },
					label: "group",
				});
				return scout({
					label: "scout",
					task: SCOUT_TASK,
					lane: read(base.out.lane),
					attachments: {
						group: {
							artifact: asked.out.file,
							hint: "first, for the questions to answer",
						},
						issue: issued,
						backlog: cut,
					},
				});
			},
			{
				onError: "continue",
				key: slotKey,
				max: maxGroups,
				when: plans,
				label: "scouts",
			},
		);
		const answers = code(answersOf, {
			in: { groups, scouts: scouts.out.results },
			out: { answers: Markdown() },
			label: "answers",
		});
		const planned = planner({
			label: "planner",
			task: PLAN_TASK,
			lane: read(base.out.lane),
			attachments: {
				issue: issued,
				answers: {
					artifact: answers.out.answers,
					hint: "first, for what the scouts found",
				},
				ruling: {
					artifact: triaged.out.ruling,
					hint: "for the triager's questions and the files it expects to change",
				},
				backlog: cut,
			},
			out: { plan: JsonOut("plan.json", Proposal) },
			when: plans,
		});
		const plan = readJson(planned.out.plan);
		const checked = checker({
			label: "checker",
			task: CHECK_TASK,
			lane: read(base.out.lane),
			attachments: {
				plan: {
					artifact: planned.out.plan,
					hint: "first, for the spec to check",
				},
				issue: issued,
				answers: {
					artifact: answers.out.answers,
					hint: "for what the scouts found",
				},
			},
			out: { check: JsonOut("check.json", Checked) },
			when: lookup(CHECKS, plan.get("verdict")),
		});
		return code(settle, {
			in: {
				ruling,
				proposal: allSettled([plan], { label: "proposal" }),
				check: allSettled([readJson(checked.out.check)], { label: "check" }),
			},
			out: { triage: Triage },
			label: "settle",
		});
	},
);
