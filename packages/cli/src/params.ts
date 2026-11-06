import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { stampHost } from "@maestro/core/compose";
import {
	type Composed,
	ConfigError,
	configDiagnostic,
	type KeyPath,
	type Layer,
	type LayerName,
	layered,
	offSchema,
	type Source,
	sourceOf,
	valuesLayer,
} from "@maestro/core/config";
import type { Host } from "@maestro/core/host";
import { type Staged, stagedRef } from "@maestro/core/perform";
import {
	ARTIFACT_TYPES,
	artifactsAsRefs,
	CORE_TYPES,
	type Diagnostic,
	findMarked,
	isPlainObject,
	type JsonSchema,
	type Marked,
	messageOf,
	replaceAt,
	schemaMarkers,
	type Validator,
	validator,
} from "@maestro/ir";
import type { ConfiguredParams, Described } from "@maestro/sdk/loader";
import { deferredKeys } from "./config";

const FLAG_PREFIX = "--";

/** A param's flag name, without the dashes: its declared name in kebab-case. */
export const flagName = (param: string) =>
	param
		.replaceAll("_", "-")
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase();

/** A param's flag: its name in kebab-case, so `maxRepairs` and `max_repairs` are `--max-repairs`. */
export const flagOf = (param: string) => FLAG_PREFIX + flagName(param);

/** The flag whose name, without the dashes, is `name`. */
export const flagFor = (name: string) => FLAG_PREFIX + name;

export type ParamRequest = {
	/** The config layers beneath the flags, lowest first, the defaults among them. */
	layers: readonly Layer[];
	pack: string;
	compositions: readonly Described[];
	/** The name of the composition to build. */
	root: string;
	/** The root's example input set, which fills params no config file or flag gives (D-19). Absent when the verb reads none. */
	example?: Readonly<Record<string, unknown>>;
	/** The root's param values given as flags, by param name. */
	flags?: Readonly<Record<string, unknown>>;
	hosts: readonly Host[];
	/** The directory a file param's relative path from `source` resolves against. */
	base: (source: Source | undefined) => string;
	/** The directory a file param's relative path in the example set resolves against: the composition file's, or the pack's. */
	exampleDir: string;
	/** The composition comes from a bare file, which no config key can reach. */
	bare?: boolean;
	/** A required root param no layer or flag gives is left unset, not refused: a verb that builds nothing reads this. */
	lax?: boolean;
};

type Params = {
	/** The config with the flags on top and the example set filling the root params nothing else gives, optional ones only when none is given. */
	composed: Composed;
	/** The root's params as given, without their declared defaults, which its build fills in. */
	root: Record<string, unknown>;
	/** Each composition's params as given, for the build context. */
	configured: ConfiguredParams;
	/** The files the root's file params name, to stage into the concert under the references the params hold. */
	staged: Staged[];
};

/** How one composition's params are read: where they sit in the config, and how a diagnostic names each. */
type Reading = {
	ajv: Validator;
	config: Composed;
	hosts: readonly Host[];
	base: ParamRequest["base"];
	composition: Described;
	path: KeyPath;
	root: boolean;
	bare: boolean;
	examples: boolean;
	lax: boolean;
};

/** A param's name in a diagnostic: with its flag for the root, else by its config key. */
const naming = (r: Reading, name: string) =>
	r.root
		? `param '${name}' (${flagOf(name)}) of '${r.path.join(".")}'`
		: `config '${[...r.path, name].join(".")}'`;

const fixing = (r: Reading, name: string) =>
	r.root
		? `Pass a valid ${flagOf(name)}, or fix '${[...r.path, name].join(".")}' in the config`
		: `Fix '${[...r.path, name].join(".")}' in the config`;

type Refused = { diagnostics: Diagnostic[] };
type Read = { value: unknown; staged: Staged[] } | Refused;
type Converted = { value: unknown; staged?: Staged } | Refused;
type Refuse = (message: string, hint: string) => Refused;

/**
 * `value` with each value its schema marks read from its text: an artifact's as the path of a file, a host type's by
 * that host's `param`.
 * @returns the value and the files to stage, or why a marked value cannot be read.
 */
function typed(
	r: Reading,
	name: string,
	schema: JsonSchema,
	value: unknown,
): Read {
	const source = sourceOf(r.config, [...r.path, name]);
	const refuse: Refuse = (message, hint) => ({
		diagnostics: [configDiagnostic("CFG.param", source, message, hint)],
	});
	let result = structuredClone(value);
	const staged: Staged[] = [];
	for (const marked of findMarked(schema, value)) {
		const read = ARTIFACT_TYPES.has(marked.type)
			? fileOf(r, name, marked, refuse)
			: hostValue(r, name, marked, refuse);
		if ("diagnostics" in read) return read;
		result = replaceAt(result, marked.pointer, read.value);
		if (read.staged) staged.push(read.staged);
	}
	return { value: result, staged };
}

