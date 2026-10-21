import {
	formatInstance,
	type GraphIndex,
	type GroupNode,
	type IrNode,
	isGroup,
	type NodeInstance,
	OUTCOMES,
	type Outcome,
	parseExpansion,
	worstOutcome,
} from "@maestro/ir";
import { type Entry, lastSegment } from "./layout";
import type { Agents, InstanceState, Seen } from "./live";

/** What a member that never started reads once nothing more starts where it sits. It has no instance, so no outcome. */
export const UNSTARTED = "not reached";

/** What a row shows: an instance's state, `pending` before its node starts, `UNSTARTED` once it never will. */
export type Shown = "pending" | typeof UNSTARTED | InstanceState["state"];

export const GLYPH: Readonly<Record<Shown, string>> = {
	pending: "○",
	[UNSTARTED]: "–",
	running: "●",
	ok: "✓",
	rejected: "✗",
	failed: "!",
	skipped: "-",
};

/** The states a count lists, in its order. */
const COUNTED: readonly Shown[] = [
	"running",
	"ok",
	"rejected",
	"failed",
	"skipped",
	UNSTARTED,
	"pending",
];

/**
 * One key per enclosing group, outermost first: the iteration a sequential group shows, or `ANY` for a parallel group,
 * whose items are drawn as one row.
 */
type Ctx = readonly string[];
const ANY = "*";

/** The iteration a sequential group's row shows in place of its latest, by row key. */
type Pins = ReadonlyMap<string, string>;

/** How the rows reach an instance: the row that shows it, the container rows above it, and each iteration to show. */
export type Focus = {
	key: string;
	path: string[];
	pins: [row: string, iteration: string][];
};

/**
 * What a reader changed of the folds: a row opened or closed by key, the container rows above the cursor, which open
 * unless closed, and the iteration a sequential group's row shows in place of its latest.
 */
export type Folds = {
	open: ReadonlyMap<string, boolean>;
	path: readonly string[];
	pins: Pins;
};

/** What `rowsOf` overlays on the shape. `settled` says the concert has; `now` is epoch ms; `folds` are a reader's. */
type Overlay = {
	graph: GraphIndex;
	seen: Seen;
	agents: Agents;
	settled: boolean;
	now: number;
	folds?: Folds;
};

/** One row of the tree. */
export type Row = {
	/** `<node id>@<ctx>`, or `<node id>#<expansion>` for one item of an aggregated row. */
	key: string;
	/** The instance it shows as `formatInstance` names it, else its node's id. */
	id: string;
	/** The key of the container row it is drawn under. */
	parent?: string;
	depth: number;
	shown: Shown;
	name: string;
	kind: string;
	/** When what it shows started, and settled or `now` while it is running, in epoch ms. Absent before it started. */
	span?: readonly [from: number, to: number];
	actor?: string;
	tokens: number;
	note: string;
	/** Whether its members are drawn under it. Absent on a row with no members to draw. */
	open?: boolean;
	/** Whether it shows a running instance or the last failure, or holds one, which fitting never hides. */
	pinned: boolean;
	/** A sequential group's iteration keys in order, and the one its members show. */
	iterations?: { keys: readonly string[]; shown: string };
};

/** Groups whose iterations follow one another: one is shown, the others are history. */
const SEQUENTIAL: ReadonlySet<string> = new Set([
	"loop",
	"map",
	"find",
	"fold",
]);
const STDLIB = "maestro:stdlib";
/** The states a stdlib helper's instance is drawn in. */
const STDLIB_SHOWN: ReadonlySet<Shown> = new Set([
	"running",
	"rejected",
	"failed",
]);
/** The iteration a sequential group shows before any has started. */
const FIRST_ITERATION = "0";
/** The round a loop's note shows before any has started. */
const NO_ROUNDS = "0";
const NO_PINS: Pins = new Map();
const NO_FOLDS: Folds = { open: new Map(), path: [], pins: NO_PINS };
/** What a sequential group's note adds while it shows an iteration other than its latest. */
const HISTORY = " (history)";
const NUMERIC = /^\d+$/;
const SCOPE_KIND = "scope";
const PATH_SEP = " › ";
const NOTE_SEP = " · ";
/** The gaps between a row's columns, and between the parts of a line or note that read apart. */
export const GAP = "  ";
export const WIDE_GAP = "   ";

