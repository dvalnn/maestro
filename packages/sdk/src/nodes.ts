import {
	type ArtifactRef,
	type Cardinality,
	type CodeContext,
	canonicalJson,
	firstDuplicate,
	type GroupNode,
	isPlainObject,
	itemKey,
	type JsonSchema,
	MAX_TIMEOUT,
	type PortRef,
	type Ports,
	type Rejection,
	type RepeatNode,
	type SeqNode,
	type Settled as SettledValue,
	settledSchema,
	type Tolerate,
} from "@maestro/ir";
import {
	addNode,
	boolPort,
	type Common,
	checkPlain,
	current,
	fail,
	info,
	innerFrame,
	innerRef,
	itemsOf,
	pushNode,
	type Ref,
	RefImpl,
	type Refs,
	type Result,
	ResultImpl,
	schemaOf,
	withFrame,
	worker,
} from "./graph";
import { schemas, type Type, type Types, type ValueOf } from "./types";

type NoOutputs = Record<never, never>;

// The constructors' generic output types are the caller's declaration; the handle holds the same ports.
const typed = <O extends Types>(result: ResultImpl) =>
	result as unknown as Result<O>;

/** A value a code function hands back. At an artifact it may be the absolute path of a file it wrote (ADR 0007). */
export type Written<T> = T extends ArtifactRef
	? T | string
	: T extends readonly (infer E)[]
		? Written<E>[]
		: T extends object
			? { [K in keyof T]: Written<T[K]> }
			: T;

/** What a code function returns for the outputs `O`. */
export type CodeOutputs<O extends Types> = {
	[K in keyof O]: Written<ValueOf<O[K]>>;
};

/** Each input a code function takes, fed by a Ref to its value or by the value itself as a literal (D-16). */
export type CodeInputs<I> = { [K in keyof I]: Ref<I[K]> | I[K] };

/**
 * A code function: inputs and outputs keyed by port name, returned as such or as a promise (ADR 0008). A rejection's
 * outputs, when given, are the same full outputs.
 */
export type CodeFunction<I, O extends Types> = (
	inputs: I,
	ctx: CodeContext,
) =>
	| CodeOutputs<O>
	| Rejection<CodeOutputs<O>>
	| Promise<CodeOutputs<O> | Rejection<CodeOutputs<O>>>;

export type CodeOptions<I, O extends Types> = Common &
	(keyof I extends never ? { in?: CodeInputs<I> } : { in: CodeInputs<I> }) & {
		out?: O;
		/** Paths the node reads, as written. Never read at build. */
		reads?: string[];
		/** Paths the node writes, as written. Never read at build. */
		writes?: string[];
		/** Milliseconds the node may take before it settles `failed`. None by default. */
		timeout?: number;
	};

/**
 * A code node whose worker is `fn`, an exported function, checked against `in` and `out` at compile time (ADR 0008).
 * @throws `SCOPE.export` for any other function.
 */
export function code<I, O extends Types = NoOutputs>(
	fn: CodeFunction<I, NoInfer<O>>,
	opts: CodeOptions<NoInfer<I>, O> = {} as CodeOptions<NoInfer<I>, O>,
): Result<O> {
	const ref = worker(fn);
	return typed(
		addNode(
			{
				kind: "code",
				label: ref.export,
				inputs: (opts.in ?? {}) as Record<string, unknown>,
				out: schemas(opts.out),
				fields: {
					worker: ref,
					timeout: checkTimeout(opts.timeout, opts.label ?? ref.export),
					reads: opts.reads,
					writes: opts.writes,
				},
			},
			opts,
		),
	);
}

export type HostNodeOptions<O extends Types> = Common & {
	in?: Record<string, unknown>;
	out?: O;
	/** Kind-specific configuration, a plain value. */
	config?: Record<string, unknown>;
};

/** A node of a host kind, `<host>.<kind>`, for host SDKs to wrap (sdk-spec 12). */
export function hostNode<O extends Types = NoOutputs>(
	kind: `${string}.${string}`,
	opts: HostNodeOptions<O> = {},
): Result<O> {
	if (opts.config !== undefined) checkPlain(opts.config, `config of '${kind}'`);
	return typed(
		addNode(
			{
				kind,
				label: kind.slice(kind.indexOf(".") + 1),
				inputs: opts.in ?? {},
				out: schemas(opts.out),
				fields: { config: opts.config },
			},
			opts,
		),
	);
}

