import { commits } from "@maestro/host-repo-sdk";
import { composition, Text } from "@maestro/sdk";
import { markdownOf } from "./shared";
import { panelOf } from "./slice/lenses";

// ADR 0008: a code node's function must be exported by its composition file.
export * from "@maestro/classics/code";

export const review = composition(
	"review",
	{
		doc: "Review a range of target commits as one change, such as an epic's stack, through the risky tier's lenses, then consolidate what they found. Leaves the panel's review and the findings it upheld, and rejects while any remain.",
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
		return panelOf("risky", { change, spec });
	},
);
