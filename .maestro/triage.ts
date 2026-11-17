import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Answers } from "@maestro/classics";
import { atLeastOne, fill, scout, scoutDeep } from "@maestro/classics";
import { MarkdownOut, read, seat } from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	allSettled,
	Bool,
	type CodeContext,
	code,
	composition,
	iter,
	List,
	literal,
	lookup,
	Markdown,
	Optional,
	type Ref,
	type Settled,
	Struct,
	Text,
	type ValueOf,
} from "@maestro/sdk";
import FIGURES from "./prompts/_figures.md" with { type: "text" };
import PLAIN from "./prompts/_plain.md" with { type: "text" };
import { fileOf, markdownOf, sealedBase, task } from "./shared";
import { MAX_REQUIREMENT_WORDS } from "./triage/ears";
import DESIGNER from "./triage/prompts/_designer.md" with { type: "text" };
import GATE from "./triage/prompts/_gate.md" with { type: "text" };
import SHAPE from "./triage/prompts/_shape.md" with { type: "text" };
import CHECKER from "./triage/prompts/checker.md" with { type: "text" };
import DESIGNER_COMMON from "./triage/prompts/designer-common.md" with {
	type: "text",
};
import DESIGNER_MINIMAL from "./triage/prompts/designer-minimal.md" with {
	type: "text",
};
import MERGE from "./triage/prompts/merge.md" with { type: "text" };
import PLANNER from "./triage/prompts/planner.md" with { type: "text" };
import REVISE from "./triage/prompts/revise.md" with { type: "text" };
import SCOUT from "./triage/prompts/scout.md" with { type: "text" };
import TRIAGER from "./triage/prompts/triager.md" with { type: "text" };
import { NARROW } from "./triage/risk";
import {
	Checked,
	Exhausted,
	GROUP_SIZE,
	Group,
	MAX_BRIEF_REQUIREMENTS,
	type PROPOSED,
	Proposal,
	Ruling,
	Triage,
} from "./triage/schemas";
import { findingsOf, plansOf, settle } from "./triage/verdict";

// ADR 0008: a code node's function must be exported by its composition file.
export * from "@maestro/classics/code";
export { settle };

/** Each call's task: its own prompt file, then the shared fragments it rules by. */
const TASKS = {
	triager: (maxGroups: number) =>
		task(
			fill(TRIAGER, {
				maxGroups,
				groupSize: GROUP_SIZE,
				narrow: NARROW,
				maxRequirements: MAX_BRIEF_REQUIREMENTS,
				maxWords: MAX_REQUIREMENT_WORDS,
			}),
			PLAIN,
			GATE,
		),
	scout: task(SCOUT),
	planner: task(
		fill(PLANNER, {
			maxWords: MAX_REQUIREMENT_WORDS,
		}),
		PLAIN,
		FIGURES,
		GATE,
		SHAPE,
	),
	checker: task(CHECKER, GATE),
	revise: task(REVISE),
	"designer-minimal": task(DESIGNER_MINIMAL, DESIGNER, SHAPE),
	"designer-common": task(DESIGNER_COMMON, DESIGNER, SHAPE),
	merge: task(MERGE),
};

/** Each designer's label, which names its task and its constraint from the classics `design-it-twice` skill. */
const DESIGNS = ["designer-minimal", "designer-common"] as const;

const Slot = Struct({ slot: Text(), group: Group });
type Slot = ValueOf<typeof Slot>;

/** Each of `groups` with its slot, `G1` on by position, which names its scout whatever id the triager gave it. */
export function slotsOf({ groups }: { groups: Group[] }): { slots: Slot[] } {
	return { slots: groups.map((group, i) => ({ slot: `G${i + 1}`, group })) };
}

export function slotKey({ slot }: Slot): string {
	return slot;
}

/** `group` as a Markdown section under a heading of `level`: its id and area, then its questions numbered. */
const groupSection = ({ id, area, questions }: Group, level: "#" | "##") => [
	`${level} ${id}: ${area}`,
	"",
	...questions.map((q, i) => `${i + 1}. ${q}`),
];

