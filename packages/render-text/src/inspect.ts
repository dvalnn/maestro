import {
	compact,
	formatInstance,
	type GraphIndex,
	type Ir,
	indexGraph,
	MS_PER_UNIT,
	type NodeInstance,
	tokensOf,
} from "@maestro/ir";
import {
	type Agents,
	type Annotated,
	browse,
	duration,
	eventLine,
	flat,
	headSegs,
	type InstanceState,
	keyLine,
	lookOf,
	MIN_BODY,
	painted,
	type Recorded,
	type Seen,
	type Seg,
	shellArg,
	shownId,
	type View,
} from "./live";
import type { Browsed, Inspect, Nav } from "./press";
import {
	countsText,
	GAP,
	holdsUnder,
	keyOf,
	labelOf,
	NOTE_SEP,
	rowOf,
	SCOPE_KIND,
	WIDE_GAP,
} from "./tree";

/** An instance as the record holds it: its artifacts beside what `Recorded` holds. */
export type Kept = Recorded & {
	artifacts: readonly { path: string; contentHash: string }[];
};

/**
 * What the inspector reads of the record: the concert's events so far in seq order, annotated, and its instances.
 * `events` only grows, so the lines drawn of it are kept between calls.
 */
export type Held = {
	events: readonly Annotated[];
	instances: readonly Kept[];
};

const INDENT = "  ";
/** The summary's label column: wide enough for `context`, and a gap. */
const LABEL_WIDTH = "context".length + GAP.length;
const RULE = "─";
/** Lines the inspector holds below its events: the rule and the key line. */
const INSPECTOR_BELOW = 2;
/** The fewest summary lines kept however short the terminal: the title and one more. */
const MIN_SUMMARY = 2;
const INSPECTOR_HINTS = [
	"j/k scroll",
	"u/d page",
	"g/G top/tail",
	"esc/q back",
	"^C quit",
];

/**
 * The events of the instances the row keyed `key` stands for, in their order: an item row's one instance, any other
 * row's instances at or under its node in its context.
 */
export const selected = <T extends NodeInstance>(
	graph: GraphIndex,
	key: string,
	events: readonly T[],
): T[] => events.filter(rowOf(graph, key).holds);

/** The events of the instances at or under `node` in the iterations `keys` name, as `holdsUnder` reads them. */
export const selectedUnder = <T extends NodeInstance>(
	graph: GraphIndex,
	node: string,
	keys: readonly string[],
	events: readonly T[],
): T[] => events.filter(holdsUnder(graph, node, keys));

const labelled = (name: string, value: readonly Seg[]): Seg[] => [
	[`${INDENT}${name.padEnd(LABEL_WIDTH)}`, "dim"],
	...value,
];

const titleSegs = (parts: readonly string[]): Seg[] => [
	["◆ inspect  ", "magenta"],
	[parts.filter(Boolean).map(flat).join(GAP), "bold"],
];

const kindOf = (graph: GraphIndex, node: string) =>
	graph.scopes.has(node) ? SCOPE_KIND : (graph.nodes.get(node)?.kind ?? "");

const tokenText = (tokens: number) =>
	tokens > 0 ? `${compact(tokens)} tok` : "";
const tokensNote = (tokens: number) =>
	tokens > 0 ? `${WIDE_GAP}${tokenText(tokens)}` : "";

/** `started +31m33s   ran 1m26s`, from the concert's start; running until `to`, else until now. */
function timesText(view: View, from?: number, to?: number): string {
	if (from === undefined) return "not started";
	const since = duration(from - view.concert.startedAt, MS_PER_UNIT.m);
	return `started +${since}${WIDE_GAP}ran ${duration((to ?? view.now) - from)}`;
}

const endOf = (s: InstanceState) =>
	s.state === "running" ? undefined : s.settledAt;

/** An instance's reason, or its latest progress while running; none without either. */
function noteSegs(s: InstanceState): Seg[][] {
	if (s.reason !== undefined)
		return [labelled("reason", [[flat(s.reason), lookOf(s.state)?.style]])];
	if (s.state === "running" && s.latest !== undefined)
		return [labelled("latest", [[s.latest, "dim"]])];
	return [];
}

/** An instance's recorded metrics by name, left out when absent. */
function keptSegs(k: Kept | undefined): Seg[][] {
	if (k === undefined) return [];
	const metrics = Object.entries(k.metrics).map(
		([name, n]) => `${flat(name)} ${compact(n)}`,
	);
	return metrics.length > 0
		? [labelled("metrics", [[metrics.join(NOTE_SEP)]])]
		: [];
}

