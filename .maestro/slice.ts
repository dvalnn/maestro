import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	atLeastOne,
	builder,
	type Findings,
	maxRepairs,
	repairUntilGreen,
	round,
	rulingLine,
	survivorsOf,
	toMarkdown,
	upheld,
	type Verdict,
	type Verdicts,
} from "@maestro/classics";
import {
	changeset,
	commits,
	extend,
	fresh,
	JsonOut,
	Lane,
	MarkdownOut,
	read,
	Session,
	seat,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	allSettled,
	Bool,
	type CodeContext,
	type CodeInputs,
	code,
	composition,
	Dir,
	Enum,
	List,
	loop,
	Markdown,
	not,
	type Ref,
	readJson,
	reject,
	type Settled,
	Struct,
	Text,
	use,
	type ValueOf,
} from "@maestro/sdk";
import FIGURES from "./prompts/_figures.md" with { type: "text" };
import PLAIN from "./prompts/_plain.md" with { type: "text" };
import { markdownOf, TIERS, type Tier, task } from "./shared";
import { JUDGED, type PANELS, panelOf, QUESTIONS } from "./slice/lenses";
import TESTED_RULE from "./slice/prompts/_tested.md" with { type: "text" };
import FIX from "./slice/prompts/fix.md" with { type: "text" };
import REVIEWER from "./slice/prompts/reviewer.md" with { type: "text" };
import REVIEWER_AGAIN from "./slice/prompts/reviewer-again.md" with {
	type: "text",
};
import TESTER from "./slice/prompts/tester.md" with { type: "text" };
import WRITER from "./slice/prompts/writer.md" with { type: "text" };

// ADR 0008: a code node's function must be exported by its composition file.
export { survivorsOf, toMarkdown };

const PATCH_EXT = ".patch";
const NOTHING_CHANGED = "the slice changed nothing";

/** Each call's task: its own prompt file, then the shared fragments it rules by. */
const TASKS = {
	reviewer: task(REVIEWER, QUESTIONS, JUDGED),
	reviewerAgain: task(REVIEWER_AGAIN, REVIEWER, QUESTIONS, JUDGED),
	fix: task(FIX),
	tester: task(TESTER),
	writer: task(WRITER, PLAIN, FIGURES),
};

/** Every check of `target.checks` in `.maestro/config.yaml`, as an agent may run only those it names. */
const REPO_CHECKS = ["format", "lint", "types", "test", "all"];

type Found = ValueOf<typeof Findings>;

/** What one review round ruled: a panel's consolidated verdict, or a reviewer's findings and its skeptic's verdicts. */
type Ruled =
	| { verdict: ValueOf<typeof Verdict> }
	| { findings: Found; verdicts?: Settled<ValueOf<typeof Verdicts>>[] };

/**
 * One round's rulings, and what its state carries to the next: the reviewed lane, the builder's session and the
 * reviewer's.
 */
type Rulings = { lane: string; session: string; lens?: string } & Ruled;

/**
 * Each blocking finding of `rulings` that was upheld, as a Markdown list item:
 * - a panel's, as its consolidator worded it;
 * - a reviewer's, with its skeptic's why, or marked unverified when no skeptic delivered verdicts.
 */
function upheldLines(rulings: Rulings): string[] {
	if ("verdict" in rulings)
		return rulings.verdict.blocking.map((b) => `- ${b}`);
	const { clean, findings } = rulings.findings;
	if (clean) return [];
	const blocking = findings.filter((f) => f.blocking);
	return upheld(blocking, rulings.verdicts?.[0]?.value).map(
		(f) => `- ${f.id}, ${f.where}: ${f.issue}\n  ${rulingLine(f.why)}`,
	);
}

/**
 * The upheld blocking findings of one review round as Markdown, `clean` when there are none, and the lane and sessions
 * it carries.
 */
export function upheldOf(
	rulings: Rulings,
	ctx: CodeContext,
): {
	lane: string;
	session: string;
	lens?: string;
	clean: boolean;
	upheld: string;
} {
	const lines = upheldLines(rulings);
	const file = join(ctx.scratch, "upheld.md");
	const body = lines.length ? lines : ["None."];
	writeFileSync(file, ["# Upheld findings", "", ...body, ""].join("\n"));
	const { lane, session, lens } = rulings;
	return {
		lane,
		session,
		...(lens !== undefined && { lens }),
		clean: lines.length === 0,
		upheld: file,
	};
}

/**
 * The changeset, the last round's upheld findings and the writer's PR body, unchanged, when the changeset holds a
 * patch; the body is empty when the writer delivered none. A rejection when the changeset holds no patch, so the slice
 * settles `rejected`.
 */
export function requirePatch(
	{
		changeset,
		upheld,
		written,
	}: {
		changeset: ArtifactRef;
		upheld: ArtifactRef;
		written: Settled<ArtifactRef>[];
	},
	ctx: CodeContext,
) {
	if (!readdirSync(ctx.path(changeset)).some((f) => f.endsWith(PATCH_EXT)))
		return reject(NOTHING_CHANGED);
	const body = written[0];
	if (body?.outcome === "ok") return { changeset, upheld, pr: body.value };
	const pr = join(ctx.scratch, "pr.md");
	writeFileSync(pr, "");
	return { changeset, upheld, pr };
}

