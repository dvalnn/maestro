import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Answers } from "@maestro/classics";
import { atLeastOne, fill, scout } from "@maestro/classics";
import { JsonOut, MarkdownOut, read, seat } from "@maestro/host-repo-sdk";
import {
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
	readJson,
	type Settled,
	Struct,
	Text,
	type ValueOf,
} from "@maestro/sdk";
import FIGURES from "./prompts/_figures.md" with { type: "text" };
import PLAIN from "./prompts/_plain.md" with { type: "text" };
import { markdownOf, sealedBase, task } from "./shared";
import { MAX_REQUIREMENT_WORDS } from "./triage/ears";
import GATE from "./triage/prompts/_gate.md" with { type: "text" };
import QUESTIONS from "./triage/prompts/_questions.md" with { type: "text" };
import CHECKER from "./triage/prompts/checker.md" with { type: "text" };
import PLANNER from "./triage/prompts/planner.md" with { type: "text" };
import REVISE from "./triage/prompts/revise.md" with { type: "text" };
import SCOUT from "./triage/prompts/scout.md" with { type: "text" };
import TRIAGER from "./triage/prompts/triager.md" with { type: "text" };
import { NARROW } from "./triage/risk";
import {
	Checked,
	GROUP_SIZE,
	Group,
	MAX_BRIEF_REQUIREMENTS,
	type PROPOSED,
	Proposal,
	Ruling,
	Triage,
} from "./triage/schemas";
import { findingsOf, plansOf, RUNNERS, settle } from "./triage/verdict";

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
				runners: RUNNERS.join(", "),
			}),
			PLAIN,
			GATE,
			QUESTIONS,
		),
	scout: task(SCOUT),
	planner: task(
		fill(PLANNER, {
			runners: RUNNERS.join(", "),
			maxWords: MAX_REQUIREMENT_WORDS,
		}),
		PLAIN,
		FIGURES,
		GATE,
	),
	checker: task(CHECKER, GATE),
	revise: task(REVISE, QUESTIONS),
};

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

/** The body of a group's section: its scout's answers, an unsure one marked, or why it has none. */
function answerOf(scout: Settled<Answered> | undefined) {
	if (scout?.outcome === "ok")
		return scout.value.answers
			.flatMap((a) => [
				`### ${a.question}`,
				"",
				a.answer,
				...(a.state === "unsure" ? ["", `Unsure, missing: ${a.missing}`] : []),
				"",
			])
			.join("\n")
			.trim();
	const why = scout && "reason" in scout ? scout.reason : undefined;
	return `Unanswered: the scout ${scout?.outcome ?? "did not run"}${why ? `: ${why}` : ""}.`;
}

/** The scouts' answers as one Markdown file, a section per group in order, marking a group whose scout failed. */
export function answersOf(
	{ groups, scouts }: { groups: Group[]; scouts: Settled<Answered>[] },
	ctx: CodeContext,
): { answers: string } {
	const sections = groups.flatMap((g, i) => [
		...groupSection(g, "##"),
		"",
		answerOf(scouts[i]),
		"",
	]);
	const answers = join(ctx.scratch, "answers.md");
	const body = sections.length ? sections : ["No questions.", ""];
	writeFileSync(answers, ["# The scouts' answers", "", ...body].join("\n"));
	return { answers };
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
});

/** The checker, fresh in an encore: a re-triage rewrites the spec it checks. */
const checker = seat("checker", { encore: false });

export const triage = composition(
	"triage",
	{
		doc: [
			"Triage an issue against the backlog into a verdict. Read-only: it leaves no changeset.",
			"A triager rules early: it sends a small ask straight to the build, asks the owner, or asks scouts.",
			"A planner proposes a verdict from the scouts' answers, a checker checks a ready spec against the code,",
			"and the planner revises it once by the findings. settle then gates the verdict.",
		].join("\n"),
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
	({ issue, backlog, maxGroups, respec }) => {
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
		const answers = code(answersOf, {
			in: { groups, scouts: scouts.out.results },
			out: { answers: Markdown() },
			label: "answers",
		});
		const planned = planner({
			label: "planner",
			task: TASKS.planner,
			lane: read(base),
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
				backlog: cutBacklog,
			},
			out: { plan: JsonOut("plan.json", Proposal) },
			when: plans,
		});
		const plan = readJson(planned.out.plan);
		const proposal = allSettled([plan], { label: "proposal" });
		const checked = checker({
			label: "checker",
			task: TASKS.checker,
			lane: read(base),
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
		const check = allSettled([readJson(checked.out.check)], {
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
			session: planned.out.session,
			attachments: {
				findings: {
					artifact: toRevise.findings,
					hint: "first, for the findings to settle",
				},
			},
			out: { plan: JsonOut("plan.json", Proposal) },
			when: toRevise.revise,
		});
		return code(settle, {
			in: {
				ruling,
				respec: literal(respec, Bool()),
				proposal,
				check,
				revision: allSettled([readJson(revised.out.plan)], {
					label: "revision",
				}),
			},
			out: { triage: Triage },
			label: "settle",
		});
	},
);
