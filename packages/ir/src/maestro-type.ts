import type AjvCore from "ajv/dist/core";
import irSchema from "../ir.schema.json";
import { artifactRefSchema } from "./artifact-ref";
import type { JsonSchema } from "./types";

/** The annotation that names an artifact or host type on a subschema, as `<namespace>.<type>` (ADR 0007). */
export const MAESTRO_TYPE = "x-maestro-type";

/** The type names core owns (ADR 0007). Each names an artifact, whose runtime value is an `ArtifactRef`. */
export const CORE_TYPES = {
	file: "core.file",
	dir: "core.dir",
	jsonFile: "core.json-file",
	markdown: "core.markdown",
} as const;

/** The `x-maestro-type` names whose runtime value is an `ArtifactRef`: every core type (ADR 0007). */
export const ARTIFACT_TYPES: ReadonlySet<string> = new Set(
	Object.values(CORE_TYPES),
);

/**
 * Registers `x-maestro-type` on `ajv` once, so a strict instance compiles schemas that carry it and rejects a bad name.
 */
export function registerMaestroType<A extends AjvCore>(ajv: A): A {
	if (ajv.getKeyword(MAESTRO_TYPE)) return ajv;
	ajv.addKeyword({
		keyword: MAESTRO_TYPE,
		metaSchema: {
			type: "string",
			pattern: irSchema.$defs.qualifiedName.pattern,
		},
	});
	return ajv;
}

type SchemaObject = Exclude<JsonSchema, boolean>;

/** A marked subschema and the value found under it. `pointer` is a JSON Pointer into the walked value. */
export type Marked = {
	type: string;
	schema: SchemaObject;
	pointer: string;
	value: unknown;
};

/**
 * Every present value in `value` that `schema` marks with `x-maestro-type`. Descends `properties`,
 * `additionalProperties`, `items`, `prefixItems` and `$ref` of the form `#` or `#/<pointer>` only, and never into a
 * marked subschema, whose content schema does not describe the value (ADR 0007).
 */
export function findMarked(schema: JsonSchema, value: unknown): Marked[] {
	const found: Marked[] = [];
	walk(schema, schema, value, "", found);
	return found;
}

function walk(
	root: JsonSchema,
	schema: JsonSchema,
	value: unknown,
	pointer: string,
	found: Marked[],
): void {
	if (typeof schema === "boolean" || value === undefined) return;
	const type = schema[MAESTRO_TYPE];
	if (typeof type === "string") {
		found.push({ type, schema, pointer, value });
		return;
	}
	const target = followRef(root, schema);
	if (target) walk(root, target.schema, value, pointer, found);
	for (const [key, sub, child] of children(schema, value))
		walk(root, sub, child, `${pointer}/${escapeSegment(key)}`, found);
}

type Child = [key: string, schema: JsonSchema, value: unknown];

function children(schema: SchemaObject, value: unknown): Child[] {
	if (Array.isArray(value)) return elements(schema, value);
	if (isObject(value)) return entries(schema, value);
	return [];
}

function elements(schema: SchemaObject, value: unknown[]): Child[] {
	const prefix = (schema.prefixItems ?? []) as JsonSchema[];
	const rest = schema.items as JsonSchema | undefined;
	return value.flatMap((item, i): Child[] => {
		const sub = i < prefix.length ? prefix[i] : rest;
		return sub === undefined ? [] : [[String(i), sub, item]];
	});
}

function entries(schema: SchemaObject, value: SchemaObject): Child[] {
	const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
	const patterns = Object.keys(schema.patternProperties ?? {}).map(
		(p) => new RegExp(p, "u"),
	);
	const additional = schema.additionalProperties as JsonSchema | undefined;
	return Object.entries(value).flatMap(([key, child]): Child[] => {
		if (Object.hasOwn(properties, key))
			return [[key, properties[key] as JsonSchema, child]];
		if (additional === undefined || patterns.some((p) => p.test(key)))
			return [];
		return [[key, additional, child]];
	});
}

