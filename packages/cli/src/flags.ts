import { isPlainObject, type JsonSchema, MAESTRO_TYPE } from "@maestro/ir";
import type { Described } from "@maestro/sdk/loader";
import type { Options, Values } from "./command";
import { usageError } from "./output";
import { flagFor, flagName } from "./params";

/** The flags a composition's params add to a command, and the param each one sets. */
type ParamFlags = {
	options: Options;
	/** Param name by flag name, without the dashes. */
	params: ReadonlyMap<string, string>;
};

const typeOf = (schema: JsonSchema) =>
	isPlainObject(schema) ? schema.type : undefined;

const itemsOf = (schema: JsonSchema): JsonSchema =>
	isPlainObject(schema) && isPlainObject(schema.items) ? schema.items : true;

/**
 * The flag of each param of `composition`, in kebab-case. A list takes its flag repeated, a boolean takes `--name` and
 * `--no-name`, anything else one value.
 * @throws CliError, a usage error, when two params share a flag, or a param's flag is one of `taken`, the command's own.
 */
export function paramFlags(
	composition: Described,
	taken: Options,
	label: string,
): ParamFlags {
	const options: Record<string, Options[string]> = {};
	const params = new Map<string, string>();
	for (const [name, schema] of Object.entries(composition.params.properties)) {
		const key = flagName(name);
		const flag = flagFor(key);
		const other = params.get(key);
		if (other !== undefined)
			throw usageError(
				`params '${other}' and '${name}' of '${label}' both take ${flag}`,
				`Rename one of them in the composition`,
			);
		if (Object.hasOwn(taken, key))
			throw usageError(
				`param '${name}' of '${label}' takes ${flag}, which the command takes too`,
				`Rename '${name}' in the composition`,
			);
		const description =
			isPlainObject(schema) && typeof schema.description === "string"
				? schema.description
				: `Param ${name}`;
		options[key] = {
			type: typeOf(schema) === "boolean" ? "boolean" : "string",
			multiple: typeOf(schema) === "array",
			arg: "value",
			desc: description,
		};
		params.set(key, name);
	}
	return { options, params };
}

/** One flag value as the param's value: text stays text, a number is read, anything else is JSON. */
function read(flag: string, schema: JsonSchema, value: string | boolean) {
	if (typeof value === "boolean") return value;
	if (isPlainObject(schema) && Object.hasOwn(schema, MAESTRO_TYPE))
		return value;
	const type = typeOf(schema);
	if (type === "string") return value;
	if (type === "integer" || type === "number") {
		const number = Number(value);
		if (value.trim() === "" || !Number.isFinite(number))
			throw usageError(
				`${flag} takes a number, not '${value}'`,
				`Pass ${flag} a number`,
			);
		return number;
	}
	try {
		return JSON.parse(value);
	} catch {
		throw usageError(
			`${flag} takes JSON, not '${value}'`,
			`Pass ${flag} a JSON value, such as '{"key": 1}'`,
		);
	}
}

/**
 * The param values the flags in `values` set, by param name.
 * @throws CliError, a usage error naming the flag, for a value that does not read as its param's type.
 */
export function flagValues(
	composition: Described,
	{ params }: ParamFlags,
	values: Values,
): Record<string, unknown> {
	const given: Record<string, unknown> = {};
	for (const [key, name] of params) {
		const value = values[key];
		if (value === undefined) continue;
		const schema = composition.params.properties[name] ?? true;
		const flag = flagFor(key);
		given[name] = Array.isArray(value)
			? value.map((v) => read(flag, itemsOf(schema), v))
			: read(flag, schema, value);
	}
	return given;
}
