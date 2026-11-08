import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	atLeastOne,
	builder,
	type Findings,
	maxRepairs,
	panel,
	repairUntilGreen,
	round,
	rulingLine,
	survivorsOf,
	toMarkdown,
	type Upheld,
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
	lookup,
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
import { JUDGED, PANELS, QUESTIONS, task } from "./slice/lenses";
import TESTED_RULE from "./slice/prompts/_tested.md" with { type: "text" };
import FIX from "./slice/prompts/fix.md" with { type: "text" };
import REVIEWER from "./slice/prompts/reviewer.md" with { type: "text" };
import REVIEWER_AGAIN from "./slice/prompts/reviewer-again.md" with {
	type: "text",
};
import TESTER from "./slice/prompts/tester.md" with { type: "text" };
import WRITER from "./slice/prompts/writer.md" with { type: "text" };
import FIGURES from "./triage/prompts/_figures.md" with { type: "text" };
import PLAIN from "./triage/prompts/_plain.md" with { type: "text" };
import { TIERS, type Tier } from "./triage/verdict";

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

/** What one review round ruled: a consolidator's verdict, or a lens's findings and its skeptic's verdicts, if any. */
type Ruled =
	| { verdict: ValueOf<typeof Verdict> }
	| { findings: Found; verdicts?: Settled<ValueOf<typeof Verdicts>>[] };

/** One round's rulings, and what its state carries to the next: the reviewed lane, the builder's session and the lens's. */
type Rulings = { lane: string; session: string; lens?: string } & Ruled;

/**
 * The blocking findings the skeptic upheld, each with its why: none when the lens was clean, every blocking one
 * without a why when no skeptic delivered verdicts.
 */
function upheldFindings(
	{ clean, findings }: Found,
	verdicts?: Settled<ValueOf<typeof Verdicts>>[],
): Upheld[] {
	if (clean) return [];
	return upheld(
		findings.filter((f) => f.blocking),
		verdicts?.[0]?.value,
	);
}

/** Each upheld blocking finding of `rulings` as a Markdown list item, carrying the skeptic's why or marked unverified. */
function upheldLines(rulings: Rulings): string[] {
	if ("verdict" in rulings)
		return rulings.verdict.blocking.map((b) => `- ${b}`);
	return upheldFindings(rulings.findings, rulings.verdicts).map(
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
	const upheld = join(ctx.scratch, "upheld.md");
	const body = lines.length ? lines : ["None."];
	writeFileSync(upheld, ["# Upheld findings", "", ...body, ""].join("\n"));
	const { lane, session, lens } = rulings;
	return {
		lane,
		session,
		...(lens !== undefined && { lens }),
		clean: lines.length === 0,
		upheld,
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

const UPHELD = {
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

/** The lens of the round before, which a later round's lens continues, and the findings that round upheld. */
type Earlier = { lens: Ref<string>; upheld: Ref<ArtifactRef> };

/**
 * The review of `tier` over the green lane version `lane`, ending in its upheld findings and carrying the builder's
 * `session`. Its lens continues the lens of `earlier` when given.
 */
function review(
	tier: Tier,
	lane: Ref<string>,
	session: Ref<string>,
	spec: Ref<ArtifactRef>,
	earlier?: Earlier,
) {
	const patches = changeset(lane, { label: "patches" }).out.changeset;
	const tally = (rulings: CodeInputs<Ruled & { lens?: string }>) =>
		code(upheldOf, {
			in: { lane, session, ...rulings },
			out: "lens" in rulings ? { ...UPHELD, lens: Session } : UPHELD,
			label: "upheld",
			tolerate: "rejected",
		});
	if (tier !== "small") {
		const lenses = PANELS[tier];
		const ruling = panel({
			items: Object.keys(lenses),
			task: (name) => lookup(lenses, name),
			change: lane,
			patches,
			spec,
			grounds: JUDGED,
			skeptics: false,
		});
		return tally({
			verdict: readJson(ruling.out.verdict, { tolerate: "rejected" }),
		});
	}
	const attached = {
		patches: {
			artifact: patches,
			hint: "for what the change did, patch by patch",
		},
		spec: { artifact: spec, hint: "for what the change must do" },
	};
	const { lens: found, skeptic: challenged } = round({
		label: "reviewer",
		task: earlier ? TASKS.reviewerAgain : TASKS.reviewer,
		change: lane,
		attached,
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
	const findings = readJson(found.out.findings, {
		tolerate: "rejected",
		label: "findings",
	});
	const lensSession = found.out.session;
	return tally({
		findings,
		lens: lensSession,
		verdicts: allSettled([
			readJson(challenged.out.verdicts, { tolerate: "rejected" }),
		]),
	});
}

export const slice = composition(
	"slice",
	{
		doc: "Build a request in a fresh lane, or at ordinary and risky on a tester's tests written first, repair until the target's checks pass, review it at the tier's depth, and fix what the review upholds, up to maxFixes rounds; leave the last reviewed lane as a changeset beside the findings its review upheld and a writer's PR body, over the PR it revises when given, empty when the writer failed, failing when it holds no patch.",
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
		const spec = code(toMarkdown, {
			in: { text: request },
			out: { file: Markdown() },
			label: "request",
		}).out.file;
		const round = (
			lane: Ref<string>,
			session: Ref<string>,
			earlier?: Earlier,
		) => {
			const green = use(
				repairUntilGreen,
				{ lane, session, spec },
				{ params: { maxRepairs, checks: REPO_CHECKS }, label: "gate" },
			);
			return review(tier, green.out.lane, session, spec, earlier);
		};
		const { built, map } = build(tier, request, spec);
		const reviewed = loop.while((s) => not(s.out.clean), {
			init: round(built.out.lane, built.out.session),
			step: (s) => {
				const fixed = builder({
					label: "fix",
					task: TASKS.fix,
					lane: extend(s.out.lane),
					session: s.out.session,
					checks: REPO_CHECKS,
					attachments: {
						upheld: {
							artifact: s.out.upheld,
							hint: "first, for the findings to fix",
						},
						spec: { artifact: spec, hint: "for what the change must do" },
					},
				});
				return round(
					fixed.out.lane,
					fixed.out.session,
					"lens" in s.out
						? { lens: s.out.lens, upheld: s.out.upheld }
						: undefined,
				);
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
						artifact: changeset(
							commits(revises, { label: "revised" }).out.lane,
							{
								label: "pr",
							},
						).out.changeset,
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
