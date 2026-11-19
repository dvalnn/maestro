import { check, extend, fresh, read, seat } from "@maestro/host-repo-sdk";
import {
	code,
	composition,
	firstOk,
	iter,
	List,
	literal,
	Markdown,
	not,
	type Settled,
	Text,
	use,
	type ValueOf,
} from "@maestro/sdk";
import {
	Brief,
	briefOf,
	builder,
	challenge,
	Finding,
	type Findings,
	fixUntilClean,
	gated,
	LENS_CHECKLISTS,
	LENSES,
	lens,
	lensLead,
	panel,
	planner,
	ROLES,
	Rulings,
	repairUntilGreen,
	reviewReads,
	tally,
	toMarkdown,
	Upheld,
} from "./index";

type Held = ValueOf<typeof Upheld>;

const REQUEST = "Add a greet function";

/** A fresh build with the spec and brief a review reads. */
function built() {
	const spec = code(toMarkdown, {
		in: { text: REQUEST },
		out: { file: Markdown() },
	}).out.file;
	const build = builder({ label: "build", task: REQUEST, lane: fresh() });
	const { brief } = code(briefOf, {
		in: { report: build.out.report },
		out: { brief: Brief },
	}).out;
	return { spec, build, brief };
}

/** One version of the target, sealed by a no-op check, for a read-only review to read. */
const sealedBase = () =>
	check(fresh(), { run: "true" }, { label: "base" }).out.lane;

const strongBuilder = seat("builder_strong", { profile: "classics/builder" });

const STRONG_TASK =
	"Fix each finding upheld under `## upheld`, keeping to what the spec asks.";

const LENS = "correctness";

/** Fix ladder: fix rounds on the builder seat, then, only if findings stay upheld, a gated, reviewed fix on a stronger seat. */
export const fixLadder = composition(
	"fix_ladder",
	{
		doc: "Climb from a cheap builder seat to a strong one, which fixes only what the cheap rounds left upheld; the strong rung is its own seat call because fix takes no seat.",
		examples: [{}],
	},
	() => {
		const { spec, build, brief } = built();
		const cheap = use(
			fixUntilClean,
			{ lane: build.out.lane, session: build.out.session, spec, brief },
			{ params: { maxFixes: 1 }, label: "cheap" },
		);
		const strong = strongBuilder({
			label: "strong",
			task: STRONG_TASK,
			lane: extend(cheap.out.lane),
			relay: { upheld: cheap.out.upheld },
			attachments: {
				spec: { artifact: spec, hint: "for what the change must do" },
			},
			when: not(cheap.ok),
			tolerate: "rejected",
		});
		const next = code(briefOf, {
			in: { report: strong.out.report },
			out: { brief: Brief },
			label: "strong_brief",
		}).out.brief;
		const green = use(
			repairUntilGreen,
			{ lane: strong.out.lane, session: strong.out.session, spec },
			{ label: "strong_gate" },
		).out.lane;
		// The lenses read no rejected upstream, and the cheap rounds reject while they leave findings upheld.
		const earlier = code(carried, {
			in: { upheld: cheap.out.upheld },
			out: { upheld: List(Upheld) },
			tolerate: "rejected",
		}).out.upheld;
		const again = use(
			panel,
			{
				change: green,
				spec,
				session: strong.out.session,
				earlier,
				brief: next,
			},
			{ label: "again" },
		);
		return firstOk([cheap.out.lane, again.out.lane]);
	},
);

/** The findings `upheld`, unchanged. */
export function carried({ upheld }: { upheld: Held[] }): { upheld: Held[] } {
	return { upheld };
}

/** Lens fusion: the same lens on two harness families, a skeptic over each, one tally over both. */
export const lensFusion = composition(
	"lens_fusion",
	{
		doc: "Rule through the same lens on two harness families, each under a skeptic, and join what they held in one tally.",
		params: { gated },
		examples: [{}],
	},
	({ gated }) => {
		const { spec, build } = built();
		const change = build.out.lane;
		const reads = reviewReads({ change, spec });
		const { attached } = reads;
		const checklist = literal(LENS_CHECKLISTS[LENS], Text());
		const group = (family: string) => {
			const onFamily = seat(`lens_${family}`, {
				profile: "classics/lens",
				verdict: true,
				reply: { findings: List(Finding) },
			});
			return {
				results: iter.parMap(
					[family],
					() => {
						const found = onFamily({
							label: "lens",
							task: lensLead(LENSES[LENS], { gated }),
							lane: read(change),
							attachments: attached,
						});
						return {
							lens: found,
							skeptic: challenge(found, { change, attached, checklist }),
						};
					},
					{ onError: "continue", label: `${family}_lenses` },
				).out.results,
				names: [family],
			};
		};
		return tally(
			reads,
			{ a: group("a"), b: group("b") },
			{ session: build.out.session },
		);
	},
);

