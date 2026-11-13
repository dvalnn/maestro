import {
	type ArtifactRef,
	canonicalJson,
	type Diagnostic,
	IR_VERSION,
	type Ir,
	type Ports,
	parseIr,
} from "@maestro/ir";
import pkg from "../package.json";
import { frozen } from "./ambient";
import { BuildError } from "./diagnostic";
import {
	type BuildContext,
	claimId,
	current,
	fail,
	inBuild,
	innerFrame,
	literalRef,
	plainProblem,
	type Ref,
	RefImpl,
	ResultImpl,
	type State,
	visible,
	withFrame,
} from "./graph";
import { schemas, type Type, type Types, type ValueOf } from "./types";

export type Values<P extends Types> = { [K in keyof P]: ValueOf<P[K]> };

/** An example set's values: a file param's is the path of a sample file, not its reference (D-19). */
export type ExampleValues<P extends Types> = {
	[K in keyof P]: [Exclude<ValueOf<P[K]>, undefined>] extends [ArtifactRef]
		? string
		: ValueOf<P[K]>;
};

type OptionalPorts<Q extends Types> = {
	[K in keyof Q]: undefined extends ValueOf<Q[K]> ? K : never;
}[keyof Q];

/** An optional port is `undefined` when the `use` site leaves it out. */
export type PortRefs<Q extends Types> = {
	[K in Exclude<keyof Q, OptionalPorts<Q>>]: Ref<ValueOf<Q[K]>>;
} & {
	[K in OptionalPorts<Q>]: Ref<Exclude<ValueOf<Q[K]>, undefined>> | undefined;
};

/** What a `use` site feeds a port: a Ref, or a plain value (D-16). */
export type PortValues<Q extends Types> = {
	[K in Exclude<keyof Q, OptionalPorts<Q>>]: Ref<ValueOf<Q[K]>> | ValueOf<Q[K]>;
} & {
	[K in OptionalPorts<Q>]?:
		| Ref<Exclude<ValueOf<Q[K]>, undefined>>
		| ValueOf<Q[K]>;
};

/** A composition with ports builds only through `use`, so only one without ports takes examples (D-16, D-19). */
export type Declaration<P extends Types, Q extends Types> = {
	doc?: string;
	/** The id of the pack that declares this composition; its config keys sit under it, whichever root uses it. */
	pack?: string;
	/**
	 * Plain values at build: CLI inputs and tunables alike (D-17). A param without a default is required, unless
	 * `Optional`.
	 */
	params?: P;
} & (
	| {
			ports?: never;
			/** Param sets for `compose` without flags; at least one. */
			examples: Partial<ExampleValues<P>>[];
	  }
	| {
			/** Ref-typed inputs fed by the `use` site. */
			ports: Q;
			examples?: never;
	  }
);

export type Composition<P extends Types, Q extends Types, R> = {
	readonly name: string;
	readonly doc?: string;
	readonly pack?: string;
	readonly params: P;
	readonly ports: Q;
	readonly examples: Partial<ExampleValues<P>>[];
	/** Synchronous, and a pure function of its params and composed config (CORE-06). */
	readonly build: (params: Values<P>, ports: PortRefs<Q>) => R;
};

const NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * Declares a composition (sdk-spec: Writing a composition).
 * @throws `SCOPE.name` or `CFG.examples` for a bad declaration.
 */
export function composition<P extends Types, Q extends Types, R>(
	name: string,
	declaration: Declaration<P, Q>,
	build: (params: Values<P>, ports: PortRefs<Q>) => R,
): Composition<P, Q, R> {
	if (!NAME.test(name))
		throw fail(
			"SCOPE.name",
			`composition name '${name}' is not a valid id`,
			"Use lowercase letters, digits, '_' and '-', starting with a letter",
		);
	const { doc, pack, params = {} as P } = declaration;
	if (pack !== undefined && !NAME.test(pack))
		throw fail(
			"SCOPE.name",
			`composition pack '${pack}' is not a valid id`,
			"Use lowercase letters, digits, '_' and '-', starting with a letter",
		);
	const ports = declaration.ports ?? ({} as Q);
	const examples = declaration.examples ?? [];
	const hasPorts = Object.keys(ports).length > 0;
	if (hasPorts && declaration.examples !== undefined)
		throw fail(
			"CFG.examples",
			`composition '${name}' has ports and declares examples`,
			"Remove examples: a composition with ports takes its values from the use that calls it",
		);
	if (!hasPorts && examples.length === 0)
		throw fail(
			"CFG.examples",
			`composition '${name}' declares no example input set`,
			"Add examples with at least one set of params, which compose uses when given no flags",
		);
	const declared = { name, doc, pack, params, ports, examples, build };
	compositions.add(declared);
	return declared;
}

/** Every composition declared so far. */
const compositions = new WeakSet<object>();