/** The group of `slot` as a Markdown file, for its scout. */
export function groupOf(
	{ slot: { group } }: { slot: Slot },
	ctx: CodeContext,
): { file: string } {
	const file = join(ctx.scratch, "group.md");
	writeFileSync(file, [...groupSection(group, "#"), ""].join("\n"));
	return { file };
}

type Answered = { answers: ValueOf<typeof Answers> };
type Answer = ValueOf<typeof Answers>[number];

/** A question one scout marked unsure, with what it found missing. */
const Unsure = Struct({ question: Text(), missing: Text() });
/** A group that climbs to scout-deep: its slot, its group and only the questions its scout marked unsure. */
const Climb = Struct({
	slot: Text(),
	id: Text(),
	area: Text(),
	unsure: List(Unsure),
});
type Climb = ValueOf<typeof Climb>;

/** The number of answer `a`, the `i`th of its scout's, in `group`: its question's, or one past the group's when it names none. */
const numberOf = (group: Group, a: Answer, i: number) => {
	const at = group.questions.indexOf(a.question);
	return at >= 0 ? at + 1 : group.questions.length + i + 1;
};

/** The grounded check: each group whose scout marked any answer `unsure`, with those questions and their `missing` notes. */
export function climbsOf({
	groups,
	scouts,
}: {
	groups: Group[];
	scouts: Settled<Answered>[];
}): { climbs: Climb[] } {
	const climbs = groups.flatMap((group, g) => {
		const scouted = scouts[g];
		if (scouted?.outcome !== "ok") return [];
		const unsure = scouted.value.answers.flatMap((a) =>
			a.state === "unsure"
				? [{ question: a.question, missing: a.missing }]
				: [],
		);
		const { id, area } = group;
		return unsure.length ? [{ slot: `G${g + 1}`, id, area, unsure }] : [];
	});
	return { climbs };
}

export function climbKey({ slot }: Climb): string {
	return slot;
}

/** The unsure questions of `climb` as a Markdown file, each with what its first scout found missing, for scout-deep. */
export function climbOf(
	{ climb: { id, area, unsure } }: { climb: Climb },
	ctx: CodeContext,
): { file: string } {
	const file = join(ctx.scratch, "group.md");
	const questions = unsure.flatMap((u, i) => [
		`${i + 1}. ${u.question}`,
		`   - Missing after the first scout: ${u.missing}`,
	]);
	writeFileSync(file, [`# ${id}: ${area}`, "", ...questions, ""].join("\n"));
	return { file };
}

/** An answer as its Markdown section, an unsure one marked, an exhausted one marked with its key. */
function sectionOf(a: Answer, exhaustedAs?: string) {
	const mark =
		a.state !== "unsure"
			? []
			: exhaustedAs
				? ["", `Exhausted (${exhaustedAs}), missing: ${a.missing}`]
				: ["", `Unsure, missing: ${a.missing}`];
	return [`### ${a.question}`, "", a.answer, ...mark, ""];
}

type Deepened = { answers: Answer[]; exhausted: Exhausted[] };

/**
 * The answers of a group's scout with those of its scout-deep in place of its unsure ones, matched by question. An
 * unsure answer is exhausted when the deep one is unsure too, left out, or its scout-deep failed.
 */
function deepened(
	slot: string,
	group: Group,
	answers: Answer[],
	climb: Climb | undefined,
	deep: Settled<Answered> | undefined,
): Deepened {
	if (!climb) return { answers, exhausted: [] };
	const deeper = deep?.outcome === "ok" ? deep.value.answers : [];
	const exhausted: Exhausted[] = [];
	const merged = answers.map((a, i) => {
		if (a.state !== "unsure") return a;
		const found = deeper.find((d) => d.question === a.question);
		if (found?.state === "grounded") return found;
		const still = found ?? a;
		const key = `${slot}.${numberOf(group, a, i)}`;
		exhausted.push({ key, question: a.question, missing: still.missing });
		return still;
	});
	return { answers: merged, exhausted };
}