/**
 * A policy or invariant. A plain `cond` is checked now: true emits nothing, false throws `ASSERT.failed`. A Ref
 * becomes an assert node that settles `onFail` when the condition is false.
 */
export function assert(
	cond: boolean | Ref<boolean>,
	message: string,
	opts: Common & { onFail: "rejected" | "failed" },
): void {
	if (cond === true) return;
	if (cond === false)
		throw fail(
			"ASSERT.failed",
			`assert failed: ${message}`,
			"Change the params or config that break it",
		);
	boolPort(cond, "assert", "Pass a plain boolean, or a Bool output of a node");
	pushNode(
		{
			kind: "assert",
			label: "assert",
			inputs: { cond },
			out: {},
			fields: { message, onFail: opts.onFail },
		},
		opts,
	);
}

type Items<T> = readonly T[] | Ref<T[]>;

/** Build-time items as an array, or undefined for items a node delivers. */
function plainItems(items: unknown, kind: string): unknown[] | undefined {
	let value = items;
	if (items instanceof RefImpl) {
		if (items.source.kind === "port") return undefined;
		value = items.source.value;
	}
	if (!Array.isArray(value))
		throw fail(
			"TYPE.items",
			`${kind} items must be a list or a Ref to one`,
			"Pass an array, or a list output of a node",
		);
	checkPlain(value, `${kind} items`);
	return value;
}

const itemSchema = (
	items: unknown,
	plain: unknown[] | undefined,
): JsonSchema =>
	plain ? schemaOf(plain) : itemsOf((items as RefImpl<unknown>).type.schema);

/** @throws `BOUND.max` unless `max` is a whole number of at least 1. */
function checkMax(max: unknown, what: string): number {
	if (max === undefined)
		throw fail(
			"BOUND.max",
			`${what} needs max, since its size is not known at build`,
			"Set max to a literal or a param",
		);
	if (typeof max === "number" && Number.isInteger(max) && max >= 1) return max;
	const got = max instanceof RefImpl ? "a Ref" : JSON.stringify(max);
	throw fail(
		"BOUND.max",
		`max of ${what} must be a whole number of at least 1, got ${got}`,
		"Set max from a literal or a param",
	);
}

/** @throws `BOUND.timeout` unless `timeout` is absent or a whole number from 1 to `MAX_TIMEOUT`. */
function checkTimeout(timeout: unknown, what: string): number | undefined {
	if (
		timeout === undefined ||
		(Number.isInteger(timeout) &&
			Number(timeout) >= 1 &&
			Number(timeout) <= MAX_TIMEOUT)
	)
		return timeout as number | undefined;
	throw fail(
		"BOUND.timeout",
		`timeout of code node '${what}' must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT}, got ${JSON.stringify(timeout)}`,
		"Set timeout within that range, or leave it out for no limit",
	);
}

// Only a map over build-time items has an exact size; any other group may stop early or wait on a node (CORE-05).
function cardinality(
	kind: "map" | "seq",
	plain: unknown[] | undefined,
	max: number | undefined,
): Cardinality {
	if (plain === undefined) return { upTo: checkMax(max, `${kind} over a Ref`) };
	if (max !== undefined)
		throw fail(
			"BOUND.max",
			`${kind} over a build-time list takes no max`,
			`Remove max: the list's ${plain.length} items bound it`,
		);
	if (kind === "map") return { exact: plain.length };
	if (plain.length === 0)
		throw fail(
			"BOUND.max",
			"seq over an empty list has nothing to try",
			"Give seq at least one item",
		);
	return { upTo: plain.length };
}

function openGroup(
	kind: "map" | "seq",
	items: unknown,
	max: number | undefined,
	common: Common,
	fields: object,
) {
	const plain = plainItems(items, kind);
	const group = pushNode(
		{
			kind,
			label: kind,
			inputs: plain ? {} : { items },
			out: {},
			fields: {
				...fields,
				items: plain,
				cardinality: cardinality(kind, plain, max),
			},
		},
		common,
	) as GroupNode;
	const schema = itemSchema(items, plain);
	group.inner = { item: schema };
	return { group, plain, item: innerRef(group.id, "item", schema) };
}

