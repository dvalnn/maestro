import {
	canonicalJson,
	collects,
	IMPLICIT_OUT,
	type IrEdge,
	type IrNode,
	isPlainObject,
	type JsonSchema,
	messageOf,
	type Ports,
	type Scope,
	STDLIB_MODULE,
	settledSchema,
	type Tolerate,
	TS_RUNTIME,
	type WorkerRef,
} from "@maestro/ir";
import pkg from "../package.json";
import { BuildError } from "./diagnostic";
import type * as stdlibFunctions from "./stdlib-functions";
import type { Type, Types, ValueOf } from "./types";

/** Any function the loader may name: a code function or a `parMap` or `parFind` key function (ADR 0008). */
export type CodeFn = (...args: never[]) => unknown;

/** Param values by pack id, then composition id, then param name. */
export type ConfiguredParams = Readonly<
	Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
>;

/** What the loader supplies to a build (ADR 0008). */
export type BuildContext = {
	pack: { id: string; version: string };
	/**
	 * The worker reference of an exported function, or nothing when `fn` is not one. Deterministic.
	 * @throws Error when it cannot name `fn`, for example when two exports reach it.
	 */
	resolveCode: (fn: CodeFn) => WorkerRef | undefined;
	/** The configured params of each subcomposition a `use` instantiates, under the pack being built (CFG-04). */
	params?: ConfiguredParams;
};

/**
 * A typed value that exists only at perform time. It throws a `REF.value` diagnostic when coerced to a string, a
 * number or JSON. Truthiness cannot be trapped in JavaScript, so a guard, a condition and an `assert` check what they
 * receive instead.
 */
export interface Ref<T> {
	readonly type: Type<T>;
	/** The field at a dotted path of field names, typed by the path: a stdlib `get` node. */
	get<P extends string>(path: P & PathOf<T>, common?: Common): Ref<At<T, P>>;
	/**
	 * The value, or `fallback` when its node settled `rejected` or `skipped`: a fan-in stdlib `or` node. A `failed`
	 * node fails it too.
	 */
	or(fallback: T, common?: Common): Ref<T>;
}

/** The most fields a typed `get` path names; past it, `PathOf` offers no longer path. */
type MaxPathDepth = 8;

/** The dotted field paths of `T`, up to `MaxPathDepth` fields, or any string when `T` is unknown. */
export type PathOf<T> = unknown extends T ? string : Paths<T, []>;

type Paths<T, Above extends unknown[]> = Above["length"] extends MaxPathDepth
	? never
	: T extends readonly unknown[]
		? never
		: T extends object
			? {
					[K in keyof T & string]:
						| K
						| `${K}.${Paths<NonNullable<T[K]>, [...Above, unknown]>}`;
				}[keyof T & string]
			: never;

/** The type of the field of `T` at the dotted `path`. */
export type At<T, P extends string> = unknown extends T
	? unknown
	: P extends `${infer K}.${infer Rest}`
		? K extends keyof T
			? At<NonNullable<T[K]>, Rest>
			: unknown
		: P extends keyof T
			? T[P]
			: unknown;

export type Refs<O extends Types> = {
	readonly [K in keyof O]: Ref<ValueOf<O[K]>>;
};

/** What every node constructor returns (sdk-spec: Nodes and their results). */
export interface Result<O extends Types = Types> {
	readonly ok: Ref<boolean>;
	/** Present when the node settled `rejected` or `failed`. */
	readonly reason: Ref<string>;
	readonly out: Refs<O>;
}

/** Options every node takes (SDK-02). */
export type Common = {
	/** The last segment of the node id. Defaults to the constructor's name. */
	label?: string;
	/** The node is skipped unless this is true (sdk-spec: Guards and tolerance). */
	when?: Ref<boolean>;
	/** Performs the node after a `rejected` upstream too. */
	tolerate?: Tolerate;
};

