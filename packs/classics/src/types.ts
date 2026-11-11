import {
	Bool,
	Enum,
	Json,
	List,
	Struct,
	Text,
	type ValueOf,
} from "@maestro/sdk";

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

const Entry = { question: Text(), answer: Text() };
const Grounded = Struct({ ...Entry, state: Enum(["grounded"]) });
const Unsure = Struct({
	...Entry,
	state: Enum(["unsure"]),
	missing: Json<string>({ type: "string", minLength: 1 }),
});

/**
 * A scout's answers, one entry per question in order: `grounded`, or `unsure` with `missing` naming the evidence it
 * could not get.
 */
export const Answers = List(
	Json<ValueOf<typeof Grounded> | ValueOf<typeof Unsure>>({
		oneOf: [Grounded.schema, Unsure.schema],
	}),
);
