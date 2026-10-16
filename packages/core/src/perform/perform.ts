import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type AssertNode,
	boundOf,
	type CodeNode,
	type Facts,
	firstDuplicate,
	formatExpansion,
	formatInstance,
	type GraphIndex,
	type GroupNode,
	type HostNode,
	type Ir,
	type IrEdge,
	type IrNode,
	indexGraph,
	isGroup,
	itemKey,
	type MapNode,
	type Outcome,
	outputValue,
	type RepeatNode,
	type SeqNode,
	type Settled,
	TS_RUNTIME,
	tolerates,
	worstOutcome,
} from "@maestro/ir";
import { type Execution, type Host, kindLookup } from "../host";
import { portCheck, validator } from "../ports";
import {
	instanceKey,
	loadFunction,
	messageOf,
	unreadableReason,
} from "../shared";
import {
	type Inputs,
	type LoadCode,
	type NodeInstance,
	timed,
} from "../worker";
import {
	type ConcertDirs,
	concertDirs,
	makeDirs,
	scratchDir,
} from "./artifacts";
import { asserted, callOf, finish, type Kit } from "./execute";
import type { ConcertResult, RecordStore, Settling } from "./record";
import { tsWorker } from "./ts-worker";

export type PerformOptions = {
	/** IR that passed `parseIr`. */
	ir: Ir;
	hosts: readonly Host[];
	loadCode: LoadCode;
	record: RecordStore;
	/** The directory each concert's artifact area and scratch directories go under, in `<dir>/<concert id>/`. */
	dir: string;
	/** The most node instances executing at once in this concert (D-26). A positive integer. */
	concurrency: number;
};

/** A concert being performed. */
export type Performance = {
	concert: string;
	/** Settles with the result once every node instance has settled. */
	done: Promise<ConcertResult>;
	/**
	 * Cancels running instances through their kind's hook, latest started first, and settles them `failed`. No other
	 * instance starts or gets a record. The concert settles `failed`, its result with no node (architecture 7).
	 */
	cancel(): Promise<void>;
};

/** What an abandoned call settles with, which its halt then replaces. */
const ABANDONED: Execution = { outcome: "failed", reason: "abandoned" };

const CANCELLED: Halt = {
	outcome: "failed",
	reason: "the concert was cancelled",
};

/**
 * Why the instances of a frame stop: each instance not yet settled settles with this. A `failed` halt outranks a
 * `skipped` one.
 */
type Halt = { outcome: "failed" | "skipped"; reason: string };

/**
 * One instantiation of a body: the top level, or one item or iteration of a group, with that group's inner port
 * values. `keys` is the expansion path, one key per enclosing group.
 */
type Frame = {
	readonly keys: readonly string[];
	readonly parent?: Frame;
	readonly group?: string;
	readonly inner: Inputs;
	/** The previous iteration's member, whose outputs a `repeat` iteration's state ports hold. */
	readonly carried?: State;
	readonly states: Map<string, Promise<State>>;
	halt?: Halt;
};

/** How an instance ended, and the next step of the result rule from it (architecture 7). */
type Ending = Settling & { cause?: State };

/** A settled instance. `order` counts settlements within the concert. */
type State = NodeInstance & Ending & { order: number };

type Running = { frame: Frame; cancel(): Promise<void>; halted?: Halt };

type Slots = { acquire(): Promise<void>; release(): void };

/** `started` holds the instance keys `record.start` took. `inflight` holds each node settling, until it has. */
type Concert = {
	id: string;
	index: GraphIndex;
	loadCode: LoadCode;
	kit: Kit;
	slots: Slots;
	root: Frame;
	running: Set<Running>;
	started: Set<string>;
	inflight: Set<Promise<void>>;
	order: number;
};

/**
 * Starts performing `ir` as a new concert. Code nodes execute in process through `loadCode`, host nodes through their
 * host, and every instance and event goes to `record`.
 * @throws RangeError when `concurrency` is not a positive integer.
 */