/** The body of a group's section: its answers, an unsure or exhausted one marked, or why it has none. */
function answerOf(
	scout: Settled<Answered> | undefined,
	deepen: (answers: Answer[]) => Deepened,
): { body: string; exhausted: Exhausted[] } {
	if (scout?.outcome === "ok") {
		const { answers, exhausted } = deepen(scout.value.answers);
		const keys = new Map(exhausted.map((e) => [e.question, e.key]));
		const body = answers
			.flatMap((a) => sectionOf(a, keys.get(a.question)))
			.join("\n")
			.trim();
		return { body, exhausted };
	}
	const why = scout && "reason" in scout ? scout.reason : undefined;
	return {
		body: `Unanswered: the scout ${scout?.outcome ?? "did not run"}${why ? `: ${why}` : ""}.`,
		exhausted: [],
	};
}

type Scouted = { groups: Group[]; scouts: Settled<Answered>[] };
type Climbed = Scouted & { climbs: Climb[]; deeps: Settled<Answered>[] };

/** The answers file of `groups`, each group's answers deepened by its climb when it has one, and the exhausted ones. */
function gathered(
	{ groups, scouts, climbs = [], deeps = [] }: Scouted & Partial<Climbed>,
	ctx: CodeContext,
): { answers: string; exhausted: Exhausted[] } {
	const exhausted: Exhausted[] = [];
	const sections = groups.flatMap((g, i) => {
		const slot = `G${i + 1}`;
		const c = climbs.findIndex((climb) => climb.slot === slot);
		const answered = answerOf(scouts[i], (answers) =>
			deepened(slot, g, answers, climbs[c], deeps[c]),
		);
		exhausted.push(...answered.exhausted);
		return [...groupSection(g, "##"), "", answered.body, ""];
	});
	const answers = join(ctx.scratch, "answers.md");
	const body = sections.length ? sections : ["No questions.", ""];
	writeFileSync(answers, ["# The scouts' answers", "", ...body].join("\n"));
	return { answers, exhausted };
}

/** The scouts' answers as one Markdown file, a section per group in order, marking a group whose scout failed. */
export function answersOf(
	scouted: Scouted,
	ctx: CodeContext,
): { answers: string } {
	return { answers: gathered(scouted, ctx).answers };
}

/**
 * The scouts' answers as `answersOf` gives them, each scout-deep answer of the `climbs` in place of its unsure one, and
 * the answers still unsure after it, or whose scout-deep failed, marked and given as `exhausted`.
 */
export function climbedAnswersOf(
	climbed: Climbed,
	ctx: CodeContext,
): { answers: string; exhausted: Exhausted[] } {
	return gathered(climbed, ctx);
}

/** The designers' sketches as one Markdown file, a section per designer in order, marking a sketch that is missing. */
export function sketchesOf(
	{ sketches }: { sketches: Settled<ArtifactRef>[] },
	ctx: CodeContext,
): { sketches: string } {
	const sections = sketches.flatMap((sketch, i) => [
		`## Sketch ${i + 1}`,
		"",
		sketch.outcome === "ok"
			? readFileSync(ctx.path(sketch.value), "utf8").trim()
			: `Missing: the designer ${sketch.outcome}${"reason" in sketch ? `: ${sketch.reason}` : ""}.`,
		"",
	]);
	const file = join(ctx.scratch, "sketches.md");
	writeFileSync(
		file,
		["# The designers' sketches", "", ...sections].join("\n"),
	);
	return { sketches: file };
}

/** The findings the planner revises its plan by, as one Markdown file, and whether there are any. */
export function revisable(
	planned: Parameters<typeof findingsOf>[0],
	ctx: CodeContext,
): { findings: string; revise: boolean } {
	const found = findingsOf(planned);
	const findings = join(ctx.scratch, "findings.md");
	const lines = found.map((f) => `- ${f}`);
	writeFileSync(
		findings,
		["# The spec's findings", "", ...lines, ""].join("\n"),
	);
	return { findings, revise: found.length > 0 };
}

/** The proposals whose spec the checker checks. */
const CHECKS: Record<(typeof PROPOSED)[number], boolean> = {
	"ready-for-agent": true,
	split: false,
};

