import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import type { Diagnostic, JsonSchema, SourceLocation } from "@maestro/ir";
import { type Validator, validator, violations } from "@maestro/ir";
import {
	type Document,
	isAlias,
	isMap,
	isScalar,
	isSeq,
	LineCounter,
	parseDocument,
	type YAMLMap,
	type YAMLSeq,
} from "yaml";
import type { Bounds } from "../host";
import { isRecord } from "../shared";

/** The layers, lowest first. `example` is the example input set `compose` falls back to. */
export type LayerName =
	| "default"
	| "user"
	| "workspace"
	| "profile"
	| "example"
	| "flag";

/** Where a config value came from: its layer, and the file and line when a file set it. */
export type Source = { layer: LayerName; file?: string; line?: number };

/** Config keys from the top level down. */
export type KeyPath = readonly string[];

/** Layered config: its plain values, and the source of each value by key path. */
export type Composed = {
	values: Readonly<Record<string, unknown>>;
	sources: readonly { path: KeyPath; source: Source }[];
};

type Item = { value: unknown; source: Source };
interface MapOf<T> {
	kind: "map";
	source: Source;
	entries: ReadonlyMap<string, T>;
	replace: boolean;
}
type List = { kind: "list"; source: Source; items: Item[]; append: boolean };
type Scalar = { kind: "scalar"; source: Source; value: unknown };
type Deletion = { kind: "delete"; source: Source };
type Tagged = MapOf<Tagged> | List | Scalar | Deletion;
type Merged = MapOf<Merged> | List | Scalar;

/** One config file or set of values, with its merge tags, ready to layer. */
export type Layer = MapOf<Tagged>;

/** A config file, or layering, that cannot be used. */
export class ConfigError extends Error {
	override readonly name = "ConfigError";
	readonly diagnostics: readonly Diagnostic[];

	constructor(diagnostics: readonly Diagnostic[]) {
		super(diagnostics.map((d) => `${d.message}\n${d.hint}`).join("\n"));
		this.diagnostics = diagnostics;
	}
}

const REPLACE = "!replace";
const APPEND = "!append";
const DELETE = "!delete";
const YAML_TAG = "tag:yaml.org,2002:";

const locationOf = ({ file, line }: Source): SourceLocation | undefined =>
	file !== undefined && line !== undefined ? { file, line } : undefined;

const at = ({ file, line }: Source) => (file ? `${file}:${line}: ` : "");

const spell = (path: KeyPath) => path.join(".");

/** An error diagnostic, located at `source` when a file set it. */
export function configDiagnostic(
	code: string,
	source: Source | undefined,
	message: string,
	hint: string,
): Diagnostic {
	const location = source && locationOf(source);
	return {
		code,
		severity: "error",
		message,
		hint,
		...(location && { source: location }),
	};
}

const tagError = (source: Source, message: string, hint: string) =>
	new ConfigError([
		configDiagnostic("CFG.tag", source, at(source) + message, hint),
	]);

type Reading = { doc: Document; sourceAt: (offset: number) => Source };

/** A YAML node, its alias resolved. */
type YamlNode = ReturnType<YAMLMap["get"]>;

const resolved = (node: unknown, { doc }: Reading): unknown =>
	isAlias(node) ? node.resolve(doc) : node;

const tagOf = (node: unknown): string | undefined =>
	(node as { tag?: string } | null)?.tag;

const offsetOf = (node: unknown): number | undefined =>
	(node as { range?: [number] } | null)?.range?.[0];

const spellTag = (tag: string) =>
	tag.startsWith(YAML_TAG) ? `!!${tag.slice(YAML_TAG.length)}` : tag;

function shapeOf(node: unknown): string {
	if (isMap(node)) return "mapping";
	return isSeq(node) ? "list" : "scalar";
}

/** A plain value: tags are refused inside list items and wherever the merge tags do not apply. */
function plain(node: unknown, reading: Reading, source: Source): unknown {
	const n = resolved(node, reading);
	const tag = tagOf(n);
	if (tag !== undefined)
		throw tagError(
			source,
			`the tag ${spellTag(tag)} is not allowed inside a list item`,
			`Drop ${spellTag(tag)}; merge tags apply to a key's value only`,
		);
	if (isMap(n))
		return Object.fromEntries(
			n.items.map((p) => [
				keyOf(p.key, source),
				plain(p.value, reading, source),
			]),
		);
	if (isSeq(n)) return n.items.map((i) => plain(i, reading, source));
	return isScalar(n) ? n.value : null;
}