export function perform(options: PerformOptions): Performance {
	const { ir, record, concurrency } = options;
	if (!Number.isInteger(concurrency) || concurrency < 1)
		throw new RangeError(
			`concurrency must be a positive integer, got ${concurrency}`,
		);
	const id = Bun.randomUUIDv7();
	record.begin({ id, ir, startedAt: Date.now() });
	const root: Frame = { keys: [], inner: {}, states: new Map() };
	const running = new Set<Running>();
	return {
		concert: id,
		done: conduct(id, options, root, running),
		cancel: () => halt(running, root, CANCELLED),
	};
}

/**
 * Performs the concert and records its result. A throw halts the running instances `failed` and waits for every node
 * to settle, so the concert settles `failed` with no node and none stays running.
 */
async function conduct(
	id: string,
	options: PerformOptions,
	root: Frame,
	running: Set<Running>,
): Promise<ConcertResult> {
	const inflight = new Set<Promise<void>>();
	const dirs = concertDirs(resolve(options.dir), id);
	let result: ConcertResult;
	try {
		result = await performed(id, options, dirs, root, running, inflight);
	} catch (error) {
		const failed = { outcome: "failed", reason: messageOf(error) } as const;
		await halt(running, root, failed);
		while (inflight.size > 0) await Promise.all(inflight);
		result = failed;
	}
	// Each instance removed its own scratch directory, so what is left is empty and does not change how the concert
	// settled.
	await rm(dirs.scratch, { recursive: true, force: true }).catch(
		() => undefined,
	);
	options.record.finish(id, result, Date.now());
	return result;
}

async function performed(
	id: string,
	options: PerformOptions,
	dirs: ConcertDirs,
	root: Frame,
	running: Set<Running>,
	inflight: Set<Promise<void>>,
): Promise<ConcertResult> {
	const { ir, hosts, loadCode } = options;
	const index = indexGraph(ir);
	await makeDirs(dirs);
	const check = portCheck(validator());
	const kit: Kit = {
		concert: id,
		record: options.record,
		dirs,
		env: await environments(hosts),
		kinds: kindLookup(hosts),
		workers: new Map([[TS_RUNTIME, tsWorker(loadCode, check)]]),
		check,
	};
	const c: Concert = {
		id,
		index,
		loadCode,
		kit,
		slots: slots(options.concurrency),
		root,
		running,
		started: new Set(),
		inflight,
		order: 0,
	};
	const top = ir.nodes.filter((n) => index.groupsOf(n.id).length === 0);
	await startFrame(c, top, root);
	const returned = await stateIn(root, ir.result.node);
	return root.halt
		? { outcome: "failed", reason: root.halt.reason }
		: resultOf(returned);
}

async function environments(
	hosts: readonly Host[],
): Promise<Record<string, Facts>> {
	const facts = hosts.map(async (h) => [h.name, await h.environment()]);
	return Object.fromEntries(await Promise.all(facts));
}

function slots(size: number): Slots {
	let free = size;
	const waiting: (() => void)[] = [];
	return {
		acquire: () => {
			if (free === 0) return new Promise((go) => waiting.push(go));
			free--;
			return Promise.resolve();
		},
		release: () => {
			const next = waiting.shift();
			if (next) next();
			else free++;
		},
	};
}

/**
 * The result rule (architecture 7): `returned` when `ok`, else the end of its chain of causes, where one skipped by its
 * own guard counts as rejected.
 */
function resultOf(returned: State): ConcertResult {
	let state = returned;
	while (state.outcome !== "ok" && state.cause) state = state.cause;
	const instance = { node: state.node, expansion: state.expansion };
	if (state.outcome === "ok")
		return { ...instance, outcome: "ok", outputs: state.outputs };
	const outcome = state.outcome === "skipped" ? "rejected" : state.outcome;
	return { ...instance, outcome, reason: state.reason };
}

/** Settles every node of `nodes` in `frame`, each once its upstreams have. */
function startFrame(
	c: Concert,
	nodes: readonly IrNode[],
	frame: Frame,
): Promise<State[]> {
	// Every state is registered before any node looks up its upstreams.
	const pending = nodes.map((node) => {
		const settled = Promise.withResolvers<State>();
		frame.states.set(node.id, settled.promise);
		return { node, settled };
	});
	for (const { node, settled } of pending) {
		const settling = settleNode(c, node, frame).then(
			settled.resolve,
			settled.reject,
		);
		c.inflight.add(settling);
		settling.then(() => c.inflight.delete(settling));
	}
	return Promise.all(pending.map((p) => p.settled.promise));
}

