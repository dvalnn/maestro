import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	atLeastOne,
	builder,
	type Findings,
	LENSES,
	lens,
	maxRepairs,
	panel,
	repairUntilGreen,
	rulingLine,
	skeptic,
	skepticTask,
	survivorsOf,
	toMarkdown,
	type Verdict,
	type Verdicts,
} from "@maestro/classics";
import {
	changeset,
	extend,
	fresh,
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
	lookup,
	loop,
	Markdown,
	not,
	type Ref,
	readJson,
	reject,
	type Settled,
	Text,
	use,
	type ValueOf,
} from "@maestro/sdk";
import GROUNDS from "./slice/prompts/_grounds.md" with { type: "text" };
import QUESTIONS from "./slice/prompts/_review-questions.md" with {
	type: "text",
};
import FIX from "./slice/prompts/fix.md" with { type: "text" };
import LENS_SPEC_TESTS from "./slice/prompts/lens-spec-tests.md" with {
	type: "text",
};
import REVIEWER from "./slice/prompts/reviewer.md" with { type: "text" };
import REVIEWER_AGAIN from "./slice/prompts/reviewer-again.md" with {
	type: "text",
};
import WRITER from "./slice/prompts/writer.md" with { type: "text" };
import FIGURES from "./triage/prompts/_figures.md" with { type: "text" };

// ADR 0008: a code node's function must be exported by its composition file.
export { survivorsOf, toMarkdown };

const PATCH_EXT = ".patch";
const NOTHING_CHANGED = "the slice changed nothing";

const TIERS = ["small", "ordinary", "risky"] as const;
type Tier = (typeof TIERS)[number];

const task = (...parts: string[]) => parts.join("\n\n");

/** Each call's task: its own prompt file, then the shared fragments it rules by. */
const TASKS = {
	reviewer: task(REVIEWER, QUESTIONS, GROUNDS),
	reviewerAgain: task(REVIEWER_AGAIN, REVIEWER, QUESTIONS, GROUNDS),
	skeptic: skepticTask(GROUNDS),
	fix: task(FIX),
	writer: task(WRITER, FIGURES),
	/** Each panel tier's lenses, by name, as each lens's task; the consolidator rules by `GROUNDS`. */
	lenses: {
		ordinary: {
			correctness: task(LENSES.correctness, GROUNDS),
			"spec-tests": task(LENS_SPEC_TESTS, QUESTIONS, GROUNDS),
		},
		risky: {
			correctness: task(LENSES.correctness, GROUNDS),
			spec: task(LENSES.spec, QUESTIONS, GROUNDS),
			tests: task(LENSES.tests, GROUNDS),
		},
	},
};

type Found = ValueOf<typeof Findings>;

/** A blocking finding and the skeptic's why for upholding it, absent when no skeptic ruled on it. */
type Upheld = Found["findings"][number] & { why?: string };

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
	const blocking = findings.filter((f) => f.blocking);
	const held = verdicts?.[0]?.value;
	if (held === undefined) return blocking;
	return blocking.flatMap((f) => {
		const verdict = held.find((v) => v.id === f.id && v.holds);
		return verdict ? [{ ...f, why: verdict.why }] : [];
	});
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
		const lenses = TASKS.lenses[tier];
		const ruling = panel({
			items: Object.keys(lenses),
			task: (name) => lookup(lenses, name),
			change: lane,
			patches,
			spec,
			grounds: GROUNDS,
			skeptics: false,
		});
		return tally({
			verdict: readJson(ruling.out.verdict, { tolerate: "rejected" }),
		});
	}
	const attachments = {
		patches: {
			artifact: patches,
			hint: "for what the change did, patch by patch",
		},
		spec: { artifact: spec, hint: "for what the change must do" },
	};
	const found = lens({
		label: "reviewer",
		task: earlier ? TASKS.reviewerAgain : TASKS.reviewer,
		lane: read(lane),
		session: earlier?.lens,
		checks: ["all"],
		attachments: {
			...attachments,
			...(earlier && {
				upheld: {
					artifact: earlier.upheld,
					hint: "the findings upheld last round",
				},
			}),
		},
	});
	const findings = readJson(found.out.findings, { tolerate: "rejected" });
	const lensSession = found.out.session;
	const challenged = skeptic({
		label: "skeptic",
		task: TASKS.skeptic,
		lane: read(lane),
		when: not(findings.get("clean")),
		tolerate: "rejected",
		attachments: {
			findings: {
				artifact: found.out.findings,
				hint: "first, for the findings to challenge",
			},
			...attachments,
		},
	});
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
		doc: "Build a request in a fresh lane, repair until the target's checks pass, review it at the tier's depth, and fix what the review upholds, up to maxFixes rounds; leave the last reviewed lane as a changeset beside the findings its review upheld and a writer's PR body, empty when the writer failed, failing when it holds no patch.",
		params: {
			request: Text({ description: "The brief: what to build" }),
			tier: Enum(TIERS, { description: "How deep the review goes" }),
			maxRepairs,
			maxFixes: atLeastOne(
				2,
				"The most fix rounds after a review upholds findings",
			),
		},
		examples: [
			{
				request: "Make greet.sh greet the name given as its first argument.",
				tier: "small",
			},
		],
	},
	({ request, tier, maxRepairs, maxFixes }) => {
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
				{ params: { maxRepairs, checks: ["all"] }, label: "gate" },
			);
			return review(tier, green.out.lane, session, spec, earlier);
		};
		const built = builder({
			label: "build",
			task: request,
			lane: fresh(),
			checks: ["all"],
		});
		const reviewed = loop.while((s) => not(s.out.clean), {
			init: round(built.out.lane, built.out.session),
			step: (s) => {
				const fixed = builder({
					label: "fix",
					task: TASKS.fix,
					lane: extend(s.out.lane),
					session: s.out.session,
					checks: ["all"],
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
				patches: {
					artifact: changes,
					hint: "for what the change did, patch by patch",
				},
				upheld: {
					artifact: reviewed.out.upheld,
					hint: "for the findings the review left upheld",
				},
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
