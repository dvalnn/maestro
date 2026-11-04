import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atLeastOne, fill, scout, toMarkdown } from "@maestro/classics";
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
import FIGURES from "./triage/prompts/_figures.md" with { type: "text" };
import GATE from "./triage/prompts/_gate.md" with { type: "text" };
import QUESTIONS from "./triage/prompts/_questions.md" with { type: "text" };
import CHECKER from "./triage/prompts/checker.md" with { type: "text" };
import PLANNER from "./triage/prompts/planner.md" with { type: "text" };
import SCOUT from "./triage/prompts/scout.md" with { type: "text" };
import TRIAGER from "./triage/prompts/triager.md" with { type: "text" };
import {
	Checked,
	GROUP_SIZE,
	Group,
	NARROW,
	type PROPOSED,
	Proposal,
	RUNNERS,
	type Ruled,
	Ruling,
	settle,
	Triage,
} from "./triage/verdict";

// ADR 0008: a code node's function must be exported by its composition file.
export { settle, toMarkdown };

const task = (...parts: string[]) => parts.join("\n\n");

/** Each call's task: its own prompt file, then the shared fragments it rules by. */
const TASKS = {
	triager: (maxGroups: number) =>
		task(
			fill(TRIAGER, { maxGroups, groupSize: GROUP_SIZE, narrow: NARROW }),
			GATE,
			QUESTIONS,
		),
	scout: task(SCOUT),
	planner: task(fill(PLANNER, { runners: RUNNERS.join(", ") }), FIGURES, GATE),
	checker: task(CHECKER, GATE),
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
	direct: false,
	plan: true,
	duplicate: false,
	"needs-info": false,
};

/** The proposals whose spec the checker checks. */
const CHECKS: Record<(typeof PROPOSED)[number], boolean> = {
	"ready-for-agent": true,
	split: false,
};

const triager = seat("triager");
/** The classics planner, fresh in an encore: a re-triage hands it the last spec rather than its grown session. */
const planner = seat("planner", { profile: "classics/planner", encore: false });

/** The checker, fresh in an encore: a re-triage rewrites the spec it checks. */
const checker = seat("checker", { encore: false });

export const triage = composition(
	"triage",
	{
		doc: "Triage an issue against the backlog: a triager cuts the backlog and rules early, sends a small clear ask straight to the build, or asks groups of questions; a scout answers each group, a planner proposes a verdict, a checker checks a ready spec against the code, and settle classifies its risk, review tier and area and gates the verdict. Only the triager asks the owner. Read-only: it leaves no changeset.",
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
			task: TASKS.triager(maxGroups),
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
					task: TASKS.scout,
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
			task: TASKS.planner,
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
			task: TASKS.checker,
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