/** The hint to `maestro art show` for an instance that has artifacts, none without. */
const filesSegs = (view: View, name: string, k: Kept | undefined): Seg[][] =>
	k && k.artifacts.length > 0
		? [
				labelled("files", [
					[
						`maestro art show ${shownId(view.concert.id, view.concert.unique)} ${shellArg(flat(name))}`,
						"dim",
					],
				]),
			]
		: [];

/** One instance's title and `state` line: its state, a stale mark, times, tokens and actor. */
function stateSegs(
	graph: GraphIndex,
	view: View,
	s: InstanceState,
	name: string,
	k: Kept | undefined,
): { title: Seg[]; state: Seg[] } {
	const actor = k?.actor ?? s.agent ?? "";
	const tokens = k ? tokensOf(k.metrics) : 0;
	const ran =
		s.startedAt === undefined
			? ""
			: duration((endOf(s) ?? view.now) - s.startedAt);
	const times = s.reused ? "reused" : timesText(view, s.startedAt, endOf(s));
	const stale: Seg[] = k?.stale ? [[`${WIDE_GAP}stale`, "yellow"]] : [];
	const title = [name, kindOf(graph, s.node)];
	return {
		title: titleSegs([...title, s.state, ran, actor, tokenText(tokens)]),
		state: labelled("state", [
			[s.state, lookOf(s.state)?.style],
			...stale,
			[`${WIDE_GAP}${times}${tokensNote(tokens)}`, "dim"],
			[actor ? `${WIDE_GAP}${flat(actor)}` : "", "dim"],
		]),
	};
}

/** One instance: its title, context, state, reason or latest, metrics and `files` hint. */
function instanceSegs(
	graph: GraphIndex,
	view: View,
	s: InstanceState,
	k: Kept | undefined,
): Seg[][] {
	const name = formatInstance(s, graph.groupsOf(s.node));
	const { title, state } = stateSegs(graph, view, s, name, k);
	return [
		title,
		labelled("context", [[flat(labelOf(graph, s))]]),
		state,
		...noteSegs(s),
		...keptSegs(k),
		...filesSegs(view, name, k),
	];
}

/** Several instances, or none: the row's node and kind, then the instances counted by state, their tokens and span. */
function groupSegs(
	graph: GraphIndex,
	view: View,
	node: string,
	states: readonly InstanceState[],
	kept: ReadonlyMap<string, Kept>,
): Seg[][] {
	const counts = countsText(states.map((s) => s.state));
	const title = titleSegs([node, kindOf(graph, node), counts]);
	if (states.length === 0)
		return [title, labelled("context", [["no instance yet", "dim"]])];
	const tokens = states.reduce((sum, s) => {
		const k = kept.get(keyOf(s));
		return sum + (k && !k.stale ? tokensOf(k.metrics) : 0);
	}, 0);
	const starts = states.flatMap((s) => s.startedAt ?? []);
	const ends = states.map(endOf);
	const to = ends.includes(undefined)
		? undefined
		: Math.max(...ends.flatMap((e) => e ?? []));
	const from = starts.length > 0 ? Math.min(...starts) : undefined;
	return [
		title,
		labelled("context", [
			[`${states.length} instance${states.length === 1 ? "" : "s"}`],
		]),
		labelled("states", [[counts], [tokensNote(tokens), "dim"]]),
		labelled("span", [[timesText(view, from, to), "dim"]]),
	];
}

/** Event lines drawn so far: of the first `read` events of a `Held`, the `count` the row selects. */
type Drawn = { read: number; lines: string[]; count: number };
/** The event lines drawn of each `Held.events`, by row key and how they are drawn. */
const DRAWN = new WeakMap<readonly Annotated[], Map<string, Drawn>>();

/** The lines of the events of row `key`, cut at `view.columns - 1` cells; only events new since the last call are drawn. */
function drawnOf(
	ir: Ir,
	graph: GraphIndex,
	view: View,
	key: string,
	events: readonly Annotated[],
): Drawn {
	const byView = DRAWN.get(events) ?? new Map<string, Drawn>();
	DRAWN.set(events, byView);
	const width = view.columns - 1;
	const id = `${key}\n${width}\n${view.color}`;
	const was = byView.get(id) ?? { read: 0, lines: [], count: 0 };
	const fresh = selected(graph, key, events.slice(was.read));
	const lines = fresh.flatMap((e) =>
		eventLine(ir, e, { ...view, columns: width })
			.split("\n")
			.map((l) => Bun.sliceAnsi(l, 0, width)),
	);
	const drawn = {
		read: events.length,
		lines: was.lines.concat(lines),
		count: was.count + fresh.length,
	};
	byView.set(id, drawn);
	return drawn;
}