type Frame = {
	readonly path: string;
	/** Enclosing groups, outermost first. */
	readonly groups: readonly string[];
};

type NodeInfo = {
	kind: string;
	groups: readonly string[];
	out: Ports;
	fanin: boolean;
};

export type State = {
	readonly context: BuildContext;
	readonly nodes: IrNode[];
	readonly edges: IrEdge[];
	readonly scopes: Scope[];
	readonly ids: Set<string>;
	readonly info: Map<string, NodeInfo>;
	/** What each lift computes, by id, to tell a repeated lift from a clash. */
	readonly lifts: Map<string, string>;
	frame: Frame;
};

type PortSource = {
	readonly kind: "port";
	readonly node: string;
	readonly port: string;
	/** A group's `inner` port, visible only from its body. */
	readonly inner: boolean;
	/** The groups a consumer must be inside to read it. */
	readonly groups: readonly string[];
};

type Source =
	| PortSource
	| { readonly kind: "literal"; readonly value: unknown };

let state: State | undefined;

/** A `BuildError` located in the current scope. */
export function fail(
	code: string,
	message: string,
	hint: string,
	node?: string,
): BuildError {
	return new BuildError({
		code,
		message,
		hint,
		scope: state?.frame.path || undefined,
		node,
	});
}

export function current(): State {
	if (!state)
		throw fail(
			"SCOPE.build",
			"a node constructor was called outside a build",
			"Call it inside a composition's build function",
		);
	return state;
}

/** Calls `fn` as the one build in progress. Builds are synchronous, so module state cannot interleave. */
export function inBuild<T>(context: BuildContext, fn: (s: State) => T): T {
	if (state)
		throw fail(
			"SCOPE.build",
			"a build was started while another one is in progress",
			"Build compositions one at a time, and nest them with use()",
		);
	state = {
		context,
		nodes: [],
		edges: [],
		scopes: [],
		ids: new Set(),
		info: new Map(),
		lifts: new Map(),
		frame: { path: "", groups: [] },
	};
	try {
		return fn(state);
	} finally {
		state = undefined;
	}
}

export function withFrame<T>(frame: Frame, fn: () => T): T {
	const s = current();
	const outer = s.frame;
	s.frame = frame;
	try {
		return fn();
	} finally {
		s.frame = outer;
	}
}

/** The frame of a group's body, or of a scope when `group` is false. */
export function innerFrame(id: string, group: boolean): Frame {
	const { groups } = current().frame;
	return { path: id, groups: group ? [...groups, id] : groups };
}

const LABEL = /^[A-Za-z0-9_-]+$/;

/** The id `segment` takes in the current frame. Characters an id cannot hold become `_`. */
function idOf(segment: string): string {
	const { path } = current().frame;
	const safe = segment.replace(/[^A-Za-z0-9_-]/g, "_");
	return path ? `${path}/${safe}` : safe;
}

/**
 * Claims a node or scope id in the current frame: its path, then `label` or else `derived` (IR-01, sdk-spec:
 * Diagnostics catalogue).
 */
export function claimId(label: string | undefined, derived: string): string {
	const s = current();
	if (label !== undefined && !LABEL.test(label))
		throw fail(
			"SCOPE.name",
			`label '${label}' has characters an id cannot hold`,
			"Use only letters, digits, '_' and '-' in a label",
		);
	const id = idOf(label ?? derived);
	if (s.ids.has(id))
		throw fail(
			"SCOPE.duplicate",
			`id '${id}' is used more than once`,
			`Give one of the nodes with id '${id}' a label of its own`,
			id,
		);
	s.ids.add(id);
	return id;
}

export const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1);

export function info(node: string): NodeInfo {
	const found = current().info.get(node);
	if (!found) throw new Error(`no node '${node}' in this build`);
	return found;
}

export class RefImpl<T> implements Ref<T> {
	constructor(
		readonly source: Source,
		readonly type: Type<T>,
		readonly owner: State,
	) {}