/** What a review round settles to. */
const ROUND_OUT = {
	lane: Lane,
	session: Session,
	clean: Bool(),
	upheld: Markdown(),
};

/** The PR body's writer: a cheap seat that only reads the finished change. */
const writer = seat("writer");

/** The tester's map: each requirement in one list, a pinned one with its test by file and name. */
const Unpinned = List(Struct({ requirement: Text(), why: Text() }));
const TestMap = Struct({
	pinned: List(Struct({ requirement: Text(), file: Text(), test: Text() })),
	deferred: Unpinned,
	untestable: Unpinned,
});

/** The seat that writes a spec's tests before the build, on another model family. */
const tester = seat("tester", {
	out: { map: JsonOut("map.json", TestMap) },
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
	const map = {
		artifact: tested.out.map,
		hint: "for the tester's tests, by requirement",
	};
	const built = builder({
		label: "build",
		task: task(request, TESTED_RULE),
		lane: extend(tested.out.lane),
		checks: REPO_CHECKS,
		attachments: { map },
	});
	return { built, map };
}

/** The upheld findings of a round's `rulings` over `lane`, carrying `session`, and the reviewer's session when any. */
const tally = (
	lane: Ref<string>,
	session: Ref<string>,
	rulings: CodeInputs<Ruled & { lens?: string }>,
) =>
	code(upheldOf, {
		in: { lane, session, ...rulings },
		out: "lens" in rulings ? { ...ROUND_OUT, lens: Session } : ROUND_OUT,
		label: "upheld",
		tolerate: "rejected",
	});

/** A reviewer round's session, which the next round's reviewer continues, and the findings that round upheld. */
type Earlier = { lens: Ref<string>; upheld: Ref<ArtifactRef> };

/**
 * A panel review of `tier` over the green lane version `lane`, ending in its upheld findings and carrying the builder's
 * `session`.
 */
function panelRound(
	tier: PanelTier,
	lane: Ref<string>,
	session: Ref<string>,
	spec: Ref<ArtifactRef>,
) {
	const ruling = panelOf(tier, lane, spec);
	return tally(lane, session, {
		verdict: readJson(ruling.out.verdict, { tolerate: "rejected" }),
	});
}

/**
 * A reviewer and its skeptic over the green lane version `lane`, ending in the upheld findings and carrying the
 * builder's `session` and the reviewer's. The reviewer continues the one of `earlier` when given.
 */
function reviewerRound(
	lane: Ref<string>,
	session: Ref<string>,
	spec: Ref<ArtifactRef>,
	earlier?: Earlier,
) {
	const patches = changeset(lane, { label: "patches" }).out.changeset;
	const { lens: reviewer, skeptic } = round({
		label: "reviewer",
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
		session: earlier?.lens,
		checks: REPO_CHECKS,
		extra: earlier && {
			upheld: {
				artifact: earlier.upheld,
				hint: "the findings upheld last round",
			},
		},
	});
	return tally(lane, session, {
		findings: readJson(reviewer.out.findings, {
			tolerate: "rejected",
			label: "findings",
		}),
		lens: reviewer.out.session,
		verdicts: allSettled([
			readJson(skeptic.out.verdicts, { tolerate: "rejected" }),
		]),
	});
}

/** A fix of the findings a round upheld, in a lane extending the round's and continuing its builder's session. */
function fix(
	reviewed: {
		lane: Ref<string>;
		session: Ref<string>;
		upheld: Ref<ArtifactRef>;
	},
	spec: Ref<ArtifactRef>,
) {
	return builder({
		label: "fix",
		task: TASKS.fix,
		lane: extend(reviewed.lane),
		session: reviewed.session,
		checks: REPO_CHECKS,
		attachments: {
			upheld: {
				artifact: reviewed.upheld,
				hint: "first, for the findings to fix",
			},
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
			earlier?: Earlier,
		) => {
			const green = use(
				repairUntilGreen,
				{ lane, session, spec },
				{ params: { maxRepairs, checks: REPO_CHECKS }, label: "gate" },
			).out.lane;
			return tier === "small"
				? reviewerRound(green, session, spec, earlier)
				: panelRound(tier, green, session, spec);
		};
		const { built, map } = build(tier, request, spec);
		const reviewed = loop.while((s) => not(s.out.clean), {
			init: gateAndReview(built.out.lane, built.out.session),
			step: (s) => {
				const fixed = fix(s.out, spec);
				const earlier =
					"lens" in s.out
						? { lens: s.out.lens, upheld: s.out.upheld }
						: undefined;
				return gateAndReview(fixed.out.lane, fixed.out.session, earlier);
			},
			max: maxFixes,
			label: "fixes",
		});
		const changes = changeset(reviewed.out.lane, { label: "changes" }).out
			.changeset;
		const written = writer({
			label: "writer",
			task: TASKS.writer,
			lane: read(reviewed.out.lane),
			attachments: {
				spec: { artifact: spec, hint: "first, for what the change had to do" },
				...(map && { map }),
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
			out: { pr: MarkdownOut("pr.md") },
		});
		return code(requirePatch, {
			in: {
				changeset: changes,
				upheld: reviewed.out.upheld,
				written: allSettled([written.out.pr], { label: "written" }),
			},
			out: { changeset: Dir(), upheld: Markdown(), pr: Markdown() },
			label: "result",
		});
	},
);
