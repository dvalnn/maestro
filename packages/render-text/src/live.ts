import { styleText } from "node:util";
import {
	type ConcertEvent,
	formatInstance,
	type GraphIndex,
	type HostEvent,
	type Ir,
	indexGraph,
	MS_PER_UNIT,
	type NodeInstance,
	type Outcome,
} from "@maestro/ir";
import { type Fitted, fitted } from "./fit";
import { arranged, shapeOf } from "./layout";
import { type Browsed, type Nav, resolve } from "./press";
import {
	countsText,
	followOf,
	GAP,
	GLYPH,
	keyOf,
	labelOf,
	lastFailureOf,
	lastFocusOf,
	leavesOf,
	type Row,
	rowsOf,
	runningOf,
	type Shown,
	UNSTARTED,
	WIDE_GAP,
} from "./tree";

/** What one instance's events say of it. `first` is the seq of its first event, which orders a node's instances. */
export type InstanceState = NodeInstance & {
	state: "running" | Outcome;
	reused: boolean;
	reason?: string;
	startedAt?: number;
	settledAt?: number;
	/** Its latest progress event's word and detail, on one line. */
	latest?: string;
	/** The actor a progress event announced for it, as `agentText` shows it before any tokens. */
	agent?: string;
	first: number;
};

/**
 * An event with the text its host gives it: `wording`, the word and detail of a progress event the host words, and
 * `actor` for one that names who executes the instance, which the agent column shows instead of a note.
 */
export type Annotated = ConcertEvent & {
	wording?: { word: string; detail: string };
	actor?: string;
};

/** Instance states keyed by node and expansion. */
export type Seen = ReadonlyMap<string, InstanceState>;

/** The concert facts a view shows beside its events. Times are epoch ms. */
export type View = {
	concert: {
		id: string;
		label: string;
		title?: string;
		status: "running" | Outcome;
		/** How many leading letters of `id`'s short id tell it from every other concert's, as `shortIds` counts. */
		unique: number;
		startedAt: number;
		settledAt?: number;
	};
	/** The concert's token total. */
	tokens: number;
	now: number;
	color: boolean;
	columns: number;
	rows: number;
};

/** A 256-colour grey, which `styleText` has no name for. */
const SOFT_GREY = { open: "\u001b[38;5;250m", close: "\u001b[39m" } as const;
/** A style `styleText` names. */
type Named = Parameters<typeof styleText>[0];
type Style = Named | typeof SOFT_GREY;

const isGrey = (style: Style): style is typeof SOFT_GREY => style === SOFT_GREY;

export const styled = (style: Style, text: string) =>
	isGrey(style)
		? `${style.open}${text}${style.close}`
		: styleText(style, text, { validateStream: false });
/** How a state is drawn. `whole` styles the whole line, `noted` its note too. */
type Look = { style: Style; whole?: boolean; noted?: boolean };

const LOOK: Readonly<Record<Shown, Look>> = {
	pending: { style: "dim", whole: true },
	[UNSTARTED]: { style: "dim", whole: true },
	running: { style: "cyan" },
	ok: { style: "green" },
	rejected: { style: "yellow", noted: true },
	failed: { style: "red", noted: true },
	skipped: { style: "dim", whole: true },
};
const RULE = "─";
type Metrics = Readonly<Record<string, number>>;
/** The prefix of the metrics that count tokens. */
const TOKEN_METRIC = "tokens_";
/** A subset of the output tokens, so a total leaves it out. */
const REASONING_METRIC = "tokens_reasoning";
const THOUSAND = 1_000;
const MILLION = 1_000_000;
const INDENT = "  ";
const NEWLINE = /\r?\n/;
/** A control character other than a newline. */
const CONTROL = /[^\P{Cc}\n]/gu;
const TENTHS_BELOW_MS = 10 * MS_PER_UNIT.s;
const TENTH_MS = 100;

/** Shows each control character but a newline as its JSON escape, so no text moves the terminal's cursor. */
const safe = (text: string) =>
	text.replace(CONTROL, (c) => JSON.stringify(c).slice(1, -1));

/** `text` on one line: newlines shown as spaces, every other control character as its JSON escape. */
export const flat = (text: string) => safe(text.split(NEWLINE).join(" "));

const twoDigits = (n: number) => String(n).padStart(2, "0");