// Covers the backslash and the control characters the IR's artifact path pattern refuses in a segment.
const UNSAFE_NAME = /[\\\p{Cc}]/u;

/** The bytes of the file at `path`, or undefined when it cannot be read. */
function bytesOf(path: string): Uint8Array | undefined {
	try {
		return readFileSync(path);
	} catch {
		return undefined;
	}
}

/** Why `bytes` do not parse as JSON, or undefined when they do. */
function notJson(bytes: Uint8Array): string | undefined {
	try {
		JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		return messageOf(error);
	}
}

/**
 * The reference to the file a marked value names, resolved as its config source's paths are, and that file to stage
 * under it.
 */
function fileOf(
	r: Reading,
	name: string,
	{ type, value }: Marked,
	refuse: Refuse,
): Converted {
	if (typeof value !== "string")
		return refuse(
			`${naming(r, name)} takes ${type}, the path of a file`,
			fixing(r, name),
		);
	const source = resolve(r.base(sourceOf(r.config, [...r.path, name])), value);
	const named = `${naming(r, name)} names '${value}'`;
	if (UNSAFE_NAME.test(basename(source)))
		return refuse(
			`${named}, whose name holds a backslash or control character`,
			"Rename the file, then pass its new path",
		);
	const bytes = bytesOf(source);
	if (bytes === undefined)
		return refuse(`${named}, which is not a readable file`, fixing(r, name));
	const unparsed = type === CORE_TYPES.jsonFile ? notJson(bytes) : undefined;
	if (unparsed !== undefined)
		return refuse(`${named}, which is not JSON: ${unparsed}`, fixing(r, name));
	const ref = stagedRef(basename(source), bytes);
	return { value: ref, staged: { source, ref, from: flagOf(name) } };
}

/** A marked value parsed by the `param` of the host that owns its type, from its text. */
function hostValue(
	r: Reading,
	name: string,
	marked: Marked,
	refuse: Refuse,
): Converted {
	const host = r.hosts.find((h) => h.types.includes(marked.type));
	if (!host?.param)
		return refuse(
			`${naming(r, name)} takes ${marked.type}, which no installed host reads`,
			`Install the host that owns '${marked.type}'`,
		);
	if (typeof marked.value !== "string")
		return refuse(
			`${naming(r, name)} must be text that host '${host.name}' reads as ${marked.type}`,
			fixing(r, name),
		);
	const read = host.param(marked.type, marked.value);
	if (!("diagnostics" in read)) return { value: read.value };
	const source = sourceOf(r.config, [...r.path, name]);
	return {
		diagnostics: read.diagnostics.map((d) =>
			stampHost(
				configDiagnostic(
					d.code,
					source,
					`${naming(r, name)}: ${d.message}`,
					d.hint,
				),
			),
		),
	};
}

/** What to do about a missing root param: the flag, the config key a pack has, the example set a verb reads. */
function requiredHint(r: Reading, name: string): string {
	const flag = flagOf(name);
	const ways = [`Pass ${flag}`];
	if (!r.bare) ways.push(`set '${[...r.path, name].join(".")}' in the config`);
	if (r.examples) ways.push("give it in the composition's example set");
	return ways.join(", or ");
}

/**
 * Why `name` may not take the artifact its schema marks: a root param that takes a directory, or another composition's
 * param that the config gives a file.
 */
function artifactError(
	r: Reading,
	name: string,
	given: boolean,
): Diagnostic | undefined {
	const schema = r.composition.params.properties[name] ?? true;
	const types = schemaMarkers(schema)
		.map((m) => m.type)
		.filter((t) => ARTIFACT_TYPES.has(t));
	const diagnostic = (message: string, hint: string) =>
		configDiagnostic(
			"CFG.param",
			sourceOf(r.config, [...r.path, name]),
			`${naming(r, name)} ${message}`,
			hint,
		);
	if (r.root && types.includes(CORE_TYPES.dir))
		return diagnostic(
			`takes ${CORE_TYPES.dir}, a directory, which a param cannot take`,
			`Declare '${name}' of '${r.path.join(".")}' as File, Markdown or JsonFile, which take a file's path`,
		);
	if (!r.root && given && types.length)
		return diagnostic(
			`takes ${types[0]}, a file, which only the root composition's params take`,
			`Remove it from the config, and feed the file to '${r.path.join(".")}' through a port of its use`,
		);
	return undefined;
}

/** The diagnostics that stop `name` before its value is read: a root param that is missing, or an artifact refused. */
function declarationErrors(
	r: Reading,
	name: string,
	given: boolean,
): Diagnostic[] {
	const refused = artifactError(r, name, given);
	if (refused) return [refused];
	if (
		r.root &&
		!r.lax &&
		!given &&
		r.composition.params.required.includes(name)
	)
		return [
			configDiagnostic(
				"CFG.required",
				undefined,
				`${naming(r, name)} is required`,
				requiredHint(r, name),
			),
		];
	return [];
}

