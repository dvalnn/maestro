import {
	changeset,
	check,
	extend,
	fresh,
	read,
	seat,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	code,
	composition,
	firstOk,
	iter,
	List,
	Markdown,
	not,
	type Ref,
	type Settled,
	Struct,
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
	heldOf,
	LENSES,
	lens,
	panel,
	planner,
	type Rulings,
	repairUntilGreen,
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

/** What a skeptic reads beside the lane. */
const attach = (change: Ref<string>, spec: Ref<ArtifactRef>) => ({
	patches: {
		artifact: changeset(change, { label: "patches" }).out.changeset,
		hint: "for what the change did, patch by patch",
	},
	spec: { artifact: spec, hint: "for what the change must do" },
});

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
		const again = use(
			panel,
			{
				change: green,
				spec,
				session: strong.out.session,
				earlier: cheap.out.upheld,
				brief: next,
			},
			{ label: "again" },
		);
		return firstOk([cheap.out.lane, again.out.lane]);
	},
);

/** The findings of two held lists, one after the other. */
export function joined({ a, b }: { a: Held[]; b: Held[] }): { held: Held[] } {
	return { held: [...a, ...b] };
}

/** Lens fusion: the same lens on two harness families, a skeptic over each, one tally over both. */
export const lensFusion = composition(
	"lens_fusion",
	{
		doc: "Rule through the same lens on two harness families, each under a skeptic, and join what they held in one tally.",
		examples: [{}],
	},
	() => {
		const { spec, build } = built();
		const change = build.out.lane;
		const attached = attach(change, spec);
		const held = (family: string) => {
			const onFamily = seat(`lens_${family}`, {
				profile: "classics/lens",
				verdict: true,
				reply: { findings: List(Finding) },
			});
			const names = [family];
			const rounds = iter.parMap(
				names,
				() => {
					const found = onFamily({
						label: "lens",
						task: LENSES[LENS],
						lane: read(change),
						attachments: attached,
					});
					return {
						lens: found,
						skeptic: challenge(found, { change, attached }),
					};
				},
				{ onError: "continue", label: `${family}_lenses` },
			);
			return code(heldOf, {
				in: { results: rounds.out.results, names },
				out: {
					held: List(Upheld),
					unreviewed: List(Struct({ lens: Text(), reason: Text() })),
				},
				label: `${family}_held`,
			}).out.held;
		};
		const both = code(joined, {
			in: { a: held("a"), b: held("b") },
			out: { held: List(Upheld) },
		});
		return tally({
			lane: change,
			session: build.out.session,
			held: both.out.held,
		});
	},
);

const VOTERS = ["a", "b", "c"];

/** The lens's findings that most of the skeptics' rulings hold. */
export function majority({
	findings,
	votes,
}: {
	findings: ValueOf<typeof Findings>;
	votes: Settled<{ rulings: ValueOf<typeof Rulings> }>[];
}): { held: Held[] } {
	const needed = Math.floor(votes.length / 2) + 1;
	const holds = (id: string) =>
		votes.filter((v) => v.value?.rulings.some((r) => r.id === id && r.holds))
			.length;
	return {
		held: findings
			.filter((f) => holds(f.id) >= needed)
			.map((f) => ({ ...f, lens: LENS })),
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
		const attached = attach(change, spec);
		const lensed = lens({
			label: "lens",
			task: LENSES[LENS],
			lane: read(change),
			attachments: attached,
		});
		const votes = iter.parMap(
			VOTERS,
			() => challenge(lensed, { change, attached }),
			{ onError: "continue", label: "voters" },
		);
		const voted = code(majority, {
			in: { findings: lensed.out.findings, votes: votes.out.results },
			out: { held: List(Upheld) },
			tolerate: "rejected",
		});
		return tally({
			lane: change,
			session: build.out.session,
			held: voted.out.held,
		});
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
							`${LENSES[LENS]}\n\nRule only on what is under ${area}/.`,
						]),
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