const MERGE_KEY = "<<";

/** A mapping key as text. @throws ConfigError on the YAML merge key `<<`, which the merge tags stand in for. */
function keyOf(key: unknown, source: Source): string {
	const text = String(isScalar(key) ? key.value : key);
	if (text !== MERGE_KEY) return text;
	throw new ConfigError([
		configDiagnostic(
			"CFG.yaml",
			source,
			`${at(source)}the merge key '${MERGE_KEY}' is not supported`,
			`Write the keys out, or merge across files with ${REPLACE}, ${APPEND} or ${DELETE}`,
		),
	]);
}

function mapOf(
	node: YAMLMap,
	reading: Reading,
	source: Source,
	replace: boolean,
): MapOf<Tagged> {
	const entries = new Map<string, Tagged>();
	for (const pair of node.items) {
		const offset = offsetOf(pair.key);
		const own = offset === undefined ? source : reading.sourceAt(offset);
		entries.set(keyOf(pair.key, own), treeOf(pair.value, reading, own));
	}
	return { kind: "map", source, entries, replace };
}

function listOf(
	node: YAMLSeq,
	reading: Reading,
	source: Source,
	append: boolean,
): List {
	const items = node.items.map((item) => {
		const offset = offsetOf(item);
		const own = offset === undefined ? source : reading.sourceAt(offset);
		return { value: plain(item, reading, own), source: own };
	});
	return { kind: "list", source, items, append };
}

function treeOf(node: unknown, reading: Reading, source: Source): Tagged {
	const n = resolved(node, reading) as YamlNode;
	const tag = tagOf(n);
	if (tag !== undefined) return taggedOf(n, tag, reading, source);
	if (isMap(n)) return mapOf(n, reading, source, false);
	if (isSeq(n)) return listOf(n, reading, source, false);
	return { kind: "scalar", source, value: isScalar(n) ? n.value : null };
}

/** Why each merge tag does not apply to a node of the wrong shape, and the fix. */
const MISPLACED: Readonly<Record<string, [string, string]>> = {
	[REPLACE]: [
		"tags a %s, and only a mapping merges",
		"Drop the tag: anything else replaces",
	],
	[APPEND]: ["tags a %s, and only a list appends", "Drop the tag"],
	[DELETE]: ["takes no value", "Drop what follows it"],
};

function taggedOf(
	node: YamlNode,
	tag: string,
	reading: Reading,
	source: Source,
): Tagged {
	if (tag === REPLACE && isMap(node)) return mapOf(node, reading, source, true);
	if (tag === APPEND && isSeq(node)) return listOf(node, reading, source, true);
	const empty = isScalar(node) && node.range?.[0] === node.range?.[1];
	if (tag === DELETE && empty) return { kind: "delete", source };
	const [why, hint] = MISPLACED[tag] ?? [];
	if (why && hint)
		throw tagError(source, `${tag} ${why.replace("%s", shapeOf(node))}`, hint);
	throw tagError(
		source,
		`unknown tag ${spellTag(tag)}`,
		`Use ${REPLACE}, ${APPEND} or ${DELETE}, or drop the tag`,
	);
}

/** Makes each relative path among the values of `keys` relative to `dir` instead. An empty string stays empty. */
function anchored(layer: Layer, keys: readonly string[], dir: string): Layer {
	const anchor = (value: unknown) =>
		typeof value === "string" && value !== "" ? resolve(dir, value) : value;
	const entries = new Map(layer.entries);
	for (const key of keys) {
		const tree = entries.get(key);
		if (tree?.kind === "scalar")
			entries.set(key, { ...tree, value: anchor(tree.value) });
		if (tree?.kind === "list")
			entries.set(key, {
				...tree,
				items: tree.items.map((i) => ({ ...i, value: anchor(i.value) })),
			});
	}
	return { ...layer, entries };
}

export type LayerFile = {
	/** The file's path, as diagnostics name it. Relative paths in it are relative to its directory. */
	file: string;
	layer: LayerName;
	/** The top-level keys whose values are file paths: a string, or a list of strings. */
	paths?: readonly string[];
};

/**
 * Parses one YAML config file into a layer. Its merge tags:
 * - `!replace` on a mapping: it replaces what is beneath instead of merging into it;
 * - `!append` on a list: it follows the list beneath;
 * - `!delete` with no value: it removes the key a lower layer set.
 * @throws ConfigError on invalid YAML, a file that is not a mapping, any other tag, or a tag on the wrong shape.
 */
