import { Bool, Json, List, Struct, Text } from "@maestro/sdk";

/** An integer param of at least 1, `value` by default. */
export const atLeastOne = (value: number, description: string) =>
	Json<number>(
		{ type: "integer", minimum: 1 },
		{ default: value, description: `${description}, at least 1` },
	);

/** What a lens found: `clean` when nothing, else each finding numbered `F1` on. */
export const Findings = Struct({
	clean: Bool(),
	findings: List(
		Struct({ id: Text(), where: Text(), issue: Text(), blocking: Bool() }),
	),
});

/** A skeptic's ruling on each finding of its lens, by the finding's id. */
export const Verdicts = List(
	Struct({ id: Text(), holds: Bool(), why: Text() }),
);

/** A consolidator's ruling: one entry per criterion, and what blocks approval. */
export const Verdict = Struct({
	approved: Bool(),
	criteria: List(Struct({ id: Text(), met: Bool(), evidence: Text() })),
	blocking: List(Text()),
});
