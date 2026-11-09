import { survivorsOf, toMarkdown } from "@maestro/classics";
import { commits } from "@maestro/host-repo-sdk";
import { composition, Text } from "@maestro/sdk";
import { markdownOf } from "./shared";
import { panelOf } from "./slice/lenses";

// ADR 0008: a code node's function must be exported by its composition file.
export { survivorsOf, toMarkdown };

export const review = composition(
	"review",
	{
		doc: "Review a range of target commits as one change, such as an epic's stack, through the risky tier's lenses, then consolidate what they found.",
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
		return panelOf("risky", change, spec);
	},
);