export function parseLayer(
	text: string,
	{ file, layer, paths = [] }: LayerFile,
): Layer {
	const lines = new LineCounter();
	const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
	const sourceAt = (offset: number): Source => ({
		layer,
		file,
		line: lines.linePos(offset).line,
	});
	const [error] = doc.errors;
	if (error) {
		const source = sourceAt(error.pos[0]);
		throw new ConfigError([
			configDiagnostic(
				"CFG.yaml",
				source,
				`${at(source)}${error.message}`,
				"Fix the YAML at that line",
			),
		]);
	}
	const root = doc.contents;
	const source = sourceAt(0);
	if (root === null)
		return { kind: "map", source, entries: new Map(), replace: false };
	if (!isMap(root) || root.tag !== undefined)
		throw new ConfigError([
			configDiagnostic(
				"CFG.yaml",
				source,
				`${file} holds a ${tagOf(root) ?? shapeOf(root)}, not a mapping of config keys`,
				"Write the file as untagged 'key: value' lines",
			),
		]);
	const parsed = mapOf(root, { doc, sourceAt }, source, false);
	return anchored(parsed, paths, dirname(file));
}

function treeOfValue(value: unknown, source: Source): Tagged {
	if (Array.isArray(value))
		return {
			kind: "list",
			source,
			items: value.map((v) => ({ value: v, source })),
			append: false,
		};
	if (!isRecord(value)) return { kind: "scalar", source, value };
	return {
		kind: "map",
		source,
		entries: new Map(
			Object.entries(value).map(([k, v]) => [k, treeOfValue(v, source)]),
		),
		replace: false,
	};
}

/** Plain values as one layer, every value credited to `source`. */
export const valuesLayer = (
	values: Readonly<Record<string, unknown>>,
	source: Source,
): Layer => treeOfValue(values, source) as Layer;

function merged(
	beneath: Merged | undefined,
	top: Exclude<Tagged, Deletion>,
	path: KeyPath,
): Merged {
	if (top.kind === "scalar") return top;
	if (top.kind === "map") {
		const base =
			beneath?.kind === "map" && !top.replace ? beneath.entries : new Map();
		return {
			...top,
			entries: mergedEntries(base, top.entries, path),
			replace: false,
		};
	}
	if (!top.append || beneath === undefined) return { ...top, append: false };
	if (beneath.kind !== "list")
		throw tagError(
			top.source,
			`${APPEND} on '${spell(path)}', which is a ${beneath.kind === "map" ? "mapping" : "scalar"} beneath it, and only a list takes it`,
			"Drop the tag to replace it",
		);
	return { ...top, items: [...beneath.items, ...top.items], append: false };
}

function mergedEntries(
	beneath: ReadonlyMap<string, Merged>,
	top: ReadonlyMap<string, Tagged>,
	path: KeyPath,
): Map<string, Merged> {
	const entries = new Map(beneath);
	for (const [key, tree] of top) {
		const at = [...path, key];
		if (tree.kind !== "delete")
			entries.set(key, merged(entries.get(key), tree, at));
		else if (!entries.delete(key))
			throw tagError(
				tree.source,
				`${DELETE} on '${spell(at)}', which nothing beneath sets`,
				"Drop the key",
			);
	}
	return entries;
}

function plainOf(tree: Merged): unknown {
	if (tree.kind === "scalar") return tree.value;
	if (tree.kind === "list") return tree.items.map((i) => i.value);
	return Object.fromEntries(
		[...tree.entries].map(([key, sub]) => [key, plainOf(sub)]),
	);
}

function sourcesOf(tree: Merged, path: KeyPath): Composed["sources"] {
	if (tree.kind === "scalar") return [{ path, source: tree.source }];
	if (tree.kind === "list")
		return [
			{ path, source: tree.source },
			...tree.items.map((i, n) => ({
				path: [...path, String(n)],
				source: i.source,
			})),
		];
	if (tree.entries.size === 0) return [{ path, source: tree.source }];
	return [...tree.entries].flatMap(([key, sub]) =>
		sourcesOf(sub, [...path, key]),
	);
}

/**
 * Merges `layers`, lowest first: mappings by key, any other value replaced whole, as the merge tags say.
 * @throws ConfigError on a `!delete` of a key nothing beneath sets, or an `!append` over a value that is not a list.
 */
export function layered(layers: readonly Layer[]): Composed {
	let entries: ReadonlyMap<string, Merged> = new Map();
	for (const layer of layers)
		entries = mergedEntries(entries, layer.entries, []);
	const root: Merged = {
		kind: "map",
		source: { layer: "default" },
		entries,
		replace: false,
	};
	return {
		values: plainOf(root) as Record<string, unknown>,
		sources: entries.size ? sourcesOf(root, []) : [],
	};
}