/** The keywords whose subschemas `findMarked` descends. */
const WALKED = new Set([
	"properties",
	"additionalProperties",
	"items",
	"prefixItems",
]);

/** Every other 2020-12 keyword that holds subschemas, except `$defs`, which is reached through `$ref` only. */
const UNWALKED = [
	"allOf",
	"anyOf",
	"oneOf",
	"not",
	"if",
	"then",
	"else",
	"contains",
	"propertyNames",
	"patternProperties",
	"dependentSchemas",
	"unevaluatedItems",
	"unevaluatedProperties",
];

const MAPS = new Set(["properties", "patternProperties", "dependentSchemas"]);

/**
 * `schema` with each subschema an artifact type marks replaced by `artifactRefSchema`, the shape of the artifact's
 * runtime value (ADR 0007). Descends every keyword that holds subschemas, `$defs` included.
 */
export function artifactsAsRefs(schema: JsonSchema): JsonSchema {
	if (typeof schema === "boolean") return schema;
	const type = schema[MAESTRO_TYPE];
	if (typeof type === "string" && ARTIFACT_TYPES.has(type))
		return artifactRefSchema;
	const replaced: SchemaObject = { ...schema };
	for (const keyword of [...WALKED, ...UNWALKED, "$defs"])
		if (Object.hasOwn(schema, keyword))
			replaced[keyword] = refsIn(keyword, schema[keyword]);
	return replaced;
}

function refsIn(keyword: string, value: unknown): unknown {
	if (Array.isArray(value)) return value.map(artifactsAsRefs);
	if (!isObject(value)) return value;
	if (!MAPS.has(keyword) && keyword !== "$defs") return artifactsAsRefs(value);
	return Object.fromEntries(
		Object.entries(value).map(([key, sub]) => [
			key,
			artifactsAsRefs(sub as JsonSchema),
		]),
	);
}

/** An `x-maestro-type` in a schema: the type it names, and the JSON Pointer of the subschema it marks. */
export type SchemaMarker = {
	type: string;
	pointer: string;
	reachable: boolean;
};

/**
 * Every `x-maestro-type` in `schema`, each once. `reachable` is false when `findMarked` cannot reach it on some path:
 * under a keyword it does not descend, behind a `$ref` it does not follow (an anchor into `$defs`), or inside a marked
 * subschema. A `$defs` entry counts only when a `$ref` reaches it. Remote and unresolvable refs show nothing.
 */
export function schemaMarkers(schema: JsonSchema): SchemaMarker[] {
	const found = new Map<string, SchemaMarker>();
	scan(schema, schema, "", true, new Set(), found);
	return [...found.values()];
}

/** The JSON Pointer of every marker in `schema` that `findMarked` cannot reach, as `schemaMarkers` finds them. */
export const unreachableMarkers = (schema: JsonSchema): string[] =>
	schemaMarkers(schema)
		.filter((m) => !m.reachable)
		.map((m) => m.pointer);

function scan(
	root: JsonSchema,
	schema: JsonSchema,
	pointer: string,
	reachable: boolean,
	seen: Set<string>,
	found: Map<string, SchemaMarker>,
): void {
	const visit = `${reachable}${pointer}`;
	if (typeof schema === "boolean" || seen.has(visit)) return;
	seen.add(visit);
	const type = schema[MAESTRO_TYPE];
	const marked = typeof type === "string";
	if (marked) {
		const before = found.get(pointer)?.reachable ?? true;
		found.set(pointer, { type, pointer, reachable: reachable && before });
	}
	const inner = reachable && !marked;
	for (const [target, walked] of nextSchemas(root, schema, pointer))
		scan(root, target.schema, target.pointer, inner && walked, seen, found);
}

/** Every subschema `schema` leads to, and whether `findMarked` descends to it. */
function nextSchemas(
	root: JsonSchema,
	schema: SchemaObject,
	pointer: string,
): [Target, walked: boolean][] {
	const keywords = [...WALKED, ...UNWALKED].flatMap((keyword) =>
		subschemas(schema, keyword).map(([at, sub]): [Target, boolean] => [
			{ pointer: pointer + at, schema: sub },
			WALKED.has(keyword),
		]),
	);
	return [...refTargets(root, schema), ...keywords];
}

