import {
	changeset,
	check,
	extend,
	fresh,
	Lane,
	Session,
} from "@maestro/host-repo-sdk";
import {
	code,
	composition,
	List,
	loop,
	Markdown,
	not,
	Text,
	use,
} from "@maestro/sdk";
import { toMarkdown } from "./code";
import REPAIR from "./prompts/repair.md" with { type: "text" };
import { builder } from "./seats";
import { atLeastOne } from "./types";

/** Each call's task: its prompt file. */
const TASKS = { repair: REPAIR };

export const EXAMPLE_REQUEST =
	"Make greet.sh greet the name given as its first argument, and the world when none is given.";

export const maxRepairs = atLeastOne(
	2,
	"The most repairs before the checks count as red",
);

export const repairUntilGreen = composition(
	"repair_until_green",
	{
		doc: "Check a lane, then repair and check again in the session that built it while the target's checks are red, up to maxRepairs times.",
		ports: { lane: Lane, session: Session, spec: Markdown() },
		params: {
			maxRepairs,
			checks: List(Text(), {
				default: [],
				description:
					"The target checks the repair agent may run on its repair, by name in target.checks",
			}),
			fix: Text({
				default: "",
				description:
					"The check in target.checks that runs before each check and recheck, to fix what a script can; empty runs none; judged by the check that follows, which runs it again",
			}),
		},
	},
	(params, { lane, session, spec }) => {
		// A failed fix goes on to the check, which runs every target check, the fix included, so the failure is red there.
		const fixed = (from: typeof lane, label: string) =>
			params.fix ? check(extend(from), params.fix, { label }).out.lane : from;
		const verify = (from: typeof lane, label: string, fixLabel: string) =>
			check(extend(fixed(from, fixLabel)), undefined, {
				label,
				tolerate: params.fix ? "rejected" : undefined,
			});
		return loop.while((s) => not(s.ok), {
			init: verify(lane, "check", "fix"),
			step: (s) => {
				const repair = builder({
					label: "repair",
					task: TASKS.repair,
					lane: extend(s.out.lane),
					session,
					checks: params.checks,
					attachments: {
						logs: { artifact: s.out.logs, hint: "first, to see what failed" },
						spec: { artifact: spec, hint: "for what the change must do" },
					},
				});
				return verify(repair.out.lane, "recheck", "refix");
			},
			max: params.maxRepairs,
			tolerate: "rejected",
		});
	},
);

export const buildThenRepair = composition(
	"build_then_repair",
	{
		doc: "Build the request in a fresh lane, repair it until the target's checks pass, and leave the change as a patch series.",
		params: {
			request: Text({ description: "What to build" }),
			maxRepairs,
		},
		examples: [{ request: EXAMPLE_REQUEST }],
	},
	({ request, maxRepairs }) => {
		const spec = code(toMarkdown, {
			in: { text: request },
			out: { file: Markdown() },
			label: "request",
		});
		const built = builder({ label: "build", task: request, lane: fresh() });
		const fixed = use(
			repairUntilGreen,
			{ lane: built.out.lane, session: built.out.session, spec: spec.out.file },
			{ params: { maxRepairs } },
		);
		return changeset(fixed.out.lane, { label: "result" });
	},
);
