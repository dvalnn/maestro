import { readFile } from "node:fs/promises";
import {
	type ArtifactRef,
	type CodeContext,
	type JsonSchema,
	messageOf,
	type Rejection,
	reject,
	type Settled,
	validator,
	violations,
	worstOutcome,
} from "@maestro/ir";

type Value<T = unknown> = { value: T };

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The field of `value` at the dotted `path`.
 * @throws when a field on the path is missing, naming the path.
 */
export function get({ value, path }: { value: unknown; path: string }): Value {
	let at = value;
	for (const key of path.split(".")) {
		if (!isRecord(at) || !Object.hasOwn(at, key))
			throw new Error(`get: path '${path}' has no field '${key}'`);
		at = at[key];
	}
	return { value: at };
}

/**
 * `value`'s value when it settled `ok`, else `fallback`.
 * @throws when `value` failed, so the node settles `failed` (ADR 0006).
 */
export function or({
	value,
	fallback,
}: {
	value: Settled<unknown>;
	fallback: unknown;
}): Value {
	if (value.outcome === "failed")
		throw new Error(`or: its input failed: ${value.reason}`);
	return { value: value.outcome === "ok" ? value.value : fallback };
}

const ajv = validator();

/**
 * The content of the JSON file `file`. Rejects when it is not JSON or does not match `schema`.
 * @throws when the file cannot be read.
 */
export async function readJson(
	{ file, schema }: { file: ArtifactRef; schema: JsonSchema },
	ctx: CodeContext,
): Promise<Value | Rejection> {
	const text = await readFile(ctx.path(file), "utf8");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return reject(`readJson: '${file.path}' is not JSON: ${messageOf(error)}`);
	}
	const found = violations(ajv, schema, value, (at) =>
		at.length ? `'${at.join(".")}'` : "the content",
	);
	if (found.length)
		return reject(
			`readJson: '${file.path}' does not match its schema: ${found.join("; ")}`,
		);
	return { value };
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
export function allSettled(
	ports: ReducerPorts,
): Value<readonly Settled<unknown>[]> {
	return { value: settledOf(ports) };
}