	get<P extends string>(
		path: P & PathOf<T>,
		common: Common = {},
	): Ref<At<T, P>> {
		return lift(
			"get",
			`${sourceOf(this)}_${path}`,
			{ value: this, path },
			pathSchema(this.type.schema, path),
			common,
		) as Ref<At<T, P>>;
	}

	or(fallback: T, common: Common = {}): Ref<T> {
		checkOr(this, fallback);
		return lift(
			"or",
			`${sourceOf(this)}_or`,
			{ value: this, fallback },
			this.type.schema,
			{ ...common, fanin: true },
		) as Ref<T>;
	}

	[Symbol.toPrimitive](): never {
		throw usedAsValue();
	}

	toJSON(): never {
		throw usedAsValue();
	}
}

function checkOr<T>(value: RefImpl<T>, fallback: unknown): void {
	if (fallback instanceof RefImpl || fallback instanceof ResultImpl)
		throw fail(
			"TYPE.or",
			"the fallback of or is a Ref, and it must be a plain value",
			"Choose between two node outputs with firstOk([x, y])",
		);
	if (value.source.kind === "port" && isResults(visible(value)))
		throw fail(
			"TYPE.or",
			"or was called on a group's results, which are a list of Settled",
			"Reduce the results with okOnly or allSettled",
		);
}

const usedAsValue = () =>
	fail(
		"REF.value",
		"a Ref was used as a plain value during build",
		"Lift it instead: ref.get(path), ref.or(fallback), when(cond, value), lookup(table, key), or a code node",
	);

export class ResultImpl implements Result {
	readonly ok: RefImpl<boolean>;
	readonly reason: RefImpl<string>;
	readonly out: Record<string, RefImpl<unknown>>;

	constructor(readonly node: string) {
		const { out } = info(node);
		const { ok, reason } = IMPLICIT_OUT;
		this.ok = this.port("ok", ok) as RefImpl<boolean>;
		this.reason = this.port("reason", reason) as RefImpl<string>;
		this.out = Object.fromEntries(
			Object.entries(out).map(([port, schema]) => [
				port,
				this.port(port, schema),
			]),
		);
	}

	[Symbol.toPrimitive](): never {
		throw usedAsValue();
	}

	toJSON(): never {
		throw usedAsValue();
	}

	port(
		port: string,
		schema = info(this.node).out[port] ?? {},
	): RefImpl<unknown> {
		const { groups } = info(this.node);
		return new RefImpl(
			{ kind: "port", node: this.node, port, inner: false, groups },
			{ schema },
			current(),
		);
	}
}

/** A Ref to a group's `inner` port, readable only from the group's body. */
export function innerRef(
	group: string,
	port: string,
	schema: JsonSchema,
): RefImpl<unknown> {
	const groups = [...info(group).groups, group];
	return new RefImpl(
		{ kind: "port", node: group, port, inner: true, groups },
		{ schema },
		current(),
	);
}

/** A Ref that stands for a plain value, so a subcomposition's port can take one (D-16). */
export function literalRef(
	value: unknown,
	type: Type<unknown>,
	what: string,
): RefImpl<unknown> {
	checkPlain(value, what);
	return new RefImpl({ kind: "literal", value }, type, current());
}

type PlainProblem = "ref" | "json" | undefined;

const isJsonScalar = (v: unknown) =>
	v === null ||
	typeof v === "string" ||
	typeof v === "boolean" ||
	(typeof v === "number" && Number.isFinite(v));

const childrenOf = (v: unknown): unknown[] | undefined => {
	if (Array.isArray(v)) return v;
	return isPlainObject(v) ? Object.values(v) : undefined;
};

/** What keeps `value` from being a plain JSON value, if anything. */
export function plainProblem(value: unknown): PlainProblem {
	if (value instanceof RefImpl || value instanceof ResultImpl) return "ref";
	if (isJsonScalar(value)) return undefined;
	const children = childrenOf(value);
	if (!children) return "json";
	return children.map(plainProblem).find((p) => p !== undefined);
}

