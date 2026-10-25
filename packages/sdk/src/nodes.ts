import {
	type ArtifactRef,
	type Cardinality,
	type CodeContext,
	canonicalJson,
	collects,
	DURATION_EXAMPLE,
	durationMs,
	type FindNode,
	FOLD_STATE,
	type FoldNode,
	firstDuplicate,
	type GroupNode,
	IMPLICIT_OUT,
	isPlainObject,
	itemKey,
	type JsonSchema,
	LOOP_STATE,
	type LoopNode,
	MAX_TIMEOUT,
	type OnError,
	type ParFindNode,
	type PortRef,
	type Ports,
	type Rejection,
	type Settled as SettledValue,
	settledSchema,
	type Tolerate,
	type WorkerRef,
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
	literalRef,
	pushNode,
	type Ref,
	RefImpl,
	type Result,
	ResultImpl,
	schemaOf,
	withFrame,
	worker,
} from "./graph";
import { schemas, type Type, type Types, type ValueOf } from "./types";

export type NoOutputs = Record<never, never>;

// The constructors' generic output types are the caller's declaration; the handle holds the same ports.
export const typed = <O extends Types>(result: ResultImpl) =>
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
		/** How long the node may take before it settles `failed`: milliseconds, or a duration such as `90s`. None by default. */
		timeout?: number | string;
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
					timeout: timeoutMs(
						opts.timeout,
						`timeout of code node '${opts.label ?? ref.export}'`,
					),
				},
			},
			opts,
		),
	);
}

/** `value` as an input of declared `type`, so a plain value can feed a port of a host type (sdk-spec 9). */
export const literal = <T>(value: T, type: Type<T>): Ref<T> =>
	literalRef(value, type, "literal") as Ref<T>;

/** A policy or invariant on a plain value, checked now: true emits nothing, false throws `ASSERT.failed`. */
export function assert(cond: boolean, message: string): void;
/** A policy or invariant on a Ref: an assert node that settles `onFail` when the condition is false. */
export function assert(
	cond: Ref<boolean>,
	message: string,
	opts: Common & { onFail: "rejected" | "failed" },
): Result;
export function assert(
	cond: boolean | Ref<boolean>,
	message: string,
	opts?: Common & { onFail: "rejected" | "failed" },
): Result | undefined {
	if (cond === true) return;
	if (cond === false)
		throw fail(
			"ASSERT.failed",
			`assert failed: ${message}`,
			"Change the params or config that break it",
		);
	boolPort(cond, "assert", "Pass a plain boolean, or a Bool output of a node");
	return addNode(
		{
			kind: "assert",
			label: "assert",
			inputs: { cond },
			out: {},
			fields: { message, onFail: opts?.onFail },
		},
		opts ?? {},
	);
}

type Items<T> = readonly T[] | Ref<T[]>;

type ItemOf<I> = I extends readonly (infer T)[]
	? T
	: I extends Ref<(infer T)[]>
		? T
		: never;

/** Over a written list a group takes no `max`; over a Ref it needs one, a literal or a param (CORE-05). */
type Bound<I> = I extends readonly unknown[]
	? { max?: never }
	: { max: number };

/** The options argument of a group whose options are all optional over a written list. */
type BoundArgs<I, O> = I extends readonly unknown[]
	? [opts?: O & Bound<I>]
	: [opts: O & Bound<I>];

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
	if (typeof max === "number" && Number.isInteger(max) && max >= 1) return max;
	const got = max instanceof RefImpl ? "a Ref" : String(JSON.stringify(max));
	throw fail(
		"BOUND.max",
		`max of ${what} must be a whole number of at least 1, got ${got}`,
		"Set max from a literal or a param",
	);
}

/**
 * `timeout` in milliseconds, which `what` names in the error, such as `timeout of code node 'x'`.
 * @throws `BOUND.timeout` unless it is absent, a duration, or a whole number from 1 to `MAX_TIMEOUT`.
 */
