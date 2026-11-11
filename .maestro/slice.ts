import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	atLeastOne,
	Brief,
	briefOf,
	builder,
	type Findings,
	heldOf,
	maxRepairs,
	type Rulings,
	repairUntilGreen,
	round,
	Tally,
	TestMap,
	tallyOf,
	type Upheld,
} from "@maestro/classics";
import {
	changeset,
	commits,
	extend,
	fresh,
	MarkdownOut,
	type Relays,
	type Report,
	read,
	Session,
	seat,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	allSettled,
	type CodeContext,
	code,
	composition,
	Dir,
	Enum,
	loop,
	Markdown,
	not,
	type Ref,
	type Result,
	reject,
	type Settled,
	Text,
	use,
	type ValueOf,
} from "@maestro/sdk";
import FIGURES from "./prompts/_figures.md" with { type: "text" };
import PLAIN from "./prompts/_plain.md" with { type: "text" };
import { markdownOf, TIERS, type Tier, task, withOutputs } from "./shared";
import {
	DESIGN_QUESTIONS,
	DESIGN_SEARCHES,
	JUDGED,
	type PanelTier,
	panelOf,
} from "./slice/lenses";
import TESTED_RULE from "./slice/prompts/_tested.md" with { type: "text" };
import FIX from "./slice/prompts/fix.md" with { type: "text" };
import REVIEWER from "./slice/prompts/reviewer.md" with { type: "text" };
import REVIEWER_AGAIN from "./slice/prompts/reviewer-again.md" with {
	type: "text",
};
import TESTER from "./slice/prompts/tester.md" with { type: "text" };
import WRITER from "./slice/prompts/writer.md" with { type: "text" };

// ADR 0008: a code node's function must be exported by its composition file.
export * from "@maestro/classics/code";

const PATCH_EXT = ".patch";
const NOTHING_CHANGED = "the slice changed nothing";

/** Each call's task: its own prompt file, then the shared fragments it rules by. */
const TASKS = {
	reviewer: task(REVIEWER, DESIGN_SEARCHES, DESIGN_QUESTIONS, JUDGED),
	reviewerAgain: task(
		REVIEWER_AGAIN,
		REVIEWER,
		DESIGN_SEARCHES,
		DESIGN_QUESTIONS,
		JUDGED,
	),
	fix: task(FIX),
	tester: task(TESTER),
	writer: task(WRITER, PLAIN, FIGURES),
};

/** Every check of `target.checks` in `.maestro/config.yaml`, as an agent may run only those it names. */
const REPO_CHECKS = ["format", "lint", "types", "test", "all", "fmt"];

/** The lens name and node label of small's reviewer, which its session group and its findings' ids carry. */
const REVIEWER_LENS = "reviewer";

/**
 * A reviewer round's tally, and the reviewer's session beside it. A skeptic that delivered no rulings leaves every
 * finding held without a why.
 */
export function reviewedOf({
	lane,
	session,
	reviewer,
	findings,
	rulings,
}: {
	lane: string;
	session: string;
	reviewer: string;
	findings: ValueOf<typeof Findings>;
	rulings: Settled<ValueOf<typeof Rulings>>[];
}) {
	const [ruled] = rulings;
	const member =
		ruled?.value !== undefined
			? { lens: { findings }, skeptic: { rulings: ruled.value } }
			: { findings };
	const { held } = heldOf({
		results: [{ outcome: "ok", value: member }],
		names: [REVIEWER_LENS],
	});
	return withOutputs(tallyOf({ lane, session, held }), { reviewer });
}

/** A finding a round upheld. */
type Held = ValueOf<typeof Upheld>;

const UNVERIFIED = "Unverified: no skeptic ruled on it";
const NO_FINDINGS = "None.";

/** `upheld` as Markdown, a `### <cites>` section per cite, each finding with its skeptic's why or a mark that none ruled. */
function upheldMarkdown(upheld: Held[]): string {
	const cited = Map.groupBy(upheld, (f) => f.cites);
	const sections = [...cited].flatMap(([cites, findings]) => [
		`### ${cites}`,
		"",
		...findings.map(
			(f) =>
				`- ${f.lens}/${f.id}, ${f.where}: ${f.issue}\n  ${f.why === undefined ? UNVERIFIED : `Upheld: ${f.why}`}`,
		),
		"",
	]);
	return [
		"# Upheld findings",
		"",
		...(upheld.length ? sections : [NO_FINDINGS, ""]),
	].join("\n");
}