/** @throws `REF.value` for a Ref anywhere in `value`, `TYPE.literal` for anything else that is not JSON. */
export function checkPlain(value: unknown, what: string): void {
	const problem = plainProblem(value);
	if (problem === "ref")
		throw fail(
			"REF.value",
			`${what} holds a Ref, and it must be a plain value`,
			childrenOf(value)
				? "Pass the Ref itself, not an object or array holding it, to an input port of its own, or combine Refs with a code node"
				: "Feed the Ref to an input port of its own, or combine Refs with a code node",
		);
	if (problem === "json")
		throw fail(
			"TYPE.literal",
			`${what} is not a JSON value`,
			"Pass only strings, finite numbers, booleans, null, arrays and plain objects",
		);
}

const jsonType = (v: unknown): string => {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
	return typeof v;
};

/** The JSON types of `values`, as a schema. */
export function schemaOf(values: unknown[]): JsonSchema {
	const types = [...new Set(values.map(jsonType))].toSorted();
	if (types.length === 0) return {};
	return { type: types.length === 1 ? types[0] : types };
}

/** The item schema of a list schema, or any value when it names none. */
export const itemsOf = (list: JsonSchema): JsonSchema =>
	typeof list === "object" && list.items !== undefined
		? (list.items as JsonSchema)
		: {};

/** A schema that types a list: `type: "array"` or an `items` keyword. An untyped schema is not one. */
const isListSchema = (schema: JsonSchema) =>
	typeof schema === "object" &&
	(schema.type === "array" || schema.items !== undefined);

/** The schema of field `key` of `at`, or nothing when `at` names no fields. */
function fieldSchema(at: JsonSchema, key: string, path: string) {
	if (isListSchema(at))
		throw fail(
			"TYPE.path",
			`get path '${path}' goes into a list at '${key}'`,
			"Get a field of one item, or reduce the list with a code node",
		);
	const props =
		typeof at === "object" ? (at.properties as Ports | undefined) : undefined;
	if (!props) return undefined;
	const next = Object.hasOwn(props, key) ? props[key] : undefined;
	if (next === undefined)
		throw fail(
			"TYPE.path",
			`get path '${path}' names no field '${key}'`,
			`Get one of: ${Object.keys(props).join(", ")}`,
		);
	return next;
}

function pathSchema(schema: JsonSchema, path: string): JsonSchema {
	let at = schema;
	for (const key of path.split(".")) {
		const next = fieldSchema(at, key, path);
		if (next === undefined) return {};
		at = next;
	}
	return at;
}

/** Checks that a Ref can be read from the current frame. Returns its port source. */
export function visible<T>(ref: RefImpl<T>): PortSource {
	const s = current();
	if (ref.owner !== s)
		throw fail(
			"REF.escape",
			"a Ref from another build was used",
			"Create every Ref inside the build that uses it",
		);
	const { source } = ref;
	if (source.kind !== "port")
		throw new Error("a literal Ref has no port source");
	const left = source.groups.find((g, i) => s.frame.groups[i] !== g);
	if (left !== undefined)
		throw fail(
			"REF.escape",
			`a Ref to '${source.node}.${source.port}' was used outside the body of group '${left}'`,
			`Read it outside through the result of group '${left}', such as a parMap's results`,
		);
	return source;
}

const isBool = (schema: JsonSchema) =>
	typeof schema === "object" && schema.type === "boolean";

/** A visible Bool output of a node. @throws `REF.bool` naming `what` otherwise. */
export function boolPort(
	value: unknown,
	what: string,
	hint: string,
): PortSource {
	if (
		value instanceof RefImpl &&
		value.source.kind === "port" &&
		isBool(value.type.schema)
	)
		return visible(value);
	const got =
		value instanceof RefImpl
			? "a Ref that is not a Bool node output"
			: `a plain ${typeof value}`;
	throw fail(
		"REF.bool",
		`${what} needs a Ref<Bool> from a node output, got ${got}`,
		hint,
	);
}

