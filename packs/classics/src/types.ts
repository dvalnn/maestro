import {
	Bool,
	Json,
	List,
	Struct,
	Text,
	type Type,
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

/** What a scout found: each fact and each risk at a `file:line`. */
export const Evidence = Struct({
	summary: Text(),
	facts: List(Struct({ where: Text(), note: Text() })),
	risks: List(Struct({ risk: Text(), where: Text() })),
});

/** A risk the scouts raised, numbered `R1` on. */
export const Risk = Struct({ id: Text(), risk: Text() });

/** A list of `item` holding one to `max` items. */
const Bounded = <T>(item: Type<T>, max: number) =>
	Json<T[]>({ type: "array", items: item.schema, minItems: 1, maxItems: max });

/**
 * A plan's criteria, numbered `C1` on, each with its proof, and one to `maxApproaches` approaches, numbered `A1` on,
 * the preferred first.
 */
export const Design = (maxApproaches: number) =>
	Struct({
		criteria: List(Struct({ id: Text(), criterion: Text(), proof: Text() })),
		approaches: Bounded(
			Struct({ id: Text(), approach: Text() }),
			maxApproaches,
		),
	});

export type DesignValue = ValueOf<ReturnType<typeof Design>>;

/** A documenter's ruling on each criterion of the design, by its id. */
export const Acceptance = List(
	Struct({ id: Text(), met: Bool(), evidence: Text() }),
);
