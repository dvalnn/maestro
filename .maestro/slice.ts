import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { changeset, extend, fresh, Lane, read } from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	allSettled,
	Bool,
	type CodeContext,
	type CodeInputs,
	code,
	composition,
	Enum,
	lookup,
	loop,
	Markdown,
	not,
	type Ref,
	readJson,
	type Settled,
	Text,
	use,
	type ValueOf,
} from "@maestro/sdk";
import { survivorsOf, toMarkdown } from "../packs/classics/src/code";
import { maxRepairs, repairUntilGreen } from "../packs/classics/src/repair";
import { panel } from "../packs/classics/src/review";
import { builder, lens, skeptic } from "../packs/classics/src/seats";
import {
	atLeastOne,
	type Findings,
	type Verdict,
	type Verdicts,
} from "../packs/classics/src/types";

// ADR 0008: a code node's function must be exported by its composition file.
export { survivorsOf, toMarkdown };

const TIERS = ["small", "ordinary", "risky"] as const;
type Tier = (typeof TIERS)[number];

const GROUNDS =
	"Standards are CODING_STANDARDS.md and CLAUDE.md; the spec is the request, its requirement IDs and the ADRs under docs/adr/. Every finding cites in its issue the rule, requirement or ADR it breaks, names its file:line in where, and states the failure. Drop any finding you cannot cite.";

const QUESTIONS =
	"Ask of every changed file: a module, export or dependency that no requirement or plan item asks for? A duplicate of a helper or pattern the codebase already has? An interface wider than the spec needs? A decision taken in code with no ADR or owner ruling behind it?";

const CORRECTNESS =
	"correctness, every changed path doing what it claims, its error paths included";
const SPEC = "the spec, each requirement met by the change, one by one";
const TESTS =
	"the tests, each new behaviour pinned by a test that fails without it";

const ALL_LENSES = `Rule on the change through every lens: ${CORRECTNESS}; ${SPEC}; ${TESTS}. ${QUESTIONS} ${GROUNDS}`;

/** The panel's lenses, by name, as each lens's task. */
const PANEL = {
	correctness: `Rule on the change through this lens only: ${CORRECTNESS}. ${GROUNDS}`,
	spec: `Rule on the change through this lens only: ${SPEC}. ${QUESTIONS} ${GROUNDS}`,
	tests: `Rule on the change through this lens only: ${TESTS}. ${GROUNDS}`,
};

const SKEPTIC_TASK =
	"A lens ruled on this change. Challenge each of its findings against the code, and rule whether it holds. A finding that cites no rule, requirement or ADR does not hold.";

const VERIFY = "Before you finish, run `check check` to verify your change.";

const FIX_TASK = `A review upheld the attached findings on your change. Fix each one, keeping to what the spec asks. ${VERIFY}`;

type Found = ValueOf<typeof Findings>;

/** What one review round ruled: a consolidator's verdict, or a lens's findings and its skeptic's verdicts, if any. */
type Ruled =
	| { verdict: ValueOf<typeof Verdict> }
	| { findings: Found; verdicts?: Settled<ValueOf<typeof Verdicts>>[] };

type Rulings = { lane: string } & Ruled;

/**
 * The blocking findings the skeptic upheld: none when the lens was clean, every blocking one when no skeptic delivered
 * verdicts.
 */
function upheldFindings(
	{ clean, findings }: Found,
	verdicts?: Settled<ValueOf<typeof Verdicts>>[],
): Found["findings"] {
	if (clean) return [];
	const blocking = findings.filter((f) => f.blocking);
	const held = verdicts?.[0]?.value;
	if (held === undefined) return blocking;
	return blocking.filter((f) => held.some((v) => v.id === f.id && v.holds));
}

/** Each upheld blocking finding of `rulings` as a Markdown list item. */
function upheldLines(rulings: Rulings): string[] {
	if ("verdict" in rulings)
		return rulings.verdict.blocking.map((b) => `- ${b}`);
	return upheldFindings(rulings.findings, rulings.verdicts).map(
		(f) => `- ${f.id}, ${f.where}: ${f.issue}`,
	);
}

/** The upheld blocking findings of one review round as Markdown, `clean` when there are none, and the reviewed lane. */
export function upheldOf(
	rulings: Rulings,
	ctx: CodeContext,
): { lane: string; clean: boolean; upheld: string } {
	const lines = upheldLines(rulings);
	const upheld = join(ctx.scratch, "upheld.md");
	const body = lines.length ? lines : ["None."];
	writeFileSync(upheld, ["# Upheld findings", "", ...body, ""].join("\n"));
	return { lane: rulings.lane, clean: lines.length === 0, upheld };
}

const UPHELD = { lane: Lane, clean: Bool(), upheld: Markdown() };

/** The review of `tier` over the green lane version `lane`, ending in its upheld findings. */
function review(tier: Tier, lane: Ref<string>, spec: Ref<ArtifactRef>) {
	const patches = changeset(lane, { label: "patches" }).out.changeset;
	const tally = (rulings: CodeInputs<Ruled>) =>
		code(upheldOf, {
			in: { lane, ...rulings },
			out: UPHELD,
			label: "upheld",
			tolerate: "rejected",
		});
	if (tier === "risky") {
		const ruling = panel({
			items: Object.keys(PANEL),
			task: (name) => lookup(PANEL, name),
			change: lane,
			patches,
			spec,
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
		task: ALL_LENSES,
		lane: read(lane),
		attachments,
	});
	const findings = readJson(found.out.findings, { tolerate: "rejected" });
	if (tier === "small") return tally({ findings });
	const challenged = skeptic({
		label: "skeptic",
		task: SKEPTIC_TASK,
		lane: read(lane),
		when: not(findings.get("clean")),
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
		verdicts: allSettled([
			readJson(challenged.out.verdicts, { tolerate: "rejected" }),
		]),
	});
}

export const slice = composition(
	"slice",
	{
		doc: "Build a request in a fresh lane, repair until the target's checks pass, review it at the tier's depth, and fix what the review upholds, up to maxFixes rounds; leave the last reviewed lane as a changeset.",
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
		const round = (lane: Ref<string>) => {
			const green = use(
				repairUntilGreen,
				{ lane, spec },
				{ params: { maxRepairs }, label: "gate" },
			);
			return review(tier, green.out.lane, spec);
		};
		const built = builder({
			label: "build",
			task: `${request}\n\n${VERIFY}`,
			lane: fresh(),
			checks: ["check"],
		});
		const reviewed = loop.while((s) => not(s.out.clean), {
			init: round(built.out.lane),
			step: (s) => {
				const fixed = builder({
					label: "fix",
					task: FIX_TASK,
					lane: extend(s.out.lane, { resume: true }),
					checks: ["check"],
					attachments: {
						upheld: {
							artifact: s.out.upheld,
							hint: "first, for the findings to fix",
						},
						spec: { artifact: spec, hint: "for what the change must do" },
					},
				});
				return round(fixed.out.lane);
			},
			max: maxFixes,
			label: "fixes",
		});
		return changeset(reviewed.out.lane, { label: "result" });
	},
);
