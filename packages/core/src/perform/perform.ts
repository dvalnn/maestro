import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type AssertNode,
	boundOf,
	type CodeNode,
	type Facts,
	type FindNode,
	type FoldNode,
	firstDuplicate,
	formatExpansion,
	formatInstance,
	type GraphIndex,
	type GroupNode,
	type HostNode,
	IMPLICIT_OUT,
	type Ir,
	type IrEdge,
	type IrNode,
	indexGraph,
	isGroup,
	itemKey,
	type LoopNode,
	type MapNode,
	messageOf,
	type NodeInstance,
	type Outcome,
	outputValue,
	type ParFindNode,
	type ParMapNode,
	type PortRef,
	type Settled,
	TS_RUNTIME,
	tolerates,
	upstreamIn,
	validator,
	worstOutcome,
} from "@maestro/ir";
import type { Composed } from "../config";
import {
	type Host,
	type HostNodeResult,
	type HostSetup,
	hostSetup,
} from "../host";
import type { Inputs, LoadCode } from "../node";
import { instanceKey, kindLookup, loadFunction } from "../shared";
import {
	type ConcertDirs,
	concertDirs,
	makeDirs,
	scratchDir,
} from "./artifacts";
import {
	asserted,
	callOf,
	finish,
	type Kit,
	portCheck,
	timed,
} from "./execute";
import {
	type ConcertOrigin,
	type ConcertResult,
	openWriter,
	type RecordWriter,
	type Settling,
} from "./record";
import { type Kept, keptOf, resumeKey } from "./resume";
import { tsWorker } from "./ts-worker";

type PerformBase = {
	hosts: readonly Host[];
	/** The composed config the concert was composed under, from which each host gets its own namespaces. */
	config: Composed;
	loadCode: LoadCode;
	/** The file of the record store the concert is written to. */
	recordPath: string;
	/** What a new concert's row keeps beside its IR. A resumed concert keeps its own. */
	origin?: ConcertOrigin;
	/** The directory each concert's artifact area and scratch directories go under, in `<dir>/<concert id>/`. */
	dir: string;
	/** The most node instances executing at once in this concert (D-26). A positive integer. */
	concurrency: number;
};

/**
 * `ir` passed `parseIr`, and each code reference in it carries its code's current `codeHash` (ADR 0008). The concert is
 * one of:
 * - a new one, without `resume`;
 * - the one `resume` names, which failed or was rejected: it keeps its id, takes `ir` in place of its stored IR, and
 *   reuses each `ok` instance whose resume key still matches (architecture 7).
 */
export type PerformOptions = PerformBase & { ir: Ir; resume?: string };

/** A concert being performed. */
export type Concert = {
	id: string;
	/** Settles with the result once every node instance has settled. */
	done: Promise<ConcertResult>;
	/**
	 * Cancels running instances through their kind's hook, latest started first, and settles them `failed`. No other
	 * instance starts or gets a record. The concert settles `failed`, its result with no node (architecture 7).
	 */
	cancel(): Promise<void>;
};

/** `PerformOptions` once the record store is open for writing. */
type Opened = Omit<PerformOptions, "recordPath"> & {
	record: RecordWriter;
	kinds: Kit["kinds"];
};

/** What an abandoned call settles with, which its halt then replaces. */
const ABANDONED: HostNodeResult = { outcome: "failed", reason: "abandoned" };

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
	/** The previous iteration's member, whose outputs a `loop` iteration's state ports hold. */
	readonly carried?: State;
	readonly states: Map<string, Promise<State>>;
	halt?: Halt;
};

/**
 * How an instance ended, and the next step of the result rule from it (architecture 7). `reused` is an `ok` instance a
 * resume kept, which has no new record.
 */
type Ending = Settling & { cause?: State; reused?: true };

/** A settled instance. `order` counts settlements within the concert. */
type State = NodeInstance & Ending & { order: number };

type Running = { frame: Frame; cancel(): Promise<void>; halted?: Halt };

type Slots = { acquire(): Promise<void>; release(): void };

/**
 * `started` holds the instance keys `record.start` took. `inflight` holds each node settling, until it has. `kept`
 * holds the instances a resume may reuse, by instance key.
 */
