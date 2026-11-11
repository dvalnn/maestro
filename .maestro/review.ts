import { Tally, tallyOf } from "@maestro/classics";
import { commits } from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	allSettled,
	code,
	composition,
	Markdown,
	Text,
} from "@maestro/sdk";
import { markdownOf, withOutputs } from "./shared";
import { panelOf } from "./slice/lenses";

// ADR 0008: a code node's function must be exported by its composition file.
export * from "@maestro/classics/code";

/** The tally of the review's consolidator, with its `review` beside it. */
export function stackedOf({
	review,
	...round
}: Parameters<typeof tallyOf>[0] & { review: ArtifactRef }) {
	return withOutputs(tallyOf(round), { review });
}

export const review = composition(
	"review",
	{
		doc: "Review a range of target commits as one change, such as an epic's stack, through the risky tier's lenses, then consolidate what they found. Leaves the consolidator's review and the findings it upheld, and rejects while any remain.",
		params: {
			request: Text({ description: "What the commits must do together" }),
			revs: Text({
				description:
					"Git revisions of the target: A..B, C^!, or B from target.base",
			}),
		},
		examples: [{ request: "Make greet.sh greet by name.", revs: "HEAD^!" }],
	},
	({ request, revs }) => {
		const change = commits(revs).out.lane;
		const spec = markdownOf(request, "request");
		const { consolidator, held } = panelOf("risky", change, spec);
		return code(stackedOf, {
			in: {
				lane: change,
				session: consolidator.out.session,
				held,
				verdict: allSettled([consolidator.out.verdict]),
				review: consolidator.out.review,
			},
			out: { ...Tally, review: Markdown() },
			tolerate: "rejected",
		});
	},
);
