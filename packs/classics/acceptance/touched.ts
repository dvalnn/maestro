import { changeset, Lane } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const touched = composition(
	"touched",
	{
		doc: "The change a lane version holds over the target's base, as a patch series.",
		params: { lane: Lane },
		examples: [{ lane: "c.repair_until_green/loop[1]/recheck" }],
	},
	({ lane }) => changeset(lane, { label: "touched" }),
);