const memberOf = (value: unknown, group: string) =>
	value instanceof ResultImpl && info(value.node).groups.at(-1) === group
		? value.node
		: undefined;

const noMember = (group: string, wanted: string) =>
	fail(
		"TYPE.member",
		`the body of ${info(group).kind} '${group}' must return ${wanted} of a node inside it`,
		"Return the Result handle of a node the body creates",
	);

function member(returned: unknown, group: string): string {
	const id = memberOf(returned, group);
	if (id === undefined) throw noMember(group, "the result");
	return id;
}

/** One member named `result`, or one per entry of an object of results (ADR 0004). */
function mapMembers(returned: unknown, group: string): Record<string, string> {
	const one = memberOf(returned, group);
	if (one !== undefined) return { result: one };
	const wanted = "a result, or an object of results,";
	const entries = isPlainObject(returned) ? Object.entries(returned) : [];
	if (entries.length === 0) throw noMember(group, wanted);
	return Object.fromEntries(
		entries.map(([name, value]) => {
			const id = memberOf(value, group);
			if (id === undefined) throw noMember(group, wanted);
			return [name, id];
		}),
	);
}

const UNTIL_HINT =
	"Return r.ok or a Bool output of a node in the body; a comparison such as !== on a Ref gives a plain boolean";

/**
 * Calls `until` on the member's handle inside the body. `until` must return a Bool port of a body node (sdk-spec 4.1).
 */
function untilPort(
	until: ((result: Result<Types>) => Ref<boolean>) | undefined,
	memberId: string,
	group: string,
): PortRef | undefined {
	if (!until) return undefined;
	const source = withFrame(innerFrame(group, true), () =>
		boolPort(until(new ResultImpl(memberId)), "until", UNTIL_HINT),
	);
	if (source.inner || info(source.node).groups.at(-1) !== group)
		throw fail(
			"REF.bool",
			`until of '${group}' must read a node inside its body`,
			UNTIL_HINT,
		);
	return { node: source.node, port: source.port };
}

/** A seq or repeat exposes its member's outputs as its own (ADR 0004). */
function mirror(group: GroupNode, memberId: string): void {
	const { out } = info(memberId);
	info(group.id).out = out;
	if (Object.keys(out).length) group.out = out;
}

export type MapOptions<T> = Common & {
	/** No default (ADR 0006). */
	onError: "settle" | "propagate";
	/** Required when `items` is a Ref. */
	max?: number;
	/** An exported function that names an item (D-18, ADR 0008). */
	key?: (item: T) => string;
};

/** The value of one member of map `id`: a record by result name of each result's outputs (ADR 0004). */
export function memberSchema(id: string): JsonSchema {
	const node = current().nodes.find((n) => n.id === id);
	const members = node?.kind === "map" ? node.members : {};
	return {
		type: "object",
		properties: Object.fromEntries(
			Object.entries(members).map(([name, member]) => [
				name,
				{ type: "object", properties: info(member).out },
			]),
		),
	};
}

export type MapResults = {
	results: Type<SettledValue<Record<string, unknown>>[]>;
};

/**
 * One body instance per item, in parallel. Build-time items are keyed by `itemKey`, and a duplicate key throws
 * `SCOPE.key`. A key function is called only at perform, where a duplicate key fails the map.
 */
export function map<T>(
	items: Items<T>,
	body: (item: Ref<T>) => Result | Record<string, Result>,
	opts: MapOptions<T>,
): Result<MapResults> {
	const key = opts.key === undefined ? undefined : worker(opts.key);
	const fields = { onError: opts.onError, key };
	const { group, plain, item } = openGroup(
		"map",
		items,
		opts.max,
		opts,
		fields,
	);
	if (plain && !key) checkKeys(plain);
	group.members = withFrame(innerFrame(group.id, true), () =>
		mapMembers(body(item as Ref<T>), group.id),
	);
	const results = {
		type: "array",
		items: settledSchema(memberSchema(group.id)),
	};
	group.out = { results };
	info(group.id).out = group.out;
	return typed(new ResultImpl(group.id));
}

