import {
	changeset,
	Lane,
	type Relays,
	read,
	Session,
} from "@maestro/host-repo-sdk";
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
	Struct,
	Text,
	type Type,
	use,
} from "@maestro/sdk";
import { heldAcross, tieredOf } from "./code";
import { tally } from "./moves";
import { task } from "./prompt";
import AGENT_DOC from "./prompts/_agent-doc.md" with { type: "text" };
import CORRECTNESS from "./prompts/_correctness.md" with { type: "text" };
import DESIGN from "./prompts/_design.md" with { type: "text" };
import DOCS from "./prompts/_docs.md" with { type: "text" };
import SMELLS from "./prompts/_smells.md" with { type: "text" };
import SPEC from "./prompts/_spec.md" with { type: "text" };
import TESTS from "./prompts/_tests.md" with { type: "text" };
import CHECKLIST from "./prompts/checklist.md" with { type: "text" };
import TIERED from "./prompts/tiered.md" with { type: "text" };
import TIERED_AGAIN from "./prompts/tiered-again.md" with { type: "text" };
import { EXAMPLE_REQUEST } from "./repair";
import { attachmentsOf, requestOf, reviewed, SUBJECT, TASKS } from "./review";
import { consolidator, crossLens, deepLens, lens, topLens } from "./seats";
import {
	atLeastOne,
	Brief,
	PACK,
	SEAT_TIERS,
	SEATS,
	type SeatKey,
	TIERS,
	Upheld,
} from "./types";

const CALLS = { lens, deepLens, topLens, crossLens };

const SOURCE = ["**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,sh}"];

/** The checklist sections in the order they appear, each with the paths that pull it in, none for always. */
export const SECTIONS = {
	correctness: { text: CORRECTNESS },
	spec: { text: SPEC },
	tests: {
		globs: ["**/*.test.*", "**/*_test.*", "**/test/**", "**/tests/**"],
		text: TESTS,
	},
	design: { globs: SOURCE, text: DESIGN },
	smells: { globs: SOURCE, text: SMELLS },
	docs: { globs: ["**/*.md"], text: DOCS },
	"agent-doc": {
		globs: ["**/AGENTS.md", "**/CLAUDE.md", "**/SKILL.md"],
		text: AGENT_DOC,
	},
};

const IGNORE = [
	"**/*.lock",
	"**/*.lockb",
	"**/package-lock.json",
	"**/pnpm-lock.yaml",
	"**/dist/**",
	"**/*.generated.*",
	"**/*.min.*",
];

const SEAT_LISTS = Object.fromEntries(
	SEATS.map((seat) => [seat, List(Text())]),
) as Record<SeatKey, Type<string[]>>;

/**
 * A review whose lenses and checklist follow the change: one `changeset` node feeds the selector, which counts the
 * changed lines and picks the seats of that tier, and each seat's lens, which rules on the one checklist the selector
 * assembled from the paths touched. A consolidator rules on what they held, and the tally rejects while a finding is
 * upheld, or when no lens delivered a review.
 * @throws BuildError `CFG.param` unless `small` < `medium` < `large`.
 */
export const tieredReview = composition(
	"tiered_review",
	{
		pack: PACK,
		doc: "Review a lane version through the lenses its size picks, each ruling on one checklist assembled from the paths it touches, then a consolidator and a Tally.",
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
		},
	},
	(
		{ small, medium, large, ignore, floor, grounds, checks },
		{ change, spec, session, earlier, brief },
	) => {
		if (!(small < medium && medium < large))
			throw new BuildError({
				code: "CFG.param",
				message: `classics.tiered_review.small, medium and large must rise, got ${small}, ${medium} and ${large}`,
				hint: "Set classics.tiered_review.small below medium and medium below large",
			});
		const patches = changeset(change, { label: "patches" }).out.changeset;
		const attached = attachmentsOf(patches, spec);
		const picked = code(tieredOf, {
			in: {
				changeset: patches,
				ignore,
				small,
				medium,
				large,
				...(floor && { floor }),
				sections: SECTIONS,
				lead: earlier ? task(TIERED_AGAIN, TIERED) : TIERED,
				close: CHECKLIST,
			},
			out: {
				lines: Int(),
				tier: Text(),
				sections: List(Text()),
				checklist: Text(),
				...SEAT_LISTS,
			},
		});
		const common: Relays = brief ? { builder: brief } : {};
		const relay = { ...(earlier && { upheld: earlier }), ...common };
		const members = SEATS.flatMap((seat) => [
			[
				`${seat}Results`,
				iter.parMap(
					picked.out[seat],
					() =>
						CALLS[seat]({
							label: "lens",
							task: picked.out.checklist,
							lane: read(change),
							checks,
							relay,
							attachments: attached,
						}),
					{ max: 1, onError: "continue", label: SEAT_TIERS[seat].name },
				).out.results,
			],
			[`${seat}Names`, picked.out[seat]],
		]);
		const held = code(heldAcross, {
			in: Object.fromEntries(members),
			out: {
				held: List(Upheld),
				unreviewed: List(Struct({ lens: Text(), reason: Text() })),
				delivered: Int(),
			},
		});
		const consolidated = consolidator({
			label: "consolidator",
			task: TASKS.consolidator(false, grounds || undefined),
			lane: read(change),
			relay: {
				findings: held.out.held,
				unreviewed: held.out.unreviewed,
				...common,
			},
			attachments: attached,
		});
		return tally({
			lane: change,
			session: session ?? consolidated.out.session,
			held: held.out.held,
			verdict: consolidated.out.verdict,
			delivered: held.out.delivered,
			brief,
		});
	},
);

export const reviewChange = composition(
	"review_change",
	{
		pack: PACK,
		doc: "Review a lane version or target commits through the lenses the change's size picks, one checklist from the paths it touches, then a consolidator and a tally that rejects while a finding is upheld, or when no lens delivered a review.",
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