export const keyOf = ({ node, expansion }: NodeInstance) =>
	JSON.stringify([node, expansion]);

const rowKey = (id: string, ctx: Ctx) => `${id}@${ctx.join(",")}`;
const itemKey = (s: NodeInstance) => `${s.node}#${s.expansion}`;
const keysOf = (expansion: string) => parseExpansion(expansion) ?? [];
const isSequential = (node: IrNode | undefined) =>
	node !== undefined && SEQUENTIAL.has(node.kind);
const isStdlib = (node: IrNode | undefined) =>
	node?.kind === "code" && node.worker.module === STDLIB;
const isOutcome = (s: Shown): s is Outcome =>
	(OUTCOMES as readonly string[]).includes(s);
/** A numeric iteration key 1-based, as a reader counts rounds; another key as it is. */
const ordinal = (key: string) =>
	NUMERIC.test(key) ? String(Number(key) + 1) : key;
const matches = (s: NodeInstance, ctx: Ctx) => {
	const keys = keysOf(s.expansion);
	return ctx.every((c, i) => c === ANY || keys[i] === c);
};

/** `states` counted as `3 ok · 1 failed`, in `COUNTED` order. */
export const countsText = (states: readonly Shown[]) =>
	COUNTED.map((state): [Shown, number] => [
		state,
		states.filter((s) => s === state).length,
	])
		.filter(([, n]) => n > 0)
		.map(([state, n]) => `${n} ${state}`)
		.join(NOTE_SEP);

/**
 * The state that stands for `states`, `undefined` for none:
 * - `running` while one is running, or while some have settled and others are pending;
 * - else the worst outcome among them (ADR 0006);
 * - else `pending` or `UNSTARTED`, as they are.
 */
function worstOf(states: readonly Shown[]): Shown | undefined {
	const outcomes = states.filter(isOutcome);
	const pending = states.includes("pending");
	if (states.includes("running") || (pending && outcomes.length > 0))
		return "running";
	if (outcomes.length > 0) return worstOutcome(outcomes);
	return pending ? "pending" : states[0];
}

/** The instances of `seen` that are drawn, by first event: a stdlib helper's only while running, rejected or failed. */
const drawnOf = (graph: GraphIndex, seen: Seen): InstanceState[] =>
	[...seen.values()]
		.filter(
			(s) => !isStdlib(graph.nodes.get(s.node)) || STDLIB_SHOWN.has(s.state),
		)
		.sort((a, b) => a.first - b.first);

/** The drawn instances of `seen` but groups', by first event. */
export const leavesOf = (graph: GraphIndex, seen: Seen) =>
	drawnOf(graph, seen).filter((s) => !isGroup(graph.nodes.get(s.node)));

/** The drawn node instances, groups aside, that are running, the latest started first. */
export const runningOf = (graph: GraphIndex, seen: Seen) =>
	leavesOf(graph, seen)
		.filter((s) => s.state === "running")
		.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

/** The latest settled `failed` node instance, groups aside. A later `rejected` one never takes its place. */
export const lastFailureOf = (graph: GraphIndex, seen: Seen) =>
	leavesOf(graph, seen)
		.filter((s) => s.state === "failed")
		.reduce<InstanceState | undefined>(
			(latest, s) =>
				(s.settledAt ?? 0) >= (latest?.settledAt ?? 0) ? s : latest,
			undefined,
		);

/** Entry `id` in `ctx`: its drawn instances, those under it, by first event, and the state its own stand for. */
function liveOf(graph: GraphIndex, seen: Seen, id: string, ctx: Ctx) {
	const drawn = drawnOf(graph, seen).filter((s) => matches(s, ctx));
	const own = drawn.filter((s) => s.node === id);
	return {
		own,
		inside: drawn.filter((s) => s.node.startsWith(`${id}/`)),
		state: worstOf(own.map((s) => s.state)),
	};
}