export function timeoutMs(timeout: unknown, what: string): number | undefined {
	if (timeout === undefined) return undefined;
	const ms = typeof timeout === "string" ? durationMs(timeout) : timeout;
	if (
		typeof ms === "number" &&
		Number.isInteger(ms) &&
		ms >= 1 &&
		ms <= MAX_TIMEOUT
	)
		return ms;
	throw fail(
		"BOUND.timeout",
		`${what} must be a duration or a whole number of milliseconds from 1 to ${MAX_TIMEOUT}, got ${JSON.stringify(timeout)}`,
		`Write it as a duration such as ${DURATION_EXAMPLE}, or leave it out for no limit`,
	);
}

type ItemsKind = Exclude<GroupNode["kind"], "loop">;

// Only a parMap over build-time items, or a group over none, has an exact size; any other may stop early (CORE-05).
function cardinality(
	kind: ItemsKind,
	plain: unknown[] | undefined,
	max: unknown,
): Cardinality {
	if (plain === undefined) return { upTo: checkMax(max, `${kind} over a Ref`) };
	if (kind === "parMap" || plain.length === 0) return { exact: plain.length };
	return { upTo: plain.length };
}

function openGroup(
	kind: ItemsKind,
	items: unknown,
	opts: Omit<Common, "tolerate"> & { max?: unknown },
	fields: object = {},
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
				cardinality: cardinality(kind, plain, opts.max),
			},
		},
		opts,
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

/** One member named `result`, or one per entry of an object of two or more results (ADR 0004). */
function collectedMembers(
	returned: unknown,
	group: string,
): Record<string, string> {
	const one = memberOf(returned, group);
	if (one !== undefined) return { result: one };
	const wanted = "a result, or an object of two or more results,";
	const entries = isPlainObject(returned) ? Object.entries(returned) : [];
	if (entries.length === 1)
		throw fail(
			"TYPE.member",
			`the body of ${info(group).kind} '${group}' returns an object of one result`,
			"Return that Result handle itself",
		);
	if (entries.length === 0) throw noMember(group, wanted);
	return Object.fromEntries(
		entries.map(([name, value]) => {
			const id = memberOf(value, group);
			if (id === undefined) throw noMember(group, wanted);
			return [name, id];
		}),
	);
}

const MEMBER_HINT =
	"Return r.ok or a Bool output of a node in the body; a comparison such as !== on a Ref gives a plain boolean";

/**
 * The Bool port `read` returns inside the body of `group`, which must belong to a node of that body, or to the state
 * of `group` when `state` (sdk-spec 4.1).
 */
function bodyBool(
	group: string,
	what: string,
	hint: string,
	read: () => unknown,
	state = false,
): PortRef {
	const source = withFrame(innerFrame(group, true), () =>
		boolPort(read(), what, hint),
	);
	if (state && source.inner && source.node === group)
		return { node: source.node, port: source.port };
	if (source.inner || info(source.node).groups.at(-1) !== group)
		throw fail(
			"REF.bool",
			`${what} of '${group}' must read a node inside its body`,
			hint,
		);
	return { node: source.node, port: source.port };
}

/** A group exposes the outputs of the member it mirrors as its own (ADR 0004). */
function mirror(group: GroupNode, memberId: string): void {
	const { out } = info(memberId);
	info(group.id).out = out;
	if (Object.keys(out).length) group.out = out;
}

type Keyed<T> = {
	/** An exported function that names an item (D-18, ADR 0008). */
	key?: (item: T) => string;
};

/** `onError` has no default. */
export type ParMapOptions<T> = Common & Keyed<T> & { onError: OnError };

export type MapOptions = Common & { onError: OnError };

type Body = Result | Readonly<Record<string, Result>>;

type OutputsOf<R> = R extends { readonly out: infer P }
	? { [K in keyof P]: P[K] extends Ref<infer V> ? V : never }
	: never;

/** The value of one member of a body returning `B`: a result's outputs, or a record of them by result name. */
type MemberOf<B> = B extends Result
	? OutputsOf<B>
	: { [K in keyof B]: OutputsOf<B[K]> };

/** The handle of a `parMap` or `map` whose members are each a `V`. */
export type MapResults<V = unknown> = { results: Type<SettledValue<V>[]> };

/**
 * The value of one member of `parMap` or `map` `id`: its one result's outputs, or a record by result name of each
 * result's outputs (ADR 0004).
 */