/** `given` over the declared defaults, as a copy, so a build that changes a value changes no later build. */
const withDefaults = <P extends Types>(
	params: P,
	given: Partial<Values<P>> | undefined,
): Values<P> =>
	structuredClone({
		...Object.fromEntries(
			Object.entries(params).flatMap(([name, { schema }]) =>
				typeof schema === "object" && schema.default !== undefined
					? [[name, schema.default]]
					: [],
			),
		),
		...given,
	}) as Values<P>;

/**
 * Instantiates `sub` in a scope of its own (sdk-spec: Subcompositions). Use-site params win over its configured params
 * in the build context, and those over the defaults.
 * @throws `REF.param` when a param gets a Ref.
 */
export function use<P extends Types, Q extends Types, R>(
	sub: Composition<P, Q, R>,
	ports: PortValues<Q>,
	opts: { params?: Partial<Values<P>>; label?: string } = {},
): R {
	const s = current();
	checkPorts(sub.name, sub.ports, ports);
	for (const [name, value] of Object.entries(opts.params ?? {}))
		if (plainProblem(value) === "ref")
			throw fail(
				"REF.param",
				`param '${name}' of '${sub.name}' got a Ref, and params are plain values`,
				`Declare '${name}' as a port of '${sub.name}' to feed it a Ref`,
			);
	const id = claimId(opts.label, sub.name);
	s.scopes.push({
		id,
		composition: sub.name,
		ports: schemas(sub.ports),
	});
	const refs = Object.fromEntries(
		Object.entries(sub.ports).map(([name, type]) => {
			const value: unknown = (ports as Record<string, unknown>)[name];
			if (value === undefined && type.optional === true)
				return [name, undefined];
			if (!(value instanceof RefImpl))
				return [
					name,
					literalRef(value, type, `port '${name}' of '${sub.name}'`),
				];
			const source =
				value.source.kind === "port" ? visible(value) : value.source;
			return [name, new RefImpl(source, type, s)];
		}),
	) as unknown as PortRefs<Q>;
	const configured =
		s.context.params?.[sub.pack ?? s.context.pack.id]?.[sub.name];
	const params = withDefaults(sub.params, {
		...configured,
		...opts.params,
	} as Partial<Values<P>>);
	return withFrame(innerFrame(id, false), () => sub.build(params, refs));
}

function checkPorts(
	sub: string,
	declared: Types,
	ports: Record<string, unknown>,
): void {
	const names = (keys: string[]) => keys.toSorted().join(", ");
	const all = Object.keys(declared);
	const required = all.filter((k) => declared[k]?.optional !== true);
	const optional = all.filter((k) => declared[k]?.optional === true);
	const given = Object.keys(ports).filter(
		(k) => ports[k] !== undefined || declared[k]?.optional !== true,
	);
	const missing = required.some((k) => ports[k] === undefined);
	const unknown = given.some((k) => !all.includes(k));
	const may =
		optional.length === 0
			? ""
			: ` and may feed the optional ports [${names(optional)}]`;
	if (missing || unknown)
		throw fail(
			"TYPE.ports",
			`use of '${sub}' must feed the required ports [${names(required)}]${may}, got [${names(given)}]`,
			`Feed every required port of '${sub}' and only ports it declares`,
		);
}

/**
 * Builds `root` with `params` over its defaults and emits its IR, with ambient state frozen (SDK-11). Identical
 * params and context give byte-identical canonical JSON (CORE-06).
 * @throws `BuildError` for any build diagnostic, or with the first diagnostic `parseIr` finds in the emitted IR.
 */
export function build<P extends Types, R>(
	root: Composition<P, Types, R>,
	params: Partial<Values<P>>,
	context: BuildContext,
): Ir {
	if (Object.keys(root.ports).length > 0)
		throw fail(
			"SCOPE.ports",
			`composition '${root.name}' has ports, so it builds only through use()`,
			`Build a composition without ports that calls use() on '${root.name}'`,
		);
	const emitted = inBuild(context, (s) => {
		const all = withDefaults(root.params, params);
		const returned = frozen(() => root.build(all, {} as PortRefs<Types>));
		return JSON.parse(canonicalJson(emit(root, s, returned))) as unknown;
	});
	const parsed = parseIr(emitted);
	if (!parsed.ok) throw new BuildError(parsed.diagnostics[0] as Diagnostic);
	return parsed.ir;
}

function emit(
	root: { name: string; doc?: string },
	s: State,
	returned: unknown,
): Ir {
	return {
		irVersion: IR_VERSION,
		composition: {
			id: root.name,
			version: s.context.pack.version,
			pack: s.context.pack.id,
			doc: root.doc,
		},
		emitter: { name: pkg.name, version: pkg.version },
		scopes: s.scopes,
		nodes: s.nodes,
		edges: s.edges,
		result: resultOf(root.name, returned),
	};
}

/**
 * The node `returned` is, or whose output port it is: where the result rule starts (architecture 7).
 * @throws `TYPE.result` for anything else.
 */
