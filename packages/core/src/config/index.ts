import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import type { Diagnostic, JsonSchema, SourceLocation } from "@maestro/ir";
import {
	durationMs,
	timeoutProblem,
	type Validator,
	validator,
	violations,
} from "@maestro/ir";
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

/**
 * The layers, lowest first. `example` marks a value taken from the composition's example set, which `compose` uses for
 * a param no file or flag gives. `directory` marks a base that `layeredOver` puts beneath a subtree of the config.
 */
export type LayerName =
	| "default"
	| "example"
	| "directory"
	| "user"
	| "workspace"
	| "preset"
	| "flag";

/** Where a config value came from: its layer, and the file and line when a file set it, or the flag as typed. */
export type Source = {
	layer: LayerName;
	file?: string;
	line?: number;
	flag?: string;
	/** The key the flag sets, as typed. */
	key?: string;
	/** The short id of the concert a resume reapplies the flag from. */
	concert?: string;
	/** The fix a diagnostic on a value it set gives, in place of its own. */
	fix?: string;
};

/** Config keys from the top level down. */
export type KeyPath = readonly string[];

/** Layered config: its plain values, and the source of each value by key path. */
export type Composed = {
	values: Readonly<Record<string, unknown>>;
	sources: readonly { path: KeyPath; source: Source; under?: Under }[];
	/** The mappings a `--preset` or `-c` layer replaced whole with `!replace`, which no layer above merged back into. */
	replaced?: readonly KeyPath[];
	/** The layers merged, lowest first. */
	layers: readonly Layer[];
};

type Item = { value: unknown; source: Source };
interface MapOf<T> {
	kind: "map";
	source: Source;
	entries: ReadonlyMap<string, T>;
	replace: boolean;
}
type List = { kind: "list"; source: Source; items: Item[]; append: boolean };
/** The value a flag displaced, and the layer beneath the flags that gave it. */
export type Under = { value: unknown; source: Source };
type Scalar = { kind: "scalar"; source: Source; value: unknown; under?: Under };
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

const spell = (path: KeyPath) => path.join(".");

/** The key path segment that matches any one key. */
const ANY = "*";

/** Whether `path` is at or below one of `patterns`, `*` in a pattern matching any one key. */
const deferredAt = (patterns: readonly KeyPath[], path: KeyPath) =>
	patterns.some(
		(p) =>
			p.length <= path.length && p.every((k, i) => k === ANY || k === path[i]),
	);

const origin = ({ key, concert }: Source) =>
	`(from -c ${key}${concert === undefined ? "" : ` of concert ${concert}`})`;

/**
 * An error diagnostic, located at `source` when a file set it, its message ending `(from -c <key>)` when a flag did, or
 * `(from -c <key> of concert <id>)` when a resumed concert was performed with it, and its hint the source's fix when it has
 * one.
 */
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
		message:
			source?.flag === undefined ? message : `${message} ${origin(source)}`,
		hint: source?.fix ?? hint,
		...(location && { source: location }),
	};
}

const tagError = (source: Source, message: string, hint: string) =>
	new ConfigError([configDiagnostic("CFG.tag", source, message, hint)]);

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
			`the merge key '${MERGE_KEY}' is not supported`,
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

/** `tree` with each value at `path` below it, `*` matching any one key, passed through `anchor`. */
function anchoredTree(
	tree: Tagged,
	[head, ...rest]: KeyPath,
	anchor: (value: unknown) => unknown,
): Tagged {
	if (head === undefined) {
		if (tree.kind === "scalar") return { ...tree, value: anchor(tree.value) };
		if (tree.kind === "list")
			return {
				...tree,
				items: tree.items.map((i) => ({ ...i, value: anchor(i.value) })),
			};
		return tree;
	}
	if (tree.kind !== "map") return tree;
	const entries = new Map(tree.entries);
	for (const [key, child] of tree.entries)
		if (head === ANY || key === head)
			entries.set(key, anchoredTree(child, rest, anchor));
	return { ...tree, entries };
}

/** Makes each relative path among the values at `paths` relative to `dir` instead. An empty string stays empty. */
function anchored(layer: Layer, paths: readonly KeyPath[], dir: string): Layer {
	const anchor = (value: unknown) =>
		typeof value === "string" && value !== "" ? resolve(dir, value) : value;
	return paths.reduce(
		(l, path) => anchoredTree(l, path, anchor) as Layer,
		layer,
	);
}

