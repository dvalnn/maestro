import { styleText } from "node:util";
import {
	type ConcertEvent,
	type Enrichment,
	formatInstance,
	type HostEvent,
	type Ir,
	indexGraph,
	MS_PER_UNIT,
	type NodeInstance,
	type Outcome,
} from "@maestro/ir";
import { arranged, layout } from "./layout";

export { arranged };

/** What one instance's events say of it. `first` is the seq of its first event, which orders a node's instances. */
type InstanceState = NodeInstance & {
	state: "running" | Outcome;
	reused: boolean;
	reason?: string;
	startedAt?: number;
	settledAt?: number;
	/** Its latest progress event, as `eventLine` shows it, on one line. */
	latest?: string;
	/** What its `agent` progress event says it uses, as `agentText` shows it before any tokens. */
	agent?: string;
	first: number;
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
		/** How many leading characters of `id` tell it from every other concert's. */
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

type Style = Parameters<typeof styleText>[0];
type Shown = "pending" | InstanceState["state"];
/** How a state is drawn. `whole` styles the whole line, `noted` its note too. */
type Look = { glyph: string; style: Style; whole?: boolean; noted?: boolean };

const LOOK: Readonly<Record<Shown, Look>> = {
	pending: { glyph: "○", style: "dim", whole: true },
	running: { glyph: "●", style: "cyan" },
	ok: { glyph: "✓", style: "green" },
	rejected: { glyph: "✗", style: "yellow", noted: true },
	failed: { glyph: "!", style: "red", noted: true },
	skipped: { glyph: "-", style: "dim", whole: true },
};
/** The states the header counts, in its order. */
const COUNTED: readonly Shown[] = [
	"running",
	"ok",
	"rejected",
	"failed",
	"skipped",
	"pending",
];
const GAP = "  ";
const RULE = "─";
/** The `kind` of the progress event an agent instance emits when it starts. */
const AGENT_EVENT = "agent";
type Metrics = Readonly<Record<string, number>>;
/** The prefix of the metrics that count tokens. */
const TOKEN_METRIC = "tokens_";
/** A subset of the output tokens, so a total leaves it out. */
const REASONING_METRIC = "tokens_reasoning";
const THOUSAND = 1_000;
const MILLION = 1_000_000;
const INDENT = "  ";
/** The width an event line pads its offset and its instance name to, separator included. */
const OFFSET_WIDTH = 8;
const NAME_WIDTH = 24;
const NEWLINE = /\r?\n/;
/** A control character other than a newline. */
const CONTROL = /[^\P{Cc}\n]/gu;
const TENTHS_BELOW_MS = 10 * MS_PER_UNIT.s;
const TENTH_MS = 100;

const keyOf = ({ node, expansion }: NodeInstance) =>
	JSON.stringify([node, expansion]);

/** Shows each control character but a newline as its JSON escape, so no text moves the terminal's cursor. */
const safe = (text: string) =>
	text.replace(CONTROL, (c) => JSON.stringify(c).slice(1, -1));

/** `text` on one line: newlines shown as spaces, every other control character as its JSON escape. */
export const flat = (text: string) => safe(text.split(NEWLINE).join(" "));

const twoDigits = (n: number) => String(n).padStart(2, "0");

/** `ms` as `3.1s` under 10 s, `42s` under a minute, `4m05s` under an hour, else `1h02m`. */
function duration(ms: number): string {
	const { s, m, h } = MS_PER_UNIT;
	const t = Math.max(0, ms);
	if (t < TENTHS_BELOW_MS)
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

function folded(
	prior: InstanceState | undefined,
	event: ConcertEvent,
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
			if (event.event.kind === AGENT_EVENT)
				return { ...base, agent: identityText(event.event) };
			const { kind, fields } = progressParts(event.event);
			const parts = kind === undefined ? fields : [kind, ...fields];
			return { ...base, latest: flat(parts.join(" ")) };
		}
		case "log":
			return prior;
	}
}

