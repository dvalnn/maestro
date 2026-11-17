import type { Settled } from "@maestro/sdk";
import { earsFindings } from "./ears";
import { classify, type Risk, scopeOf } from "./risk";
import type {
	Checked,
	Child,
	Exhausted,
	Proposal,
	Question,
	Ruled,
	Ruling,
	Triage,
	Verdict,
} from "./schemas";

const NO_TOUCHES = "Which paths does the change create or edit?";
const outsideRepo = (paths: string[]) =>
	`Which repo-relative paths does the change touch in place of ${paths.join(", ")}?`;

/**
 * Whether each ruling hands the issue on to the scouts and the planner:
 * - `plan`, always;
 * - `direct` on a `respec`, so the planner revises the last spec rather than a brief dropping it.
 */
export const plansOf = (respec: boolean): Record<Ruled, boolean> => ({
	direct: respec,
	plan: true,
	duplicate: false,
	"needs-info": false,
});

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
 * - a ready one's missing or outside paths;
 * - a split's child that depends on one not before it.
 */
function gapsOf(proposal: Proposal): string[] {
	if (proposal.verdict === "split")
		return (proposal.children ?? []).flatMap(orderGaps);
	if (proposal.verdict !== "ready-for-agent") return [];
	return scopeGaps(proposal.touches);
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

/** The question for an answer still unsure after the scout-deep rung: its question, with what is missing. */
const askExhausted = ({ key, question, missing }: Exhausted): Question => ({
	ask: question,
	lead: `The scouts could not ground answer ${key}.`,
	options: [],
	context: [{ topic: "Missing", text: missing }],
});

/** The question for each of `exhausted` but those whose key `proposal` names as answered by an owner's reply. */
function exhaustedGaps(proposal: Proposal, exhausted: Exhausted[]): Question[] {
	const answered = new Set(proposal.answered ?? []);
	return exhausted.filter((e) => !answered.has(e.key)).map(askExhausted);
}

/**
 * The triage of a planner's `proposal`, asking the owner its gaps, its own questions, each of `exhausted` it does not
 * name as answered and `unrun`. A ready proposal's spec stays in the result whatever the verdict, for a re-triage to
 * continue and the owner to approve.
 */
function proposed(
	proposal: Proposal,
	exhausted: Exhausted[],
	unrun: string[],
): Triage {
	const { touches, spec, children, related } = proposal;
	const contract = proposal.contract.trim();
	const classified = classify(touches, contract);
	const questions = [
		...gapsOf(proposal).map(askAlone),
		...(proposal.questions ?? []),
		...exhaustedGaps(proposal, exhausted),
		...unrun.map(askAlone),
	];
	const verdict = verdictOf(proposal.verdict, classified.risk, questions);
	return {
		verdict,
		...classified,
		questions,
		...(proposal.verdict === "ready-for-agent" &&
			spec && {
				spec: {
					touches: scopeOf(touches).paths,
					...spec,
				},
			}),
		...(verdict === "split" && { children }),
		...relatedOf(related),
		...(contract && { contract }),
		...(proposal.kept && spec && !questions.length && { kept: true }),
	};
}

/** The spec of a direct ruling: its brief, marked `brief`. */
const directSpec = ({
	files,
	what = "",
	requirements = [],
	subject = "",
}: Ruling) => ({
	touches: scopeOf(files).paths,
	what,
	requirements,
	decisions: [],
	excluded: [],
	subject,
	brief: true,
});

/** The triage of a ruling the triager settled early as `verdict`, `direct` building at once on its brief. */
function ruled(ruling: Ruling, ruledAs: Exclude<Ruled, "plan">): Triage {
	const { files, questions, duplicateOf, related, ahead } = ruling;
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
		...(verdict === "needs-info" && ahead && { ahead }),
	};
}

/** `question` without a recommendation that names none of its options, a rule its schema cannot express. */
function recommendable({ recommend, ...question }: Question): Question {
	const named = question.options.some((o) => o.label === recommend?.label);
	return named ? { ...question, recommend } : question;
}

/**
 * The findings the planner revises its plan by:
 * - the spec check's, when it ran;
 * - one per requirement of the plan that breaks the EARS shape.
 */
export function findingsOf({
	proposal: [planned],
	check: [checked],
}: {
	proposal: Settled<Proposal>[];
	check: Settled<Checked>[];
}): string[] {
	return [
		...(checked?.outcome === "ok" ? checked.value.findings : []),
		...(planned?.outcome === "ok"
			? earsFindings(planned.value.spec?.requirements ?? [])
			: []),
	];
}

/** The question saying `step` failed to run, none when it ran or was skipped. */
function unrunOf(step: string, [settled]: Settled<unknown>[]): string[] {
	if (!settled || settled.outcome === "ok" || settled.outcome === "skipped")
		return [];
	return [`The ${step} did not run: ${settled.reason}.`];
}

type Planned = {
	proposal: Settled<Proposal>[];
	check: Settled<Checked>[];
	revision: Settled<Proposal>[];
	/** The answers still unsure after the scout-deep rung, given only when the triage builds it. */
	exhausted?: Settled<Exhausted[]>[];
};

/**
 * The triage of `ruling`, or of the planner's proposal when the issue was handed on: its `revision` when the planner
 * revised it by the spec `check`, asking the owner when either failed to run.
 */
function triageOf(
	ruling: Ruling,
	respec: boolean,
	{ proposal, check, revision, exhausted = [] }: Planned,
) {
	const { verdict } = ruling;
	if (verdict !== "plan" && !plansOf(respec)[verdict])
		return ruled(ruling, verdict);
	const [planned] = proposal;
	if (planned?.outcome !== "ok")
		throw new Error("the planner gave no proposal");
	const [revised] = revision;
	const final = revised?.outcome === "ok" ? revised.value : planned.value;
	const unrun = [
		...unrunOf("spec check", check),
		...unrunOf("planner's revision", revision),
	];
	const [answers] = exhausted;
	return proposed(final, answers?.outcome === "ok" ? answers.value : [], unrun);
}

/**
 * The triage verdict: the triager's early ruling or the planner's proposal, which it only ever downgrades or gates,
 * never upgrades. A spec check or revision that failed to run is asked of the owner, as is each `exhausted` answer the
 * proposal does not name as answered.
 * @param respec whether the issue carries a spec rather than a brief, which a direct ruling hands on to the planner.
 * @throws Error when the issue was handed on and the planner gave no proposal.
 */
export function settle({
	ruling,
	respec,
	...planned
}: { ruling: Ruling; respec: boolean } & Planned): {
	triage: Triage;
} {
	const triage = triageOf(ruling, respec, planned);
	return {
		triage: { ...triage, questions: triage.questions.map(recommendable) },
	};
}
