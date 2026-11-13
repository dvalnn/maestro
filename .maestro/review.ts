import { tieredReview } from "@maestro/classics";
import { commits } from "@maestro/host-repo-sdk";
import { composition, Text, use } from "@maestro/sdk";
import { JUDGED, markdownOf } from "./shared";

// ADR 0008: a code node's function must be exported by its composition file.
export * from "@maestro/classics/code";

export const review = composition(
	"review",
	{
		doc: "Review a range of target commits as one change, such as an epic's stack, by tiered review with every ground at the consolidator, then consolidate what the lenses found. Leaves the review and the findings it upheld, and rejects while any remain.",
		params: {
			request: Text({ description: "What the commits must do together" }),
			revs: Text({
				description:
					"Git revisions of the target: A..B, C^!, or B from target.base",
			}),
		},
		examples: [{ request: "Make greet.sh greet by name.", revs: "HEAD^!" }],
	},
	({ request, revs }) =>
		use(
			tieredReview,
			{ change: commits(revs).out.lane, spec: markdownOf(request, "request") },
			{ params: { grounds: JUDGED } },
		),
);