/** `ms` as `3.1s` under `tenthsBelow` ms, `42s` under a minute, `4m05s` under an hour, else `1h02m`. */
function duration(ms: number, tenthsBelow = TENTHS_BELOW_MS): string {
	const { s, m, h } = MS_PER_UNIT;
	const t = Math.max(0, ms);
	if (t < tenthsBelow)
		return `${(Math.floor(t / TENTH_MS) / (s / TENTH_MS)).toFixed(1)}s`;
	if (t < m) return `${Math.floor(t / s)}s`;
	if (t < h)
		return `${Math.floor(t / m)}m${twoDigits(Math.floor((t % m) / s))}s`;
	return `${Math.floor(t / h)}h${twoDigits(Math.floor((t % h) / m))}m`;
}

/** `kind` when it is a string; each other defined field as itself when a string, else compact JSON. */
function progressParts(event: HostEvent) {
	const kind = typeof event.kind === "string" ? event.kind : undefined;
	const fields = Object.entries(event)
		.filter(
			([key, value]) =>
				!(kind !== undefined && key === "kind") && value !== undefined,
		)
		.map(([, value]) =>
			typeof value === "string" ? value : JSON.stringify(value),
		);
	return { kind, fields };
}

/** `kind` then each other field, on one line. */
function genericLine(event: HostEvent): string {
	const { kind, fields } = progressParts(event);
	return (kind === undefined ? fields : [kind, ...fields]).join(" ");
}

function folded(
	prior: InstanceState | undefined,
	event: Annotated,
): InstanceState | undefined {
	const { node, expansion, seq, at } = event;
	const base = prior ?? {
		node,
		expansion,
		state: "running",
		reused: false,
		first: seq,
	};
	switch (event.type) {
		case "running":
			return {
				node,
				expansion,
				state: "running",
				reused: false,
				first: base.first,
				startedAt: at,
			};
		case "settled":
			return {
				...base,
				state: event.outcome,
				settledAt: at,
				reason: event.reason,
			};
		case "reused":
			return { ...base, state: "ok", reused: true };
		case "progress": {
			const named =
				event.actor === undefined ? base : { ...base, agent: event.actor };
			if (event.actor !== undefined && event.wording === undefined)
				return named;
			const line = event.wording
				? `${event.wording.word} ${event.wording.detail}`.trimEnd()
				: genericLine(event.event);
			return { ...named, latest: flat(line) };
		}
		case "log":
			return prior;
	}
}

/** `prior` with `events` folded in; the latest event of an instance wins. */
export function seen(prior: Seen, events: readonly Annotated[]): Seen {
	const next = new Map(prior);
	for (const event of events) {
		const state = folded(next.get(keyOf(event)), event);
		if (state) next.set(keyOf(event), state);
	}
	return next;
}

/** A row's texts as the frame shows them, safe for a terminal. */
type Texts = {
	name: string;
	kind: string;
	time: string;
	agent: string;
	note: string;
};
type Seg = readonly [text: string, style?: Style];
type Widths = {
	lead: number;
	kind: number;
	state: number;
	time: number;
	agent: number;
};

/** What executes each current agent instance, as its host says, and its tokens, by instance. */
export type Agents = ReadonlyMap<string, { actor?: string; tokens: number }>;

/** An instance's record: who its host says ran it, and its metrics, with whether an earlier attempt left it. */
type Recorded = NodeInstance & {
	actor?: string;
	metrics: Metrics;
	stale: boolean;
};

/** The sum of the token metrics of `metrics`, but reasoning tokens, which output tokens already count. */
export const tokensOf = (metrics: Metrics) =>
	Object.entries(metrics)
		.filter(
			([name]) => name.startsWith(TOKEN_METRIC) && name !== REASONING_METRIC,
		)
		.reduce((sum, [, value]) => sum + value, 0);

/** `n` as `1.2M` from a million, `15.5k` from a thousand, else as it is. */
export function compact(n: number): string {
	if (n < THOUSAND) return String(n);
	const thousands = (n / THOUSAND).toFixed(1);
	return Number(thousands) < THOUSAND
		? `${thousands}k`
		: `${(n / MILLION).toFixed(1)}M`;
}

/** `actor` as the agent column shows it, then the total of `tokensOf` as `<total> tok`, left out when 0. Empty without an actor. */
export function agentText(actor: string | undefined, metrics: Metrics): string {
	const tokens = tokensOf(metrics);
	if (actor === undefined) return "";
	return tokens > 0 ? `${actor}${GAP}${compact(tokens)} tok` : actor;
}

/** The actor and the `tokensOf` total of each current instance of `records`, by instance. */
export function agentsOf(records: readonly Recorded[]): Agents {
	const agents = new Map<string, { actor?: string; tokens: number }>();
	for (const r of records)
		if (!r.stale)
			agents.set(keyOf(r), { actor: r.actor, tokens: tokensOf(r.metrics) });
	return agents;
}

