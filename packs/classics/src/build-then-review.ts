import { changeset } from "@maestro/host-repo-sdk";
import {
	code,
	composition,
	Dir,
	List,
	Markdown,
	Text,
	use,
} from "@maestro/sdk";
import { resultOf, toMarkdown } from "./code";
import { fixUntilClean, maxFixes } from "./fix-until-clean";
import { EXAMPLE_REQUEST } from "./repair";
import { buildChange } from "./test-first";
import { PACK, Upheld } from "./types";

export const buildThenReview = composition(
	"build_then_review",
	{
		pack: PACK,
		doc: "Build the request in a fresh lane, with tests pinned first under classics.build.testFirst, then repair and review it by tiered review, fixing what the review upholds, and leave the change as a patch series. Rejects, with the series, while findings remain upheld.",
		params: {
			request: Text({ description: "What to build" }),
			maxFixes,
		},
		examples: [{ request: EXAMPLE_REQUEST }],
	},
	({ request, maxFixes }) => {
		const built = use(
			buildChange,
			{
				spec: code(toMarkdown, {
					in: { text: request },
					out: { file: Markdown() },
					label: "request",
				}).out.file,
			},
			{ params: { request } },
		);
		const reviewed = use(fixUntilClean, built, { params: { maxFixes } });
		return code(resultOf, {
			in: {
				changeset: changeset(reviewed.out.lane, {
					label: "result",
					tolerate: "rejected",
				}).out.changeset,
				upheld: reviewed.out.upheld,
			},
			out: { changeset: Dir(), upheld: List(Upheld) },
			label: "outcome",
			tolerate: "rejected",
		});
	},
);
