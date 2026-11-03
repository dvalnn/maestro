import { basename, posix } from "node:path";
import {
	Enum,
	Int,
	Json,
	List,
	type Settled,
	Struct,
	Text,
	type Type,
	type Types,
	type ValueOf,
} from "@maestro/sdk";

export const PROPOSED = ["ready-for-agent", "split"] as const;
/** What the triager rules: `plan` hands the issue on to the scouts and the planner, any other settles it early. */
const RULED = ["direct", "plan", "duplicate", "needs-info"] as const;
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

export type Ruled = (typeof RULED)[number];
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
export const NARROW = 3;
const TEST_FILE = /\.test\.ts$/;
const MARKDOWN = /\.md$/;
/** The programs an acceptance command may start with to count as runnable. */
export const RUNNERS = ["bun", "bunx", "just", "mise"];

/** The acceptance of a direct build: the target's whole gate. */
const GATE_COMMAND = "just check";
/** The lead of what the spec check found, left in the spec for the build and the review. */
const CHECKED = "Open after the spec check";
const NO_TOUCHES = "Which paths does the change create or edit?";
const NO_ACCEPTANCE = `Which command proves the change done? Acceptance commands start with ${RUNNERS.join(", ")}.`;
const outsideRepo = (paths: string[]) =>
	`Which repo-relative paths does the change touch in place of ${paths.join(", ")}?`;
/** The most questions in one group, one scout's run. */
export const GROUP_SIZE = 3;

/** A decision or exclusion: `lead` only titles it, each of `points` holds one fact. */
const Point = Struct({ lead: Text(), points: List(Text()) });
const SpecPart = Struct({
	what: Text(),
	decisions: List(Point),
	excluded: List(Point),
	acceptance: List(Text()),
	subject: Text(),
});
type SpecPart = ValueOf<typeof SpecPart>;
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

/** A rule that a direct ruling names one to `NARROW` files. */
const NARROWS = forVerdict("direct", {
	properties: { files: { minItems: 1, maxItems: NARROW } },
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
	},
	{
		spec: SpecPart,
		children: Children,
		related: List(Int()),
	},
	[needs("ready-for-agent", "spec"), needs("split", "children")],
);
export type Proposal = ValueOf<typeof Proposal>;

export const Group = Struct({
	id: Text(),
	area: Text(),
	questions: Json<string[]>({
		type: "array",
		items: Text().schema,
		minItems: 1,
		maxItems: GROUP_SIZE,
	}),
});
export type Group = ValueOf<typeof Group>;

/** The spec check's findings: one per failure of the spec against the code, none when it holds. */
export const Checked = shape({ findings: List(Text()) }, {});
export type Checked = ValueOf<typeof Checked>;

/**
 * The triager's ruling: an early verdict, a direct brief of `what` and `subject`, or at most `maxGroups` groups of
 * questions for the scouts and the planner.
 */
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
		{
			what: Text(),
			subject: Text(),
			duplicateOf: Int(),
			related: List(Int()),
		},
		[
			needs("duplicate", "duplicateOf"),
			needs("direct", "what"),
			needs("direct", "subject"),
			NARROWS,
			ASKS,
		],
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

/** `spec` with the spec check's `findings`, when it has any, as the last of what it leaves out. */
function withFindings(spec: SpecPart, findings: string[]): SpecPart {
	if (!findings.length) return spec;
	const open = { lead: CHECKED, points: findings };
	return { ...spec, excluded: [...spec.excluded, open] };
}

/**
 * The triage of a planner's `proposal`, its gaps asked of the owner and the spec check's `findings` left in its spec. A
 * ready proposal's spec stays in the result whatever the verdict, for a re-triage to continue and the owner to approve.
 */
function proposed(proposal: Proposal, findings: string[]): Triage {
	const { touches, spec, children, related } = proposal;
	const contract = proposal.contract.trim();
	const classified = classify(touches, contract);
	const questions = gapsOf(proposal).map(askAlone);
	const verdict = verdictOf(proposal.verdict, classified.risk, questions);
	return {
		verdict,
		...classified,
		questions,
		...(proposal.verdict === "ready-for-agent" &&
			spec && {
				spec: {
					touches: scopeOf(touches).paths,
					...withFindings(spec, findings),
				},
			}),
		...(verdict === "split" && { children }),
		...relatedOf(related),
		...(contract && { contract }),
	};
}

/** The spec of a direct ruling: its brief, built under the gate alone. */
const directSpec = ({ files, what = "", subject = "" }: Ruling) => ({
	touches: scopeOf(files).paths,
	what,
	decisions: [],
	excluded: [],
	acceptance: [GATE_COMMAND],
	subject,
});

/** The triage of a ruling the triager settled early as `verdict`, `direct` building at once on its brief. */
function ruled(ruling: Ruling, ruledAs: Exclude<Ruled, "plan">): Triage {
	const { files, questions, duplicateOf, related } = ruling;
	const direct = ruledAs === "direct";
	const classified = classify(files, "");
	const verdict = verdictOf(
		direct ? "ready-for-agent" : ruledAs,
		classified.risk,
		questions,
	);
	return {
		verdict,
		...classified,
		questions,
		...(direct && { spec: directSpec(ruling) }),
		...(verdict === "duplicate" && { duplicateOf }),
		...relatedOf(related),
	};
}

/** `question` without a recommendation that names none of its options, a rule its schema cannot express. */
function recommendable({ recommend, ...question }: Question): Question {
	const named = question.options.some((o) => o.label === recommend?.label);
	return named ? { ...question, recommend } : question;
}

/** The spec check's findings: those it found, none when it was skipped, or the one saying it failed to run. */
function findingsOf(check: Settled<Checked>[]): string[] {
	const [checked] = check;
	if (checked?.outcome === "ok") return checked.value.findings;
	if (!checked || checked.outcome === "skipped") return [];
	return [`The spec check did not run: ${checked.reason}.`];
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
	return proposed(planned.value, findingsOf(check));
}

/**
 * The triage verdict: the triager's early ruling or the planner's proposal, which it only ever downgrades or gates,
 * never upgrades. A failure the spec check found, or a check that failed to run, is left in the spec for the build.
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