/** `instances` in graph order, as the watch view lists them: ordered by first event in `seen`, then laid out. */
export function inGraphOrder<T extends NodeInstance>(
	ir: Ir,
	instances: readonly T[],
	seen: Seen,
): T[] {
	const first = (i: T) => seen.get(keyOf(i))?.first ?? Number.MAX_SAFE_INTEGER;
	return arranged(
		ir,
		[...instances].sort((a, b) => first(a) - first(b)),
	);
}

/** `text` padded with spaces to `cells` terminal cells. */
export const padCells = (text: string, cells: number) =>
	text + " ".repeat(Math.max(0, cells - Bun.stringWidth(text)));

const indentOf = (depth: number) => INDENT.repeat(depth);
/** A container row's marker, open or closed, before its glyph; blank on a row with no members. */
const MARKER = { open: "▾ ", closed: "▸ ", none: "  " } as const;
/** The cells before a row's name beside its indent: the marker, the glyph and a space. */
const LEAD_CELLS = MARKER.none.length + 2;
const ELLIPSIS = "…";

export const markerOf = ({ open }: Row) => {
	if (open === undefined) return MARKER.none;
	return open ? MARKER.open : MARKER.closed;
};

function textsOf(row: Row): Texts {
	const tokens = row.tokens > 0 ? `${compact(row.tokens)} tok` : "";
	return {
		name: flat(row.name),
		kind: safe(row.kind),
		time: row.span ? duration(row.span[1] - row.span[0]) : "",
		agent: [row.actor === undefined ? "" : safe(row.actor), tokens]
			.filter(Boolean)
			.join(GAP),
		note: flat(row.note),
	};
}

/** A row with the texts it shows. */
type Texted = Row & { t: Texts };

function widthsOf(rows: readonly Texted[]): Widths {
	const most = (cells: (row: Texted) => number) =>
		Math.max(0, ...rows.map(cells));
	return {
		lead: most(
			({ depth, t }) =>
				indentOf(depth).length + LEAD_CELLS + Bun.stringWidth(t.name),
		),
		kind: most(({ t }) => t.kind.length),
		state: most(({ shown }) => shown.length),
		time: most(({ t }) => t.time.length),
		agent: most(({ t }) => Bun.stringWidth(t.agent)),
	};
}

function noteStyleOf(shown: Shown): Style | undefined {
	const look = LOOK[shown];
	if (look.noted) return look.style;
	return shown === "running" ? "dim" : undefined;
}

function rowSegs(row: Row, t: Texts, w: Widths): Seg[] {
	const look = LOOK[row.shown];
	const indent = indentOf(row.depth);
	const agent: Seg[] =
		w.agent === 0 ? [] : [[padCells(t.agent, w.agent) + GAP, "dim"]];
	const segs: Seg[] = [
		[indent + markerOf(row), "dim"],
		[GLYPH[row.shown], look.style],
		[padCells(` ${t.name}`, w.lead - indent.length - LEAD_CELLS + 1) + GAP],
		[t.kind.padEnd(w.kind) + GAP, "dim"],
		[row.shown.padEnd(w.state) + GAP, look.style],
		[t.time.padEnd(w.time) + GAP, "dim"],
		...agent,
		[t.note, noteStyleOf(row.shown)],
	];
	return look.whole ? segs.map(([text]) => [text, look.style]) : segs;
}

/** A stretch of hidden rows as one line at its depth: `… 12 ok · 1 skipped`. */
const hiddenSegs = (depth: number, states: readonly Shown[]): Seg[] => [
	[`${indentOf(depth)}${MARKER.none}${ELLIPSIS} ${countsText(states)}`, "dim"],
];

const lineSegs = (line: Fitted<Texted>, w: Widths): Seg[] =>
	line.type === "row"
		? rowSegs(line.row, line.row.t, w)
		: hiddenSegs(line.depth, line.states);

/** `text` cut to its first `room` terminal cells, by whole code points. */
function fit(text: string, room: number): string {
	let cut = "";
	let left = room;
	for (const point of text) {
		left -= Bun.stringWidth(point);
		if (left < 0) break;
		cut += point;
	}
	return cut;
}

/** One line cut at `limit` terminal cells without trailing spaces, each segment styled after the cut when `color`. */
function painted(segs: readonly Seg[], color: boolean, limit: number): string {
	const plain = segs.map(([text]) => text).join("");
	let room = Math.min(Bun.stringWidth(plain.trimEnd()), limit);
	let out = "";
	for (const [text, style] of segs) {
		const cut = fit(text, room);
		room = cut === text ? room - Bun.stringWidth(cut) : 0;
		out += color && style && cut ? styled(style, cut) : cut;
	}
	return out;
}