/**
 * The changeset, the last round's upheld findings as `upheld.md` and the writer's PR body, unchanged, when the changeset
 * holds a patch; the body is empty when the writer delivered none. A rejection when the changeset holds no patch, so the slice
 * settles `rejected`.
 */
export function requirePatch(
	{
		changeset,
		upheld,
		written,
	}: {
		changeset: ArtifactRef;
		upheld: Held[];
		written: Settled<ArtifactRef>[];
	},
	ctx: CodeContext,
) {
	if (!readdirSync(ctx.path(changeset)).some((f) => f.endsWith(PATCH_EXT)))
		return reject(NOTHING_CHANGED);
	const file = join(ctx.scratch, "upheld.md");
	writeFileSync(file, upheldMarkdown(upheld));
	const body = written[0];
	if (body?.outcome === "ok")
		return { changeset, upheld: file, pr: body.value };
	const pr = join(ctx.scratch, "pr.md");
	writeFileSync(pr, "");
	return { changeset, upheld: file, pr };
}

/** The PR body's writer: a cheap seat that only reads the finished change. */
const writer = seat("writer");

/** The seat that writes a spec's tests before the build, on another model family. */
const tester = seat("tester", {
	reply: { map: TestMap },
	checks: REPO_CHECKS,
});

/** The tiers whose build starts from a tester's tests. */
const TESTED: readonly Tier[] = ["ordinary", "risky"];

/**
 * The build of `request` against `spec`: in a fresh lane, or at a tested `tier` in a lane extending the tester's, its
 * task then carrying the rule for the tester's tests. Gives the tester's map when tested.
 */
function build(tier: Tier, request: string, spec: Ref<ArtifactRef>) {
	if (!TESTED.includes(tier))
		return {
			built: builder({
				label: "build",
				task: request,
				lane: fresh(),
				checks: REPO_CHECKS,
			}),
		};
	const tested = tester({
		label: "tester",
		task: TASKS.tester,
		lane: fresh(),
		attachments: {
			spec: { artifact: spec, hint: "first, for the requirements to pin" },
		},
	});
	const map = tested.out.map;
	const built = builder({
		label: "build",
		task: task(request, TESTED_RULE),
		lane: extend(tested.out.lane),
		checks: REPO_CHECKS,
		relay: { map },
	});
	return { built, map };
}

/** What a reviewer round settles to: the tally and the reviewer's session. */
const REVIEWED = { ...Tally, reviewer: Session };

/** A reviewer round's session, which the next round's reviewer continues, and the findings that round upheld. */
type Earlier = { reviewer: Ref<string>; upheld: Ref<Held[]> };

/**
 * A panel review of `tier` over the green lane version `lane`, ending in its tally and carrying the builder's
 * `session`.
 */
function panelRound(
	tier: PanelTier,
	lane: Ref<string>,
	session: Ref<string>,
	spec: Ref<ArtifactRef>,
	builder: Relays,
) {
	const { consolidator, held } = panelOf(tier, lane, spec, builder);
	return code(tallyOf, {
		in: {
			lane,
			session,
			held,
			verdict: allSettled([consolidator.out.verdict]),
		},
		out: Tally,
		label: "upheld",
		tolerate: "rejected",
	});
}

/**
 * A reviewer and its skeptic over the green lane version `lane`, ending in the tally, carrying the builder's `session`
 * and the reviewer's. The reviewer continues the one of `earlier` when given.
 */
function reviewerRound(
	lane: Ref<string>,
	session: Ref<string>,
	spec: Ref<ArtifactRef>,
	builder: Relays,
	earlier?: Earlier,
) {
	const patches = changeset(lane, { label: "patches" }).out.changeset;
	const { lens: reviewer, skeptic } = round({
		label: REVIEWER_LENS,
		task: earlier ? TASKS.reviewerAgain : TASKS.reviewer,
		change: lane,
		attached: {
			patches: {
				artifact: patches,
				hint: "for what the change did, patch by patch",
			},
			spec: { artifact: spec, hint: "for what the change must do" },
		},
		grounds: JUDGED,
		skeptics: true,
		session: earlier?.reviewer,
		checks: REPO_CHECKS,
		relay: earlier && { upheld: earlier.upheld },
		common: builder,
	});
	return code(reviewedOf, {
		in: {
			lane,
			session,
			reviewer: reviewer.out.session,
			findings: reviewer.out.findings,
			rulings: allSettled([skeptic.out.rulings]),
		},
		out: REVIEWED,
		label: "upheld",
		tolerate: "rejected",
	});
}