export function memberSchema(id: string): JsonSchema {
	const node = current().nodes.find((n) => n.id === id);
	const members = node && collects(node) ? node.members : {};
	const outputs = (member: string) => ({
		type: "object",
		properties: info(member).out,
	});
	const entries = Object.entries(members);
	const [only] = entries;
	if (entries.length === 1 && only) return outputs(only[1]);
	return {
		type: "object",
		properties: Object.fromEntries(
			entries.map(([name, member]) => [name, outputs(member)]),
		),
	};
}

function collected<B extends Body>(
	kind: "parMap" | "map",
	items: unknown,
	body: (item: Ref<never>) => B,
	opts: Common & { max?: unknown },
	fields: { onError: OnError; key?: WorkerRef },
): Result<MapResults<MemberOf<B>>> {
	const { group, plain, item } = openGroup(kind, items, opts, fields);
	if (plain && kind === "parMap" && !fields.key) checkKeys(plain, kind);
	group.members = withFrame(innerFrame(group.id, true), () =>
		collectedMembers(body(item as unknown as Ref<never>), group.id),
	);
	const results = {
		type: "array",
		items: settledSchema(memberSchema(group.id)),
	};
	group.out = { results };
	info(group.id).out = group.out;
	return typed(new ResultImpl(group.id));
}

/** @throws `TYPE.options` when `what` is called without its options argument, for a caller the types do not reach. */
function requireOptions(
	what: string,
	needs: string,
	opts: unknown,
): asserts opts is object {
	if (opts) return;
	throw fail(
		"TYPE.options",
		`${what} needs an options argument with ${needs}`,
		`Pass an options object with ${needs}`,
	);
}

/**
 * One body instance per item, all at once. Build-time items are keyed by `itemKey`, and a duplicate key throws
 * `SCOPE.key`. A key function is called only at perform, where a duplicate key fails the group.
 */
function parMap<I extends Items<unknown>, B extends Body>(
	items: I,
	body: (item: Ref<ItemOf<I>>) => B,
	opts: ParMapOptions<ItemOf<I>> & Bound<I>,
): Result<MapResults<MemberOf<B>>> {
	requireOptions("iter.parMap", "'onError'", opts);
	return collected("parMap", items, body, opts, {
		onError: opts.onError,
		key: keyOf(opts.key),
	});
}

/** One body instance per item, in order; `stop` starts no item after a non-`ok` member. */
function map<I extends Items<unknown>, B extends Body>(
	items: I,
	body: (item: Ref<ItemOf<I>>) => B,
	opts: MapOptions & Bound<I>,
): Result<MapResults<MemberOf<B>>> {
	requireOptions("iter.map", "'onError'", opts);
	return collected("map", items, body, opts, { onError: opts.onError });
}

const keyOf = (key: ((item: never) => string) | undefined) =>
	key === undefined ? undefined : worker(key);

/** @throws `SCOPE.key` when two of `items` share an item key. */
function checkKeys(items: unknown[], kind: string): void {
	const dup = firstDuplicate(items.map(itemKey));
	if (dup)
		throw fail(
			"SCOPE.key",
			`${kind} item key '${dup.key}' appears more than once`,
			`Make the items unique, or give ${kind} a key function`,
		);
}

function found<I extends Items<unknown>, O extends Types>(
	kind: "find" | "parFind",
	items: I,
	body: (item: Ref<ItemOf<I>>) => Result<O>,
	cond: (result: Result<O>) => Ref<boolean>,
	opts: Common & Keyed<never> & { max?: unknown } = {},
): Result<O> {
	const key = keyOf(opts.key);
	const { group, plain, item } = openGroup(kind, items, opts, { key });
	if (plain && kind === "parFind" && !key) checkKeys(plain, kind);
	const id = withFrame(innerFrame(group.id, true), () =>
		member(body(item as Ref<ItemOf<I>>), group.id),
	);
	group.members = { result: id };
	mirror(group, id);
	(group as FindNode | ParFindNode).cond = bodyBool(
		group.id,
		`the condition of iter.${kind}`,
		MEMBER_HINT,
		() => cond(new ResultImpl(id) as unknown as Result<O>),
	);
	return typed(new ResultImpl(group.id));
}