/** `segs` as one line as they are, each styled when `color`. */
const line = (segs: readonly Seg[], color: boolean) =>
	segs
		.map(([text, style]) =>
			color && style && text ? styled(style, text) : text,
		)
		.join("");

const lookOf = (state: string): Look | undefined =>
	Object.entries(LOOK).find(([shown]) => shown === state)?.[1];

/** `state`, an instance's or a concert's, in the style the views give it when `color`. */
export const stateWord = (state: string, color: boolean) => {
	const look = lookOf(state);
	return color && look ? styled(look.style, state) : state;
};

/** How many letters of a concert's short id are shown at least. */
const SHORT_ID_MIN = 8;
/** How many trailing hex digits of a concert's UUIDv7 its short id spells: the random tail. */
const SHORT_ID_DIGITS = 15;
/** jj's reverse hex: hex digit `d` is the letter at index `d`, so a short id never reads as hex. */
const REVERSE_HEX = "zyxwvutsrqponmlk";
const HEX_DIGIT = /[0-9a-f]/gi;
const HEX_RADIX = 16;

/** Concert `id`'s short id: the last 15 hex digits of its UUID, each written as its reverse-hex letter. */
export const shortId = (id: string) =>
	id
		.replaceAll("-", "")
		.slice(-SHORT_ID_DIGITS)
		.replace(HEX_DIGIT, (d) =>
			REVERSE_HEX.charAt(Number.parseInt(d, HEX_RADIX)),
		);

/** How many leading characters `a` and `b` share. */
function shared(a: string, b: string): number {
	let n = 0;
	while (n < a.length && a[n] === b[n]) n++;
	return n;
}

/** Concert `id`'s short id as shown: its first `unique` letters, and at least 8. */
const shownId = (id: string, unique: number) =>
	shortId(id).slice(0, Math.max(SHORT_ID_MIN, unique));

/** Concert `id`'s short id as segments: its first `unique` letters bold, then dim up to at least 8 letters. */
function idSegs(id: string, unique: number): Seg[] {
	const shown = shownId(id, unique);
	return [
		[shown.slice(0, unique), "bold"],
		[shown.slice(unique), "dim"],
	];
}

/** The short ids of the concerts `ids`, each told apart from every other, worked out once for all of them. */
export type ShortIds = {
	/** How many leading letters of concert `id`'s short id no other's starts with. */
	unique(id: string): number;
	/** Concert `id`'s short id as shown, at least 8 letters, its unique ones bold and the rest dim when `color`. */
	label(id: string, color: boolean): string;
};

/** The short ids of the concerts `ids`: each one's unique length is one past what it shares with its sorted neighbours. */
export function shortIds(ids: readonly string[]): ShortIds {
	const sorted = ids.map(shortId).sort();
	const lengths = new Map(
		sorted.map((short, i) => [
			short,
			Math.min(
				short.length,
				1 +
					Math.max(
						shared(short, sorted[i - 1] ?? ""),
						shared(short, sorted[i + 1] ?? ""),
					),
			),
		]),
	);
	const unique = (id: string) => lengths.get(shortId(id)) ?? 1;
	return {
		unique,
		label: (id, color) => line(idSegs(id, unique(id)), color),
	};
}

/** How long `view`'s concert ran: until it settled, else until now. */
const ranFor = ({ concert, now }: View) =>
	duration((concert.settledAt ?? now) - concert.startedAt);

function headerSegs(view: View): Seg[] {
	const { concert } = view;
	const look = lookOf(concert.status);
	const title =
		concert.title === undefined ? "" : `"${flat(concert.title)}"${GAP}`;
	return [
		[`${GLYPH[concert.status]} ${safe(concert.label)}${GAP}${title}`, "bold"],
		...idSegs(concert.id, concert.unique),
		[`${GAP} `],
		[safe(concert.status), look?.style],
		[`${GAP}${ranFor(view)}`],
	];
}

/** The width of the `now` and `last` labels, with their gap. */
const LABEL_CELLS = "last".length + GAP.length;
const label = (text: string): Seg => [text.padEnd(LABEL_CELLS), "dim"];

/** `now`: the latest started running instance, its time and how many more are running, then its latest progress. */
function nowSegs(graph: GraphIndex, seen: Seen, view: View): Seg[] {
	const [first, ...rest] = runningOf(graph, seen);
	if (!first) {
		const idle =
			view.concert.status === "running"
				? "between nodes"
				: "nothing, the concert settled";
		return [label("now"), [idle, "dim"]];
	}
	const time =
		first.startedAt === undefined ? "" : duration(view.now - first.startedAt);
	const more: Seg[] =
		rest.length > 0 ? [[`${WIDE_GAP}+${rest.length} running`, "cyan"]] : [];
	return [
		label("now"),
		[`${GLYPH.running} `, LOOK.running.style],
		[flat(labelOf(graph, first)), "bold"],
		[`${WIDE_GAP}${time}`],
		...more,
		[first.latest ? `${WIDE_GAP}${first.latest}` : "", "dim"],
	];
}

