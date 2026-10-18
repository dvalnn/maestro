import {
	type Rejection,
	reject,
	type Settled,
	worstOutcome,
} from "@maestro/ir";

type Value<T = unknown> = { value: T };

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The field of `value` at the dotted `path`.
 * @throws when a field on the path is missing, naming the path.
 */
export function pick({ value, path }: { value: unknown; path: string }): Value {
	let at = value;
	for (const key of path.split(".")) {
		if (!isRecord(at) || !Object.hasOwn(at, key))
			throw new Error(`pick: path '${path}' has no field '${key}'`);
		at = at[key];
	}
	return { value: at };
}

/** `value`'s value when it settled `ok`, else `fallback`. */
export function or({
	value,
	fallback,
}: {
	value: Settled<unknown>;
	fallback: unknown;
}): Value {
	return { value: value.outcome === "ok" ? value.value : fallback };
}

/** `value`, unchanged. */
export function when({ value }: Value): Value {
	return { value };
}

/** `value` negated. */
export function not({ value }: Value<boolean>): Value<boolean> {
	return { value: !value };
}

/**
 * The entry of `table` under `key`. An array takes a number key only.
 * @throws when there is no such entry, naming the key.
 */
export function lookup({
	key,
	table,
}: {
	key: string | number;
	table: Record<string, unknown> | readonly unknown[];
}): Value {
	const indexed = Array.isArray(table) ? typeof key === "number" : true;
	if (!indexed || !Object.hasOwn(table, key))
		throw new Error(`lookup: no entry under key ${JSON.stringify(key)}`);
	return { value: Reflect.get(table, key) };
}

/**
 * Pairs the items of `a` and `b`.
 * - Without `on`, the i-th items, in order.
 * - With `on`, every item of `a` with every item of `b` whose field `on` is equal, in the order of `a`, then of `b`. A
 *   string, number or boolean key matches by strict equality, and an item whose key is `null` or missing matches
 *   nothing.
 * @throws when the lists differ in length without `on`, naming both lengths.
 * @throws when a key is an object or an array, naming the key.
 */
export function zip({
	a,
	b,
	on,
}: {
	a: readonly unknown[];
	b: readonly unknown[];
	on?: string;
}): Value<unknown[][]> {
	if (on !== undefined) return { value: zipByKey(a, b, on) };
	if (a.length !== b.length)
		throw new Error(`zip: lists differ in length, ${a.length} and ${b.length}`);
	return { value: a.map((item, i) => [item, b[i]]) };
}

function zipByKey(
	a: readonly unknown[],
	b: readonly unknown[],
	on: string,
): unknown[][] {
	const keyOf = (item: unknown) => {
		const key = isRecord(item) ? item[on] : undefined;
		if (typeof key === "object" && key !== null)
			throw new Error(
				`zip: key ${JSON.stringify(key)} of field '${on}' is not a string, number or boolean`,
			);
		return key ?? undefined;
	};
	const matches = Map.groupBy(b, keyOf);
	return a.flatMap((x) => {
		const key = keyOf(x);
		if (key === undefined) return [];
		return (matches.get(key) ?? []).map((y) => [x, y]);
	});
}

/** A reducer's ports: a `parMap` or `map`'s `results`, or one `Settled` input per output, `in0` to `inN`. */
type ReducerPorts =
	| { results: readonly Settled<unknown>[] }
	| { [port: `in${number}`]: Settled<unknown> };

/**
 * The one `Settled` list a reducer reads, in input order.
 * @throws when the ports are not `results` or exactly `in0` to `in(n-1)`.
 */
function settledOf(ports: ReducerPorts): readonly Settled<unknown>[] {
	if ("results" in ports) return ports.results;
	const names = Object.keys(ports);
	return names.map((_, i) => {
		const input = ports[`in${i}`];
		if (input === undefined)
			throw new Error(
				`reducer ports must be in0 to in${names.length - 1}, and 'in${i}' is missing from: ${names.join(", ")}`,
			);
		return input;
	});
}

/**
 * The first `ok` input's value. With none, it rejects with the inputs' reasons, unless one failed (ADR 0006).
 * @throws when no input is `ok` and any failed, so the node settles `failed`.
 */
export function firstOk(ports: ReducerPorts): Value | Rejection {
	const others = [];
	for (const input of settledOf(ports)) {
		if (input.outcome === "ok") return { value: input.value };
		others.push(input);
	}
	const reasons = others.map((o) => o.reason ?? o.outcome).join("; ");
	const reason = `firstOk: no input was ok: ${reasons || "there were none"}`;
	if (worstOutcome(others.map((o) => o.outcome)) === "failed")
		throw new Error(reason);
	return reject(reason);
}

/**
 * The values of the `ok` inputs, in input order.
 * @throws when the ports are not `results` or exactly `in0` to `in(n-1)`.
 */
export function okOnly(ports: ReducerPorts): Value<unknown[]> {
	return {
		value: settledOf(ports).flatMap((s) =>
			s.outcome === "ok" ? [s.value] : [],
		),
	};
}

/**
 * Every input as `Settled`, in input order.
 * @throws when the ports are not `results` or exactly `in0` to `in(n-1)`.
 */
export function settle(
	ports: ReducerPorts,
): Value<readonly Settled<unknown>[]> {
	return { value: settledOf(ports) };
}
