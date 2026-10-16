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
import { type Validator, validator } from "@maestro/core/ports";
import {
	ARTIFACT_TYPES,
	type Diagnostic,
	findMarked,
	isPlainObject,
	type JsonSchema,
	replaceAt,
	schemaMarkers,
} from "@maestro/ir";
import type { ConfiguredParams, Described } from "@maestro/sdk";

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
	/** The config layers beneath the example set and the flags, lowest first. */
	layers: readonly Layer[];
	pack: string;
	compositions: readonly Described[];
	/** The name of the composition to build. */
	root: string;
	/** The root's example input set, which stands over every config file. */
	example?: Readonly<Record<string, unknown>>;
	/** The root's param values given as flags, by param name. */
	flags?: Readonly<Record<string, unknown>>;
	hosts: readonly Host[];
};

type Params = {
	/** The config with the example set and the flags layered on top. */
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
	const at = [...r.path, name].join(".");
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
				`Pass ${flagOf(name)}, or set '${at}' in the config`,
			),
		];
	return [];
}

/** One composition's params from the config, each typed param read through its host and checked against its schema. */
function paramsOf(r: Reading): Read {
	const section = r.path.reduce<unknown>(
		(at, key) => (isPlainObject(at) ? at[key] : undefined),
		r.config.values,
	);
	const given = isPlainObject(section) ? section : {};
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

/**
 * Resolves params, lowest first: the config layers, the example set, then the flags, with a composition's keys under
 * `<pack>.<composition>`. Every composition of the pack is read, so a subcomposition's configured params reach its
 * `use` through the build context; only the root's must hold every required param. Declared defaults are left to the
 * build.
 * @throws ConfigError for a missing required root param, a value off its schema, a typed param no host reads or that
 * does not parse, or a param that takes an artifact.
 */
export function paramValues(request: ParamRequest): Params {
	const { pack, root } = request;
	const above = (
		layer: LayerName,
		values?: Readonly<Record<string, unknown>>,
	) => (values ? [valuesLayer({ [pack]: { [root]: values } }, { layer })] : []);
	const config = layered([
		...request.layers,
		...above("example", request.example),
		...above("flag", request.flags),
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