async function settleNode(
	c: Concert,
	node: IrNode,
	frame: Frame,
): Promise<State> {
	const instance = { node: node.id, expansion: formatExpansion(frame.keys) };
	const sources = await upstreams(c, node, frame);
	const stop =
		haltOf(frame) ??
		gate(c, node, frame, sources) ??
		unreadable(c, node, frame, sources);
	if (stop) return settle(c, instance, stop);
	const inputs = gather(c, node, frame, sources);
	const mismatch = c.kit.check(node.in, inputs, "input");
	if (mismatch)
		return settle(c, instance, { outcome: "failed", reason: mismatch });
	const ending = isGroup(node)
		? await group(c, node, frame, instance, inputs)
		: await leaf(c, node, frame, instance, inputs);
	return settle(c, instance, ending);
}

/** Records how `instance` settled, unless it never started in a halted concert (architecture 7). */
function settle(c: Concert, instance: NodeInstance, ending: Ending): State {
	if (c.started.has(instanceKey(instance)) || !c.root.halt)
		c.kit.record.settle(c.id, instance, ending, Date.now());
	return { ...ending, ...instance, order: c.order++ };
}

function start(c: Concert, instance: NodeInstance, at: number): void {
	c.kit.record.start(c.id, instance, at);
	c.started.add(instanceKey(instance));
}

const isFanIn = (node: IrNode) => node.kind === "code" && node.fanin === true;

/** An edge from an enclosing group reads one of its inner ports. */
const isInner = (c: Concert, edge: IrEdge) =>
	c.index.groupsOf(edge.to.node).includes(edge.from.node);

/** The settled states of the nodes with an edge into `node`, by id, leaving out inner ports. */
async function upstreams(
	c: Concert,
	node: IrNode,
	frame: Frame,
): Promise<Map<string, State>> {
	const ids = new Set(
		c.index
			.edgesInto(node.id)
			.filter((e) => !isInner(c, e))
			.map((e) => e.from.node),
	);
	const states = await Promise.all(
		[...ids].map((id) => stateIn(frameOf(c, frame, id), id)),
	);
	return new Map(states.map((s) => [s.node, s]));
}

/** The frame on `frame`'s chain that holds `id`'s instance: the one as deep as `id` sits in groups. */
function frameOf(c: Concert, frame: Frame, id: string): Frame {
	const depth = c.index.groupsOf(id).length;
	let at = frame;
	while (at.keys.length > depth && at.parent) at = at.parent;
	return at;
}

function stateIn(frame: Frame, id: string): Promise<State> {
	const state = frame.states.get(id);
	if (!state) throw new Error(`node '${id}' has no instance in this frame`);
	return state;
}

/** The worst halt of `frame` and the frames around it. */
function haltOf(frame: Frame): Halt | undefined {
	let worst: Halt | undefined;
	for (let at: Frame | undefined = frame; at; at = at.parent)
		if (at.halt) worst = worseOf(worst, at.halt);
	return worst;
}

/** `halt` when it outranks `current`, else `current`. */
const worseOf = (current: Halt | undefined, halt: Halt): Halt =>
	current && worstOutcome([current.outcome, halt.outcome]) === current.outcome
		? current
		: halt;

const shown = (c: Concert, instance: NodeInstance) =>
	formatInstance(instance, c.index.groupsOf(instance.node));

/**
 * `skipped` when an upstream settled other than `ok` and nothing tolerates it (CORE-04), naming the first such to
 * settle as the cause, or when a guard is not true.
 */
