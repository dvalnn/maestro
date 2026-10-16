import {
	type JsonSchema,
	type Settled as SettledValue,
	settledSchema,
} from "@maestro/ir";
import {
	type Common,
	canonicalJson,
	checkPlain,
	fail,
	info,
	isPlainObject,
	isResults,
	itemsOf,
	lift,
	type Ref,
	RefImpl,
	type Result,
	ResultImpl,
	type StdlibName,
	schemaOf,
	sourceOf,
	stdlib,
	visible,
} from "./graph";
import { type MapResults, memberSchema } from "./nodes";
import type { Type } from "./types";

const isStringSchema = (schema: JsonSchema) =>
	typeof schema === "object" && schema.type === "string";

const pairs = (a: Ref<unknown>, b: Ref<unknown>) => ({
	type: "array",
	items: {
		type: "array",
		prefixItems: [itemsOf(a.type.schema), itemsOf(b.type.schema)],
		items: false,
	},
});

/** The i-th items of two lists, as pairs: a stdlib `zip` node. */
export function zip<A, B>(
	a: Ref<A[]>,
	b: Ref<B[]>,
	common: Common = {},
): Ref<[A, B][]> {
	return lift(
		"zip",
		`zip_${sourceOf(a)}_${sourceOf(b)}`,
		{ a, b },
		pairs(a, b),
		common,
	) as Ref<[A, B][]>;
}

/** The pairs of items of two lists whose field `on` is equal: a stdlib `join` node. */
export function join<A, B>(
	a: Ref<A[]>,
	b: Ref<B[]>,
	{ on, ...common }: Common & { on: string },
): Ref<[A, B][]> {
	return lift(
		"join",
		`join_${sourceOf(a)}_${sourceOf(b)}`,
		{ a, b, on },
		pairs(a, b),
		common,
	) as Ref<[A, B][]>;
}

/** `value`, from a stdlib `when` node that is skipped unless `cond` is true. `or` gives it a fallback. */
export function when<T>(
	cond: Ref<boolean>,
	value: Ref<T> | T,
	common: Omit<Common, "when"> = {},
): Ref<T> {
	const schema =
		value instanceof RefImpl ? value.type.schema : schemaOf([value]);
	return lift("when", `${sourceOf(value)}_when`, { value }, schema, {
		...common,
		when: cond,
	}) as Ref<T>;
}

/** The entry of the plain `table` under `key`: a stdlib `lookup` node. An array table takes a number key only. */
export function lookup<V>(
	table: readonly V[],
	key: Ref<number>,
	common?: Common,
): Ref<V>;
export function lookup<V>(
	table: Record<string, V>,
	key: Ref<string> | Ref<number>,
	common?: Common,
): Ref<V>;
export function lookup<V>(
	table: Record<string, V> | readonly V[],
	key: Ref<string> | Ref<number>,
	common: Common = {},
): Ref<V> {
	checkPlain(table, "lookup table");
	if (Array.isArray(table) && isStringSchema(key.type.schema))
		throw fail(
			"TYPE.key",
			"lookup into an array takes a number key, and this key is a string",
			"Pass a number key, or put the entries in an object keyed by string",
		);
	const entries =
		isPlainObject(table) || Array.isArray(table) ? Object.values(table) : [];
	return lift(
		"lookup",
		`${sourceOf(key)}_lookup`,
		{ key, table },
		schemaOf(entries),
		common,
	) as Ref<V>;
}

/** A map's handle or its results, or node outputs each delivered as `Settled` (ADR 0006 "Reducer inputs"). */
export type ReducerInputs<T> =
	| readonly Ref<T>[]
	| Ref<SettledValue<T>[]>
	| Result<MapResults>;

const badInputs = (name: StdlibName) =>
	fail(
		"TYPE.reducer",
		`${name} takes a map, its results or a non-empty list of node outputs`,
		`Pass a map's handle, or a list such as [a.out.x, b.out.y]`,
	);

const isNodeOutput = (ref: unknown): ref is RefImpl<unknown> =>
	ref instanceof RefImpl &&
	ref.source.kind === "port" &&
	!isResults(visible(ref));

/** The input ports of a reducer, and the schema of one input's value. */
function reducerPorts(name: StdlibName, given: unknown) {
	const inputs =
		given instanceof ResultImpl && info(given.node).kind === "map"
			? given.out.results
			: given;
	if (inputs instanceof RefImpl) {
		if (inputs.source.kind !== "port" || !isResults(visible(inputs)))
			throw badInputs(name);
		return {
			ports: { results: inputs },
			value: memberSchema(inputs.source.node),
		};
	}
	if (!Array.isArray(inputs) || inputs.length === 0) throw badInputs(name);
	if (!inputs.every(isNodeOutput)) throw badInputs(name);
	const distinct = [
		...new Map(
			inputs.map((r) => [canonicalJson(r.type.schema), r.type.schema]),
		).values(),
	];
	const value =
		distinct.length === 1 ? (distinct[0] as JsonSchema) : { anyOf: distinct };
	return {
		ports: Object.fromEntries(inputs.map((ref, i) => [`in${i}`, ref])),
		value,
	};
}

function reducer(
	name: StdlibName,
	inputs: unknown,
	common: Common,
	out: (value: JsonSchema) => JsonSchema,
) {
	const { ports, value } = reducerPorts(name, inputs);
	return stdlib(name, ports, { value: out(value) }, { ...common, fanin: true });
}

type Value<T> = Result<{ value: Type<T> }>;

/**
 * The first `ok` input's value. With no `ok` input it settles `failed` if any input failed, else `rejected` (ADR 0006).
 * Returned from a build function, it is the composition's result.
 */
export function firstOk<T>(
	inputs: ReducerInputs<T>,
	common: Common = {},
): Value<T> {
	return reducer("firstOk", inputs, common, (v) => v) as unknown as Value<T>;
}

/** The values of the `ok` inputs, in input order. */
export function okOnly<T>(
	inputs: ReducerInputs<T>,
	common: Common = {},
): Value<T[]> {
	return reducer("okOnly", inputs, common, (v) => ({
		type: "array",
		items: v,
	})) as unknown as Value<T[]>;
}

/** Every input as `Settled`, in input order. */
export function settle<T>(
	inputs: ReducerInputs<T>,
	common: Common = {},
): Value<SettledValue<T>[]> {
	return reducer("settle", inputs, common, (v) => ({
		type: "array",
		items: settledSchema(v),
	})) as unknown as Value<SettledValue<T>[]>;
}