/** One body instance per item, in order, up to the first whose result meets `cond`; else the last member. */
function find<I extends Items<unknown>, O extends Types>(
	items: I,
	body: (item: Ref<ItemOf<I>>) => Result<O>,
	cond: (result: Result<O>) => Ref<boolean>,
	...[opts]: BoundArgs<I, Common>
): Result<O> {
	return found("find", items, body, cond, opts);
}

/**
 * One body instance per item, all at once. The first member to settle meeting `cond` is the result, and the others
 * are cancelled; else the last member to settle. Items are keyed as `parMap` keys them.
 */
function parFind<I extends Items<unknown>, O extends Types>(
	items: I,
	body: (item: Ref<ItemOf<I>>) => Result<O>,
	cond: (result: Result<O>) => Ref<boolean>,
	...[opts]: BoundArgs<I, Common & Keyed<ItemOf<I>>>
): Result<O> {
	return found("parFind", items, body, cond, opts as Keyed<never>);
}

export type FoldOptions<T, O extends Types> = Omit<Common, "tolerate"> & {
	/** Builds the first accumulator from the first item. */
	first: (item: Ref<T>) => Result<O>;
	/** Builds each next accumulator from the previous one and the next item, whose outputs it must repeat. */
	step: (acc: Result<O>, item: Ref<T>, index: Ref<number>) => Result<O>;
	/** Carries a `rejected` accumulator into the next step. */
	tolerate?: Tolerate;
};

/**
 * The first item seeds the accumulator through `first`, and `step` adds each next item, in order. The fold ends on its
 * last accumulator, or on one it cannot carry on from; no items is `skipped`.
 */
function fold<I extends Items<unknown>, O extends Types>(
	items: I,
	opts: FoldOptions<ItemOf<I>, O> & Bound<I>,
): Result<O> {
	requireOptions("iter.fold", "'first' and 'step'", opts);
	const { group, item } = openGroup(
		"fold",
		items,
		{ label: opts.label, when: opts.when, max: opts.max },
		{ tolerate: opts.tolerate },
	);
	const phase = (name: string) => ({
		...innerFrame(group.id, true),
		path: `${group.id}/${name}`,
	});
	const built = current().nodes.length;
	const first = withFrame(phase("first"), () =>
		member(opts.first(item as Ref<ItemOf<I>>), group.id),
	);
	const once = current()
		.nodes.slice(built)
		.filter((n) => info(n.id).groups.at(-1) === group.id);
	const out = info(first).out;
	mirror(group, first);
	const acc = carried<O>(group, out, FOLD_STATE, "first");
	const index = innerRef(group.id, "index", { type: "integer" }) as Ref<number>;
	const step = withFrame(phase("step"), () =>
		member(opts.step(acc, item as Ref<ItemOf<I>>, index), group.id),
	);
	checkState(step, out, group.id, "first");
	group.members = { first, step };
	(group as FoldNode).first = once.map((n) => n.id);
	return typed(new ResultImpl(group.id));
}

/** Iteration over a list known up front (sdk-spec 4.1). */
export const iter = { parMap, map, find, parFind, fold };

/**
 * The state `group` carries, with the outputs `out` and the ports `reserved` holds beside them, as a Result handle its
 * body reads. Sets the group's inner ports.
 * @throws `TYPE.state` when `out` has a port `reserved` names.
 */
function carried<O extends Types>(
	group: GroupNode,
	out: Ports,
	reserved: readonly string[],
	from: string,
): Result<O> {
	const clash = reserved.find((port) => Object.hasOwn(out, port));
	if (clash)
		throw fail(
			"TYPE.state",
			`the state of ${group.kind} '${group.id}' has a port named '${clash}', a name the ${group.kind} state holds itself`,
			`Rename the '${clash}' output of ${from} and of the step`,
		);
	const { ok, reason } = IMPLICIT_OUT;
	group.inner = {
		...group.inner,
		...out,
		ok,
		reason,
		index: { type: "integer" },
	};
	return {
		ok: innerRef(group.id, "ok", ok),
		reason: innerRef(group.id, "reason", reason),
		out: Object.fromEntries(
			Object.entries(out).map(([port, schema]) => [
				port,
				innerRef(group.id, port, schema),
			]),
		),
	} as unknown as Result<O>;
}

