import type { JsonSchema } from "./types";

/** Best to worst, the one order every aggregation of outcomes follows (ADR 0006). */
export const OUTCOMES = ["ok", "skipped", "rejected", "failed"] as const;

export type Outcome = (typeof OUTCOMES)[number];

export type Settled<T> =
	| { outcome: "ok"; value: T }
	| { outcome: "rejected" | "failed"; value?: T; reason: string }
	| { outcome: "skipped"; value?: T; reason?: string };

/** The worst of `outcomes`: `failed` > `rejected` > `skipped` > `ok`. An empty input is `ok` (ADR 0006). */
export function worstOutcome(outcomes: Iterable<Outcome>): Outcome {
	let worst: Outcome = "ok";
	for (const outcome of outcomes)
		if (OUTCOMES.indexOf(outcome) > OUTCOMES.indexOf(worst)) worst = outcome;
	return worst;
}

/**
 * The JSON Schema of `Settled<T>`, where `valueSchema` is T's. `valueSchema` sits at `properties.value`, the
 * subschema a `data` edge into a fan-in input is checked against (ADR 0006).
 */
export function settledSchema(
	valueSchema: JsonSchema,
): Exclude<JsonSchema, boolean> {
	return {
		type: "object",
		required: ["outcome"],
		additionalProperties: false,
		properties: {
			outcome: { enum: [...OUTCOMES] },
			value: valueSchema,
			reason: { type: "string" },
		},
		// One branch per member of `Settled`. A `true` entry declares a field its branch requires, as Ajv's
		// strictRequired demands.
		oneOf: [
			{
				required: ["value"],
				properties: { outcome: { const: "ok" }, value: true, reason: false },
			},
			{
				required: ["reason"],
				properties: { outcome: { enum: ["rejected", "failed"] }, reason: true },
			},
			{ properties: { outcome: { const: "skipped" } } },
		],
	};
}
