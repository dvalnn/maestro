import { extend, fresh } from "@maestro/host-repo-sdk";
import { composition, List, Markdown, Text } from "@maestro/sdk";
import { task } from "./prompt";
import BUILD_TESTED from "./prompts/build-tested.md" with { type: "text" };
import TESTER from "./prompts/tester.md" with { type: "text" };
import { builder, tester } from "./seats";
import { Overrules, PACK } from "./types";

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
	({ request, checks }, { spec }) => {
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
	},
);