function gate(
	c: Concert,
	node: IrNode,
	frame: Frame,
	sources: ReadonlyMap<string, State>,
): Ending | undefined {
	const edges = c.index.edgesInto(node.id);
	const cause = [...sources.values()]
		.filter((s) => blocks(node, edges, s))
		.sort((a, b) => a.order - b.order)[0];
	if (cause)
		return {
			outcome: "skipped",
			reason: `'${shown(c, cause)}' settled ${cause.outcome}`,
			cause,
		};
	const guard = edges.find(
		(e) =>
			e.kind === "control" &&
			e.from.port !== undefined &&
			edgeValue(e, frame, sources) !== true,
	);
	if (guard)
		return {
			outcome: "skipped",
			reason: `the guard '${guard.from.node}.${guard.from.port}' is not true`,
		};
}

/**
 * Whether `source`'s outcome keeps `node` from starting. A fan-in node takes any outcome over a `data` or `collect`
 * edge (ADR 0006). A tolerating control edge admits `rejected`, as a `repeat`'s `tolerate` does for its state.
 */
function blocks(
	node: IrNode,
	edges: readonly IrEdge[],
	source: State,
): boolean {
	if (source.outcome === "ok") return false;
	const from = edges.filter((e) => e.from.node === source.node);
	if (!from.some((e) => e.kind === "control" || !isFanIn(node))) return false;
	return !(
		source.outcome === "rejected" && from.some((e) => tolerates(node, e))
	);
}

/**
 * `failed` when `node` reads a declared output of an upstream that rejected without outputs, naming the first such
 * upstream and port (ADR 0008). A fan-in node takes that upstream `Settled` instead.
 */
function unreadable(
	c: Concert,
	node: IrNode,
	frame: Frame,
	sources: ReadonlyMap<string, State>,
): Ending | undefined {
	for (const edge of c.index.edgesInto(node.id)) {
		if (edge.kind === "control" || (edge.kind === "data" && isFanIn(node)))
			continue;
		const source = sources.get(edge.from.node) ?? carriedBy(c, frame, edge);
		const failure = source && unreadablePort(c, source, edge.from.port ?? "");
		if (failure) return failure;
	}
}

/** `failed` when output `port` of `state` cannot be read, as `unreadableReason` rules. */
function unreadablePort(
	c: Concert,
	state: State,
	port: string,
): Ending | undefined {
	const out = c.index.nodes.get(state.node)?.out;
	const reason = unreadableReason(shown(c, state), state, out, port);
	return reason === undefined ? undefined : { outcome: "failed", reason };
}

/** The member a `repeat` state port that `edge` reads carries over from the previous iteration, if any. */
function carriedBy(c: Concert, frame: Frame, edge: IrEdge): State | undefined {
	const group = c.index.nodes.get(edge.from.node);
	const port = edge.from.port ?? "";
	if (group?.kind !== "repeat" || !Object.hasOwn(group.out ?? {}, port))
		return undefined;
	for (let at: Frame | undefined = frame; at; at = at.parent)
		if (at.group === group.id) return at.carried;
}

function edgeValue(
	edge: IrEdge,
	frame: Frame,
	sources: ReadonlyMap<string, State>,
): unknown {
	const port = edge.from.port ?? "";
	const state = sources.get(edge.from.node);
	if (state) return outputValue(state, state.outputs, port);
	for (let at: Frame | undefined = frame; at; at = at.parent)
		if (at.group === edge.from.node) return at.inner[port];
}

/** `node`'s input values, a copy so no instance changes another's. A fan-in node gets each `data` input `Settled`. */
function gather(
	c: Concert,
	node: IrNode,
	frame: Frame,
	sources: ReadonlyMap<string, State>,
): Inputs {
	const inputs: Record<string, unknown> = { ...node.literals };
	for (const edge of c.index.edgesInto(node.id)) {
		if (edge.kind === "control") continue;
		const value = edgeValue(edge, frame, sources);
		const wrap = edge.kind === "data" && isFanIn(node);
		inputs[edge.to.port] = wrap
			? asSettled(sources.get(edge.from.node), value)
			: value;
	}
	return structuredClone(inputs);
}

/** A fan-in input: `value` as `Settled`. */
function asSettled(state: State | undefined, value: unknown): Settled<unknown> {
	if (!state) return { outcome: "ok", value };
	return settledOf(state, state.outputs !== undefined, value);
}

