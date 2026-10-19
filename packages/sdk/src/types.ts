import {
	type ArtifactRef,
	CORE_TYPES,
	type JsonSchema,
	MAESTRO_TYPE,
	type Ports,
	type Settled as SettledValue,
	settledSchema,
} from "@maestro/ir";

type SchemaObject = Exclude<JsonSchema, boolean>;

/**
 * A port, param or config type: its JSON Schema, and `T`, the TypeScript type of a value at perform time. An
 * `optional` param may be absent.
 */
export type Type<T> = {
	readonly schema: JsonSchema;
	readonly optional?: true;
	readonly __value?: T;
};

export type ValueOf<X> = X extends Type<infer T> ? T : never;

/** Named types, as ports, params and node outputs declare them. */
export type Types = Record<string, Type<unknown>>;

/** The schema of each named type. */
export const schemas = (types: Types | undefined): Ports =>
	Object.fromEntries(
		Object.entries(types ?? {}).map(([name, type]) => [name, type.schema]),
	);

/** Standard JSON Schema annotations, which double as CLI hints on params. */
export type Hints<T> = { default?: T; description?: string };

const typed = <T>(schema: SchemaObject, hints?: Hints<T>): Type<T> => ({
	schema: { ...schema, ...hints },
});

export const Text = (hints?: Hints<string>) =>
	typed<string>({ type: "string" }, hints);

export const Bool = (hints?: Hints<boolean>) =>
	typed<boolean>({ type: "boolean" }, hints);

export const Int = (hints?: Hints<number>) =>
	typed<number>({ type: "integer" }, hints);

export const Float = (hints?: Hints<number>) =>
	typed<number>({ type: "number" }, hints);

/** Any value `schema` describes. `T` is the caller's word for it. */
export const Json = <T = unknown>(schema: SchemaObject, hints?: Hints<T>) =>
	typed<T>(schema, hints);

export const List = <T>(item: Type<T>, hints?: Hints<T[]>) =>
	typed<T[]>({ type: "array", items: item.schema }, hints);

/** An object with exactly these fields, each one required. */
export const Struct = <F extends Types>(
	fields: F,
	hints?: Hints<{ [K in keyof F]: ValueOf<F[K]> }>,
) =>
	typed<{ [K in keyof F]: ValueOf<F[K]> }>(
		{
			type: "object",
			properties: schemas(fields),
			required: Object.keys(fields),
			additionalProperties: false,
		},
		hints,
	);

/** One of these strings. */
export const Enum = <const V extends readonly string[]>(
	values: V,
	hints?: Hints<V[number]>,
) => typed<V[number]>({ type: "string", enum: [...values] }, hints);

/** An artifact's value is its reference, so a hint carries no default. */
type ArtifactHints = Omit<Hints<ArtifactRef>, "default">;

/** The reference to a JSON file whose content is a `T`, as `readJson` reads it. */
export type JsonArtifact<T> = ArtifactRef & { readonly [JSON_CONTENT]: T };

// A type-only brand: no value carries it, so only a `JsonFile` type yields a `JsonArtifact`.
declare const JSON_CONTENT: unique symbol;

// An artifact's schema describes the file's content, and its value is the reference (ADR 0007).
const artifact = <T extends ArtifactRef = ArtifactRef>(
	type: string,
	content: SchemaObject,
	hints?: ArtifactHints,
) => typed<T>({ ...content, [MAESTRO_TYPE]: type }, hints);

export const File = (hints?: ArtifactHints) =>
	artifact(CORE_TYPES.file, {}, hints);

export const Dir = (hints?: ArtifactHints) =>
	artifact(CORE_TYPES.dir, {}, hints);

/** A JSON file whose content is a `type`. */
export const JsonFile = <T>(type: Type<T>, hints?: ArtifactHints) =>
	artifact<JsonArtifact<T>>(
		CORE_TYPES.jsonFile,
		typeof type.schema === "object" ? type.schema : {},
		hints,
	);

export const Markdown = (hints?: ArtifactHints) =>
	artifact(CORE_TYPES.markdown, {}, hints);

/** `type` as a param that may be absent: no flag or config needs to give it, and the build sees `undefined`. */
export const Optional = <T>(type: Type<T>): Type<T | undefined> => ({
	...type,
	optional: true,
});

/** What a group member or a fan-in input delivers (ADR 0006). */
export type Settled<T> = SettledValue<T>;

/** The type of a `Settled` value of `type`. */
export const Settled = <T>(type: Type<T>): Type<SettledValue<T>> => ({
	schema: settledSchema(type.schema),
});