/** The iteration keys of `states` at `level`, numerically when they are numbers, else by first event. */
function iterationsOf(states: readonly NodeInstance[], level: number) {
	const keys = [
		...new Set(states.flatMap((s) => keysOf(s.expansion)[level] ?? [])),
	];
	return keys.every((k) => NUMERIC.test(k))
		? keys.sort((a, b) => Number(a) - Number(b))
		: keys;
}

/** The key the members of `group` show in `ctx`: a sequential group's pinned iteration, else its latest, else `ANY`. */
function innerKey(
	graph: GraphIndex,
	seen: Seen,
	group: string,
	ctx: Ctx,
	pins: Pins,
): string {
	if (!isSequential(graph.nodes.get(group))) return ANY;
	const { inside } = liveOf(graph, seen, group, ctx);
	return (
		pins.get(rowKey(group, ctx)) ??
		iterationsOf(inside, ctx.length).at(-1) ??
		FIRST_ITERATION
	);
}

/** The context node `id` is shown in: per enclosing group, its pinned or latest iteration, or `ANY`. */
export function contextOf(
	graph: GraphIndex,
	seen: Seen,
	id: string,
	pins: Pins = NO_PINS,
): Ctx {
	const ctx: string[] = [];
	for (const group of graph.groupsOf(id))
		ctx.push(innerKey(graph, seen, group, ctx, pins));
	return ctx;
}

/** How the rows reach instance `s`: under a parallel group its item row, the aggregated row above it on the path. */
export function focusOf(graph: GraphIndex, s: NodeInstance): Focus {
	const keys = keysOf(s.expansion);
	const ctxAt = (id: string) =>
		graph
			.groupsOf(id)
			.map((g, i) =>
				isSequential(graph.nodes.get(g)) ? (keys[i] ?? "") : ANY,
			);
	const containers = graph
		.ancestors(s.node)
		.reverse()
		.filter((id) => graph.scopes.has(id) || isGroup(graph.nodes.get(id)));
	const path = containers.map((id) => rowKey(id, ctxAt(id)));
	const pins = containers
		.filter((id) => isSequential(graph.nodes.get(id)))
		.map((id): [string, string] => [
			rowKey(id, ctxAt(id)),
			keys[graph.groupsOf(id).length] ?? "",
		]);
	const own = rowKey(s.node, ctxAt(s.node));
	return ctxAt(s.node).includes(ANY)
		? { key: itemKey(s), path: [...path, own], pins }
		: { key: own, path, pins };
}

/**
 * The focus a following cursor takes: the latest started running instance, its aggregated row under a parallel group;
 * else, once the concert settled, the last failure; else none.
 */
export function followOf(
	graph: GraphIndex,
	seen: Seen,
	settled: boolean,
): Focus | undefined {
	const [running] = runningOf(graph, seen);
	if (running === undefined)
		return settled ? lastFocusOf(graph, seen) : undefined;
	const focus = focusOf(graph, running);
	const row = focus.path.at(-1);
	return focus.key === itemKey(running) && row !== undefined
		? { ...focus, key: row, path: focus.path.slice(0, -1) }
		: focus;
}

/** The focus of the last failure, none without one. */
export function lastFocusOf(graph: GraphIndex, seen: Seen) {
	const last = lastFailureOf(graph, seen);
	return last && focusOf(graph, last);
}

/** Instance `s` as a reader names it: `test-loop ⟲2 › repair`, `panel › lenses[spec] › lens`. */
export function labelOf(graph: GraphIndex, s: NodeInstance): string {
	const keys = keysOf(s.expansion);
	const groups = graph.groupsOf(s.node);
	const segs = s.node.split("/");
	return segs
		.map((seg, j) => {
			const i = groups.indexOf(segs.slice(0, j + 1).join("/"));
			if (i < 0) return seg;
			const key = keys[i] ?? "";
			return isSequential(graph.nodes.get(groups[i] ?? ""))
				? `${seg} ⟲${ordinal(key)}`
				: `${seg}[${key}]`;
		})
		.join(PATH_SEP);
}