type Live = {
	id: string;
	index: GraphIndex;
	kept: ReadonlyMap<string, Kept>;
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
 * Starts performing a concert, a new one or the one `options.resume` names. Code nodes execute in process through
 * `loadCode`, host nodes through their host, and every instance and event goes to the record at `recordPath`, which
 * stays open until the concert settles. Every refusal rejects:
 * @throws RangeError when `concurrency` is not a positive integer.
 * @throws Error when two hosts register one node kind, or the concert to resume is unknown.
 * @throws Unresumable when the concert to resume is running, or settled `ok`.
 */
export async function perform(options: PerformOptions): Promise<Concert> {
	const { concurrency, recordPath } = options;
	if (!Number.isInteger(concurrency) || concurrency < 1)
		throw new RangeError(
			`concurrency must be a positive integer, got ${concurrency}`,
		);
	const kinds = kindLookup(options.hosts);
	const id = options.resume ?? Bun.randomUUIDv7();
	const record = openWriter(recordPath);
	const opened: Opened = { ...options, record, kinds };
	let kept: Map<string, Kept>;
	try {
		kept = enter(id, opened);
	} catch (error) {
		record.close();
		throw error;
	}
	const root: Frame = { keys: [], inner: {}, states: new Map() };
	const running = new Set<Running>();
	return {
		id,
		done: conduct(id, options.ir, kept, opened, root, running).finally(() =>
			record.close(),
		),
		cancel: () => halt(running, root, CANCELLED),
	};
}

/** Records the concert as running, and finds what a resume may reuse of it. */
function enter(id: string, opened: Opened): Map<string, Kept> {
	const { record, resume, ir } = opened;
	if (resume === undefined) {
		record.begin({ id, ir, startedAt: Date.now(), ...opened.origin });
		return new Map();
	}
	return keptOf(record.resume({ id, ir }));
}

/**
 * Performs the concert and records its result. A throw halts the running instances `failed` and waits for every node
 * to settle, so the concert settles `failed` with no node and none stays running.
 */
async function conduct(
	id: string,
	ir: Ir,
	kept: ReadonlyMap<string, Kept>,
	options: Opened,
	root: Frame,
	running: Set<Running>,
): Promise<ConcertResult> {
	const inflight = new Set<Promise<void>>();
	const dirs = concertDirs(resolve(options.dir), id);
	let result: ConcertResult;
	try {
		result = await performed(
			id,
			ir,
			kept,
			options,
			dirs,
			root,
			running,
			inflight,
		);
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
	ir: Ir,
	kept: ReadonlyMap<string, Kept>,
	options: Opened,
	dirs: ConcertDirs,
	root: Frame,
	running: Set<Running>,
	inflight: Set<Promise<void>>,
): Promise<ConcertResult> {
	const { hosts, loadCode } = options;
	const setup = (host: Host) => hostSetup(host, options.config);
	const index = indexGraph(ir);
	await makeDirs(dirs);
	const check = portCheck(validator());
	const kit: Kit = {
		concert: id,
		record: options.record,
		dirs,
		env: await environments(hosts, setup),
		kinds: options.kinds,
		setup,
		workers: new Map([[TS_RUNTIME, tsWorker(loadCode, check)]]),
		check,
	};
	const c: Live = {
		id,
		index,
		kept,
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
	setup: (host: Host) => HostSetup,
): Promise<Record<string, Facts>> {
	const facts = hosts.map(async (h) => [h.name, await h.environment(setup(h))]);
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
	if (state.outcome === "rejected" && state.outputs !== undefined)
		return {
			...instance,
			outcome: "rejected",
			reason: state.reason,
			outputs: state.outputs,
		};
	const outcome = state.outcome === "skipped" ? "rejected" : state.outcome;
	return { ...instance, outcome, reason: state.reason };
}

/** Settles every node of `nodes` in `frame`, each once its upstreams have. */
function startFrame(
	c: Live,
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

async function settleNode(c: Live, node: IrNode, frame: Frame): Promise<State> {
	const instance = { node: node.id, expansion: formatExpansion(frame.keys) };
	const sources = await upstreams(c, node, frame);
	const stop =
		haltOf(frame) ??
		gate(c, node, frame, sources) ??
		unproduced(c, node, frame, sources);
	if (stop) return settle(c, instance, stop);
	const inputs = gather(c, node, frame, sources);
	const mismatch = c.kit.check(node.in, inputs, "input");
	if (mismatch)
		return settle(c, instance, { outcome: "failed", reason: mismatch });
	const ending = isGroup(node)
		? await group(c, node, frame, instance, inputs, sources)
		: await leaf(c, node, frame, instance, inputs);
	return settle(c, instance, ending);
}

/** Records how `instance` settled, unless it was reused or never started in a halted concert (architecture 7). */
function settle(c: Live, instance: NodeInstance, ending: Ending): State {
	const recorded = c.started.has(instanceKey(instance)) || !c.root.halt;
	if (recorded && !ending.reused)
		c.kit.record.settle(c.id, instance, ending, Date.now());
	return { ...ending, ...instance, order: c.order++ };
}

function start(c: Live, instance: NodeInstance, at: number): void {
	c.kit.record.start(c.id, instance, at);
	c.started.add(instanceKey(instance));
}

const isFanIn = (node: IrNode) => node.kind === "code" && node.fanin === true;

/** An edge from an enclosing group reads one of its inner ports. */
const isInner = (c: Live, edge: IrEdge) =>
	c.index.groupsOf(edge.to.node).includes(edge.from.node);

/** The settled states of the nodes with an edge into `node`, by id, leaving out inner ports. */
async function upstreams(
	c: Live,
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
function frameOf(c: Live, frame: Frame, id: string): Frame {
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

const shown = (c: Live, instance: NodeInstance) =>
	formatInstance(instance, c.index.groupsOf(instance.node));

/** The first of `states` to settle. */
const firstSettled = (states: readonly (State | undefined)[]) =>
	states.filter((s) => s !== undefined).sort((a, b) => a.order - b.order)[0];

/**
 * `skipped` when an upstream settled other than `ok` and nothing tolerates it (CORE-04), naming the first such to
 * settle as the cause, or when a guard is not true, naming as the cause an upstream not `ok` whose status port the
 * guard reads.
 */
function gate(
	c: Live,
	node: IrNode,
	frame: Frame,
	sources: ReadonlyMap<string, State>,
): Ending | undefined {
	const edges = c.index.edgesInto(node.id);
	const cause = firstSettled(
		[...sources.values()].filter((s) => blocks(node, edges, s)),
	);
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
	if (!guard) return undefined;
	const source = sources.get(guard.from.node);
	const status = Object.hasOwn(IMPLICIT_OUT, guard.from.port ?? "");
	return {
		outcome: "skipped",
		reason: `the guard '${guard.from.node}.${guard.from.port}' is not true`,
		...(status && source?.outcome !== "ok" && { cause: source }),
	};
}

/**
 * Whether `source`'s outcome keeps `node` from starting. A fan-in node takes any outcome over a `data` or `collect`
 * edge (ADR 0006). `rejected` passes where `tolerates` admits it.
 */
function blocks(
	node: IrNode,
	edges: readonly IrEdge[],
	source: State,
): boolean {
	if (source.outcome === "ok") return false;
	const from = edges.filter((e) => e.from.node === source.node);
	if (!from.some((e) => e.kind === "control" || !isFanIn(node))) return false;
	return !(source.outcome === "rejected" && tolerates(node, from));
}

/**
 * `skipped` when `node` reads a declared output of an upstream that rejected without outputs, naming the first such
 * upstream as the cause (ADR 0008). A fan-in node takes that upstream `Settled` instead.
 */
function unproduced(
	c: Live,
	node: IrNode,
	frame: Frame,
	sources: ReadonlyMap<string, State>,
): Ending | undefined {
	for (const edge of c.index.edgesInto(node.id)) {
		if (edge.kind === "control" || (edge.kind === "data" && isFanIn(node)))
			continue;
		const source = sources.get(edge.from.node) ?? carriedBy(c, frame, edge);
		const port = edge.from.port ?? "";
		if (source && lacks(c, source, port))
			return {
				outcome: "skipped",
				reason: `'${shown(c, source)}' rejected without its '${port}'`,
				cause: source,
			};
	}
}

/** Whether `state` rejected without outputs, though its node's `out` declares `port`. */
const lacks = (c: Live, state: State, port: string) =>
	state.outcome === "rejected" &&
	state.outputs === undefined &&
	Object.hasOwn(c.index.nodes.get(state.node)?.out ?? {}, port);

/** The member a `loop` or `fold` state port that `edge` reads carries over from the previous iteration, if any. */
function carriedBy(c: Live, frame: Frame, edge: IrEdge): State | undefined {
	const group = c.index.nodes.get(edge.from.node);
	const port = edge.from.port ?? "";
	const carrying = group?.kind === "loop" || group?.kind === "fold";
	if (!carrying || !Object.hasOwn(group.out ?? {}, port)) return undefined;
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
	c: Live,
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
	c: Live,
	node: CodeNode | HostNode | AssertNode,
	frame: Frame,
	instance: NodeInstance,
	inputs: Inputs,
): Promise<Ending> {
	const halted = haltOf(frame);
	if (halted) return halted;
	const key = resumeKey(node, inputs);
	const kept = c.kept.get(instanceKey(instance));
	if (kept?.key === key) {
		c.kit.record.reuse(c.id, instance, Date.now());
		return { outcome: "ok", outputs: kept.outputs, key, reused: true };
	}
	await c.slots.acquire();
	try {
		return { ...(await settleLeaf(c, node, frame, instance, inputs)), key };
	} finally {
		c.slots.release();
	}
}

async function settleLeaf(
	c: Live,
	node: CodeNode | HostNode | AssertNode,
	frame: Frame,
	instance: NodeInstance,
	inputs: Inputs,
): Promise<Settling> {
	if (node.kind !== "assert") return execute(c, node, frame, instance, inputs);
	const late = haltOf(frame);
	if (late) return late;
	start(c, instance, Date.now());
	return asserted(node, inputs);
}

/**
 * Executes a code or host instance in its own scratch directory, which goes once its outputs are moved (ADR 0007). A
 * halted instance settles with its halt once its cancel hook has returned and the event loop has turned, keeping the
 * metrics and enrichment its call reported by then. Its call is abandoned, and a later result is ignored.
 */
async function execute(
	c: Live,
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
		const call = callOf(c.kit, node, instance, inputs, {
			scratch,
			clock,
			id: shown(c, instance),
		});
		const abandoned = Promise.withResolvers<HostNodeResult>();
		const entry: Running = {
			frame,
			cancel: async () => {
				await call.cancel();
				setImmediate(() => abandoned.resolve(ABANDONED));
			},
		};
		c.running.add(entry);
		const timeout = node.kind === "code" ? node.timeout : undefined;
		const reported = await timed(
			Promise.race([call.invoke(), abandoned.promise]),
			{ name: shown(c, instance), timeout },
			async (reason) => {
				await stop(entry, { outcome: "failed", reason });
				return abandoned.promise;
			},
		).finally(() => c.running.delete(entry));
		const { metrics, enrichment } = reported;
		return entry.halted
			? { ...entry.halted, metrics, enrichment }
			: await finish(c.kit, node, instance, scratch, reported);
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
	c: Live,
	node: GroupNode,
	frame: Frame,
	instance: NodeInstance,
	inputs: Inputs,
	sources: ReadonlyMap<string, State>,
): Promise<Ending> {
	start(c, instance, Date.now());
	const ending = await groupEnding(c, node, frame, instance, inputs, sources);
	return haltOf(frame) ?? ending;
}

function groupEnding(
	c: Live,
	node: GroupNode,
	frame: Frame,
	instance: NodeInstance,
	inputs: Inputs,
	sources: ReadonlyMap<string, State>,
): Promise<Ending> {
	if (node.kind === "parMap" || node.kind === "parFind")
		return parallel(c, node, frame, instance, inputs);
	if (node.kind === "map") return inOrder(c, node, frame, instance, inputs);
	const first: Ending =
		node.kind === "loop"
			? firstState(c, node, sources, inputs)
			: { outcome: "ok", outputs: inputs };
	return serial(c, node, frame, instance, first);
}

/**
 * A loop's first state: its inputs, `ok` unless a node whose data feeds it rejected, a tolerated rejection taking the
 * first such to settle.
 */
function firstState(
	c: Live,
	node: LoopNode,
	sources: ReadonlyMap<string, State>,
	inputs: Inputs,
): Ending {
	const rejected = firstSettled(
		c.index
			.edgesInto(node.id)
			.flatMap((e) => (e.kind === "data" ? [sources.get(e.from.node)] : []))
			.filter((s) => s?.outcome === "rejected"),
	);
	return rejected
		? { ...endingOf(rejected), outputs: inputs }
		: { outcome: "ok", outputs: inputs };
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

/** A group's items, or why they cannot be expanded. */
function itemsOf(
	c: Live,
	node: Exclude<GroupNode, LoopNode>,
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

type Parallel = ParMapNode | ParFindNode;

/** How a group that takes its result from a member ends over no items. */
const noItems = (c: Live, node: GroupNode, instance: NodeInstance): Ending => ({
	outcome: "skipped",
	reason: `${node.kind} '${shown(c, instance)}' has no items`,
});

/**
 * The item keys of a `parMap` or `parFind` (D-18), each from its key function when it has one, sanitized by
 * `itemKey`, or why they cannot name its members: a throwing key function, or two items keyed alike.
 */
async function keysOf(
	c: Live,
	node: Parallel,
	instance: NodeInstance,
	items: unknown[],
): Promise<string[] | Settling> {
	const name = `${node.kind} '${shown(c, instance)}'`;
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
	const reason = `${name} has items ${dup.first} and ${dup.second} keyed '${dup.key}'. ${keyFix(node)}`;
	return { outcome: "failed", reason };
}

const keyFix = (node: Parallel) =>
	node.key
		? "Make its key function return a unique key per item"
		: `Give the ${node.kind} a key function that returns a unique key per item`;

type Member = { settled: Settled<unknown>; state: State };

/**
 * A member's `Settled` value, its one result's outputs or a record of them by result name, and the entry whose
 * outcome it takes (ADR 0006).
 */
async function memberOf(node: GroupNode, frame: Frame): Promise<Member> {
	const entries = await Promise.all(
		Object.entries(node.members).map(
			async ([name, id]) => [name, await stateIn(frame, id)] as const,
		),
	);
	const worst = worstOutcome(entries.map(([, s]) => s.outcome));
	const [, state] = entries.find(([, s]) => s.outcome === worst) ?? [];
	if (!state) throw new Error(`${node.kind} '${node.id}' has no members`);
	const value =
		entries.length === 1
			? state.outputs
			: Object.fromEntries(entries.map(([n, s]) => [n, s.outputs]));
	const complete = entries.every(([, s]) => s.outputs !== undefined);
	return { settled: settledOf(state, complete, value), state };
}

/**
 * A `parMap` or `parFind`: one body instance per item, all at once. Once a member ends the group, the others are
 * halted as `skipped` (ADR 0006): with `stop`, a parMap's first member to settle non-`ok`; a parFind's first member to
 * settle failed or meeting `cond`.
 */
async function parallel(
	c: Live,
	node: Parallel,
	frame: Frame,
	instance: NodeInstance,
	inputs: Inputs,
): Promise<Ending> {
	const items = itemsOf(c, node, instance, inputs);
	if (!Array.isArray(items)) return items;
	if (node.kind === "parFind" && items.length === 0)
		return noItems(c, node, instance);
	const keys = await keysOf(c, node, instance, items);
	if (!Array.isArray(keys)) return keys;
	const frames = keys.map((key, i) =>
		childFrame(frame, node.id, key, { item: items[i] }),
	);
	let ended: Ending | undefined;
	const members = await Promise.all(
		frames.map(async (member) => {
			const body = startFrame(c, c.index.body(node.id), member);
			const found = await memberOf(node, member);
			const ends = await endsGroup(node, member, found.state);
			if (ends && !ended) {
				ended = ends;
				await haltOthers(
					c,
					frames,
					member,
					cancelled(c, node, found.state, ends),
				);
			}
			await body;
			return found;
		}),
	);
	if (node.kind === "parMap") return collectedEnding(node, members);
	return ended ?? endingOf(lastSettled(members));
}

/**
 * How a member that settled as `state` in `frame` ends its group, or nothing when it does not:
 * - a parMap with `stop`, at a non-`ok` member;
 * - a parFind, as `found` reads its `cond`.
 */
async function endsGroup(
	node: Parallel,
	frame: Frame,
	state: State,
): Promise<Ending | undefined> {
	if (node.kind === "parFind") return found(node, frame, state);
	return node.onError === "stop" && state.outcome !== "ok"
		? endingOf(state)
		: undefined;
}

/**
 * How a `find` or `parFind` ends on the member that settled as `last` in `frame`, or nothing when it goes on:
 * - `failed` when the member or the `cond` node failed;
 * - as `last` when `cond` holds.
 */
async function found(
	node: FindNode | ParFindNode,
	frame: Frame,
	last: State,
): Promise<Ending | undefined> {
	const read = await stateIn(frame, node.cond.node);
	const broken = [last, read].find((s) => s.outcome === "failed");
	if (broken) return endingOf(broken);
	return holds(read, node.cond.port) ? endingOf(last) : undefined;
}

const lastSettled = (members: readonly Member[]) =>
	members.map((m) => m.state).toSorted((a, b) => b.order - a.order)[0] as State;

/**
 * A `map`: one body instance per item, in order. With `stop` it starts no item after a non-`ok` member.
 */
async function inOrder(
	c: Live,
	node: MapNode,
	frame: Frame,
	instance: NodeInstance,
	inputs: Inputs,
): Promise<Ending> {
	const items = itemsOf(c, node, instance, inputs);
	if (!Array.isArray(items)) return items;
	const members: Member[] = [];
	for (let i = 0; i < items.length && !haltOf(frame); i++) {
		const f = childFrame(frame, node.id, String(i), { item: items[i] });
		await startFrame(c, c.index.body(node.id), f);
		const member = await memberOf(node, f);
		members.push(member);
		if (node.onError === "stop" && member.state.outcome !== "ok") break;
	}
	return collectedEnding(node, members);
}

/**
 * A `parMap` or `map`'s ending over its `members`, its `results` holding each settled. With `continue` it is `ok`.
 * With `stop` it takes the worst member outcome and the reason of the first such member (ADR 0006).
 */
function collectedEnding(
	node: ParMapNode | MapNode,
	members: readonly Member[],
): Ending {
	const results = members.map((m) => m.settled);
	const worst = worstOutcome(results.map((r) => r.outcome));
	const first = members.find((m) => m.settled.outcome === worst)?.state;
	if (node.onError === "continue" || !first || first.outcome === "ok")
		return { outcome: "ok", outputs: { results } };
	return {
		outcome: worst,
		reason: first.reason,
		outputs: { results },
		cause: first,
	};
}

/**
 * Why the members of `node` are cancelled when the one that settled as `state` ends it as `ending`:
 * - a parFind's member that met its `cond`;
 * - otherwise the instance that settled as the group ends.
 */
function cancelled(
	c: Live,
	node: Parallel,
	state: State,
	ending: Ending,
): string {
	const by = shown(c, ending.cause ?? state);
	return node.kind === "parFind" && ending.outcome !== "failed"
		? `cancelled: ${by} met the condition`
		: `cancelled: ${by} ${ending.outcome}`;
}

/** Halts every member frame but `member`, cancelling them as `skipped` for `reason` (ADR 0006). */
async function haltOthers(
	c: Live,
	frames: readonly Frame[],
	member: Frame,
	reason: string,
): Promise<void> {
	for (const other of frames.filter((f) => f !== member))
		await halt(c.running, other, { outcome: "skipped", reason });
}

type Serial = FindNode | FoldNode | LoopNode;

/**
 * A `find`, `fold` or `loop` entered on `first`, its inputs as outputs: one body instance per item or iteration, in
 * order. A `find` stops after its last item or at a `cond` that holds, a `fold` after its last item, a `loop` at its
 * bound or at a test that does not hold, and a `fold` or `loop` at a member it cannot carry on from. Each ends with its
 * last state's outcome and outputs: its last member's, or a loop's first state when it takes no step.
 */
async function serial(
	c: Live,
	node: Serial,
	frame: Frame,
	instance: NodeInstance,
	first: Ending,
): Promise<Ending> {
	const steps = stepsOf(c, node, instance, first);
	if ("outcome" in steps) return steps;
	const phases = phasesOf(c, node);
	let last: State | undefined;
	let state = first;
	for (let i = 0; i < steps.count && !haltOf(frame); i++) {
		const f = childFrame(
			frame,
			node.id,
			String(i),
			steps.inner(i, state),
			last,
		);
		const before = phases.test && (await startTest(c, f, phases.test, state));
		if (before) return before;
		const phase = (i === 0 && phases.first) || phases.step;
		await startFrame(c, phase.nodes, f);
		last = await stateIn(f, phase.member);
		state = endingOf(last);
		const ending = await endAfter(node, f, last);
		if (ending) return ending;
	}
	return state;
}

type StartTest = { port: PortRef; nodes: IrNode[] };

/** Body nodes performed together, and the member whose state they end on. */
type Phase = { nodes: readonly IrNode[]; member: string };

/**
 * The body of `node` split into the phases each iteration performs: a loop's test at `start`, performed first; a
 * fold's `first`, performed on the first item in place of its step; and the step.
 */
function phasesOf(
	c: Live,
	node: Serial,
): { test?: StartTest; first?: Phase; step: Phase } {
	const body = c.index.body(node.id);
	const apart = (phase: ReadonlySet<string>) =>
		[
			body.filter((n) => phase.has(n.id)),
			body.filter((n) => !phase.has(n.id)),
		] as const;
	if (node.kind === "fold") {
		const [once, rest] = apart(new Set(node.first));
		return {
			first: { nodes: once, member: node.members.first },
			step: { nodes: rest, member: node.members.step },
		};
	}
	const member = Object.values(node.members)[0] ?? "";
	if (node.kind !== "loop" || node.test.at !== "start")
		return { step: { nodes: body, member } };
	const [test, rest] = apart(upstreamIn(c.index, node.id, node.test.port.node));
	return {
		test: { port: node.test.port, nodes: [...test] },
		step: { nodes: rest, member },
	};
}

/**
 * How a loop ends at its test at `start` in `frame`, before its step, or nothing when the test holds:
 * - on a state port, as `state` when the port is not `true`;
 * - on a body node, as `loopTest` reads it once its nodes are performed.
 */
async function startTest(
	c: Live,
	frame: Frame,
	test: StartTest,
	state: Ending,
): Promise<Ending | undefined> {
	if (test.port.node === frame.group)
		return frame.inner[test.port.port] === true ? undefined : state;
	await startFrame(c, test.nodes, frame);
	return loopTest(frame, test.port, state);
}

/**
 * How a loop ends at its test `port` in `frame`, or nothing when the test holds:
 * - `failed` when the test node failed;
 * - as `state` when the port does not read `true`, as when the test node rejected without it.
 */
async function loopTest(
	frame: Frame,
	port: PortRef,
	state: Ending,
): Promise<Ending | undefined> {
	const read = await stateIn(frame, port.node);
	if (read.outcome === "failed") return endingOf(read);
	return holds(read, port.port) ? undefined : state;
}

/** Whether output `port` of `read` is `true`. */
const holds = (read: State, port: string) =>
	outputValue(read, read.outputs, port) === true;

/**
 * How `node` ends after the iteration in `frame` whose member settled `last`, or nothing when it goes on: at a member
 * it cannot carry on from, at a find's `cond` that holds, or as a loop's test at `end` ends it.
 */
async function endAfter(
	node: Serial,
	frame: Frame,
	last: State,
): Promise<Ending | undefined> {
	if (!carries(node, last)) return endingOf(last);
	if (node.kind === "find") return found(node, frame, last);
	if (node.kind === "loop" && node.test.at === "end")
		return loopTest(frame, node.test.port, endingOf(last));
}

/** A member's outcome and outputs as its group's ending. */
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

/** The inner ports of a carried `state`: its outputs, `ok`, and `reason` when not `ok`. */
const stateInner = (state: Ending): Inputs => ({
	...state.outputs,
	ok: state.outcome === "ok",
	...(state.outcome !== "ok" && { reason: state.reason }),
});

/**
 * How many members `node` entered on `first` may have, and the inner port values of each given the last state, or
 * how it ends without one: `skipped` with no items. A loop's state, and a fold's after its first item, carry `ok` and
 * `reason` beside the outputs.
 */
function stepsOf(
	c: Live,
	node: Serial,
	instance: NodeInstance,
	first: Ending,
):
	| {
			count: number;
			inner(i: number, state: Ending): Inputs;
	  }
	| Settling {
	if (node.kind === "loop")
		return {
			count: boundOf(node.cardinality),
			inner: (index, state) => ({ ...stateInner(state), index }),
		};
	const items = itemsOf(c, node, instance, first.outputs ?? {});
	if (!Array.isArray(items)) return items;
	if (items.length === 0) return noItems(c, node, instance);
	if (node.kind === "find")
		return { count: items.length, inner: (i) => ({ item: items[i] }) };
	return {
		count: items.length,
		inner: (index, state) => ({
			...(index > 0 && stateInner(state)),
			item: items[index],
			index,
		}),
	};
}

/**
 * Whether `node` goes on past a member that settled as `last`. A `find` leaves that to `found`. A `fold` or `loop`
 * carries `ok` state, and `rejected` when tolerated.
 */
const carries = (node: Serial, last: State) =>
	node.kind === "find" ||
	last.outcome === "ok" ||
	(last.outcome === "rejected" && node.tolerate === "rejected");
