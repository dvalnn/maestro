// Worked examples of the repo host SDK: a review round, build-then-repair with a seat, and N lanes merged by a fold.

import { readFileSync } from "node:fs";
import type { ArtifactRef, CodeContext, Settled } from "@maestro/ir";
import {
	assert,
	code,
	composition,
	firstOk,
	Int,
	iter,
	List,
	loop,
	not,
	okOnly,
	type Ref,
	Struct,
	Text,
} from "@maestro/sdk";
import {
	apply,
	changeset,
	check,
	extend,
	fresh,
	JsonOut,
	type LaneInput,
	MarkdownOut,
	seat,
} from "../index";

const Findings = List(Struct({ file: Text(), issue: Text() }));
const Verdicts = List(Struct({ issue: Text(), holds: Text() }));

const LENSES = ["correctness", "security", "tests"];

type Round = {
	lens: { findings: ArtifactRef };
	skeptic: { verdicts: ArtifactRef };
};

/** The verdicts of every lens whose skeptic settled, as one text. */
export function byFinding(
	{ runs }: { runs: Settled<Round>[] },
	ctx: CodeContext,
): { text: string } {
	const verdicts = runs.flatMap((r) =>
		r.outcome === "ok" && r.value
			? [readFileSync(ctx.path(r.value.skeptic.verdicts), "utf8")]
			: [],
	);
	return { text: `Consolidate these verdicts:\n${verdicts.join("\n")}` };
}

/** The pack's own model-family rule: the provider before the slash. */
const family = (model: string) => model.split("/")[0];

const lens = seat("lens", {
	out: { findings: JsonOut("findings.json", Findings) },
});
const skeptic = seat("skeptic", {
	out: { verdicts: JsonOut("verdicts.json", Verdicts) },
});
const consolidator = seat("consolidator", {
	out: { summary: MarkdownOut("review.md") },
});

/**
 * A lens and its skeptic per lens, then a consolidator. `lensModel` and `skepticModel` are a build-time policy check,
 * refusing a skeptic of the lens's model family; the agents' models come from their profiles.
 */
export const review = composition(
	"review",
	{
		params: {
			lensModel: Text({ default: "openai/gpt-5" }),
			skepticModel: Text({ default: "anthropic/opus" }),
		},
		examples: [{}],
	},
	({ lensModel, skepticModel }) => {
		assert(
			family(lensModel) !== family(skepticModel),
			`skeptic model '${skepticModel}' is of the family of lens model '${lensModel}'`,
		);
		const rounds = iter.parMap(
			LENSES,
			(angle) => {
				const found = lens({ label: "lens", task: angle, lane: fresh() });
				const challenged = skeptic({
					label: "skeptic",
					task: "Challenge each finding: does it hold?",
					lane: fresh(),
					attachments: {
						findings: {
							artifact: found.out.findings,
							hint: "Read before judging any finding",
						},
					},
				});
				return { lens: found, skeptic: challenged };
			},
			{ onError: "continue" },
		);
		const merged = code(byFinding, {
			in: { runs: rounds.out.results },
			out: { text: Text() },
		});
		return consolidator({
			label: "consolidator",
			task: merged.out.text,
			lane: fresh(),
		});
	},
);

const builder = seat("builder", { checks: ["test"] });

/** Build, then repair in the builder's session while check `test` is red, bounded by a param; the result is the patch. */
export const buildThenRepair = composition(
	"build_then_repair",
	{
		params: {
			task: Text({ default: "Add a greeting to a.txt." }),
			maxRepairs: Int({ default: 2 }),
		},
		examples: [{}],
	},
	({ task, maxRepairs }) => {
		const built = builder({ label: "build", task, lane: fresh() });
		const repaired = loop.while((checked) => not(checked.ok), {
			init: check(extend(built.out.lane), "test"),
			step: (checked) => {
				const repair = builder({
					label: "repair",
					task: "Make check 'test' pass.",
					lane: extend(checked.out.lane),
					session: built.out.session,
					attachments: {
						logs: {
							artifact: checked.out.logs,
							hint: "Read first, to see why the check failed",
						},
					},
				});
				return check(extend(repair.out.lane), "test");
			},
			max: maxRepairs,
			tolerate: "rejected",
		});
		return changeset(repaired.out.lane, { label: "result" });
	},
);

const resolver = seat("resolver");
const implementer = seat("implementer");

/** The changeset of `item` applied to `lane`, and a resolver extending the result on a conflict: the merged version. */
function merge(
	lane: LaneInput<"fresh" | "extend">,
	item: Ref<{ changeset: ArtifactRef }>,
) {
	const change = item.get("changeset");
	const applied = apply(lane, change);
	const resolved = resolver({
		task: "Resolve the conflict markers in the files.",
		lane: extend(applied.out.lane),
		attachments: {
			incoming: {
				artifact: change,
				hint: "Read when you need to see what the incoming change set out to do",
			},
		},
		when: not(applied.ok),
		tolerate: "rejected",
	});
	return firstOk([resolved.out.lane, applied.out.lane]);
}

/**
 * Implementers in parallel, one per task, then the changesets of those that settled `ok` folded into one lane by
 * apply, in task order.
 */
export const fold = composition(
	"fold",
	{
		params: {
			tasks: List(Text(), {
				default: ["Write b.txt.", "Write c.txt.", "Write d.txt."],
			}),
		},
		examples: [{}],
	},
	({ tasks }) => {
		const implemented = iter.parMap(
			tasks,
			(task) => changeset(implementer({ task, lane: fresh() }).out.lane),
			{ onError: "stop" },
		);
		const merged = iter.fold(okOnly(implemented), {
			first: (cs) => merge(fresh(), cs),
			step: (acc, cs) => merge(extend(acc.out.value), cs),
			max: tasks.length,
		});
		return changeset(merged.out.value, { label: "result" });
	},
);