/**
 * The inspector on the row keyed `key`: its title and summary, the lines of its events as `eventLine` draws them, and
 * their count. One instance of the row's own node is summarised in full: its context, state, times, tokens, actor, a
 * `stale` mark, its reason or latest progress, its metrics by name when recorded, and a `files` line naming the
 * `maestro art` that serves its artifacts. Any other row counts the instances under it by state, with tokens and span.
 * `held.events` only grows, so only the events new since the last call are drawn.
 */
export function inspectorLines(
	ir: Ir,
	seen: Seen,
	view: View,
	key: string,
	held: Held,
): { head: Seg[][]; events: string[]; count: number } {
	const graph = indexGraph(ir);
	const row = rowOf(graph, key);
	const states = [...seen.values()].filter(row.holds);
	const kept = new Map(held.instances.map((i) => [keyOf(i), i]));
	const [only] = states;
	const head =
		only?.node === row.node && states.length === 1
			? instanceSegs(graph, view, only, kept.get(keyOf(only)))
			: groupSegs(graph, view, row.node, states, kept);
	const { lines, count } = drawnOf(ir, graph, view, key, held.events);
	return { head, events: lines, count };
}

/** `head` within `most` lines, the last of them counting what is left out. */
function capped(head: readonly Seg[][], most: number): Seg[][] {
	if (head.length <= most) return [...head];
	const kept = head.slice(0, most - 1);
	return [
		...kept,
		[[`${INDENT}… ${head.length - kept.length} more lines`, "dim"]],
	];
}

/** The rule under the events: how many, and which lines are in view when they do not all fit. */
function ruleSegs(
	view: View,
	count: number,
	lines: number,
	scroll: number,
	body: number,
): Seg[] {
	const range =
		lines > body
			? `${NOTE_SEP}lines ${scroll + 1}–${Math.min(lines, scroll + body)} of ${lines}`
			: "";
	const head = `${RULE}${RULE} ${count} events${range} `;
	return [
		[
			`${head}${RULE.repeat(Math.max(1, view.columns - 1 - head.length))}`,
			"dim",
		],
	];
}

/** The inspector's screen: the header, `now` and `last`, the summary, a viewport of event lines, the rule and the keys. */
function inspector(
	ir: Ir,
	seen: Seen,
	view: View,
	nav: Nav,
	held: Held,
	at: Inspect,
): Browsed {
	const graph = indexGraph(ir);
	const { head, events, count } = inspectorLines(ir, seen, view, at.key, held);
	const top = headSegs(graph, seen, view);
	const room = view.rows - top.length - INSPECTOR_BELOW;
	const summary = capped(head, Math.max(MIN_SUMMARY, room - MIN_BODY));
	const body = Math.max(MIN_BODY, room - summary.length);
	const scrollMax = Math.max(0, events.length - body);
	const scroll = at.tail ? scrollMax : Math.min(at.scroll, scrollMax);
	const shown = events.slice(scroll, scroll + body);
	const paint = (segs: readonly Seg[]) =>
		painted(segs, view.color, view.columns - 1);
	const keys = keyLine(
		[at.tail ? "◆ tail" : "◆ scrolled", "magenta"],
		INSPECTOR_HINTS,
		view.columns - 1,
	);
	const lines = [
		...[...top, ...summary].map(paint),
		...shown,
		...Array<string>(body - shown.length).fill(""),
		paint(ruleSegs(view, count, events.length, scroll, body)),
		paint(keys),
	];
	return {
		lines,
		nav: { ...nav, inspect: { ...at, scroll } },
		rows: [],
		body,
		scrollMax,
	};
}

/** The view `nav` is on: the tree as `browse` draws it, or with `nav.inspect` the inspector on that row from `held`. */
export const navigated = (
	ir: Ir,
	seen: Seen,
	view: View,
	agents: Agents,
	nav: Nav,
	held: Held,
): Browsed =>
	nav.inspect
		? inspector(ir, seen, view, nav, held, nav.inspect)
		: browse(ir, seen, view, agents, nav);