/** `state` as `Settled`, with `value` when `ok`, or when `rejected` with `complete` outputs (ADR 0006, ADR 0008). */
function settledOf<T>(state: State, complete: boolean, value: T): Settled<T> {
	if (state.outcome === "ok") return { outcome: "ok", value };
	if (state.outcome === "rejected" && complete)
		return { outcome: "rejected", reason: state.reason, value };
	return notOk(state);
}

/** A non-`ok` instance as `Settled`, without a value. */
function notOk(state: {
	outcome: Exclude<Outcome, "ok">;
	reason: string;
}): Exclude<Settled<never>, { outcome: "ok" }> {
	return { outcome: state.outcome, reason: state.reason };
}

async function leaf(
	c: Concert,
	node: CodeNode | HostNode | AssertNode,
	frame: Frame,
	instance: NodeInstance,
	inputs: Inputs,
): Promise<Settling> {
	const halted = haltOf(frame);
	if (halted) return halted;
	await c.slots.acquire();
	try {
		if (node.kind !== "assert")
			return await execute(c, node, frame, instance, inputs);
		const late = haltOf(frame);
		if (late) return late;
		start(c, instance, Date.now());
		return asserted(node, inputs);
	} finally {
		c.slots.release();
	}
}

/**
 * Executes a code or host instance in its own scratch directory, which goes once its outputs are moved (ADR 0007). A
 * halted instance settles with its halt once its cancel hook has returned and the event loop has turned, keeping the
 * metrics and enrichment its call reported by then. Its call is abandoned, and a later result is ignored.
 */
