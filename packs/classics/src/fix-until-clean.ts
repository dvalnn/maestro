import { Lane, Session } from "@maestro/host-repo-sdk";
import {
	code,
	composition,
	loop,
	Markdown,
	not,
	Optional,
	Text,
	use,
} from "@maestro/sdk";
import { briefOf } from "./code";
import { fix, type Held } from "./moves";
import { repairUntilGreen } from "./repair";
import { tieredReview } from "./tiered-review";
import { atLeastOne, Brief, PACK } from "./types";

export const maxFixes = atLeastOne(
	2,
	"The most fix rounds after a review upholds findings",
);

export const fixUntilClean = composition(
	"fix_until_clean",
	{
		pack: PACK,
		doc: "Repair a lane until the target's checks pass, then review it by tiered review; while the review upholds findings, fix them in the builder's session and gate and review again, up to maxFixes times. Ends in the last review's Tally.",
		ports: {
			lane: Lane,
			session: Session,
			spec: Markdown(),
			brief: Brief,
		},
		params: {
			maxFixes,
			checks: repairUntilGreen.params.checks,
			grounds: Optional(Text()),
		},
	},
	({ maxFixes, checks, grounds }, { lane, session, spec, brief }) => {
		/** Repair `from` until green, then review it in `carried`. */
		const gateAndReview = (
			from: typeof lane,
			carried: typeof session,
			given: typeof brief,
			earlier?: Held,
		) => {
			const green = use(
				repairUntilGreen,
				{ lane: from, session: carried, spec },
				{
					params: { checks },
					label: "gate",
				},
			).out.lane;
			return use(
				tieredReview,
				{ change: green, spec, session: carried, earlier, brief: given },
				{ params: grounds === undefined ? {} : { grounds } },
			);
		};
		return loop.while((s) => not(s.ok), {
			init: gateAndReview(lane, session, brief),
			step: (s) => {
				const fixed = fix(s.out, spec, { checks });
				const { brief: next } = code(briefOf, {
					in: { report: fixed.out.report },
					out: { brief: Brief },
					label: "brief",
				}).out;
				return gateAndReview(
					fixed.out.lane,
					fixed.out.session,
					next,
					s.out.upheld,
				);
			},
			max: maxFixes,
			label: "fixes",
			tolerate: "rejected",
		});
	},
);