/** `last`: the latest `failed` instance and its reason. */
function lastSegs(graph: GraphIndex, seen: Seen, settled: boolean): Seg[] {
	const failure = lastFailureOf(graph, seen);
	if (!failure)
		return [label("last"), [settled ? "no failure" : "no failure yet", "dim"]];
	const { style } = LOOK.failed;
	return [
		label("last"),
		[`${GLYPH.failed} `, style],
		[flat(labelOf(graph, failure)), "bold"],
		[`${WIDE_GAP}${failure.state}`, style],
		[`${WIDE_GAP}${flat(failure.reason ?? "")}`, style],
	];
}

/** The rule under the rows: the drawn node instances counted, groups aside, then `hint` when given, and the tokens. */
function footerSegs(states: readonly Shown[], view: View, hint = ""): Seg[] {
	const after = hint ? `${RULE}${RULE} ${hint} ` : "";
	const head = `${RULE}${RULE} ${countsText(states)} ${after}`;
	const tail =
		view.tokens > 0 ? ` ${compact(view.tokens)} tok ${RULE}${RULE}` : "";
	const fill = Math.max(1, view.columns - 1 - head.length - tail.length);
	return [[`${head}${RULE.repeat(fill)}${tail}`, "dim"]];
}

/** The header, `now` and `last`. */
const headSegs = (graph: GraphIndex, seen: Seen, view: View): Seg[][] => [
	headerSegs(view),
	nowSegs(graph, seen, view),
	lastSegs(graph, seen, view.concert.status !== "running"),
];

/** Lines the frame holds beside its rows: the header, `now`, `last` and the footer. */
const CHROME_LINES = 4;
/** The line the terminal keeps free below the frame. */
const FREE_LINES = 1;

/**
 * The live graph as lines within `columns - 1` terminal cells and `rows - 1` lines: a header, `now` and `last`, the
 * rows of `rowsOf` passed through `fitted`, and a footer of counts and the concert's tokens. `agents` says what executes
 * each agent instance and its tokens.
 */
export function frame(ir: Ir, seen: Seen, view: View, agents: Agents): string {
	const graph = indexGraph(ir);
	const settled = view.concert.status !== "running";
	const rows = rowsOf(shapeOf(ir, graph), {
		graph,
		seen,
		agents,
		settled,
		now: view.now,
	}).map((row) => ({ ...row, t: textsOf(row) }));
	const widths = widthsOf(rows);
	const lines = fitted(rows, view.rows - FREE_LINES - CHROME_LINES);
	const hid = lines.filter((l) => l.type === "row").length < rows.length;
	const { id, unique } = view.concert;
	const states = leavesOf(graph, seen).map((s) => s.state);
	return [
		...headSegs(graph, seen, view),
		...lines.map((l) => lineSegs(l, widths)),
		footerSegs(
			states,
			view,
			hid ? `every row: maestro ls ${shownId(id, unique)}` : "",
		),
	]
		.map((segs) => painted(segs, view.color, view.columns - 1))
		.join("\n");
}

/** Lines a browsed view holds above its viewport: the header, `now` and `last`. */
const ABOVE_LINES = 3;
/** Lines a browsed view holds below its viewport: the rule, the cursor row's two detail lines and the key line. */
const BELOW_LINES = 4;
/** The fewest rows a viewport shows, however short the terminal. */
const MIN_BODY = 3;
/** Reverse video on and off, which marks the cursor row. */
const REVERSE = { open: "\u001b[7m", close: "\u001b[27m" } as const;
/** The column before each row of a viewport: the cursor row's mark, else blank. */
const LEAD = { cursor: ">", other: " " } as const;
const KEY_HINTS = "j/k move  h/l fold  [ ] round  e last failure";
const FOLLOW_HINT = "f follow";
const QUIT_HINT = "q quit";

/** The cursor row: its mark in the lead column, and with color reverse video across the line. */
function cursorLine(segs: readonly Seg[], color: boolean, limit: number) {
	const plain = `${LEAD.cursor}${painted(segs, false, limit - LEAD.cursor.length)}`;
	return color
		? `${REVERSE.open}${padCells(plain, limit)}${REVERSE.close}`
		: plain;
}

