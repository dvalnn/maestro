import {
	Brief,
	challenge,
	type Findings,
	fix,
	heldOf,
	lens,
	type Rulings,
	repairUntilGreen,
	Tally,
	tallyOf,
} from "@maestro/classics";
import { changeset, type Report, read, Session } from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	allSettled,
	type CodeContext,
	code,
	loop,
	not,
	type PortRefs,
	type Ref,
	type Rejection,
	reject,
	type Settled,
	use,
	type ValueOf,
} from "@maestro/sdk";
import { briefFrom, FIX_CHECK, REPO_CHECKS, task } from "../shared";
import { DESIGN_QUESTIONS, DESIGN_SEARCHES, JUDGED } from "./lenses";
import REVIEWER from "./prompts/reviewer.md" with { type: "text" };
import REVIEWER_AGAIN from "./prompts/reviewer-again.md" with { type: "text" };

const REVIEWER_TASK = task(REVIEWER, DESIGN_SEARCHES, DESIGN_QUESTIONS, JUDGED);
const REVIEWER_AGAIN_TASK = task(
	REVIEWER_AGAIN,
	REVIEWER,
	DESIGN_SEARCHES,
	DESIGN_QUESTIONS,
	JUDGED,
);

/** The lens name and node label of small's reviewer, which its session group and its findings' ids carry. */
const REVIEWER_LENS = "reviewer";

/** A round's `tally` with `extra` outputs beside it, a rejection's included. */
function withOutputs<T extends object, E extends object>(
	tally: T | Required<Rejection<T>>,
	extra: E,
) {
	return "outcome" in tally
		? reject(tally.reason, { ...tally.outputs, ...extra })
		: { ...tally, ...extra };
}

/**
 * A reviewer round's tally, with the builder's `brief` and the reviewer's session beside it. A skeptic that delivered
 * no rulings leaves every finding held without a why.
 */
export function reviewedOf(
	{
		lane,
		session,
		brief,
		reviewer,
		findings,
		rulings,
	}: {
		lane: string;
		session: string;
		brief: ValueOf<typeof Brief>;
		reviewer: string;
		findings: ValueOf<typeof Findings>;
		rulings: Settled<ValueOf<typeof Rulings>>[];
	},
	ctx: CodeContext,
) {
	const [ruled] = rulings;
	const member =
		ruled?.value !== undefined
			? { lens: { findings }, skeptic: { rulings: ruled.value } }
			: { findings };
	const { held } = heldOf({
		results: [
			{
				outcome: ruled?.outcome === "skipped" ? "skipped" : "rejected",
				reason: "findings",
				value: member,
			},
		],
		names: [REVIEWER_LENS],
	});
	return withOutputs(tallyOf({ lane, session, held }, ctx), {
		reviewer,
		brief,
	});
}

/** What a reviewer round settles to: the tally, the brief it carries and the reviewer's session. */
const REVIEWED = { ...Tally, brief: Brief, reviewer: Session };

/** A reviewer round's session, which the next round's reviewer continues, and the findings that round upheld. */
type Earlier = Pick<PortRefs<typeof REVIEWED>, "reviewer" | "upheld">;

/**
 * A reviewer and its skeptic over the green lane version `lane`, ending in the tally, carrying the builder's `session`
 * and the reviewer's. The reviewer continues the one of `earlier` when given.
 */
function reviewerRound(
	lane: Ref<string>,
	session: Ref<string>,
	spec: Ref<ArtifactRef>,
	brief: Ref<ValueOf<typeof Brief>>,
	earlier?: Earlier,
) {
	const attached = {
		patches: {
			artifact: changeset(lane, { label: "patches" }).out.changeset,
			hint: "for what the change did, patch by patch",
		},
		spec: { artifact: spec, hint: "for what the change must do" },
	};
	const reviewer = lens({
		label: REVIEWER_LENS,
		task: earlier ? REVIEWER_AGAIN_TASK : REVIEWER_TASK,
		lane: read(lane),
		session: earlier?.reviewer,
		checks: REPO_CHECKS,
		relay: { ...(earlier && { upheld: earlier.upheld }), builder: brief },
		attachments: attached,
	});
	const skeptic = challenge(reviewer, {
		change: lane,
		attached,
		grounds: JUDGED,
		relay: { builder: brief },
	});
	return code(reviewedOf, {
		in: {
			lane,
			session,
			brief,
			reviewer: reviewer.out.session,
			findings: reviewer.out.findings,
			rulings: allSettled([skeptic.out.rulings]),
		},
		out: REVIEWED,
		label: "upheld",
		tolerate: "rejected",
	});
}

/**
 * Small's loop of gate, reviewer round and fix, in which the reviewer continues its session. Ends in the last round's
 * tally and the reviewer's session.
 */
export function smallLoop(
	built: {
		out: { lane: Ref<string>; session: Ref<string>; report: Ref<Report> };
	},
	spec: Ref<ArtifactRef>,
	maxRepairs: number,
	maxFixes: number,
) {
	/** Repair `lane` until its checks pass, then review it. */
	const gateAndReview = (
		lane: Ref<string>,
		session: Ref<string>,
		report: Ref<Report>,
		earlier?: Earlier,
	) => {
		const green = use(
			repairUntilGreen,
			{ lane, session, spec },
			{
				params: { maxRepairs, checks: REPO_CHECKS, fix: FIX_CHECK },
				label: "gate",
			},
		).out.lane;
		return reviewerRound(green, session, spec, briefFrom(report), earlier);
	};
	return loop.while((s) => not(s.ok), {
		init: gateAndReview(built.out.lane, built.out.session, built.out.report),
		step: (s) => {
			const fixed = fix(s.out, spec, { checks: REPO_CHECKS });
			return gateAndReview(
				fixed.out.lane,
				fixed.out.session,
				fixed.out.report,
				{ reviewer: s.out.reviewer, upheld: s.out.upheld },
			);
		},
		max: maxFixes,
		label: "fixes",
		tolerate: "rejected",
	});
}