/** `states`' span: from the first start to the last settle, or to `now` while one is running. */
function spanOf(
	states: readonly InstanceState[],
	now: number,
): Row["span"] | undefined {
	const starts = states.flatMap((s) => s.startedAt ?? []);
	if (starts.length === 0) return undefined;
	const from = Math.min(...starts);
	if (states.some((s) => s.state === "running")) return [from, now];
	const ends = states.flatMap((s) => s.settledAt ?? []);
	return ends.length === 0 ? undefined : [from, Math.max(...ends)];
}

function noteOf(s: InstanceState): string {
	if (s.state === "running") return s.latest ?? "";
	if (s.state === "ok") return s.reused ? "reused" : "";
	return s.reason ?? "";
}

/** A row's group's cardinality: `4`, a loop's cap `3`, else an `upTo` bound as `≤8`, whose total is not known. */
function capOf(node: GroupNode): string {
	const { cardinality } = node;
	if ("exact" in cardinality) return String(cardinality.exact);
	return node.kind === "loop"
		? String(cardinality.upTo)
		: `≤${cardinality.upTo}`;
}

/** The state of iteration `key` at `level`: the worst of the instances in it. */
const iterationState = (
	states: readonly InstanceState[],
	level: number,
	key: string,
): Shown =>
	worstOf(
		states
			.filter((s) => keysOf(s.expansion)[level] === key)
			.map((s) => s.state),
	) ?? "pending";

type Walk = Omit<Overlay, "folds"> & {
	folds: Folds;
	last?: InstanceState;
	pinned: ReadonlySet<string>;
};
/**
 * Where an entry is drawn, under the row keyed `parent`. `done` says nothing more starts there, so what never started is
 * `UNSTARTED`.
 */
type At = { depth: number; done: boolean; parent?: string };
/** An entry's rows, and the state it stands for among its container's members; none when it is left out. */
type Drawn = { rows: Row[]; shown?: Shown };
type Base = Pick<Row, "key" | "id" | "parent" | "depth" | "name" | "kind">;

const LEFT_OUT: Drawn = { rows: [] };
const notYet = (done: boolean): Shown => (done ? UNSTARTED : "pending");
const tokensIn = (w: Walk, states: readonly InstanceState[]) =>
	states.reduce((sum, s) => sum + (w.agents.get(keyOf(s))?.tokens ?? 0), 0);
const holdsFailure = (w: Walk, states: readonly InstanceState[]) =>
	w.settled && w.last !== undefined && states.includes(w.last);
/** Whether the row keyed `key` is open: as the reader set it, else when `auto` says so or the cursor is under it. */
const isOpen = (w: Walk, key: string, auto: boolean) =>
	w.folds.open.get(key) ?? (auto || w.folds.path.includes(key));
/** Whether a container opens of itself: it holds running work, or the concert settled and it holds the last failure. */
const holds = (w: Walk, states: readonly InstanceState[]) =>
	states.some((s) => s.state === "running") || holdsFailure(w, states);
const idOf = (w: Walk, s: NodeInstance) =>
	formatInstance(s, w.graph.groupsOf(s.node));
const pinnedRow = (w: Walk, row: Omit<Row, "pinned">): Row => ({
	...row,
	pinned: row.shown === "running" || w.pinned.has(row.key),
});
/** A container's rows: its own, then its members' when it has any and is open. */
function contained(row: Row, members: readonly Drawn[]): Row[] {
	const rows = members.flatMap((m) => m.rows);
	if (rows.length === 0) return [{ ...row, open: undefined }];
	return row.open ? [row, ...rows] : [row];
}

function instanceRow(w: Walk, s: InstanceState, base: Base): Row {
	const agent = w.agents.get(keyOf(s));
	return pinnedRow(w, {
		...base,
		shown: s.state,
		span: spanOf([s], w.now),
		actor: agent?.actor ?? s.agent,
		tokens: agent?.tokens ?? 0,
		note: noteOf(s),
	});
}

/** The keys of `s`'s parallel groups in `ctx`, which tell its items apart. */
const itemKeys = (s: NodeInstance, ctx: Ctx) => {
	const keys = keysOf(s.expansion);
	return ctx.flatMap((c, i) => (c === ANY ? [keys[i] ?? ""] : []));
};

