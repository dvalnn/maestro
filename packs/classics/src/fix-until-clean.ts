import { Lane, Session } from "@maestro/host-repo-sdk";
import {
	Bool,
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
import { fix } from "./moves";
import { maxRepairs, repairUntilGreen } from "./repair";
import { panel } from "./review";
import { atLeastOne, Brief } from "./types";

export const maxFixes = atLeastOne(
	2,
	"The most fix rounds after a review upholds findings",
);

export const fixUntilClean = composition(
	"fix_until_clean",
	{
		doc: "Repair a lane until the target's checks pass, then review it by panel; while the panel upholds findings, fix them in the builder's session and gate and review again, up to maxFixes times. Ends in the last panel's Tally.",
		ports: {
			lane: Lane,
			session: Session,
			spec: Markdown(),
			brief: Optional(Brief),
		},
		params: {
			maxFixes,
			maxRepairs,
			checks: repairUntilGreen.params.checks,
			fix: repairUntilGreen.params.fix,
			lenses: panel.params.lenses,
			skeptics: Optional(Bool()),
			consolidate: Optional(Bool()),
			grounds: Optional(Text()),
		},
	},
	(
		{
			maxFixes,
			maxRepairs,
			checks,
			fix: fixCheck,
			lenses,
			skeptics,
			consolidate,
			grounds,
		},
		{ lane, session, spec, brief },
	) => {
		/** Repair `from` until green, then review it by panel in `carried`. */
		const gateAndPanel = (
			from: typeof lane,
			carried: typeof session,
			given: typeof brief,
		) => {
			const green = use(
				repairUntilGreen,
				{ lane: from, session: carried, spec },
				{
					params: { maxRepairs, checks, fix: fixCheck },
					label: "gate",
				},
			).out.lane;
			return use(
				panel,
				{ change: green, spec, session: carried, brief: given },
				{
					// A param left unset stays the config's or the panel's own default.
					params: {
						lenses,
						...(skeptics !== undefined && { skeptics }),
						...(consolidate !== undefined && { consolidate }),
						...(grounds !== undefined && { grounds }),
					},
				},
			);
		};
		return loop.while((s) => not(s.ok), {
			init: gateAndPanel(lane, session, brief),
			step: (s) => {
				const fixed = fix(s.out, spec, { checks });
				const { brief: next } = code(briefOf, {
					in: { report: fixed.out.report },
					out: { brief: Brief },
					label: "brief",
				}).out;
				return gateAndPanel(fixed.out.lane, fixed.out.session, next);
			},
			max: maxFixes,
			label: "fixes",
			tolerate: "rejected",
		});
	},
);