function resultOf(name: string, returned: unknown): Ir["result"] {
	if (returned instanceof ResultImpl) return { node: returned.node };
	if (returned instanceof RefImpl && returned.source.kind === "port")
		return { node: returned.source.node };
	throw fail(
		"TYPE.result",
		`the build of '${name}' returned no node`,
		"Return the node whose outcome is the concert result, or a reducer over several",
	);
}

/** A composition's name, doc, params and examples, known without building it (ADR 0002). */
export type Described = {
	name: string;
	doc?: string;
	pack?: string;
	/** An object schema of the params: a param without a default is required, unless `Optional`. */
	params: {
		type: "object";
		properties: Ports;
		required: string[];
		additionalProperties: false;
	};
	examples: Record<string, unknown>[];
};

/** The names a bundle's entry exports beside the authored ones. */
const ENTRY_EXPORTS = ["describe", "build"];

/**
 * The compositions among `exports`, the values of a module namespace, by name.
 * @throws `SCOPE.name` when an export takes a name the bundle's entry exports, `SCOPE.duplicate` when two
 * compositions share a name.
 */
function compositionsOf(
	exports: Readonly<Record<string, unknown>>,
): Map<string, Composition<Types, Types, unknown>> {
	const taken = ENTRY_EXPORTS.filter((name) => Object.hasOwn(exports, name));
	if (taken.length)
		throw fail(
			"SCOPE.name",
			`the module exports '${taken.join("' and '")}', a name its bundle's entry exports`,
			`Rename the export '${taken[0]}'`,
		);
	const found = new Map<string, Composition<Types, Types, unknown>>();
	for (const value of Object.values(exports)) {
		if (!compositions.has(value as object)) continue;
		const c = value as Composition<Types, Types, unknown>;
		const other = found.get(c.name);
		if (other && other !== c)
			throw fail(
				"SCOPE.duplicate",
				`two exported compositions are named '${c.name}'`,
				`Rename one of the compositions named '${c.name}'`,
			);
		found.set(c.name, c);
	}
	return found;
}

/** Whether a param may be left out: it has a default, or is `Optional`. */
const omissible = (type: Type<unknown>) =>
	type.optional === true ||
	(typeof type.schema === "object" && type.schema.default !== undefined);

/** Each composition among `exports`, a module namespace: its name, doc, params as JSON Schema and examples. */
export function describe(
	exports: Readonly<Record<string, unknown>>,
): Described[] {
	return [...compositionsOf(exports).values()].map((c) => ({
		name: c.name,
		doc: c.doc,
		pack: c.pack,
		params: {
			type: "object",
			properties: schemas(c.params),
			required: Object.entries(c.params)
				.filter(([, type]) => !omissible(type))
				.map(([name]) => name),
			additionalProperties: false,
		},
		examples: structuredClone(c.examples) as Record<string, unknown>[],
	}));
}

/**
 * Builds the composition named `name` among `exports`, a module namespace, twice, and emits its IR as canonical JSON
 * (SDK-12).
 * @throws `SCOPE.name` when none has that name, `BUILD.unstable` when the two builds differ, else as `build` does.
 */
export function buildNamed(
	exports: Readonly<Record<string, unknown>>,
	name: string,
	params: Readonly<Record<string, unknown>>,
	context: BuildContext,
): string {
	const root = compositionsOf(exports).get(name);
	if (!root)
		throw fail(
			"SCOPE.name",
			`no exported composition is named '${name}'`,
			"Name one of the compositions the module exports",
		);
	const first = canonicalJson(build(root, params, context));
	if (first !== canonicalJson(build(root, params, context)))
		throw fail(
			"BUILD.unstable",
			`two builds of '${name}' with the same params gave different IR`,
			"Keep the build a function of its params alone: no state kept between builds",
		);
	return first;
}

/** The name of a bundle's entry, beside the authored module so its relative import resolves. Never written to disk. */
export const GLUE_FILE = ".maestro-entry.js";

/** One message of a bundler's log, at a source position when it has one. */
export type BundlerLog = {
	message: string;
	position?: { file: string; line: number; column: number } | null;
};

/** The bundler's `logs` joined, each led by its file, line and column. */
export const bundlerMessage = (logs: readonly BundlerLog[]) =>
	logs
		.map(({ message, position: at }) =>
			at ? `${at.file}:${at.line}:${at.column}: ${message}` : message,
		)
		.join("; ");

/**
 * The source of a bundle's entry over `entry`, the authored module's import specifier: it exports what `entry`
 * exports, plus `describe()` and `build(name, params, context)` through the bundle's own SDK copy (ADR 0002).
 */
export function glue(entry: string): string {
	const from = JSON.stringify(entry);
	return [
		`import { buildNamed, describe as described } from "${pkg.name}/loader";`,
		`import * as authored from ${from};`,
		`export * from ${from};`,
		"export const describe = () => described(authored);",
		"export const build = (name, params, context) => buildNamed(authored, name, params, context);",
		"",
	].join("\n");
}