function checkKeys(items: unknown[]): void {
	const dup = firstDuplicate(items.map(itemKey));
	if (dup)
		throw fail(
			"SCOPE.key",
			`map item key '${dup.key}' appears more than once`,
			"Make the items unique, or give map a key function",
		);
}

export type SeqOptions<O extends Types> = Common & {
	/** Stops at the first item whose result meets it. */
	until?: (result: Result<O>) => Ref<boolean>;
	/** Required when `items` is a Ref. */
	max?: number;
};

/** One body instance per item, in order, up to the first whose result meets `until`. */
export function seq<T, O extends Types>(
	items: Items<T>,
	body: (item: Ref<T>) => Result<O>,
	opts: SeqOptions<O> = {},
): Result<O> {
	const { group, item } = openGroup("seq", items, opts.max, opts, {});
	const id = withFrame(innerFrame(group.id, true), () =>
		member(body(item as Ref<T>), group.id),
	);
	group.members = { result: id };
	mirror(group, id);
	(group as SeqNode).until = untilPort(
		opts.until as (r: Result<Types>) => Ref<boolean>,
		id,
		group.id,
	);
	return typed(new ResultImpl(group.id));
}

export type RepeatOptions<O extends Types> = Omit<Common, "tolerate"> & {
	/** The node whose outputs are the first state. */
	init: Result<O>;
	/** Builds one iteration from the previous state, whose outputs it must repeat. */
	step: (state: { out: Refs<O> }, index: Ref<number>) => Result<O>;
	/** Read on each new state, never on `init`. */
	until?: (result: Result<O>) => Ref<boolean>;
	/** A literal or a param. */
	max: number;
	/** Carries a `rejected` state, the initial one included, into the next iteration. */
	tolerate?: Tolerate;
};

/** A bounded loop over typed state. At least one iteration happens. */
export function repeat<O extends Types>(opts: RepeatOptions<O>): Result<O> {
	const init: unknown = opts.init;
	if (!(init instanceof ResultImpl))
		throw fail(
			"TYPE.member",
			"repeat init must be a node's result",
			"Pass the Result handle of the node that makes the first state",
		);
	const state = info(init.node).out;
	const group = pushNode(
		{
			kind: "repeat",
			label: "repeat",
			inputs: init.out,
			out: state,
			fields: {
				cardinality: { upTo: checkMax(opts.max, "repeat") },
				tolerate: opts.tolerate,
			},
		},
		{ label: opts.label, when: opts.when },
	) as RepeatNode;
	if (Object.hasOwn(state, "index"))
		throw fail(
			"TYPE.state",
			`the state of repeat '${group.id}' has a port named 'index', which names the iteration`,
			"Rename the 'index' output of init and of the step",
		);
	group.inner = { ...state, index: { type: "integer" } };
	const refs = Object.fromEntries(
		Object.entries(state).map(([port, schema]) => [
			port,
			innerRef(group.id, port, schema),
		]),
	);
	const index = innerRef(group.id, "index", { type: "integer" }) as Ref<number>;
	const id = withFrame(innerFrame(group.id, true), () =>
		member(opts.step({ out: refs as unknown as Refs<O> }, index), group.id),
	);
	checkState(id, state, group.id);
	group.members = { result: id };
	group.until = untilPort(
		opts.until as (r: Result<Types>) => Ref<boolean>,
		id,
		group.id,
	);
	return typed(new ResultImpl(group.id));
}

function checkState(memberId: string, state: Ports, group: string): void {
	const got = info(memberId).out;
	const differ = [...new Set([...Object.keys(state), ...Object.keys(got)])]
		.filter((port) => canonicalJson(state[port]) !== canonicalJson(got[port]))
		.toSorted();
	if (differ.length)
		throw fail(
			"TYPE.state",
			`the step of repeat '${group}' differs from init in the ports ${differ.join(", ")}`,
			"Return a node whose outputs have the names and types of init's",
		);
}