/** Where a layer's text came from, and how its values are read. */
export type LayerText = {
	layer: LayerName;
	/** The key paths whose values are file paths: a string, or a list of strings. `*` matches any one key. */
	paths?: readonly KeyPath[];
} & (
	| {
			/** The file's path, as diagnostics name it. */
			file: string;
			/** The directory the file's relative paths resolve against. The file's own directory when absent. */
			base?: string;
	  }
	| {
			/** The flag the text was given in, as diagnostics name it. Its values have no line. */
			flag: string;
			/** The key the flag sets, as typed. */
			key: string;
			/** The short id of the concert a resume reapplies the flag from. */
			concert?: string;
			/** The fix a diagnostic on one of its values gives, in place of its own. */
			fix?: string;
			/** The directory the flag's relative paths resolve against. */
			base: string;
	  }
);

/** The source `text` credits its values to, but for their line, and the directory its relative paths resolve in. */
const originOf = (text: LayerText): { source: Source; base: string } =>
	"file" in text
		? {
				source: { layer: text.layer, file: text.file },
				base: text.base ?? dirname(text.file),
			}
		: {
				source: {
					layer: text.layer,
					flag: text.flag,
					key: text.key,
					concert: text.concert,
					fix: text.fix,
				},
				base: text.base,
			};

/**
 * Parses one YAML config file, or the YAML a flag gives, into a layer. Its merge tags:
 * - `!replace` on a mapping: it replaces what is beneath instead of merging into it;
 * - `!append` on a list: it follows the list beneath;
 * - `!delete` with no value: it removes the key a lower layer set.
 * @throws ConfigError on invalid YAML, a file that is not a mapping, any other tag, or a tag on the wrong shape.
 */