/** A node under a parallel group: one row for its items with a strip of their states, open on the last failure. */
function aggregated(
	w: Walk,
	base: Base,
	own: readonly InstanceState[],
	ctx: Ctx,
): Drawn {
	const shown = worstOf(own.map((s) => s.state)) ?? "pending";
	const open = isOpen(w, base.key, holdsFailure(w, own));
	const row = pinnedRow(w, {
		...base,
		name: `${base.name} ×${own.length}`,
		shown,
		span: spanOf(own, w.now),
		tokens: tokensIn(w, own),
		note: own
			.map((s) => `${itemKeys(s, ctx).join("/")} ${GLYPH[s.state]}`)
			.join(GAP),
		open,
	});
	const items = own.map((s) =>
		instanceRow(w, s, {
			key: itemKey(s),
			id: idOf(w, s),
			parent: base.key,
			depth: base.depth + 1,
			name: itemKeys(s, ctx)
				.map((k) => `[${k}]`)
				.join(""),
			kind: base.kind,
		}),
	);
	return { rows: open ? [row, ...items] : [row], shown };
}

function leafRows(w: Walk, e: Entry, node: IrNode, at: At): Drawn {
	const ctx = contextOf(w.graph, w.seen, e.id, w.folds.pins);
	const { own } = liveOf(w.graph, w.seen, e.id, ctx);
	const base = {
		key: rowKey(e.id, ctx),
		id: e.id,
		parent: at.parent,
		depth: at.depth,
		name: lastSegment(e.id),
		kind: node.kind,
	};
	const [first] = own;
	if (first === undefined) {
		if (isStdlib(node)) return LEFT_OUT;
		const shown = notYet(at.done);
		return {
			rows: [pinnedRow(w, { ...base, shown, tokens: 0, note: "" })],
			shown,
		};
	}
	if (ctx.includes(ANY)) return aggregated(w, base, own, ctx);
	return {
		rows: [instanceRow(w, first, { ...base, id: idOf(w, first) })],
		shown: first.state,
	};
}

/** `⟲ 2/3   1✗ 2●`: the iteration `shown` of the cap, marked when it is not the latest, then each iteration's state. */
function roundsNote(
	node: GroupNode,
	keys: readonly string[],
	inside: readonly InstanceState[],
	level: number,
	shown: string,
): string {
	const at = keys.length === 0 ? NO_ROUNDS : ordinal(shown);
	const history = isHistory({ keys, shown }) ? HISTORY : "";
	const strip = keys
		.map((k) => `${ordinal(k)}${GLYPH[iterationState(inside, level, k)]}`)
		.join(" ");
	return [`⟲ ${at}/${capOf(node)}${history}`, strip]
		.filter(Boolean)
		.join(WIDE_GAP);
}

/** `4/4 items · 1 failed · 3 ok`: the items started of the cardinality, then each item's state counted. */
function itemsNote(
	node: GroupNode,
	keys: readonly string[],
	inside: readonly InstanceState[],
	level: number,
): string {
	const states = keys.map((k) => iterationState(inside, level, k));
	return [`${keys.length}/${capOf(node)} items`, countsText(states)]
		.filter(Boolean)
		.join(NOTE_SEP);
}

/** Whether a sequential group shows an iteration other than its latest. */
const isHistory = ({ keys, shown }: NonNullable<Row["iterations"]>) =>
	keys.length > 0 && shown !== keys.at(-1);

/** A group's note, and a sequential group's iterations: which it has, and the one its members show. */
function iterationsNote(
	w: Walk,
	node: GroupNode,
	ctx: Ctx,
	inside: readonly InstanceState[],
): Pick<Row, "note" | "iterations"> {
	const level = ctx.length;
	const keys = iterationsOf(inside, level);
	if (!isSequential(node))
		return { note: itemsNote(node, keys, inside, level) };
	const shown = innerKey(w.graph, w.seen, node.id, ctx, w.folds.pins);
	return {
		note: roundsNote(node, keys, inside, level, shown),
		iterations: { keys, shown },
	};
}