const within = (outer: KeyPath, inner: KeyPath) =>
	outer.length <= inner.length && outer.every((key, i) => inner[i] === key);

/** The source of the value at `path`, or else of the nearest value above it, or else of the first value under it. */
export function sourceOf(
	{ sources }: Composed,
	path: KeyPath,
): Source | undefined {
	const above = sources
		.filter((s) => within(s.path, path))
		.toSorted((a, b) => b.path.length - a.path.length);
	return (above[0] ?? sources.find((s) => within(path, s.path)))?.source;
}

/** Where a value under check sits in the config, and how its diagnostics name it and the fix. */
export type Placed = {
	config: Composed;
	path: KeyPath;
	hint: string;
	/** Names the offending key path. Defaults to `config '<a.b.c>'`. */
	subject?: (path: KeyPath) => string;
};

/** A `CFG.schema` error for each way `value` is off `schema`, located where the config set the offending key. */
export function offSchema(
	ajv: Validator,
	schema: JsonSchema,
	value: unknown,
	{ config, path, hint, subject = (p) => `config '${spell(p)}'` }: Placed,
): Diagnostic[] {
	const paths: KeyPath[] = [];
	const named = (segments: string[]) => {
		paths.push([...path, ...segments]);
		return subject([...path, ...segments]);
	};
	return violations(ajv, schema, value, named).map((message, i) =>
		configDiagnostic(
			"CFG.schema",
			sourceOf(config, paths[i] ?? path),
			message,
			hint,
		),
	);
}

/** A `CFG.schema` error for each way a namespace of `config` is off its schema in `schemas`, an absent one read as `{}`. */
export function schemaErrors(
	ajv: Validator,
	schemas: Readonly<Record<string, JsonSchema>>,
	config: Composed,
): Diagnostic[] {
	return Object.entries(schemas).flatMap(([ns, schema]) =>
		offSchema(
			ajv,
			schema,
			Object.hasOwn(config.values, ns) ? config.values[ns] : {},
			{
				config,
				path: [ns],
				hint: `Change '${ns}' in the config to match the schema of its owner`,
			},
		),
	);
}

/** The `concurrency` of the default layer: one node instance per CPU. */
const DEFAULT_CONCURRENCY = availableParallelism();

/** Core's own config keys and their schemas (CFG-01). */
export const CORE_CONFIG: Readonly<Record<string, JsonSchema>> = {
	concurrency: { type: "integer", minimum: 1 },
	caps: {
		type: "object",
		additionalProperties: { type: "integer", minimum: 0 },
	},
	dataRoot: { type: "string", minLength: 1 },
	workspace: { type: "string" },
};

/** The core config keys whose values are file paths. */
export const CORE_PATHS = ["dataRoot"] as const;

export type CoreConfig = {
	/** The most node instances in flight at once. */
	concurrency: number;
	/** Caps by name, as compose takes them (D-23). */
	caps: Bounds;
	/** The directory holding the record store, concert areas and node scratch. */
	dataRoot: string;
	/** The workspace's name, empty outside any workspace. */
	workspace: string;
};

/** The default layer of core config. */
export const coreDefaults = (dataRoot: string, workspace: string): Layer =>
	valuesLayer(
		{ concurrency: DEFAULT_CONCURRENCY, caps: {}, dataRoot, workspace },
		{ layer: "default" },
	);

/**
 * The core config `config` holds.
 * @throws ConfigError when a core key is off its schema, or a `!delete` left one unset.
 */
export function coreConfig(config: Composed): CoreConfig {
	const unset = Object.keys(CORE_CONFIG)
		.filter((key) => !Object.hasOwn(config.values, key))
		.map((key) =>
			configDiagnostic(
				"CFG.required",
				undefined,
				`config key '${key}' is unset`,
				`Set '${key}' in a config file, or drop the ${DELETE} that removes it`,
			),
		);
	const set = Object.fromEntries(
		Object.entries(CORE_CONFIG).filter(([key]) =>
			Object.hasOwn(config.values, key),
		),
	);
	const errors = [...unset, ...schemaErrors(validator(), set, config)];
	if (errors.length) throw new ConfigError(errors);
	const { concurrency, caps, dataRoot, workspace } = config.values;
	return { concurrency, caps, dataRoot, workspace } as CoreConfig;
}