export function parseLayer(text: string, from: LayerText): Layer {
	const { source: origin, base } = originOf(from);
	const lines = new LineCounter();
	const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
	const sourceAt = (offset: number): Source =>
		origin.file === undefined
			? origin
			: { ...origin, line: lines.linePos(offset).line };
	const [error] = doc.errors;
	if (error) {
		const source = sourceAt(error.pos[0]);
		throw new ConfigError([
			configDiagnostic(
				"CFG.yaml",
				source,
				error.message,
				origin.file === undefined
					? "Fix the value's YAML"
					: "Fix the YAML at that line",
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
				`the file holds a ${tagOf(root) ?? shapeOf(root)}, not a mapping of config keys`,
				"Write the file as untagged 'key: value' lines",
			),
		]);
	const parsed = mapOf(root, { doc, sourceAt }, source, false);
	return anchored(parsed, from.paths ?? [], base);
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

const COMMAND_LINE: readonly LayerName[] = ["preset", "flag"];

function mergedMap(
	beneath: Merged | undefined,
	top: MapOf<Tagged>,
	path: KeyPath,
	deferred: readonly KeyPath[],
): Merged {
	const below = beneath?.kind === "map" ? beneath : undefined;
	const replaced = top.replace || below?.replace === true;
	return {
		...top,
		entries: mergedEntries(
			below && !top.replace ? below.entries : new Map(),
			top.entries,
			path,
			deferred,
		),
		replace: replaced && COMMAND_LINE.includes(top.source.layer),
	};
}

/** A scalar a flag set, with the value the layers beneath the flags gave it, when they did. */
function flagged(beneath: Merged | undefined, top: Scalar): Scalar {
	if (top.source.layer !== "flag" || beneath?.kind !== "scalar") return top;
	const under =
		beneath.source.layer === "flag"
			? beneath.under
			: { value: beneath.value, source: beneath.source };
	return under ? { ...top, under } : top;
}

function merged(
	beneath: Merged | undefined,
	top: Exclude<Tagged, Deletion>,
	path: KeyPath,
	deferred: readonly KeyPath[],
): Merged {
	if (top.kind === "scalar") return flagged(beneath, top);
	if (top.kind === "map") return mergedMap(beneath, top, path, deferred);
	if (!top.append || beneath === undefined) return { ...top, append: false };
	if (beneath.kind !== "list")
		throw tagError(
			top.source,
			`${APPEND} on '${spell(path)}', which is a ${beneath.kind === "map" ? "mapping" : "scalar"} beneath it, and only a list takes it`,
			"Drop the tag to replace it",
		);
	return { ...top, items: [...beneath.items, ...top.items], append: false };
}

/** `beneath` with `top` merged in; a `!delete` at or below a `deferred` path that finds nothing beneath is dropped. */
function mergedEntries(
	beneath: ReadonlyMap<string, Merged>,
	top: ReadonlyMap<string, Tagged>,
	path: KeyPath,
	deferred: readonly KeyPath[],
): Map<string, Merged> {
	const entries = new Map(beneath);
	for (const [key, tree] of top) {
		const at = [...path, key];
		if (tree.kind !== "delete")
			entries.set(key, merged(entries.get(key), tree, at, deferred));
		else if (!entries.delete(key) && !deferredAt(deferred, at))
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
	if (tree.kind === "scalar")
		return [
			{
				path,
				source: tree.source,
				...(tree.under && { under: tree.under }),
			},
		];
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

function replacedOf(tree: Merged, path: KeyPath): KeyPath[] {
	if (tree.kind !== "map") return [];
	return [
		...(tree.replace ? [path] : []),
		...[...tree.entries].flatMap(([key, sub]) =>
			replacedOf(sub, [...path, key]),
		),
	];
}

/**
 * Merges `layers`, lowest first: mappings by key, any other value replaced whole, as the merge tags say. At or below a
 * `deferred` key path, whose base `layeredOver` gives later, a `!delete` that finds nothing beneath is left pending.
 * `*` in a deferred path matches any one key.
 * @throws ConfigError on a `!delete` of a key nothing beneath sets, or an `!append` over a value that is not a list.
 */
export function layered(
	layers: readonly Layer[],
	deferred: readonly KeyPath[] = [],
): Composed {
	let entries: ReadonlyMap<string, Merged> = new Map();
	for (const layer of layers)
		entries = mergedEntries(entries, layer.entries, [], deferred);
	const root: Merged = {
		kind: "map",
		source: { layer: "default" },
		entries,
		replace: false,
	};
	return {
		values: plainOf(root) as Record<string, unknown>,
		sources: entries.size ? sourcesOf(root, []) : [],
		replaced: replacedOf(root, []),
		layers,
	};
}

/** `layer` cut down to the chain of mappings that leads to `path`, and what lies there. */
function chainTo(layer: Layer, [head, ...rest]: KeyPath): Layer {
	if (head === undefined) return layer;
	const child = layer.entries.get(head);
	const kept = child?.kind === "map" ? chainTo(child, rest) : child;
	return { ...layer, entries: new Map(kept ? [[head, kept]] : []) };
}

/** `base` set at `path` in a layer of its own. */
const nestedAt = (base: Layer, path: KeyPath): Layer =>
	path.reduceRight<Layer>(
		(inner, key) => ({
			kind: "map",
			source: base.source,
			entries: new Map([[key, inner]]),
			replace: false,
		}),
		base,
	);

/**
 * The subtree at `path` of the config `layers` merge to, layered again with `base` as its lowest layer, every merge tag applying to it
 * as to any layer beneath. Its values, sources and replaced mappings are relative to `path`.
 * @throws ConfigError as `layered` does, with nothing deferred.
 */
export function layeredOver(
	{ layers: above }: Pick<Composed, "layers">,
	path: KeyPath,
	base: Layer,
): Omit<Composed, "layers"> {
	const layers = [nestedAt(base, path), ...above.map((l) => chainTo(l, path))];
	const whole = layered(layers);
	const value = valueAt(whole.values, path);
	const inside = <T extends { path: KeyPath }>(s: T) =>
		within(path, s.path) ? [{ ...s, path: s.path.slice(path.length) }] : [];
	return {
		values: isRecord(value) ? value : {},
		sources: whole.sources.flatMap(inside),
		replaced: (whole.replaced ?? [])
			.filter((p) => within(path, p))
			.map((p) => p.slice(path.length)),
	};
}

const valueAt = (root: unknown, path: KeyPath) =>
	path.reduce<unknown>((at, key) => (isRecord(at) ? at[key] : undefined), root);

function setAt(root: Record<string, unknown>, path: KeyPath, value: unknown) {
	let at = root;
	for (const key of path.slice(0, -1)) {
		if (!isRecord(at[key])) at[key] = {};
		at = at[key] as Record<string, unknown>;
	}
	at[path[path.length - 1] as string] = value;
}

/** The part of a config the `--preset` and `-c` layers set. */
export type CommandLine = {
	/** Their values at their key paths; a list comes whole, never by item. */
	values: Record<string, unknown>;
	/** The mappings they replaced whole with `!replace`. */
	replaced: readonly KeyPath[];
};

/** The part of `config` that the `--preset` and `-c` layers set, and nothing a file or default set. */
export function commandLineOf(config: Composed): CommandLine {
	const values: Record<string, unknown> = {};
	for (const { path, source } of config.sources) {
		const item = Array.isArray(valueAt(config.values, path.slice(0, -1)));
		if (COMMAND_LINE.includes(source.layer) && path.length && !item)
			setAt(values, path, valueAt(config.values, path));
	}
	return { values, replaced: config.replaced ?? [] };
}

const within = (outer: KeyPath, inner: KeyPath) =>
	outer.length <= inner.length && outer.every((key, i) => inner[i] === key);

/** The source of the value at `path`, or else of the nearest value above it, or else of the first value under it. */
export function sourceOf(
	{ sources }: Pick<Composed, "sources">,
	path: KeyPath,
): Source | undefined {
	const above = sources
		.filter((s) => within(s.path, path))
		.toSorted((a, b) => b.path.length - a.path.length);
	return (above[0] ?? sources.find((s) => within(path, s.path)))?.source;
}

/** What the layers beneath the flags gave the value at `path` a flag set, or undefined when none gave it. */
export function underOf(
	{ sources }: Composed,
	path: KeyPath,
): Under | undefined {
	return sources.find((s) => s.path.join("\0") === path.join("\0"))?.under;
}

/** Where a value under check sits in the config, and how its diagnostics name it and the fix. */
export type Placed = {
	config: Pick<Composed, "sources">;
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
	limits: {
		type: "object",
		additionalProperties: false,
		properties: {
			timeout: { type: "string", minLength: 1 },
			tokens: { type: "integer", minimum: 1 },
		},
	},
};

/** The core config keys whose values are file paths. */
export const CORE_PATHS: readonly KeyPath[] = [["dataRoot"]];

export type CoreConfig = {
	/** The most node instances in flight at once. */
	concurrency: number;
	/** Caps by name, as compose takes them (D-23). */
	caps: Bounds;
	/** The directory holding the record store, concert areas and node scratch. */
	dataRoot: string;
	/** The workspace's name, empty outside any workspace. */
	workspace: string;
	limits: ConcertLimits;
};

/** What a concert's ceiling bounds, each unset by default: `timeout` in milliseconds of wall clock, and tokens. */
export type ConcertLimits = { timeout?: number; tokens?: number };

/** The default layer of core config. */
export const coreDefaults = (dataRoot: string, workspace: string): Layer =>
	valuesLayer(
		{
			concurrency: DEFAULT_CONCURRENCY,
			caps: {},
			dataRoot,
			workspace,
			limits: {},
		},
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
	return {
		concurrency,
		caps,
		dataRoot,
		workspace,
		limits: limitsOf(config),
	} as CoreConfig;
}

/**
 * The `limits` of `config`, which passed its schema, with `timeout` in milliseconds.
 * @throws ConfigError when `limits.timeout` is not a duration, or is longer than any timer holds.
 */
function limitsOf(config: Composed): ConcertLimits {
	const { timeout, tokens } = config.values.limits as {
		timeout?: string;
		tokens?: number;
	};
	const found = timeout === undefined ? undefined : timeoutProblem(timeout);
	if (found)
		throw new ConfigError([
			configDiagnostic(
				"CFG.schema",
				sourceOf(config, ["limits", "timeout"]),
				`config 'limits.timeout' '${timeout}' ${found.problem}`,
				found.fix,
			),
		]);
	return {
		...(timeout !== undefined && { timeout: durationMs(timeout) }),
		...(tokens !== undefined && { tokens }),
	};
}