function groupRows(w: Walk, e: Entry, node: GroupNode, at: At): Drawn {
	const ctx = contextOf(w.graph, w.seen, e.id, w.folds.pins);
	const { own, inside, state } = liveOf(w.graph, w.seen, e.id, ctx);
	const key = rowKey(e.id, ctx);
	const { note, iterations } = iterationsNote(w, node, ctx, inside);
	const past = iterations !== undefined && isHistory(iterations);
	const inner: At = {
		depth: at.depth + 1,
		done:
			at.done ||
			past ||
			(own.length > 0 && own.every((s) => s.state !== "running")),
		parent: key,
	};
	const members = e.children.map((c) => drawn(w, c, inner));
	const shown = state ?? notYet(at.done);
	const [first] = own;
	const row = pinnedRow(w, {
		key,
		id: first === undefined ? e.id : idOf(w, first),
		parent: at.parent,
		depth: at.depth,
		shown,
		name: lastSegment(e.id),
		kind: node.kind,
		span: spanOf(own, w.now),
		tokens: tokensIn(w, inside),
		note,
		open: isOpen(w, key, holds(w, [...own, ...inside])),
		...(iterations && { iterations }),
	});
	return { rows: contained(row, members), shown };
}

/** A scope: its state is that of its members' rows, each group by its own instance (ADR 0006). */
function scopeRows(w: Walk, e: Entry, at: At): Drawn {
	const ctx = contextOf(w.graph, w.seen, e.id, w.folds.pins);
	const { inside } = liveOf(w.graph, w.seen, e.id, ctx);
	const key = rowKey(e.id, ctx);
	const members = e.children.map((c) =>
		drawn(w, c, { ...at, depth: at.depth + 1, parent: key }),
	);
	const shown =
		worstOf(members.flatMap((m) => m.shown ?? [])) ?? notYet(at.done);
	const composition = w.graph.scopes.get(e.id)?.composition ?? "";
	const leaves = inside.filter((s) => !isGroup(w.graph.nodes.get(s.node)));
	const row = pinnedRow(w, {
		key,
		id: e.id,
		parent: at.parent,
		depth: at.depth,
		shown,
		name: lastSegment(e.id),
		kind: SCOPE_KIND,
		span: spanOf(inside, w.now),
		tokens: tokensIn(w, inside),
		note: [composition, countsText(leaves.map((s) => s.state))]
			.filter(Boolean)
			.join(NOTE_SEP),
		open: isOpen(w, key, holds(w, inside)),
	});
	return { rows: contained(row, members), shown };
}

function drawn(w: Walk, e: Entry, at: At): Drawn {
	if (!e.node) return scopeRows(w, e, at);
	return isGroup(e.node)
		? groupRows(w, e, e.node, at)
		: leafRows(w, e, e.node, at);
}

/**
 * The rows of `shape` with `o`'s live state on it, each node once:
 * - a sequential group shows its latest iteration, and a strip of each one's state;
 * - under a parallel group a node is one row for all its items, with a strip of each item's state;
 * - a container is open as `o.folds` set it, else while it holds running work or the cursor, and once the concert
 *   settled while it holds the last failure;
 * - a sequential group shows the iteration `o.folds` pins in place of its latest, and what never started in an earlier
 *   one is `UNSTARTED`;
 * - a stdlib helper is left out unless running, rejected or failed;
 * - a member that never started is `pending`, and `UNSTARTED` once its iteration, group or concert is done.
 */
export function rowsOf(shape: readonly Entry[], o: Overlay): Row[] {
	const last = lastFailureOf(o.graph, o.seen);
	const pinned = [...runningOf(o.graph, o.seen), ...(last ? [last] : [])]
		.map((s) => focusOf(o.graph, s))
		.flatMap((f) => [f.key, ...f.path]);
	const w: Walk = {
		...o,
		folds: o.folds ?? NO_FOLDS,
		last,
		pinned: new Set(pinned),
	};
	return shape.flatMap((e) => drawn(w, e, { depth: 0, done: o.settled }).rows);
}
