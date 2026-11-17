import { Lane, read, Session } from "@maestro/host-repo-sdk";
import {
	BuildError,
	code,
	composition,
	Enum,
	Int,
	iter,
	List,
	Markdown,
	Optional,
	Text,
	type Type,
	use,
} from "@maestro/sdk";
import { type Section, tieredOf } from "./code";
import { requestOf, reviewReads, tally } from "./moves";
import { task } from "./prompt";
import CHECKLIST from "./prompts/checklist.md" with { type: "text" };
import TIERED from "./prompts/tiered.md" with { type: "text" };
import STANDARDS from "./prompts/tiered-standards.md" with { type: "text" };
import { EXAMPLE_REQUEST } from "./repair";
import {
	CHECKLISTS,
	gated,
	lensLead,
	reviewed,
	SUBJECT,
	TASKS,
} from "./review";
import {
	crossLens,
	deepLens,
	deepLensStandards,
	lens,
	lensStandards,
	topLens,
	topLensStandards,
} from "./seats";
import {
	atLeastOne,
	Brief,
	type Half,
	PACK,
	SEAT_TIERS,
	SEATS,
	type SeatKey,
	TIERS,
	Upheld,
} from "./types";

const SOURCE = ["**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,sh}"];

/** The checklist sections, by the half of the review that rules on them, each with the paths that pull it in, none for always. */
export const SECTIONS = {
	behaviour: {
		correctness: { text: CHECKLISTS.correctness },
		spec: { text: CHECKLISTS.spec },
		tests: {
			globs: ["**/*.test.*", "**/*_test.*", "**/test/**", "**/tests/**"],
			text: CHECKLISTS.tests,
		},
	},
	standards: {
		design: { globs: SOURCE, text: CHECKLISTS.design },
		smells: { globs: SOURCE, text: CHECKLISTS.smells },
		docs: { globs: ["**/*.md"], text: CHECKLISTS.docs },
		"agent-doc": {
			globs: ["**/AGENTS.md", "**/CLAUDE.md", "**/SKILL.md"],
			text: CHECKLISTS["agent-doc"],
		},
	},
} satisfies Record<Half, Record<string, Section>>;

const IGNORE = [
	"**/*.lock",
	"**/*.lockb",
	"**/package-lock.json",
	"**/pnpm-lock.yaml",
	"**/dist/**",
	"**/*.generated.*",
	"**/*.min.*",
];

/** The selector's output of each seat: its own name when it sits, else nothing. */
const SEAT_LISTS = Object.fromEntries(
	SEATS.map((seat) => [seat, List(Text())]),
) as Record<SeatKey, Type<string[]>>;

/**
 * A review whose lenses and checklist follow the change: one `changeset` node feeds the selector, which counts the
 * changed lines, picks the seats of that tier and assembles each half of the checklist from the paths touched.
 * - Each tier seats a behaviour lens and, on the same profile, a standards lens, each ruling on its half of
 *   `SECTIONS`. A standards lens sits only when its half picked a section.
 * - A consolidator rules on what they held, and the tally rejects while a finding is upheld, or when no behaviour lens
 *   delivered a review: a standards lens's findings count, its delivering does not.
 * @throws BuildError `CFG.param` unless `small` < `medium` < `large`.
 */
export const tieredReview = composition(
	"tiered_review",
	{
		pack: PACK,
		doc: "Review a lane version through the behaviour and standards lenses its size picks, each ruling on its half of a checklist assembled from the paths it touches, then a consolidator and a Tally.",
		ports: {
			change: Lane,
			spec: Markdown(),
			session: Optional(Session),
			earlier: Optional(List(Upheld)),
			brief: Optional(Brief),
		},
		params: {
			small: atLeastOne(200, "The most changed lines of a small change"),
			medium: Int({
				default: 800,
				description: "The most changed lines of a medium change",
			}),
			large: Int({
				default: 2000,
				description:
					"The most changed lines of a large change; a bigger one is xlarge",
			}),
			ignore: List(Text(), {
				default: IGNORE,
				description: "Globs of paths whose changed lines do not count",
			}),
			floor: Optional(
				Enum(TIERS, {
					description:
						"The tier a review is at least, however small the change",
				}),
			),
			grounds: Text({
				default: "",
				description: "The rules a finding must cite, held by the consolidator",
			}),
			checks: List(Text(), {
				default: [],
				description: "The target checks the lenses may run, by name",
			}),
			gated,
		},
	},
	(
		{ small, medium, large, ignore, floor, grounds, checks, gated },
		{ change, spec, session, earlier, brief },
	) => {
		if (!(small < medium && medium < large))
			throw new BuildError({
				code: "CFG.param",
				message: `classics.tiered_review.small, medium and large must rise, got ${small}, ${medium} and ${large}`,
				hint: "Set classics.tiered_review.small below medium and medium below large",
			});
		// What every lens reads: the change, its patches and spec, and what it relays.
		const reads = reviewReads({ change, spec, earlier, brief });
		const { attached, relay } = reads;
		// The selector reads the patches and returns the tier, the seats it fills and each half's checklist.
		const lead = lensLead(TIERED, { earlier: earlier !== undefined, gated });
		const selected = code(tieredOf, {
			in: {
				changeset: attached.patches.artifact,
				ignore,
				small,
				medium,
				large,
				...(floor && { floor }),
				sections: SECTIONS,
				leads: { behaviour: lead, standards: task(lead, STANDARDS) },
				close: CHECKLIST,
			},
			out: {
				lines: Int(),
				tier: Text(),
				sections: List(Text()),
				behaviour: Text(),
				standards: Text(),
				...SEAT_LISTS,
			},
		});
		// A seat's lens rules on its half's checklist. The selector gives each seat a list of its own name
		// when it sits and an empty one when not, so mapping over that list runs the lens once or not at all.
		const seat = (key: SeatKey, call: typeof lens) => {
			const { name, half } = SEAT_TIERS[key];
			const lenses = iter.parMap(
				selected.out[key],
				() =>
					call({
						label: "lens",
						task: selected.out[half],
						lane: read(change),
						checks: gated ? [] : checks,
						relay,
						attachments: attached,
					}),
				{ max: 1, onError: "continue", label: name },
			);
			return {
				results: lenses.out.results,
				names: selected.out[key],
				// Only a behaviour lens delivering makes the review delivered.
				counts: half === "behaviour",
			};
		};
		// The tally holds what the lenses found, has the consolidator rule on it, and settles the review.
		return tally(
			reads,
			{
				lens: seat("lens", lens),
				lensStandards: seat("lensStandards", lensStandards),
				deepLens: seat("deepLens", deepLens),
				deepLensStandards: seat("deepLensStandards", deepLensStandards),
				topLens: seat("topLens", topLens),
				topLensStandards: seat("topLensStandards", topLensStandards),
				crossLens: seat("crossLens", crossLens),
			},
			{
				consolidator: TASKS.consolidator(false, grounds || undefined),
				session,
			},
		);
	},
);

export const reviewChange = composition(
	"review_change",
	{
		pack: PACK,
		doc: "Review a lane version or target commits through the behaviour and standards lenses the change's size picks, a checklist from the paths it touches, then a consolidator and a tally that rejects while a finding is upheld, or when no behaviour lens delivered a review.",
		params: {
			request: Text({ description: "What the change must do" }),
			...SUBJECT,
		},
		examples: [{ request: EXAMPLE_REQUEST, revs: "HEAD^!" }],
	},
	({ request, change: given, revs }) =>
		use(tieredReview, {
			change: reviewed("review_change", given, revs),
			spec: requestOf(request),
		}),
);