const triager = seat("triager");
/** The classics planner, fresh in an encore: a re-triage hands it the last spec rather than its grown session. */
const planner = seat("planner", {
	profile: "classics/planner",
	encore: false,
	checks: ["ears"],
	reply: { plan: Proposal },
});

/** A designer, fresh in an encore: it sketches from the evidence the re-triage gathers anew. */
const designer = seat("designer", { encore: false });

/** The checker, fresh in an encore: a re-triage rewrites the spec it checks. */
const checker = seat("checker", {
	encore: false,
	reply: { check: Checked },
});

type Planned = ReturnType<typeof planner>["out"];
type Attachments = Parameters<typeof designer>[0]["attachments"];

/**
 * The planner's plan merged, in its own `session`, with the sketches of designers who start from its `evidence`, never
 * its plan; each runs `when` the planner does.
 */
function merged({
	session,
	evidence,
	base,
	when,
}: {
	session: Planned["session"];
	evidence: Attachments;
	base: Parameters<typeof read>[0];
	when: Ref<boolean>;
}) {
	const sketches = DESIGNS.map(
		(label) =>
			designer({
				label,
				task: TASKS[label],
				lane: read(base),
				attachments: evidence,
				out: { sketch: MarkdownOut("sketch.md") },
				when,
			}).out.sketch,
	);
	const gathered = code(sketchesOf, {
		in: { sketches: allSettled(sketches, { label: "designs" }) },
		out: { sketches: Markdown() },
		label: "sketches",
	});
	return planner({
		label: "merge",
		task: TASKS.merge,
		lane: read(base),
		session,
		attachments: {
			sketches: {
				artifact: gathered.out.sketches,
				hint: "first, for the rival contract shapes to weigh",
			},
		},
		when,
	}).out;
}

