import {
	canonicalJson,
	type Diagnostic,
	IR_VERSION,
	type Ir,
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
import { schemas, type Types, type ValueOf } from "./types";

export type Values<P extends Types> = { [K in keyof P]: ValueOf<P[K]> };

export type PortRefs<Q extends Types> = { [K in keyof Q]: Ref<ValueOf<Q[K]>> };

/** What a `use` site feeds a port: a Ref, or a plain value (D-16). */
export type PortValues<Q extends Types> = {
	[K in keyof Q]: Ref<ValueOf<Q[K]>> | ValueOf<Q[K]>;
};

export type Declaration<P extends Types, Q extends Types> = {
	doc?: string;
	/** Plain values at build: CLI inputs and tunables alike (D-17). A param without a default is required. */
	params?: P;
	/** Ref-typed inputs fed by the `use` site. A composition with ports builds only through `use` (D-16). */
	ports?: Q;
	/** Param sets for `compose` without flags. Required without ports, optional with them (D-19). */
	examples?: Partial<Values<P>>[];
};

export type Composition<P extends Types, Q extends Types, R> = {
	readonly name: string;
	readonly doc?: string;
	readonly params: P;
	readonly ports: Q;
	readonly examples: Partial<Values<P>>[];
	/** Synchronous, and a pure function of its params and composed config (CORE-06). */
	readonly build: (params: Values<P>, ports: PortRefs<Q>) => R;
};

const NAME = /^[a-z][a-z0-9_-]*$/;

/** Declares a composition (sdk-spec 2). @throws `SCOPE.name` or `CFG.examples` for a bad declaration. */
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
	const { doc, params = {} as P, ports = {} as Q, examples = [] } = declaration;
	if (Object.keys(ports).length === 0 && examples.length === 0)
		throw fail(
			"CFG.examples",
			`composition '${name}' declares no example input set`,
			"Add examples with at least one set of params, which compose uses when given no flags",
		);
	return { name, doc, params, ports, examples, build };
}

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
 * Instantiates `sub` in a scope of its own (sdk-spec 8). Use-site params win over the defaults.
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
			const value: unknown = ports[name];
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
	const params = withDefaults(sub.params, opts.params);
	return withFrame(innerFrame(id, false), () => sub.build(params, refs));
}

function checkPorts(sub: string, declared: object, ports: object): void {
	const names = (o: object) => Object.keys(o).toSorted().join(", ");
	if (names(ports) !== names(declared))
		throw fail(
			"TYPE.ports",
			`use of '${sub}' must feed the ports [${names(declared)}], got [${names(ports)}]`,
			`Feed exactly the ports '${sub}' declares`,
		);
}

/**
 * Builds `root` with `params` over its defaults and emits its IR, with ambient state frozen (SDK-11). Identical
 * params and context give byte-identical `irJson` (CORE-06).
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
		return JSON.parse(irJson(emit(root, s, returned))) as unknown;
	});
	const parsed = parseIr(emitted);
	if (!parsed.ok) throw new BuildError(parsed.diagnostics[0] as Diagnostic);
	return parsed.ir;
}

/**
 * Builds `root` twice and compares the IR (SDK-12).
 * @throws `PURE.unstable` when the two differ.
 */
export function buildTwice<P extends Types, R>(
	root: Composition<P, Types, R>,
	params: Partial<Values<P>>,
	context: BuildContext,
): Ir {
	const first = irJson(build(root, params, context));
	if (first !== irJson(build(root, params, context)))
		throw fail(
			"PURE.unstable",
			`two builds of '${root.name}' with the same params gave different IR`,
			"Keep the build a function of its params alone: no state kept between builds",
		);
	return JSON.parse(first) as Ir;
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

/** `ir` as JSON with object keys sorted, so equal IR gives equal bytes (CORE-06). */
export const irJson = (ir: Ir): string => canonicalJson(ir);