const VOTERS = ["a", "b", "c"];

/**
 * One ruling per finding of the lens, held when most of the voters hold it (each counts once), with the holders' whys joined.
 */
export function majority({
	findings,
	votes,
}: {
	findings: ValueOf<typeof Findings>;
	votes: Settled<{ rulings: ValueOf<typeof Rulings> }>[];
}): { rulings: ValueOf<typeof Rulings> } {
	const needed = Math.floor(votes.length / 2) + 1;
	return {
		rulings: findings.map(({ id }) => {
			const holders = votes.flatMap((v) => {
				const held = v.value?.rulings.find((r) => r.id === id && r.holds);
				return held ? [held] : [];
			});
			return {
				id,
				holds: holders.length >= needed,
				why: holders.map((r) => r.why).join("; "),
			};
		}),
	};
}

/** Ruling vote: three skeptics rule on one lens's findings, and a finding stands when most of them hold it. */
export const rulingVote = composition(
	"ruling_vote",
	{
		doc: "Have three skeptics rule on a lens's findings and hold each finding that most of them hold.",
		examples: [{}],
	},
	() => {
		const { spec, build } = built();
		const change = build.out.lane;
		const reads = reviewReads({ change, spec });
		const { attached } = reads;
		const checklist = literal(LENS_CHECKLISTS[LENS], Text());
		return tally(
			reads,
			{
				lens: {
					results: iter.parMap(
						[LENS],
						() => {
							const found = lens({
								label: "lens",
								task: LENSES[LENS],
								lane: read(change),
								attachments: attached,
							});
							const votes = iter.parMap(
								VOTERS,
								() => challenge(found, { change, attached, checklist }),
								{ onError: "continue", label: "voters" },
							);
							return {
								lens: found,
								skeptic: code(majority, {
									in: {
										findings: found.out.findings,
										votes: votes.out.results,
									},
									out: { rulings: Rulings },
									tolerate: "rejected",
								}),
							};
						},
						{ onError: "continue", label: "lenses" },
					).out.results,
					names: [LENS],
				},
			},
			{ session: build.out.session },
		);
	},
);

const AREAS = ["src", "docs"];

/** Audit sweep: a lens per area over the base, with no change under review. */
export const auditSweep = composition(
	"audit_sweep",
	{
		doc: "Audit the target's base with a lens per area, and report the findings upheld.",
		examples: [{}],
	},
	() => {
		const spec = code(toMarkdown, {
			in: { text: "Audit the target for defects" },
			out: { file: Markdown() },
		}).out.file;
		return use(
			panel,
			{ change: sealedBase(), spec },
			{
				params: {
					lenses: Object.fromEntries(
						AREAS.map((area) => [
							area,
							`${ROLES[LENS]}\n\nRule only on what is under ${area}/.`,
						]),
					),
					checklists: Object.fromEntries(
						AREAS.map((area) => [area, LENS_CHECKLISTS[LENS]]),
					),
				},
			},
		);
	},
);

const PLAN_LENS =
	"Rule on the plan in spec.md alone: whether it would build what the request asks, and what it leaves out. The change is the unbuilt base.";

/** Plan review: a planner writes the plan, and the panel rules on it over a sealed base. */
export const planReview = composition(
	"plan_review",
	{
		doc: "Have a planner write a plan, then rule on it by panel over a sealed base.",
		examples: [{}],
	},
	() => {
		const base = sealedBase();
		const planned = planner({ label: "plan", task: REQUEST, lane: read(base) });
		return use(
			panel,
			{ change: base, spec: planned.out.plan },
			{ params: { lenses: { plan: PLAN_LENS } } },
		);
	},
);
