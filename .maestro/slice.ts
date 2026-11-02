import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	atLeastOne,
	builder,
	type Findings,
	lens,
	maxRepairs,
	panel,
	repairUntilGreen,
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
	read,
	Session,
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

// ADR 0008: a code node's function must be exported by its composition file.
export { survivorsOf, toMarkdown };

const PATCH_EXT = ".patch";
const NOTHING_CHANGED = "the slice changed nothing";

const TIERS = ["small", "ordinary", "risky"] as const;
type Tier = (typeof TIERS)[number];

const GROUNDS =
	"Standards are CODING_STANDARDS.md and CLAUDE.md; the spec is the request, its requirement IDs and the ADRs under docs/adr/. Every finding cites in its issue the rule, requirement or ADR it breaks, names its file:line in where, and states the failure. Drop any finding you cannot cite. A requirement the change leaves unmet blocks. The lane's commit message is a placeholder the tour manager replaces on landing: its subject and closing line are out of review. Judge only the change's tests; a test the change leaves alone is out of review. A test must pull weight. Logic the change adds that reading it does not settle at a glance, such as a branch, a computation, a fixed bug or a behaviour the spec names, needs a test that fails when that logic is removed or broken: judge it as a mutation would, naming the line whose removal or change no test catches. Trivial logic, a one-liner whose effect the code shows plainly, needs no test, and one test over a list's shape covers its entries. Logic with edges, such as a limit, an empty input or one past the end, is tested at them. A missing test for non-trivial logic or its edges blocks. Advisory, not blocking: a missing test for trivial logic, or for a case neither the issue nor the spec names; a test that duplicates another's coverage, to drop or merge; a test that still passes with its logic removed, or only restates the implementation; a test that restates wording, such as an error message or a prompt, unless the text is a contract: piped stdout, --json output, or a line something parses.";

const QUESTIONS =
	"Ask of every changed file: a module, export or dependency that no requirement or plan item asks for? A duplicate of a helper or pattern the codebase already has? An interface wider than the spec needs? A decision taken in code with no ADR or owner ruling behind it?";

const CORRECTNESS =
	"correctness, every changed path doing what it claims, its error paths included";
const SPEC = "the spec, each requirement met by the change, one by one";
const TESTS =
	"the tests, each new behaviour pinned by a test that fails without it";

const ALL_LENSES = `Rule on the change through every lens: ${CORRECTNESS}; ${SPEC}; ${TESTS}. ${QUESTIONS} ${GROUNDS} Run \`check all\` to see the tests run.`;

const AGAIN = `The change was fixed after your last ruling. ${ALL_LENSES} The attached upheld findings are those of yours the last round upheld; anything else you raised was dismissed.`;

const ONLY_CORRECTNESS = `Rule on the change through this lens only: ${CORRECTNESS}. ${GROUNDS}`;

/** Each panel tier's lenses, by name, as each lens's task. */
const PANELS = {
	ordinary: {
		correctness: ONLY_CORRECTNESS,
		"spec-tests": `Rule on the change through these lenses only: ${SPEC}; ${TESTS}. ${QUESTIONS} ${GROUNDS}`,
	},
	risky: {
		correctness: ONLY_CORRECTNESS,
		spec: `Rule on the change through this lens only: ${SPEC}. ${QUESTIONS} ${GROUNDS}`,
		tests: `Rule on the change through this lens only: ${TESTS}. ${GROUNDS}`,
	},
};

const FIX_TASK =
	"A review upheld the attached findings on your change. Fix each one, keeping to what the spec asks.";

type Found = ValueOf<typeof Findings>;

/** What one review round ruled: a consolidator's verdict, or a lens's findings and its skeptic's verdicts, if any. */
type Ruled =
	| { verdict: ValueOf<typeof Verdict> }
	| { findings: Found; verdicts?: Settled<ValueOf<typeof Verdicts>>[] };

/** One round's rulings, and what its state carries to the next: the reviewed lane, the builder's session and the lens's. */
type Rulings = { lane: string; session: string; lens?: string } & Ruled;

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
 * The changeset, unchanged, when it holds a patch.
 * A rejection when it holds none, so the slice settles `rejected`.
 */
export function requirePatch(
	{ changeset }: { changeset: ArtifactRef },
	ctx: CodeContext,
) {
	if (!readdirSync(ctx.path(changeset)).some((f) => f.endsWith(PATCH_EXT)))
		return reject(NOTHING_CHANGED);
	return { changeset };
}

const UPHELD = {
	lane: Lane,
	session: Session,
	clean: Bool(),
	upheld: Markdown(),
};

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
			grounds: GROUNDS,
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
		task: earlier ? AGAIN : ALL_LENSES,
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
		task: skepticTask(GROUNDS),
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
		doc: "Build a request in a fresh lane, repair until the target's checks pass, review it at the tier's depth, and fix what the review upholds, up to maxFixes rounds; leave the last reviewed lane as a changeset, failing when it holds no patch.",
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
					task: FIX_TASK,
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
		return code(requirePatch, {
			in: {
				changeset: changeset(reviewed.out.lane, { label: "changes" }).out
					.changeset,
			},
			out: { changeset: Dir() },
			label: "result",
		});
	},
);
