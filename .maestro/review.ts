import { panel, survivorsOf, toMarkdown } from "@maestro/classics";
import { changeset, commits } from "@maestro/host-repo-sdk";
import { code, composition, lookup, Markdown, Text } from "@maestro/sdk";
import { JUDGED, PANELS } from "./slice/lenses";

// ADR 0008: a code node's function must be exported by its composition file.
export { survivorsOf, toMarkdown };

const LENSES = PANELS.risky;

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
		const spec = code(toMarkdown, {
			in: { text: request },
			out: { file: Markdown() },
			label: "request",
		}).out.file;
		return panel({
			items: Object.keys(LENSES),
			task: (name) => lookup(LENSES, name),
			change,
			patches: changeset(change, { label: "patches" }).out.changeset,
			spec,
			grounds: JUDGED,
			skeptics: false,
		});
	},
);
