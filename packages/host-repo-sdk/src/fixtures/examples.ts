// Worked examples of the repo host SDK: a review round, build-then-repair with a seat, and N lanes merged by a fold.

import { readFileSync } from "node:fs";
import type { ArtifactRef, CodeContext, Settled } from "@maestro/ir";
import {
	assert,
	code,
	composition,
	Dir,
	firstOk,
	Int,
	List,
	lookup,
	map,
	Record,
	type Ref,
	repeat,
	Text,
} from "@maestro/sdk";
import {
	agent,
	apply,
	changeset,
	check,
	fresh,
	JsonOut,
	join,
	type LaneInput,
	MarkdownOut,
	seat,
} from "../index";

const Findings = List(Record({ file: Text(), issue: Text() }));
const Verdicts = List(Record({ issue: Text(), holds: Text() }));

const LENSES = ["correctness", "security", "tests"];

/** The pack's own model-family rule: the provider before the slash. */
const family = (model: string) => model.split("/")[0];

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

/** A lens and its skeptic per lens, then a consolidator; the skeptic's model family must differ from the lens's. */
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
			{ onFail: "failed" },
		);
		const rounds = map(
			LENSES,
			(lens) => {
				const found = agent({
					label: "lens",
					task: lens,
					lane: fresh(),
					role: { name: "reviewer", model: lensModel },
					out: { findings: JsonOut("findings.json", Findings) },
				});
				const skeptic = agent({
					label: "skeptic",
					task: "Challenge each finding: does it hold?",
					lane: fresh(),
					role: { name: "reviewer", model: skepticModel },
					refs: {
						findings: {
							artifact: found.out.findings,
							when: "before judging any finding",
						},
					},
					out: { verdicts: JsonOut("verdicts.json", Verdicts) },
				});
				return { lens: found, skeptic };
			},
			{ onError: "settle" },
		);
		const merged = code(byFinding, {
			in: { runs: rounds.out.results as Ref<Settled<Round>[]> },
			out: { text: Text() },
		});
		return agent({
			label: "consolidator",
			task: merged.out.text,
			lane: fresh(),
			role: "reviewer",
			out: { summary: MarkdownOut("review.md") },
		});
	},
);

const builder = seat({
	role: "builder",
	identity: "You build in small steps, and leave the tree compiling.",
	checks: ["test"],
});

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
		const repaired = repeat({
			init: check(join(built.out.lane), "test"),
			step: (checked) => {
				const repair = builder({
					label: "repair",
					task: "Make check 'test' pass.",
					lane: join(checked.out.lane),
					resume: true,
					refs: {
						logs: {
							artifact: checked.out.logs,
							when: "first, to see why the check failed",
						},
					},
				});
				return check(join(repair.out.lane), "test");
			},
			until: (c) => c.ok,
			max: maxRepairs,
			tolerate: "rejected",
		});
		return changeset(repaired.out.lane, { label: "result" });
	},
);

type Implemented = { result: { changeset: ArtifactRef } };

/** The changeset of the implementer at `index + offset`. @throws Error when that implementer has none. */
export function nthChangeset({
	results,
	index,
	offset,
}: {
	results: Settled<Implemented>[];
	index: number;
	offset: number;
}): { changeset: ArtifactRef } {
	const member = results[index + offset];
	if (member?.outcome !== "ok" || !member.value)
		throw new Error(`implementer ${index + offset} left no changeset`);
	return { changeset: member.value.result.changeset };
}

/** Whether an apply that settled each outcome left conflicts to resolve. */
const CONFLICTED = { ok: false, rejected: true, failed: false, skipped: false };

const resolver = seat({
	role: "resolver",
	identity: "You resolve merge conflicts, keeping both sides' intent.",
});

/** `cs` applied to `lane`, and a resolver joining the result on a conflict: the merged version. */
function merge(lane: LaneInput<"fresh" | "join">, cs: Ref<ArtifactRef>) {
	const applied = apply(lane, { change: cs });
	const conflicted = lookup(CONFLICTED, applied.outcome, {
		tolerate: "rejected",
	});
	const resolved = resolver({
		task: "Resolve the conflict markers in the files.",
		lane: join(applied.out.lane),
		when: conflicted,
		tolerate: "rejected",
	});
	return firstOk([resolved.out.lane, applied.out.lane], { label: "merged" });
}

/** Implementers in parallel, one per task, then their changesets folded into one lane by apply, in task order. */
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
		assert(tasks.length >= 2, "fold needs two tasks or more", {
			onFail: "failed",
		});
		const implemented = map(
			tasks,
			(task) =>
				changeset(agent({ task, lane: fresh(), role: "implementer" }).out.lane),
			{ onError: "propagate" },
		);
		const results = implemented.out.results as Ref<Settled<Implemented>[]>;
		const nth = (index: Ref<number> | number, offset: number) =>
			code(nthChangeset, {
				in: { results, index, offset },
				out: { changeset: Dir() },
			}).out.changeset;
		const merged = repeat({
			init: merge(fresh(), nth(0, 0)),
			step: (state, i) => merge(join(state.out.value), nth(i, 1)),
			max: tasks.length - 1,
		});
		return changeset(merged.out.value, { label: "result" });
	},
);
