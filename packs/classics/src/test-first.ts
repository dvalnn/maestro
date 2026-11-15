import { extend, fresh } from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	Bool,
	code,
	composition,
	List,
	Markdown,
	type Ref,
	Text,
} from "@maestro/sdk";
import { briefOf, specOf } from "./code";
import { task } from "./prompt";
import BUILD_TESTED from "./prompts/build-tested.md" with { type: "text" };
import TESTER from "./prompts/tester.md" with { type: "text" };
import { builder, tester } from "./seats";
import { Brief, Overrules, PACK } from "./types";

/**
 * A tester pinning `spec` in tests in a fresh lane, then a builder of `request` extending its lane, both under
 * `checks`, as nodes of the calling composition, so `build` names its builder alike with or without a tester.
 */
function testThenBuild(
	request: string,
	checks: string[],
	spec: Ref<ArtifactRef>,
) {
	const tested = tester({
		label: "tester",
		task: TESTER,
		lane: fresh(),
		checks,
		attachments: {
			spec: { artifact: spec, hint: "first, for the requirements to pin" },
		},
	});
	const map = tested.out.map;
	const built = builder({
		label: "build",
		task: task(request, BUILD_TESTED),
		lane: extend(tested.out.lane),
		checks,
		relay: { map },
		reply: { overrules: Overrules },
	});
	return { built, map };
}

export const testFirst = composition(
	"test_first",
	{
		pack: PACK,
		doc: "A tester pins the spec's requirements in tests, then a builder extends its lane and makes them pass. Gives the built lane and the tester's map; the builder replies with the tests it overrules.",
		ports: { spec: Markdown() },
		params: {
			request: Text({ description: "What to build" }),
			checks: List(Text(), {
				default: [],
				description:
					"The target checks the tester and the builder may run, by name in target.checks",
			}),
		},
	},
	({ request, checks }, { spec }) => testThenBuild(request, checks, spec),
);

export const buildChange = composition(
	"build",
	{
		pack: PACK,
		doc: "Build the request in a fresh lane, after a tester pins it in tests when testFirst. Gives the built lane, the builder's session, the spec with the tester's map and the builder's overrules when tested, and the builder's brief.",
		ports: { spec: Markdown() },
		params: {
			request: Text({ description: "What to build" }),
			testFirst: Bool({
				default: false,
				description:
					"A tester pins the spec in tests before the builder builds",
			}),
			checks: List(Text(), {
				default: [],
				description:
					"The target checks the builder, and the tester when testFirst, may run, by name in target.checks",
			}),
		},
	},
	({ request, testFirst: tested, checks }, { spec }) => {
		// The tester joins this scope, not one of its own, so an encore that turns it off continues the same builder.
		const first = tested ? testThenBuild(request, checks, spec) : undefined;
		const built =
			first?.built ??
			builder({ label: "build", task: request, lane: fresh(), checks });
		const folded = code(specOf, {
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
		return {
			lane: built.out.lane,
			session: built.out.session,
			spec: folded,
			brief,
		};
	},
);
