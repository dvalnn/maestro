import { changeset, commits } from "@maestro/host-repo-sdk";
import { composition, Text } from "@maestro/sdk";
import { LANE_BASE, onBase, proverOn, proving } from "./shared";

export const prove = composition(
	"prove",
	{
		doc: "Show what a range of target commits did against the claims made for it: a prover writes a script that measures each claim on the base and on the head, and a check runs it. Leaves the results, one file per claim, with the script.",
		params: {
			claims: Text({
				description: "What the change was for, one claim per line",
			}),
			revs: Text({ description: "Git revisions of the target: A..B or C^!" }),
		},
		examples: [
			{ claims: "greet.sh prints half as many lines.", revs: "HEAD^!" },
		],
	},
	({ claims, revs }) => {
		const target = commits(revs).out.lane;
		const scripted = proverOn(target, claims, changeset(target).out.changeset);
		return onBase(scripted.out.lane, LANE_BASE, proving, "proved");
	},
);