export function worker(fn: CodeFn): WorkerRef {
	const { context } = current();
	let found: WorkerRef | undefined;
	try {
		found = context.resolveCode(fn);
	} catch (error) {
		throw fail(
			"SCOPE.export",
			messageOf(error),
			"Export the function under one name",
		);
	}
	if (found) return found;
	const name = fn.name ? `function '${fn.name}'` : "an anonymous function";
	const example = fn.name ?? "tally";
	throw fail(
		"SCOPE.export",
		`${name} is not an exported function the loader can name`,
		fn.name
			? `Export it from the composition file or pack entry, next to its import: \`export { ${example} };\``
			: "Name the function and export it from the composition file or pack entry, then pass the export itself",
	);
}

export { STDLIB_MODULE };

export const SDK_VERSION = pkg.version;

/** The `codeHash` of every stdlib reference: the module and the version of the SDK that holds it (ADR 0008). */
export const STDLIB_HASH = `${STDLIB_MODULE}@${SDK_VERSION}`;

/** The name of a stdlib function, so a node cannot name an export the module lacks (ADR 0008). */
export type StdlibName = keyof typeof stdlibFunctions;

type StdlibOptions = Common & {
	fanin?: boolean;
	/** The id's last segment when `label` is absent. Defaults to `name`. */
	derived?: string;
};

/** A node of the engine's standard library (ADR 0008). */
export function stdlib(
	name: StdlibName,
	inputs: Record<string, unknown>,
	out: Ports,
	{ fanin = false, derived = name, ...common }: StdlibOptions = {},
): ResultImpl {
	return addNode(
		{
			kind: "code",
			label: derived,
			inputs,
			out,
			fanin,
			fields: {
				worker: {
					runtime: TS_RUNTIME,
					module: STDLIB_MODULE,
					export: name,
					codeHash: STDLIB_HASH,
				},
				fanin: fanin || undefined,
			},
		},
		common,
	);
}

/** The last segment of the node a Ref reads, or `literal` for a Ref that stands for a plain value. */
export const sourceOf = (ref: unknown): string =>
	ref instanceof RefImpl && ref.source.kind === "port"
		? lastSegment(ref.source.node)
		: "literal";

const described = (value: unknown) =>
	value instanceof RefImpl
		? value.source.kind === "port"
			? { node: value.source.node, port: value.source.port }
			: { literal: value.source.value }
		: { literal: value };

/**
 * A stdlib node with one output, `value`, returned as a Ref. Its id is `derived` unless a label is given (sdk-spec:
 * Refs and mapping between nodes). A lift's id names its source and what it does: `x.or(d)` is `x_or`, and
 * `readJson(planner.out.plan)` is `planner_plan_json`, so two JSON outputs of one node need no labels.
 * @throws `SCOPE.duplicate` that says to reuse the earlier Ref when an identical lift already holds the id.
 */
export function lift(
	name: StdlibName,
	derived: string,
	inputs: Record<string, unknown>,
	value: JsonSchema,
	opts: StdlibOptions = {},
): RefImpl<unknown> {
	const s = current();
	const what = canonicalJson({
		name,
		inputs: Object.fromEntries(
			Object.entries(inputs).map(([port, v]) => [port, described(v)]),
		),
		when: opts.when === undefined ? undefined : described(opts.when),
		tolerate: opts.tolerate,
	});
	const id = idOf(derived);
	if (opts.label === undefined && s.lifts.get(id) === what)
		throw fail(
			"SCOPE.duplicate",
			`id '${id}' is used more than once, by the same ${name} twice`,
			`Reuse the Ref the first ${name} returned`,
			id,
		);
	const node = stdlib(name, inputs, { value }, { ...opts, derived });
	s.lifts.set(node.node, what);
	return node.port("value");
}