function subschemas(
	schema: SchemaObject,
	keyword: string,
): [pointer: string, schema: JsonSchema][] {
	const value = schema[keyword];
	const at = `/${keyword}`;
	if (Array.isArray(value)) return value.map((sub, i) => [`${at}/${i}`, sub]);
	if (MAPS.has(keyword) && isObject(value))
		return Object.entries(value).map(([key, sub]) => [
			`${at}/${escapeSegment(key)}`,
			sub as JsonSchema,
		]);
	return value === undefined ? [] : [[at, value as JsonSchema]];
}

type Target = { pointer: string; schema: JsonSchema };

/** Where `schema.$ref` leads, and whether `findMarked` follows it there. */
function refTargets(
	root: JsonSchema,
	schema: SchemaObject,
): [Target, followed: boolean][] {
	const followed = followRef(root, schema);
	if (followed) return [[followed, true]];
	const anchored = anchorRef(root, schema);
	return anchored ? [[anchored, false]] : [];
}

/** The target of `schema.$ref` when it is `#` or `#/<pointer>` and resolves to a schema. */
function followRef(root: JsonSchema, schema: SchemaObject): Target | undefined {
	const ref = schema.$ref;
	if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/")))
		return undefined;
	const segments = decodeSegments(ref.slice(1));
	const target = segments?.reduce<unknown>(step, root);
	if (!isObject(target) && typeof target !== "boolean") return undefined;
	const pointer = (segments ?? []).map((s) => `/${escapeSegment(s)}`).join("");
	return { pointer, schema: target };
}

/** The `$defs` entry whose `$anchor` `schema.$ref` (`#<anchor>`) names. */
function anchorRef(root: JsonSchema, schema: SchemaObject): Target | undefined {
	const ref = schema.$ref;
	const defs = isObject(root) && isObject(root.$defs) ? root.$defs : {};
	if (typeof ref !== "string" || !/^#[^/]/.test(ref)) return undefined;
	const entry = Object.entries(defs).find(
		([, def]) => isObject(def) && def.$anchor === ref.slice(1),
	);
	return (
		entry && {
			pointer: `/$defs/${escapeSegment(entry[0])}`,
			schema: entry[1] as JsonSchema,
		}
	);
}

/** The unescaped segments of a URI-encoded JSON Pointer, or undefined when it does not decode. */
function decodeSegments(fragment: string): string[] | undefined {
	try {
		return decodeURIComponent(fragment)
			.split("/")
			.slice(1)
			.map(unescapeSegment);
	} catch {
		return undefined;
	}
}

function step(at: unknown, key: string): unknown {
	if (typeof at !== "object" || at === null || !Object.hasOwn(at, key))
		return undefined;
	return (at as SchemaObject)[key];
}

const isObject = (v: unknown): v is SchemaObject =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const escapeSegment = (s: string) =>
	s.replaceAll("~", "~0").replaceAll("/", "~1");

const unescapeSegment = (s: string) =>
	s.replaceAll("~1", "/").replaceAll("~0", "~");

function child(at: unknown, key: string): unknown {
	if (Array.isArray(at)) return at[Number(key)];
	if (typeof at === "object" && at !== null)
		return (at as Record<string, unknown>)[key];
}

/**
 * `root` with the value at the JSON Pointer `pointer` replaced, in place below the top.
 * @throws Error when nothing holds that value.
 */
export function replaceAt(
	root: unknown,
	pointer: string,
	value: unknown,
): unknown {
	if (pointer === "") return value;
	const keys = pointer.slice(1).split("/").map(unescapeSegment);
	const last = keys.pop() ?? "";
	let at = root;
	for (const key of keys) at = child(at, key);
	if (Array.isArray(at)) at[Number(last)] = value;
	else if (typeof at === "object" && at !== null)
		(at as Record<string, unknown>)[last] = value;
	else throw new Error(`no value at '${pointer}'`);
	return root;
}