/** `prior` with `events` folded in; the latest event of an instance wins. */
export function seen(prior: Seen, events: readonly ConcertEvent[]): Seen {
	const next = new Map(prior);
	for (const event of events) {
		const state = folded(next.get(keyOf(event)), event);
		if (state) next.set(keyOf(event), state);
	}
	return next;
}

/** One row of the frame, its texts safe for a terminal. */
type Row = {
	depth: number;
	shown: Shown;
	name: string;
	kind: string;
	time: string;
	agent: string;
	note: string;
};
type Line =
	| { type: "heading"; depth: number; text: string; round: boolean }
	| ({ type: "row" } & Row);
type Seg = readonly [text: string, style?: Style];
type Widths = {
	lead: number;
	kind: number;
	state: number;
	time: number;
	agent: number;
};

/** What an agent instance's harness reported, as `agentText` shows it, by instance. */
type Agents = ReadonlyMap<string, string>;

/** An instance's record: its enrichment and metrics, with whether an earlier attempt left it. */
type Recorded = NodeInstance & {
	enrichment?: Enrichment;
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

const stringOf = (value: unknown) =>
	typeof value === "string" && value !== "" ? value : undefined;

/** `<harness> · <model> · <effort>` of `fields`, `undefined` when they name no harness and model. */
function identityText(fields: Readonly<Record<string, unknown>> | undefined) {
	const harness = stringOf(fields?.harness);
	const model = stringOf(fields?.model);
	if (harness === undefined || model === undefined) return undefined;
	const effort = stringOf(fields?.thinking);
	return [
		harness,
		model.slice(model.lastIndexOf("/") + 1),
		...(effort === undefined ? [] : [effort]),
	].join(" · ");
}

/**
 * An agent instance as `<harness> · <model> · <effort>  <total> tok`: the model without its provider prefix, the
 * effort when its role sets one, the total of `tokensOf`, left out when 0. Empty for an instance that is not an
 * agent's.
 */
export function agentText(
	enrichment: Enrichment | undefined,
	metrics: Metrics,
): string {
	const identity = identityText(enrichment);
	const tokens = tokensOf(metrics);
	if (identity === undefined) return "";
	return tokens > 0 ? `${identity}${GAP}${compact(tokens)} tok` : identity;
}

/** The agent text of each current instance of `records` that has one, by instance. */
export function agentsOf(records: readonly Recorded[]): Agents {
	const agents = new Map<string, string>();
	for (const r of records) {
		const text = r.stale ? "" : agentText(r.enrichment, r.metrics);
		if (text) agents.set(keyOf(r), text);
	}
	return agents;
}

function timeOf(s: InstanceState, now: number): string {
	if (s.startedAt === undefined) return "";
	if (s.state === "running") return duration(now - s.startedAt);
	return s.settledAt === undefined ? "" : duration(s.settledAt - s.startedAt);
}

function noteOf(s: InstanceState): string {
	if (s.state === "running") return s.latest ?? "";
	if (s.state === "ok") return s.reused ? "reused" : "";
	return flat(s.reason ?? "");
}

/**
 * The frame's lines: a row per instance by first event, laid out as the IR nests them. A node that never ran is
 * `pending`, and `skipped` once the concert has settled.
 */
function outline(ir: Ir, seen: Seen, agents: Agents, view: View): Line[] {
	const ordered = [...seen.values()].sort((a, b) => a.first - b.first);
	const never = view.concert.status === "running" ? "pending" : "skipped";
	return layout(ir, ordered).map((item): Line => {
		if (item.type === "heading") return { ...item, text: flat(item.text) };
		const { depth, node, name, instance: s } = item;
		const shown = {
			depth,
			name: flat(name),
			kind: safe(node.kind),
		};
		return s
			? {
					type: "row",
					...shown,
					shown: s.state,
					time: timeOf(s, view.now),
					agent: safe(agents.get(keyOf(s)) ?? s.agent ?? ""),
					note: noteOf(s),
				}
			: { type: "row", ...shown, shown: never, time: "", agent: "", note: "" };
	});
}

/** `text` padded with spaces to `cells` terminal cells. */
const padCells = (text: string, cells: number) =>
	text + " ".repeat(Math.max(0, cells - Bun.stringWidth(text)));

const indentOf = (depth: number) => INDENT.repeat(depth);

const leadOf = (l: Row) =>
	indentOf(l.depth).length + 2 + Bun.stringWidth(l.name);

const rowsOf = (lines: readonly Line[]) =>
	lines.filter((l): l is { type: "row" } & Row => l.type === "row");

const widthsOf = (rows: readonly Row[]): Widths => ({
	lead: Math.max(0, ...rows.map(leadOf)),
	kind: Math.max(0, ...rows.map((l) => l.kind.length)),
	state: Math.max(0, ...rows.map((l) => l.shown.length)),
	time: Math.max(0, ...rows.map((l) => l.time.length)),
	agent: Math.max(0, ...rows.map((l) => Bun.stringWidth(l.agent))),
});

function segsOf(line: Line, w: Widths): Seg[] {
	if (line.type === "heading")
		return [[indentOf(line.depth) + line.text, line.round ? "dim" : "bold"]];
	const look = LOOK[line.shown];
	const noteStyle = look.noted
		? look.style
		: line.shown === "running"
			? "dim"
			: undefined;
	const indent = indentOf(line.depth);
	const agent: Seg[] =
		w.agent === 0 ? [] : [[padCells(line.agent, w.agent) + GAP, "dim"]];
	const segs: Seg[] = [
		[indent],
		[look.glyph, look.style],
		[padCells(` ${line.name}`, w.lead - indent.length - 1) + GAP],
		[line.kind.padEnd(w.kind) + GAP, "dim"],
		[line.shown.padEnd(w.state) + GAP, look.style],
		[line.time.padEnd(w.time) + GAP, "dim"],
		...agent,
		[line.note, noteStyle],
	];
	return look.whole ? segs.map(([text]) => [text, look.style]) : segs;
}

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

/** One line cut at `limit` terminal cells without trailing spaces, each segment styled after the cut. */
function painted(segs: readonly Seg[], limit: number, color: boolean): string {
	const plain = segs.map(([text]) => text).join("");
	let room = Math.min(Bun.stringWidth(plain.trimEnd()), limit);
	let out = "";
	for (const [text, style] of segs) {
		const cut = fit(text, room);
		room = cut === text ? room - Bun.stringWidth(cut) : 0;
		out +=
			color && style && cut
				? styleText(style, cut, { validateStream: false })
				: cut;
	}
	return out;
}

const lookOf = (state: string): Look | undefined =>
	Object.entries(LOOK).find(([shown]) => shown === state)?.[1];

/** How many characters of a concert id its short form shows at least. */
const SHORT_ID_MIN = 8;

/** The length of the shortest prefix of `id` that no other of `ids` starts with. */
export function uniqueLength(id: string, ids: readonly string[]): number {
	const others = ids.filter((other) => other !== id);
	let length = 1;
	while (
		length < id.length &&
		others.some((o) => o.startsWith(id.slice(0, length)))
	)
		length++;
	return length;
}

/** An id as segments: its first `unique` characters, then the rest, dim. */
export const idSegs = (id: string, unique: number): Seg[] => [
	[safe(id.slice(0, unique)), "bold"],
	[safe(id.slice(unique)), "dim"],
];

function headerSegs({ concert, now }: View): Seg[] {
	const elapsed = duration((concert.settledAt ?? now) - concert.startedAt);
	const look = lookOf(concert.status);
	const title =
		concert.title === undefined ? "" : `"${flat(concert.title)}"${GAP}`;
	const shown = Math.max(SHORT_ID_MIN, concert.unique);
	return [
		[`${look?.glyph ?? ""} ${safe(concert.label)}${GAP}${title}`, "bold"],
		...idSegs(concert.id.slice(0, shown), concert.unique),
		[`${GAP} `],
		[safe(concert.status), look?.style],
		[`${GAP}${elapsed}`],
	];
}

function footerSegs(rows: readonly Row[], view: View): Seg[] {
	const counts = COUNTED.map((state) => ({
		state,
		n: rows.filter((l) => l.shown === state).length,
	}))
		.filter(({ n }) => n > 0)
		.map(({ state, n }) => `${n} ${state}`)
		.join(" · ");
	const head = `${RULE}${RULE} ${counts} `;
	const tail =
		view.tokens > 0 ? ` ${compact(view.tokens)} tok ${RULE}${RULE}` : "";
	const fill = Math.max(1, view.columns - 1 - head.length - tail.length);
	return [[`${head}${RULE.repeat(fill)}${tail}`, "dim"]];
}

/** Lines the frame holds beside its rows: the header and the footer, each beside a blank line. */
const CHROME_LINES = 4;
/** Lines a clipped frame gives up beyond its chrome: the one the terminal keeps free, and the `… n more` line. */
const CLIPPED_EXTRA_LINES = 2;

/**
 * The live graph as lines, clipped to `columns - 1` terminal cells and `rows - 1` lines: a header, the rows laid
 * out by `layout`, and a footer of counts and the concert's tokens. `agents` says what each agent instance ran on.
 */
export function frame(ir: Ir, seen: Seen, view: View, agents: Agents): string {
	const lines = outline(ir, seen, agents, view);
	const rows = rowsOf(lines);
	const widths = widthsOf(rows);
	const limit = view.columns - 1;
	const fits = lines.length + CHROME_LINES <= view.rows - 1;
	const kept = fits
		? lines
		: lines.slice(
				0,
				Math.max(0, view.rows - CHROME_LINES - CLIPPED_EXTRA_LINES),
			);
	const more: Seg[][] = fits
		? []
		: [[[`… ${lines.length - kept.length} more`, "dim"]]];
	return [
		headerSegs(view),
		[],
		...kept.map((l) => segsOf(l, widths)),
		...more,
		[],
		footerSegs(rows, view),
	]
		.map((segs) => painted(segs, limit, view.color))
		.join("\n");
}

type Paint = (text: string, style: Style) => string;

/** A string's newlines continue on the next lines after `indent`. */
function progressText(event: HostEvent, paint: Paint, indent: string): string {
	const { kind, fields } = progressParts(event);
	const body = fields.map((f) =>
		f.split(NEWLINE).map(safe).join(`\n${indent}`),
	);
	return [
		...(kind === undefined ? [] : [paint(flat(kind), "magenta")]),
		...body,
	].join(" ");
}

function happened(event: ConcertEvent, paint: Paint, indent: string): string {
	switch (event.type) {
		case "running":
			return paint("running", LOOK.running.style);
		case "settled": {
			const reason =
				event.reason === undefined ? "" : `: ${flat(event.reason)}`;
			return paint(`${event.outcome}${reason}`, LOOK[event.outcome].style);
		}
		case "reused":
			return paint("ok (reused)", LOOK.ok.style);
		case "log":
			return paint(`log ${flat(event.line)}`, "dim");
		case "progress":
			return progressText(event.event, paint, indent);
	}
}

/** One event as a text line: offset from the concert's start, instance name, what happened. */
export function eventLine(ir: Ir, event: ConcertEvent, view: View): string {
	const paint: Paint = (text, style) =>
		view.color && text
			? styleText(style, text, { validateStream: false })
			: text;
	const offset = `+${duration(event.at - view.concert.startedAt)}`.padEnd(
		OFFSET_WIDTH - 1,
	);
	const name = padCells(
		flat(formatInstance(event, indexGraph(ir).groupsOf(event.node))),
		NAME_WIDTH - 1,
	);
	const indent = " ".repeat(offset.length + Bun.stringWidth(name) + 2);
	return `${paint(offset, "dim")} ${name} ${happened(event, paint, indent)}`;
}