async function execute(
	c: Concert,
	node: CodeNode | HostNode,
	frame: Frame,
	instance: NodeInstance,
	inputs: Inputs,
): Promise<Settling> {
	const scratch = await scratchDir(c.kit.dirs);
	try {
		const halted = haltOf(frame);
		if (halted) return halted;
		const clock = Date.now();
		start(c, instance, clock);
		const call = callOf(c.kit, node, instance, inputs, { scratch, clock });
		const abandoned = Promise.withResolvers<Execution>();
		const entry: Running = {
			frame,
			cancel: async () => {
				await call.cancel();
				setImmediate(() => abandoned.resolve(ABANDONED));
			},
		};
		c.running.add(entry);
		const timeout = node.kind === "code" ? node.timeout : undefined;
		const execution = await timed(
			Promise.race([call.invoke(), abandoned.promise]),
			{ name: shown(c, instance), timeout },
			async (reason) => {
				await stop(entry, { outcome: "failed", reason });
				return abandoned.promise;
			},
		).finally(() => c.running.delete(entry));
		const { metrics, enrichment } = execution;
		return entry.halted
			? { ...entry.halted, metrics, enrichment }
			: await finish(c.kit, node, instance, scratch, execution);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/**
 * Halts `frame` and the frames inside it: each running instance there is cancelled through its hook, latest started
 * first, so dependents go before what they depend on, and settles with the worst halt it was given.
 */
async function halt(
	running: ReadonlySet<Running>,
	frame: Frame,
	reason: Halt,
): Promise<void> {
	frame.halt ??= reason;
	const inside = [...running].filter((r) => within(r.frame, frame)).reverse();
	for (const r of inside) await stop(r, reason);
}

/** Gives a running instance `reason`, the worst it was given, and cancels it on its first halt. */
async function stop(r: Running, reason: Halt): Promise<void> {
	const cancelled = r.halted !== undefined;
	r.halted = worseOf(r.halted, reason);
	if (!cancelled) await r.cancel();
}

function within(frame: Frame, outer: Frame): boolean {
	for (let at: Frame | undefined = frame; at; at = at.parent)
		if (at === outer) return true;
	return false;
}

async function group(
	c: Concert,
	node: GroupNode,
	frame: Frame,
	instance: NodeInstance,
	inputs: Inputs,
): Promise<Ending> {
	start(c, instance, Date.now());
	const ending =
		node.kind === "map"
			? await mapGroup(c, node, frame, instance, inputs)
			: await serial(c, node, frame, instance, inputs);
	return haltOf(frame) ?? ending;
}

const childFrame = (
	frame: Frame,
	group: string,
	key: string,
	inner: Inputs,
	carried?: State,
): Frame => ({
	keys: [...frame.keys, key],
	parent: frame,
	group,
	inner,
	...(carried && { carried }),
	states: new Map(),
});

/** A `map` or `seq`'s items, or why they cannot be expanded. */
function itemsOf(
	c: Concert,
	node: MapNode | SeqNode,
	instance: NodeInstance,
	inputs: Inputs,
): unknown[] | Settling {
	const items = node.items ?? inputs.items;
	const name = `${node.kind} '${shown(c, instance)}'`;
	if (!Array.isArray(items))
		return {
			outcome: "failed",
			reason: `${name} got items that are not a list`,
		};
	const most = boundOf(node.cardinality);
	if (items.length > most)
		return {
			outcome: "failed",
			reason: `${name} got ${items.length} items, over its bound of ${most}. Raise its bound, or pass fewer items`,
		};
	return items;
}

/**
 * The item keys of a `map` (D-18), each from its key function when it has one, sanitized by `itemKey`, or why they
 * cannot name its members: a throwing key function, or two items keyed alike.
 */
async function keysOf(
	c: Concert,
	node: MapNode,
	instance: NodeInstance,
	items: unknown[],
): Promise<string[] | Settling> {
	const name = `map '${shown(c, instance)}'`;
	let named = items;
	try {
		const key = node.key && (await loadFunction(c.loadCode, node.key));
		if (key) named = await Promise.all(items.map(async (item) => key(item)));
	} catch (error) {
		return {
			outcome: "failed",
			reason: `the key function of ${name} threw: ${messageOf(error)}`,
		};
	}
	const keys = named.map((k, i) => itemKey(k, i));
	const dup = firstDuplicate(keys);
	if (!dup) return keys;
	const fix = node.key
		? "Make its key function return a unique key per item"
		: "Give the map a key function that returns a unique key per item";
	const reason = `${name} has items ${dup.first} and ${dup.second} keyed '${dup.key}'. ${fix}`;
	return { outcome: "failed", reason };
}

/** A `map` member's `Settled` result, a record by result name, and the entry whose outcome it takes (ADR 0006). */
async function memberOf(
	node: MapNode,
	frame: Frame,
): Promise<{ settled: Settled<Record<string, unknown>>; state: State }> {
	const entries = await Promise.all(
		Object.entries(node.members).map(
			async ([name, id]) => [name, await stateIn(frame, id)] as const,
		),
	);
	const worst = worstOutcome(entries.map(([, s]) => s.outcome));
	const [, state] = entries.find(([, s]) => s.outcome === worst) ?? [];
	if (!state) throw new Error(`map '${node.id}' has no members`);
	const value = Object.fromEntries(entries.map(([n, s]) => [n, s.outputs]));
	const complete = entries.every(([, s]) => s.outputs !== undefined);
	return { settled: settledOf(state, complete, value), state };
}

/**
 * A `map`: one body instance per item, in parallel. With `settle` it is `ok` and its `results` hold each member
 * settled. With `propagate` the first member to settle non-ok halts the others as `skipped`, and the map takes the
 * worst member outcome and the first such member's reason (ADR 0006).
 */
async function mapGroup(
	c: Concert,
	node: MapNode,
	frame: Frame,
	instance: NodeInstance,
	inputs: Inputs,
): Promise<Ending> {
	const items = itemsOf(c, node, instance, inputs);
	if (!Array.isArray(items)) return items;
	const keys = await keysOf(c, node, instance, items);
	if (!Array.isArray(keys)) return keys;
	const frames = keys.map((key, i) =>
		childFrame(frame, node.id, key, { item: items[i] }),
	);
	let halting = false;
	const members = await Promise.all(
		frames.map(async (member) => {
			const body = startFrame(c, c.index.body(node.id), member);
			const [settled] = await Promise.all([
				memberOf(node, member).then(async (found) => {
					const failing = found.state.outcome !== "ok";
					if (node.onError === "propagate" && failing && !halting) {
						halting = true;
						await haltOthers(c, frames, member, found.state);
					}
					return found;
				}),
				body,
			]);
			return settled;
		}),
	);
	const results = members.map((m) => m.settled);
	const worst = worstOutcome(results.map((r) => r.outcome));
	const first = members.find((m) => m.settled.outcome === worst)?.state;
	if (node.onError === "settle" || !first || first.outcome === "ok")
		return { outcome: "ok", outputs: { results } };
	return {
		outcome: worst,
		reason: first.reason,
		outputs: { results },
		cause: first,
	};
}

/** Halts every member frame but `member`, whose non-`ok` `state` cancels them as `skipped` (ADR 0006). */
async function haltOthers(
	c: Concert,
	frames: readonly Frame[],
	member: Frame,
	state: State,
): Promise<void> {
	const reason = `cancelled: ${shown(c, state)} ${state.outcome}`;
	for (const other of frames.filter((f) => f !== member))
		await halt(c.running, other, { outcome: "skipped", reason });
}

/**
 * A `seq` or `repeat`: one body instance per item or iteration, in order, each read by `until` once it settles. A
 * `seq` stops after its last item, a `repeat` at its bound or at a member it cannot carry on from. Either takes its
 * last member's outcome and outputs.
 */
async function serial(
	c: Concert,
	node: SeqNode | RepeatNode,
	frame: Frame,
	instance: NodeInstance,
	inputs: Inputs,
): Promise<Ending> {
	const steps = stepsOf(c, node, instance, inputs);
	if ("outcome" in steps) return steps;
	const member = Object.values(node.members)[0] ?? "";
	let state = inputs;
	let last: State | undefined;
	for (let i = 0; i < steps.count && !haltOf(frame); i++) {
		const inner = steps.inner(i, state);
		const f = childFrame(frame, node.id, String(i), inner, last);
		await startFrame(c, c.index.body(node.id), f);
		last = await stateIn(f, member);
		const ending = await endAfter(c, node, f, last);
		if (ending) return ending;
		state = last.outputs ?? {};
	}
	if (!last)
		return {
			outcome: "skipped",
			reason: `${node.kind} '${shown(c, instance)}' has no items`,
		};
	return endingOf(last);
}

/**
 * How `node` ends after the iteration in `frame` whose member settled `last`, or nothing when it goes on: at a member
 * it cannot carry on from, at an `until` that holds, or `failed` at an `until` read from a rejection without outputs.
 */
async function endAfter(
	c: Concert,
	node: SeqNode | RepeatNode,
	frame: Frame,
	last: State,
): Promise<Ending | undefined> {
	if (!carries(node, last)) return endingOf(last);
	if (!node.until) return undefined;
	const { port } = node.until;
	const state = await stateIn(frame, node.until.node);
	const failure = unreadablePort(c, state, port);
	if (failure) return failure;
	const holds = outputValue(state, state.outputs, port) === true;
	return holds ? endingOf(last) : undefined;
}

/** A member's outcome and outputs as its `seq` or `repeat`'s ending. */
function endingOf(last: State): Ending {
	return last.outcome === "ok"
		? { outcome: "ok", outputs: last.outputs }
		: {
				outcome: last.outcome,
				reason: last.reason,
				outputs: last.outputs,
				cause: last,
			};
}

/** How many members a `seq` or `repeat` may have, and the inner port values of each given the last state. */
function stepsOf(
	c: Concert,
	node: SeqNode | RepeatNode,
	instance: NodeInstance,
	inputs: Inputs,
): { count: number; inner(i: number, state: Inputs): Inputs } | Settling {
	if (node.kind === "repeat")
		return {
			count: boundOf(node.cardinality),
			inner: (i, state) => ({ ...state, index: i }),
		};
	const items = itemsOf(c, node, instance, inputs);
	if (!Array.isArray(items)) return items;
	return { count: items.length, inner: (i) => ({ item: items[i] }) };
}

/** A `seq` goes on whatever its member's outcome. A `repeat` carries `ok` state, and `rejected` when tolerated. */
const carries = (node: SeqNode | RepeatNode, last: State) =>
	node.kind === "seq" ||
	last.outcome === "ok" ||
	(last.outcome === "rejected" && node.tolerate === "rejected");