/** The rows `nav` puts in a viewport of `body` lines, the cursor's marked, blank lines filling what is left. */
function viewportLines(
	rows: readonly Texted[],
	nav: Nav,
	body: number,
	view: View,
): string[] {
	const widths = widthsOf(rows);
	const limit = view.columns - 1;
	const shown = rows.slice(nav.top, nav.top + body).map((row, i) => {
		const segs = rowSegs(row, row.t, widths);
		return nav.top + i === nav.index
			? cursorLine(segs, view.color, limit)
			: `${LEAD.other}${painted(segs, view.color, limit - LEAD.other.length)}`;
	});
	return [...shown, ...Array(body - shown.length).fill("")];
}

/** The cursor row in full: its instance, kind, state, time and agent, then its note. */
function detailSegs(row: Texted | undefined): Seg[][] {
	if (row === undefined) return [[], []];
	const { t } = row;
	const look = LOOK[row.shown];
	return [
		[
			["› "],
			[
				[row.id, t.kind, row.shown, t.time, t.agent].filter(Boolean).join(GAP),
				"bold",
			],
		],
		[[INDENT], [t.note, look.noted ? look.style : "dim"]],
	];
}

/** The key line: the mode, settled, following or browsing, then the keys. */
function keySegs(nav: Nav, settled: boolean): Seg[] {
	const [mode, style]: Seg = settled
		? ["■ settled", "green"]
		: nav.follow
			? ["● follow", "cyan"]
			: ["○ browse", "yellow"];
	const hints = [KEY_HINTS, ...(settled ? [] : [FOLLOW_HINT]), QUIT_HINT];
	return [
		[mode, style],
		[`${WIDE_GAP}${hints.join(GAP)}`, "dim"],
	];
}

/**
 * The live graph to browse, in `view.rows` lines within `columns - 1` cells: the header, `now` and `last`, a viewport
 * of the rows of `rowsOf` folded as `prior` says, a rule of counts with the rows in view, the cursor row's detail, and
 * the key line. Following, the cursor goes to the follow target. `agents` says what executes each agent instance and its
 * tokens.
 */
export function browse(
	ir: Ir,
	seen: Seen,
	view: View,
	agents: Agents,
	prior: Nav,
): Browsed {
	const graph = indexGraph(ir);
	const settled = view.concert.status !== "running";
	const target = prior.follow ? followOf(graph, seen, settled) : undefined;
	const wanted = target
		? { ...prior, cursor: target.key, path: target.path }
		: prior;
	const rows = rowsOf(shapeOf(ir, graph), {
		graph,
		seen,
		agents,
		settled,
		now: view.now,
		folds: wanted,
	}).map((row) => ({ ...row, t: textsOf(row) }));
	const body = Math.max(MIN_BODY, view.rows - ABOVE_LINES - BELOW_LINES);
	const nav = resolve(wanted, rows, body);
	const states = leavesOf(graph, seen).map((s) => s.state);
	const range = `rows ${nav.top + 1}–${Math.min(rows.length, nav.top + body)} of ${rows.length}`;
	const paint = (segs: readonly Seg[]) =>
		painted(segs, view.color, view.columns - 1);
	const lines = [
		...headSegs(graph, seen, view).map(paint),
		...viewportLines(rows, nav, body, view),
		paint(footerSegs(states, view, rows.length > body ? range : "")),
		...detailSegs(rows[nav.index]).map(paint),
		paint(keySegs(nav, settled)),
	];
	return { lines, nav, rows, body, failure: lastFocusOf(graph, seen) };
}