/** A fix of the findings a round upheld, in a lane extending the round's and continuing its builder's session. */
function fix(
	reviewed: {
		lane: Ref<string>;
		session: Ref<string>;
		upheld: Ref<Held[]>;
	},
	spec: Ref<ArtifactRef>,
) {
	return builder({
		label: "fix",
		task: TASKS.fix,
		lane: extend(reviewed.lane),
		session: reviewed.session,
		checks: REPO_CHECKS,
		relay: { upheld: reviewed.upheld },
		attachments: {
			spec: { artifact: spec, hint: "for what the change must do" },
		},
	});
}

/** The patches of the PR held by the target revisions `revises`. */
const prPatches = (revises: string) =>
	changeset(commits(revises, { label: "revised" }).out.lane, { label: "pr" })
		.out.changeset;

export const slice = composition(
	"slice",
	{
		doc: [
			"Build a request, review it at the tier's depth and fix what the review upholds.",
			"At ordinary and risky, a tester writes the spec's tests first and the build starts from them.",
			"Each round repairs until the target's checks pass, then reviews; up to maxFixes fix rounds follow.",
			"Leaves the changeset, the findings the last review upheld and a writer's PR body: over the PR it revises",
			"when given, empty when the writer failed. Fails when the changeset holds no patch.",
		].join("\n"),
		params: {
			request: Text({ description: "The brief: what to build" }),
			tier: Enum(TIERS, { description: "How deep the review goes" }),
			maxRepairs,
			maxFixes: atLeastOne(
				2,
				"The most fix rounds after a review upholds findings",
			),
			revises: Text({
				default: "",
				description:
					"Git revisions of the target holding the PR this build revises, such as C^!; empty for a fresh build",
			}),
		},
		examples: [
			{
				request: "Make greet.sh greet the name given as its first argument.",
				tier: "small",
			},
		],
	},
	({ request, tier, maxRepairs, maxFixes, revises }) => {
		const spec = markdownOf(request, "request");
		/** Repair `lane` until its checks pass, then review it at the tier's depth. */
		const gateAndReview = (
			lane: Ref<string>,
			session: Ref<string>,
			report: Ref<Report>,
			earlier?: Earlier,
		): Result<typeof Tally | typeof REVIEWED> => {
			const green = use(
				repairUntilGreen,
				{ lane, session, spec },
				{
					params: { maxRepairs, checks: REPO_CHECKS, fix: "fmt" },
					label: "gate",
				},
			).out.lane;
			const { brief } = code(briefOf, {
				in: { report },
				out: { brief: Brief },
				label: "brief",
			}).out;
			const relay = { builder: brief };
			return tier === "small"
				? reviewerRound(green, session, spec, relay, earlier)
				: panelRound(tier, green, session, spec, relay);
		};
		const { built, map } = build(tier, request, spec);
		const reviewed = loop.while((s) => not(s.ok), {
			init: gateAndReview(built.out.lane, built.out.session, built.out.report),
			step: (s) => {
				const fixed = fix(s.out, spec);
				const earlier =
					"reviewer" in s.out
						? { reviewer: s.out.reviewer, upheld: s.out.upheld }
						: undefined;
				return gateAndReview(
					fixed.out.lane,
					fixed.out.session,
					fixed.out.report,
					earlier,
				);
			},
			max: maxFixes,
			label: "fixes",
			tolerate: "rejected",
		});
		const changes = changeset(reviewed.out.lane, {
			label: "changes",
			tolerate: "rejected",
		}).out.changeset;
		const written = writer({
			label: "writer",
			task: TASKS.writer,
			lane: read(reviewed.out.lane),
			attachments: {
				spec: { artifact: spec, hint: "first, for what the change had to do" },
				patches: {
					artifact: changes,
					hint: "for what the change did, patch by patch",
				},
				...(revises && {
					revised: {
						artifact: prPatches(revises),
						hint: "for the PR the patches revise, which the body covers with them as one change",
					},
				}),
			},
			...(map && { relay: { map } }),
			out: { pr: MarkdownOut("pr.md") },
			tolerate: "rejected",
		});
		return code(requirePatch, {
			in: {
				changeset: changes,
				upheld: reviewed.out.upheld,
				written: allSettled([written.out.pr], { label: "written" }),
			},
			out: { changeset: Dir(), upheld: Markdown(), pr: Markdown() },
			label: "result",
			tolerate: "rejected",
		});
	},
);
