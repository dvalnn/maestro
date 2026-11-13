import { changeset, fresh } from "@maestro/host-repo-sdk";
import {
	Bool,
	code,
	composition,
	Dir,
	List,
	Markdown,
	Text,
	use,
} from "@maestro/sdk";
import { briefOf, resultOf, specOf, toMarkdown } from "./code";
import { fixUntilClean, maxFixes } from "./fix-until-clean";
import { EXAMPLE_REQUEST, maxRepairs } from "./repair";
import { builder } from "./seats";
import { testFirst } from "./test-first";
import { Brief, PACK, Upheld } from "./types";

export const buildThenReview = composition(
	"build_then_review",
	{
		pack: PACK,
		doc: "Build the request in a fresh lane, with tests pinned first when tested, then repair and review it by panel, fixing what the panel upholds, and leave the change as a patch series. Rejects, with the series, while findings remain upheld.",
		params: {
			request: Text({ description: "What to build" }),
			tested: Bool({
				default: false,
				description:
					"A tester pins the request in tests before the builder builds",
			}),
			maxFixes,
			maxRepairs,
		},
		examples: [{ request: EXAMPLE_REQUEST }],
	},
	({ request, tested, maxFixes, maxRepairs }) => {
		const first = tested
			? use(
					testFirst,
					{
						spec: code(toMarkdown, {
							in: { text: request },
							out: { file: Markdown() },
							label: "request",
						}).out.file,
					},
					{ params: { request } },
				)
			: undefined;
		const built =
			first?.built ?? builder({ label: "build", task: request, lane: fresh() });
		const spec = code(specOf, {
			in: {
				request,
				...(first && { map: first.map, overrules: first.built.out.overrules }),
			},
			out: { file: Markdown() },
			label: "spec",
		}).out.file;
		const { brief } = code(briefOf, {
			in: { report: built.out.report },
			out: { brief: Brief },
			label: "brief",
		}).out;
		const reviewed = use(
			fixUntilClean,
			{ lane: built.out.lane, session: built.out.session, spec, brief },
			{ params: { maxFixes, maxRepairs } },
		);
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