/** The style of each word an event line shows; the longest sets the word column's width, and other words are unstyled. */
const WORD_STYLE: ReadonlyMap<string, Style> = new Map<string, Style>([
	["running", []],
	["ok", ["green", "bold"]],
	["rejected", ["red", "bold"]],
	["failed", ["red", "bold"]],
	["skipped", "dim"],
	["log", []],
	["agent", "cyan"],
	["tool", []],
	["thinking", ["dim", "italic"]],
	["text", []],
	["usage", "dim"],
	["settled", "dim"],
	["fault", []],
]);
const WORD_WIDTH = Math.max(...[...WORD_STYLE.keys()].map((w) => w.length));
/** The word of a progress event without a `kind`. */
const PROGRESS_WORD = "progress";
const TIME_WIDTH = 7;
/** The room a node path keeps per group for that group's key, a two-digit round. */
const KEY_ROOM = "[nn]".length;
/** The fewest cells a wrapped detail keeps per row, however narrow the terminal. */
const MIN_DETAIL_WIDTH = 20;
/** What follows a detail's first line when more lines with text follow it. */
const MORE = " …";
/** One JSON token per match: a string with the colon after a key, a number, a literal, punctuation or whitespace. */
const JSON_TOKEN =
	/("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],:])|(\s+)/gy;
const JSON_START = /^\s*[[{]/;

/** `ms` as `+12.4s` under a minute, `+12m05s` under an hour, else `+2h05m`, right-aligned in the time column. */
const elapsed = (ms: number) =>
	`+${duration(ms, MS_PER_UNIT.m)}`.padStart(TIME_WIDTH);

/** `text`'s first line with text, safe for a terminal, then `MORE` when a line with text follows it. */
function firstLine(text: string): string {
	const lines = text.split(NEWLINE);
	const [first = "", ...rest] = lines.slice(
		Math.max(
			0,
			lines.findIndex((l) => l.trim()),
		),
	);
	return safe(first) + (rest.some((l) => l.trim()) ? MORE : "");
}

/** A progress event's word and detail: the host's, else its kind and then the actor or its other fields. */
function progressWord(
	event: Annotated & { type: "progress" },
): [word: string, detail: string] {
	if (event.wording) return [event.wording.word, event.wording.detail];
	const { kind = PROGRESS_WORD, fields } = progressParts(event.event);
	return [kind, event.actor ?? fields.join(" ")];
}

/** The word an event line shows for `event`, and the detail after it. */
function wordOf(event: Annotated): [word: string, detail: string] {
	switch (event.type) {
		case "running":
			return ["running", ""];
		case "settled":
			return [event.outcome, event.reason ?? ""];
		case "reused":
			return ["ok", "reused"];
		case "log":
			return ["log", event.line];
		case "progress":
			return progressWord(event);
	}
}

function tokenSegs([
	,
	string,
	colon,
	num,
	literal,
	punct,
	space = "",
]: RegExpMatchArray): Seg[] {
	if (string !== undefined)
		return colon === undefined
			? [[string, "green"]]
			: [
					[string, "blue"],
					[colon, "dim"],
				];
	if (num !== undefined) return [[num, "yellow"]];
	if (literal !== undefined) return [[literal, "cyan"]];
	if (punct !== undefined) return [[punct, "dim"]];
	return [[space]];
}

const parses = (text: string) => {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
};

/** `text` highlighted as JSON when it is a JSON object or array, else in soft grey. */
function valueSegs(text: string): Seg[] {
	if (!JSON_START.test(text) || !parses(text)) return [[text, SOFT_GREY]];
	return [...text.matchAll(JSON_TOKEN)].flatMap(tokenSegs);
}

/** A detail's first token bold, then the rest as `valueSegs` shows it. */
function headedSegs(detail: string): Seg[] {
	const space = detail.indexOf(" ");
	if (space < 0) return [[detail, "bold"]];
	return [
		[detail.slice(0, space), "bold"],
		[" "],
		...valueSegs(detail.slice(space + 1)),
	];
}

const plainly =
	(style: Style) =>
	(detail: string): Seg[] => [[detail, style]];

/**
 * How the detail after a word shows, for the words whose detail is not `valueSegs`: a reason yellow, a tool's detail
 * its name bold then its input.
 */
const DETAIL_SEGS: ReadonlyMap<string, (detail: string) => Seg[]> = new Map([
	["rejected", plainly("yellow")],
	["failed", plainly("yellow")],
	["skipped", plainly("dim")],
	["thinking", plainly(["dim", "italic"])],
	["usage", plainly("dim")],
	["tool", headedSegs],
]);

/** Where the row from `start` ends within `width` cells: at the last space that fits, else at the last cell that fits. */
function breakOf(cells: readonly Seg[], start: number, width: number): number {
	let end = start;
	for (let used = 0; end < cells.length; end++) {
		used += Bun.stringWidth(cells[end]?.[0] ?? "");
		if (used > width) break;
	}
	if (end === cells.length) return end;
	for (let space = end; space > start; space--)
		if (cells[space]?.[0] === " ") return space;
	return end;
}

/** `cells` with each stretch of one style joined into one segment. */
function joined(cells: readonly Seg[]): Seg[] {
	const segs: [string, Style?][] = [];
	for (const [text, style] of cells) {
		const last = segs.at(-1);
		if (last && last[1] === style) last[0] += text;
		else segs.push([text, style]);
	}
	return segs;
}

/** `segs` in rows of at most `width` terminal cells, each broken at a space where it can be, without leading spaces. */
function wrapped(segs: readonly Seg[], width: number): Seg[][] {
	const cells = segs.flatMap(([text, style]) =>
		[...text].map((c): Seg => [c, style]),
	);
	const rows: Seg[][] = [];
	let at = 0;
	while (at < cells.length) {
		const end = breakOf(cells, at, width);
		rows.push(joined(cells.slice(at, end)));
		at = end;
		while (cells[at]?.[0] === " ") at++;
	}
	return rows;
}

/** The width of the node column: the longest node path of `ir` with room for a two-digit key per group. */
const nodeWidthOf = (ir: Ir, graph: GraphIndex) =>
	Math.max(
		0,
		...ir.nodes.map(
			(n) => n.id.length + graph.groupsOf(n.id).length * KEY_ROOM,
		),
	);

/**
 * One event as text: the time since the concert's start, the instance, a word for what happened and its detail's first
 * line. With `view.columns` above 0 the detail wraps at that width under its own column; at 0 it stays on one line.
 */
export function eventLine(ir: Ir, event: Annotated, view: View): string {
	const graph = indexGraph(ir);
	const [raw, detail] = wordOf(event);
	const word = flat(raw);
	const name = flat(formatInstance(event, graph.groupsOf(event.node)));
	const head: Seg[] = [
		[elapsed(event.at - view.concert.startedAt), "dim"],
		[`${GAP}${padCells(name, nodeWidthOf(ir, graph))}${GAP}`],
		[word, WORD_STYLE.get(word)],
		[`${" ".repeat(Math.max(0, WORD_WIDTH - Bun.stringWidth(word)))}${GAP}`],
	];
	const segs = (DETAIL_SEGS.get(word) ?? valueSegs)(firstLine(detail));
	return hanging(head, segs, view.columns, view.color);
}

/** How a concert ended beside its view: where and why when not ok, and each output as its port and its value's text. */
export type Ending = {
	at?: string;
	reason?: string;
	outputs: readonly (readonly [port: string, value: string])[];
};

/** The closing block's label column: wide enough for `changeset`, the stdlib results' longest port, and a gap. */
const LABEL_WIDTH = "changeset".length + GAP.length;

function concertSegs(view: View, label: Seg): Seg[] {
	const { id, unique, status } = view.concert;
	const tokens = view.tokens > 0 ? ` · ${compact(view.tokens)} tokens` : "";
	return [
		label,
		...idSegs(id, unique),
		[GAP],
		[status, WORD_STYLE.get(status)],
		[`${GAP}${ranFor(view)}${tokens}`, "dim"],
	];
}

/**
 * How `view`'s settled concert ended, in one label column: `head`, its `concert` row then `ending`'s `at` and `reason`,
 * and `outputs`, a row per output when it has any, colored when `outputsColor`. With `view.columns` above 0 the reason
 * wraps under the value column; each value is otherwise shown as it is.
 */
export function closingBlock(
	view: View,
	{ at, reason, outputs }: Ending = { outputs: [] },
	outputsColor = view.color,
): { head: string; outputs?: string } {
	const width = Math.max(
		LABEL_WIDTH,
		...outputs.map(([port]) => Bun.stringWidth(flat(port)) + GAP.length),
	);
	const label = (text: string): Seg => [padCells(flat(text), width), "dim"];
	const row = (name: string, value: readonly Seg[], columns = 0) =>
		hanging([label(name)], value, columns, view.color);
	const head = [
		line(concertSegs(view, label("concert")), view.color),
		...(at === undefined ? [] : [row("at", [[flat(at)]])]),
		...(reason === undefined
			? []
			: [row("reason", [[flat(reason), "yellow"]], view.columns)]),
	];
	const rows = outputs.map(([port, value]) =>
		hanging([label(port)], valueSegs(value), 0, outputsColor),
	);
	return {
		head: head.join("\n"),
		...(rows.length > 0 && { outputs: rows.join("\n") }),
	};
}

/** `segs` without the spaces they end with. */
function trimmed(segs: readonly Seg[]): Seg[] {
	const kept = [...segs];
	while (kept.length > 0 && !kept.at(-1)?.[0].trim()) kept.pop();
	const [text = "", style] = kept.pop() ?? [];
	return text ? [...kept, [text.trimEnd(), style]] : kept;
}

/**
 * `head` then `detail`, wrapped under the detail's column at `columns` cells when above 0, else as it is. Without a
 * detail, `head` ends at its last character.
 */
function hanging(
	head: readonly Seg[],
	detail: readonly Seg[],
	columns: number,
	color: boolean,
): string {
	const lead = head.map(([text]) => text).join("");
	if (!detail.some(([text]) => text)) return line(trimmed(head), color);
	const indent = Bun.stringWidth(lead);
	const [first = [], ...more] =
		columns > 0
			? wrapped(detail, Math.max(MIN_DETAIL_WIDTH, columns - indent))
			: [detail];
	return [
		[...head, ...first],
		...more.map((row): Seg[] => [[" ".repeat(indent)], ...row]),
	]
		.map((row) => line(row, color))
		.join("\n");
}
