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
	sourceOf,
	valuesLayer,
} from "@maestro/core/config";
import type { Host } from "@maestro/core/host";
import {
	ARTIFACT_TYPES,
	type Diagnostic,
	findMarked,
	isPlainObject,
	type JsonSchema,
	replaceAt,
	schemaMarkers,
	type Validator,
	validator,
} from "@maestro/ir";
import type { ConfiguredParams, Described } from "@maestro/sdk/loader";

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
	/** The root's example input set, which fills params no config file or flag gives (D-19). */
	example?: Readonly<Record<string, unknown>>;
	/** The root's param values given as flags, by param name. */
	flags?: Readonly<Record<string, unknown>>;
	hosts: readonly Host[];
	/** The composition comes from a bare file, which no config key can reach. */
	bare?: boolean;
};

type Params = {
	/** The config with the flags on top and the example set filling the root params nothing else gives, optional ones only when none is given. */
	composed: Composed;
	/** The root's params as given, without their declared defaults, which its build fills in. */
	root: Record<string, unknown>;
	/** Each composition's params as given, for the build context. */
	configured: ConfiguredParams;
};

/** How one composition's params are read: where they sit in the config, and how a diagnostic names each. */
type Reading = {
	ajv: Validator;
	config: Composed;
	hosts: readonly Host[];
	composition: Described;
	path: KeyPath;
	root: boolean;
	bare: boolean;
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

type Read = { value: unknown } | { diagnostics: Diagnostic[] };

/**
 * `value` with each value its schema marks with a host type parsed by that host's `param`, from its text.
 * @returns the value, or why a marked value is not text, has no host to read it, or does not parse.
 */
function typed(
	r: Reading,
	name: string,
	schema: JsonSchema,
	value: unknown,
): Read {
	const source = sourceOf(r.config, [...r.path, name]);
	const refuse = (message: string, hint: string): Read => ({
		diagnostics: [configDiagnostic("CFG.param", source, message, hint)],
	});
	let result = structuredClone(value);
	for (const marked of findMarked(schema, value)) {
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
		if ("diagnostics" in read)
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
		result = replaceAt(result, marked.pointer, read.value);
	}
	return { value: result };
}

/** What to do about a missing root param: a bare file has no config key to set, only its example set. */
function requiredHint(r: Reading, name: string): string {
	const flag = flagOf(name);
	if (!r.bare)
		return `Pass ${flag}, or set '${[...r.path, name].join(".")}' in the config`;
	return r.composition.examples.length
		? `Pass ${flag}, or give it in the composition's example set`
		: `Pass ${flag}`;
}

/** The diagnostics that stop `name` before its value is read: a root param that is missing, or takes an artifact. */
function declarationErrors(
	r: Reading,
	name: string,
	given: boolean,
): Diagnostic[] {
	const schema = r.composition.params.properties[name] ?? true;
	const artifact = schemaMarkers(schema).find((m) =>
		ARTIFACT_TYPES.has(m.type),
	);
	if (artifact && (r.root || given))
		return [
			configDiagnostic(
				"CFG.param",
				sourceOf(r.config, [...r.path, name]),
				`${naming(r, name)} takes ${artifact.type}, an artifact, and a param cannot hold one`,
				`Declare '${name}' of '${r.path.join(".")}' with a type that is not an artifact`,
			),
		];
	if (r.root && !given && r.composition.params.required.includes(name))
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

/** One composition's params from the config, each typed param read through its host and checked against its schema. */
function paramsOf(r: Reading): Read {
	const given = sectionAt(r.config.values, r.path);
	const values: Record<string, unknown> = {};
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
		diagnostics.push(...offSchema(r.ajv, schema, read.value, placed));
		values[name] = read.value;
	}
	return diagnostics.length ? { diagnostics } : { value: values };
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
 * only the root's must hold every required param. Declared defaults are left to the build.
 * @throws ConfigError for a missing required root param, a value off its schema, a typed param no host reads or that
 * does not parse, or a param that takes an artifact.
 */
export function paramValues(request: ParamRequest): Params {
	const { pack, root } = request;
	const rooted = (
		layer: LayerName,
		values: Readonly<Record<string, unknown>>,
	) => valuesLayer({ [pack]: { [root]: values } }, { layer });
	const flagged = request.flags ? [rooted("flag", request.flags)] : [];
	const set = sectionAt(layered([...request.layers, ...flagged]).values, [
		pack,
		root,
	]);
	const config = layered([
		...request.layers,
		...flagged,
		rooted("example", exampleFill(request, set)),
	]);
	const ajv = validator();
	const configured: Record<string, Record<string, unknown>> = {};
	const diagnostics: Diagnostic[] = [];
	for (const composition of request.compositions) {
		const read = paramsOf({
			ajv,
			config,
			hosts: request.hosts,
			composition,
			path: [pack, composition.name],
			root: composition.name === root,
			bare: request.bare ?? false,
		});
		if ("diagnostics" in read) diagnostics.push(...read.diagnostics);
		else configured[composition.name] = read.value as Record<string, unknown>;
	}
	if (diagnostics.length) throw new ConfigError(diagnostics);
	return {
		composed: config,
		root: configured[root] ?? {},
		configured: { [pack]: configured },
	};
}