/** The mapping at `path` in `values`, empty when there is none. */
function sectionAt(
	values: Readonly<Record<string, unknown>>,
	path: KeyPath,
): Readonly<Record<string, unknown>> {
	const section = path.reduce<unknown>(
		(at, key) => (isPlainObject(at) ? at[key] : undefined),
		values,
	);
	return isPlainObject(section) ? section : {};
}

/**
 * One composition's params from the config, each marked value read as a file or through its host, then checked against
 * its schema.
 */
function paramsOf(r: Reading): Read {
	const given = sectionAt(r.config.values, r.path);
	const values: Record<string, unknown> = {};
	const staged: Staged[] = [];
	const diagnostics: Diagnostic[] = [];
	for (const [name, schema] of Object.entries(
		r.composition.params.properties,
	)) {
		const has = Object.hasOwn(given, name);
		const stopped = declarationErrors(r, name, has);
		diagnostics.push(...stopped);
		if (stopped.length || !has) continue;
		const read = typed(r, name, schema, given[name]);
		if ("diagnostics" in read) {
			diagnostics.push(...read.diagnostics);
			continue;
		}
		const subject = r.root ? () => naming(r, name) : undefined;
		const placed = {
			config: r.config,
			path: [...r.path, name],
			hint: fixing(r, name),
			subject,
		};
		diagnostics.push(
			...offSchema(r.ajv, artifactsAsRefs(schema), read.value, placed),
		);
		values[name] = read.value;
		staged.push(...read.staged);
	}
	return diagnostics.length ? { diagnostics } : { value: values, staged };
}

/** The params of `composition` that may be absent: neither required nor defaulted. */
function optionalParams(composition: Described | undefined): string[] {
	const { properties = {}, required = [] } = composition?.params ?? {};
	return Object.entries(properties)
		.filter(
			([name, schema]) =>
				!required.includes(name) &&
				!(isPlainObject(schema) && schema.default !== undefined),
		)
		.map(([name]) => name);
}

/**
 * The part of the root's example set that `set`, the root's params the layers and flags give, leaves to it: each
 * param `set` lacks, an optional one only when `set` has none of the root's optional params (D-19).
 */
function exampleFill(
	request: ParamRequest,
	set: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const optional = optionalParams(
		request.compositions.find((c) => c.name === request.root),
	);
	const optionalGiven = optional.some((name) => Object.hasOwn(set, name));
	return Object.fromEntries(
		Object.entries(request.example ?? {}).filter(
			([name]) =>
				!Object.hasOwn(set, name) &&
				!(optionalGiven && optional.includes(name)),
		),
	);
}

/**
 * Resolves params, lowest first: the config layers, then the flags, with a composition's keys under
 * `<pack>.<composition>`. The example set is no layer: it gives the root's value for each param the rest leave unset,
 * an optional one only when the rest give none of the root's optional params, and no merge tag acts on it. Every
 * composition of the pack is read, so a subcomposition's configured params reach its `use` through the build context;
 * only the root's must hold every required param. Declared defaults are left to the build. A root file param's value
 * is the path of a file, resolved against `base` of its source, or `exampleDir` for the example set, and becomes the reference that file is staged under.
 * @throws ConfigError for a missing required root param, a value off its schema, a typed param no host reads or that
 * does not parse, a file param whose file cannot be read or, for `core.json-file`, is not JSON, a root param that takes
 * a directory, or another composition's param the config gives a file.
 */
export function paramValues(request: ParamRequest): Params {
	const { pack, root } = request;
	const rooted = (
		layer: LayerName,
		values: Readonly<Record<string, unknown>>,
	) => valuesLayer({ [pack]: { [root]: values } }, { layer });
	const flagged = request.flags ? [rooted("flag", request.flags)] : [];
	const deferred = deferredKeys(request.hosts);
	const set = sectionAt(
		layered([...request.layers, ...flagged], deferred).values,
		[pack, root],
	);
	const config = layered(
		[
			...request.layers,
			...flagged,
			rooted("example", exampleFill(request, set)),
		],
		deferred,
	);
	const ajv = validator();
	const configured: Record<string, Record<string, unknown>> = {};
	const staged: Staged[] = [];
	const diagnostics: Diagnostic[] = [];
	for (const composition of request.compositions) {
		const read = paramsOf({
			ajv,
			config,
			hosts: request.hosts,
			base: (source) =>
				source?.layer === "example" ? request.exampleDir : request.base(source),
			composition,
			path: [pack, composition.name],
			root: composition.name === root,
			bare: request.bare ?? false,
			examples: request.example !== undefined,
			lax: request.lax ?? false,
		});
		if ("diagnostics" in read) diagnostics.push(...read.diagnostics);
		else {
			configured[composition.name] = read.value as Record<string, unknown>;
			staged.push(...read.staged);
		}
	}
	if (diagnostics.length) throw new ConfigError(diagnostics);
	return {
		composed: config,
		root: configured[root] ?? {},
		configured: { [pack]: configured },
		staged,
	};
}