export type NodeSpec = {
	kind: string;
	/** The label when `Common.label` is absent. */
	label: string;
	/** Port name to a Ref, or to a plain value that becomes a literal. */
	inputs: Record<string, unknown>;
	out: Ports;
	/** Kind-specific IR fields. */
	fields: Record<string, unknown>;
	/** Data inputs arrive as `Settled` (ADR 0006). */
	fanin?: boolean;
};

/** Emits a node with its input edges, guard and tolerance. Returns its IR entry, which a group completes. */
export function pushNode(spec: NodeSpec, common: Common): IrNode {
	const s = current();
	const id = claimId(common.label, spec.label);
	const fanin = spec.fanin ?? false;
	s.info.set(id, {
		kind: spec.kind,
		groups: s.frame.groups,
		out: spec.out,
		fanin,
	});
	const node = {
		id,
		kind: spec.kind,
		out: Object.keys(spec.out).length ? spec.out : undefined,
		...spec.fields,
	} as IrNode;
	s.nodes.push(node);
	const upstream = wire(node, spec.inputs, fanin);
	if (common.when !== undefined) {
		const guard = boolPort(
			common.when,
			"when",
			"For a plain value, branch with a build-time if instead",
		);
		s.edges.push({
			kind: "control",
			from: { node: guard.node, port: guard.port },
			to: { node: id },
		});
		if (!guard.inner) upstream.add(guard.node);
	}
	if (common.tolerate)
		for (const from of upstream)
			s.edges.push({
				kind: "control",
				from: { node: from },
				to: { node: id },
				tolerate: common.tolerate,
			});
	return node;
}

export function addNode(spec: NodeSpec, common: Common): ResultImpl {
	return new ResultImpl(pushNode(spec, common).id);
}

type Wiring = {
	ports: Ports;
	literals: Record<string, unknown>;
	/** Upstream nodes outside every enclosing group. */
	upstream: Set<string>;
};

/** Feeds each input port by an edge or a literal. Returns the upstream nodes outside any enclosing group. */
function wire(
	node: IrNode,
	inputs: Record<string, unknown>,
	fanin: boolean,
): Set<string> {
	const w: Wiring = { ports: {}, literals: {}, upstream: new Set() };
	for (const [port, value] of Object.entries(inputs))
		wirePort(node.id, port, inputRef(port, value), fanin, w);
	if (Object.keys(w.ports).length) node.in = w.ports;
	if (Object.keys(w.literals).length) node.literals = w.literals;
	return w.upstream;
}

function inputRef(port: string, value: unknown): RefImpl<unknown> {
	if (value instanceof RefImpl) return value;
	if (value instanceof ResultImpl)
		throw fail(
			"REF.value",
			`input '${port}' got a node's result, not one of its ports`,
			"Pass a port, such as result.out.<name>, result.ok or result.reason",
		);
	return literalRef(value, { schema: schemaOf([value]) }, `input '${port}'`);
}

function wirePort(
	node: string,
	port: string,
	ref: RefImpl<unknown>,
	fanin: boolean,
	w: Wiring,
): void {
	w.ports[port] = ref.type.schema;
	if (ref.source.kind === "literal") {
		w.literals[port] = ref.source.value;
		return;
	}
	const source = visible(ref);
	const collect = isResults(source);
	// A fan-in node receives each data input as Settled; a collect input already is a Settled list (ADR 0006).
	if (fanin && !collect) w.ports[port] = settledSchema(ref.type.schema);
	current().edges.push({
		kind: collect ? "collect" : "data",
		from: { node: source.node, port: source.port },
		to: { node, port },
	});
	if (!source.inner) w.upstream.add(source.node);
}

/** A `parMap` or `map`'s `results`, which leave it only through `collect` edges (CORE-03). */
export const isResults = (source: PortSource) =>
	!source.inner && source.port === "results" && collects(info(source.node));