export const triage = composition(
	"triage",
	{
		doc: [
			"Triage an issue against the backlog into a verdict. Read-only: it leaves no changeset.",
			"A triager rules early: it sends a small ask straight to the build, asks the owner, or asks scouts.",
			"A planner proposes a verdict from the scouts' answers, a checker checks a ready spec against the code,",
			"and the planner revises it once by the findings. settle then gates the verdict.",
			"With designs, two designers sketch rival contract shapes beside the planner, which merges them into its plan.",
			"With scoutDeep, a group with an unsure answer gets one scout-deep look; an answer still unsure is asked of the owner.",
		].join("\n"),
		params: {
			issue: Text({
				description: "The issue to triage: its number, title and body",
			}),
			backlog: Markdown({
				description:
					"The backlog snapshot: the open and recently closed issues to check it against",
			}),
			sightings: Optional(
				Markdown({
					description:
						"The sightings of the factory runs no masterclass has read yet, one bullet each as `path · cites · text`",
				}),
			),
			maxGroups: atLeastOne(
				4,
				"The most question groups the triager writes, one scout each",
			),
			designs: Bool({
				default: false,
				description:
					"Whether two designers sketch rival contract shapes from the planner's evidence, which the planner merges into its plan",
			}),
			scoutDeep: Bool({
				default: false,
				description:
					"Whether a group whose scout marks an answer unsure gets one stronger scout-deep look, and an answer still unsure after it is asked of the owner",
			}),
			respec: Bool({
				default: false,
				description:
					"Whether the issue carries a spec rather than a brief, which a direct ruling hands on to the planner to revise",
			}),
		},
		examples: [
			{
				issue:
					"#1 Greet by name\n\nMake greet.sh greet the name given as its first argument.",
				backlog: "triage/backlog.md",
			},
		],
	},
	({
		issue,
		backlog,
		sightings,
		maxGroups,
		designs,
		scoutDeep: deep,
		respec,
	}) => {
		const issued = {
			artifact: markdownOf(issue, "issue"),
			hint: "first, for the issue to triage",
		};
		const base = sealedBase();
		const triaged = triager({
			label: "triager",
			task: TASKS.triager(maxGroups),
			lane: read(base),
			attachments: {
				issue: issued,
				backlog: {
					artifact: fileOf(backlog, "backlog"),
					hint: "for the open and recently closed issues, to cut down to those that matter",
				},
			},
			out: { backlog: MarkdownOut("backlog.md") },
			reply: { ruling: Ruling(maxGroups) },
		});
		const ruling = triaged.out.ruling;
		const plans = lookup(plansOf(respec), ruling.get("verdict"));
		const groups = ruling.get("groups");
		const cutBacklog = {
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
					task: TASKS.scout,
					lane: read(base),
					attachments: {
						group: {
							artifact: asked.out.file,
							hint: "first, for the questions to answer",
						},
						issue: issued,
						backlog: cutBacklog,
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
		const climbs = deep
			? code(climbsOf, {
					in: { groups, scouts: scouts.out.results },
					out: { climbs: List(Climb) },
					label: "grounded",
				}).out.climbs
			: undefined;
		const deeps = climbs
			? iter.parMap(
					climbs,
					(climb) => {
						const asked = code(climbOf, {
							in: { climb },
							out: { file: Markdown() },
							label: "group",
						});
						return scoutDeep({
							label: "scout-deep",
							task: TASKS.scout,
							lane: read(base),
							attachments: {
								group: {
									artifact: asked.out.file,
									hint: "first, for the questions to answer and what the first scout found missing",
								},
								issue: issued,
								backlog: cutBacklog,
							},
						});
					},
					{
						onError: "continue",
						key: climbKey,
						max: maxGroups,
						label: "deeps",
					},
				)
			: undefined;
		const climbed =
			climbs && deeps
				? code(climbedAnswersOf, {
						in: {
							groups,
							scouts: scouts.out.results,
							climbs,
							deeps: deeps.out.results,
						},
						out: { answers: Markdown(), exhausted: List(Exhausted) },
						label: "answers",
					}).out
				: undefined;
		const answers =
			climbed ??
			code(answersOf, {
				in: { groups, scouts: scouts.out.results },
				out: { answers: Markdown() },
				label: "answers",
			}).out;
		const evidence = {
			issue: issued,
			answers: {
				artifact: answers.answers,
				hint: "first, for what the scouts found",
			},
			backlog: cutBacklog,
		};
		const planned = planner({
			label: "planner",
			task: TASKS.planner,
			lane: read(base),
			attachments: {
				...evidence,
				...(sightings && {
					sightings: {
						artifact: fileOf(sightings, "sightings"),
						hint: "for the known defects and smells no masterclass has read yet, to see the debt around the change",
					},
				}),
			},
			relay: { ruling },
			when: plans,
		});
		const proposed = designs
			? merged({ session: planned.out.session, evidence, base, when: plans })
			: planned.out;
		const plan = proposed.plan;
		const proposal = allSettled([plan], { label: "proposal" });
		const checked = checker({
			label: "checker",
			task: TASKS.checker,
			lane: read(base),
			attachments: {
				issue: issued,
				answers: {
					artifact: answers.answers,
					hint: "for what the scouts found",
				},
			},
			relay: { plan },
			when: lookup(CHECKS, plan.get("verdict")),
		});
		const check = allSettled([checked.out.check], {
			label: "check",
		});
		const toRevise = code(revisable, {
			in: { proposal, check },
			out: { findings: Markdown(), revise: Bool() },
			label: "revisable",
		}).out;
		const revised = planner({
			label: "revise",
			task: TASKS.revise,
			lane: read(base),
			session: proposed.session,
			attachments: {
				findings: {
					artifact: toRevise.findings,
					hint: "first, for the findings to settle",
				},
			},
			when: toRevise.revise,
		});
		return code(settle, {
			in: {
				ruling,
				respec: literal(respec, Bool()),
				proposal,
				check,
				revision: allSettled([revised.out.plan], {
					label: "revision",
				}),
				...(climbed && {
					exhausted: allSettled([climbed.exhausted], {
						label: "exhausted",
					}),
				}),
			},
			out: { triage: Triage },
			label: "settle",
		});
	},
);