export type LoopOptions<O extends Types> = Omit<Common, "tolerate"> & {
	/** The node whose outputs are the first state. */
	init: Result<O>;
	/** Builds one iteration from the previous state, whose outputs it must repeat. */
	step: (state: Result<O>, index: Ref<number>) => Result<O>;
	/** A literal or a param. */
	max: number;
	/** Carries a `rejected` state, the initial one included, into the next iteration. */
	tolerate?: Tolerate;
};

const WHILE_HINT =
	"Return s.ok, a Bool port of the state, or a Bool output of a node built from the state, not from the step, such as not(s.ok)";

const DO_WHILE_HINT =
	"Return r.ok or a Bool output of a node in the body, such as not(r.ok)";

/**
 * A loop over typed state that reads `cond` on the state before each step and steps while it holds: 0 to `max` steps.
 * `cond` must return a Bool port of the state, or a Bool output of a node built from the state, not from the step.
 */
function whileLoop<O extends Types>(
	cond: (state: Result<O>) => Ref<boolean>,
	opts: LoopOptions<O>,
): Result<O> {
	const { group, state } = openLoop(opts, "start");
	const port = bodyBool(
		group.id,
		"the condition of loop.while",
		WHILE_HINT,
		() => cond(state),
		true,
	);
	group.test = { at: "start", port };
	group.members = { result: loopStep(group.id, opts, state) };
	return typed(new ResultImpl(group.id));
}

/**
 * A loop over typed state that steps, then reads `cond` on the step's result and goes on while it holds: 1 to `max`
 * steps.
 */
function doWhile<O extends Types>(
	cond: (result: Result<O>) => Ref<boolean>,
	opts: LoopOptions<O>,
): Result<O> {
	const { group, state } = openLoop(opts, "end");
	const id = loopStep(group.id, opts, state);
	group.members = { result: id };
	group.test = {
		at: "end",
		port: bodyBool(
			group.id,
			"the condition of loop.doWhile",
			DO_WHILE_HINT,
			() => cond(new ResultImpl(id) as unknown as Result<O>),
		),
	};
	return typed(new ResultImpl(group.id));
}

/** Bounded loops over typed state, told apart by when they read their condition (sdk-spec 4.1). */
export const loop = { while: whileLoop, doWhile };

/** The loop group fed by `opts.init`, and the state its body reads. */
function openLoop<O extends Types>(
	opts: LoopOptions<O>,
	at: LoopNode["test"]["at"],
) {
	const name = at === "start" ? "loop.while" : "loop.doWhile";
	requireOptions(name, "'init', 'step' and 'max'", opts);
	const init: unknown = opts.init;
	if (!(init instanceof ResultImpl))
		throw fail(
			"TYPE.member",
			`${name} init must be a node's result`,
			"Pass the Result handle of the node that makes the first state",
		);
	const out = info(init.node).out;
	const group = pushNode(
		{
			kind: "loop",
			label: "loop",
			inputs: init.out,
			out,
			fields: {
				cardinality: { upTo: checkMax(opts.max, name) },
				tolerate: opts.tolerate,
			},
		},
		{ label: opts.label, when: opts.when },
	) as LoopNode;
	const state = carried<O>(group, out, LOOP_STATE, "init");
	return { group, state };
}

/** Builds the step in the body of loop `group`. Returns its member's id. */
function loopStep<O extends Types>(
	group: string,
	opts: LoopOptions<O>,
	state: Result<O>,
): string {
	const index = innerRef(group, "index", { type: "integer" }) as Ref<number>;
	const id = withFrame(innerFrame(group, true), () =>
		member(opts.step(state, index), group),
	);
	checkState(id, info(group).out, group, "init");
	return id;
}

function checkState(
	memberId: string,
	state: Ports,
	group: string,
	from: "init" | "first",
): void {
	const got = info(memberId).out;
	const differ = [...new Set([...Object.keys(state), ...Object.keys(got)])]
		.filter((port) => canonicalJson(state[port]) !== canonicalJson(got[port]))
		.toSorted();
	if (differ.length)
		throw fail(
			"TYPE.state",
			`the step of ${info(group).kind} '${group}' differs from ${from} in the ports ${differ.join(", ")}`,
			`Return a node whose outputs have the names and types of ${from}'s`,
		);
}
