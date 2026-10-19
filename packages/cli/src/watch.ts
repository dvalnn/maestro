import type { ConcertRecord, Records } from "@maestro/core/perform";
import type { ConcertEvent } from "@maestro/ir";
import {
	agentsOf,
	eventLine,
	frame,
	type Seen,
	seen,
	tokensOf,
	uniqueLength,
	type View,
} from "@maestro/render-text/live";
import {
	COMMON,
	type Command,
	colorOn,
	type Deps,
	isSet,
	type Options,
	only,
	type Values,
} from "./command";
import { actorOf, annotated, hostTextOf } from "./host-text";
import { closingLine, exitOf, resultDoc } from "./output";
import { concertOf, type Stored, withStore } from "./session";

/** How often `watch` reads the record, in milliseconds. */
const WATCH_POLL_MS = 100;
const ESC = "\u001b";
/** Erases from the cursor to the end of the screen. */
const CLEAR_BELOW = `${ESC}[J`;
/** Moves the cursor up `lines` lines, to column 1. */
const cursorUp = (lines: number) => `${ESC}[${lines}F`;
/** The event types a view's JSON lines show without `--events`: those that change an instance's state. */
const STATE_CHANGES = new Set(["running", "settled", "reused"]);
/** What a view holds beside the record's row, off a terminal: no size, so event lines do not wrap. */
const UNFRAMED = { columns: 0, rows: 0, tokens: 0, unique: 0 };

const WATCH_OPTIONS = {
	...COMMON,
	json: {
		type: "boolean",
		desc: "Print a JSON Lines stream of events, ending with the concert document",
	},
	events: {
		type: "boolean",
		desc: "Show every event, tool calls and thinking among them, not the graph",
	},
	color: {
		type: "boolean",
		desc: "Color the view on a terminal (default); --no-color turns it off",
	},
} as const satisfies Options;

type Terminal = NonNullable<Deps["terminal"]>;
type Show = (events: readonly ConcertEvent[], row: ConcertRecord) => void;

const viewOf = (
	row: ConcertRecord,
	color: boolean,
	{ unique, tokens, ...size } = UNFRAMED,
): View => ({
	concert: {
		id: row.id,
		label: `${row.pack}.${row.composition}`,
		title: row.title,
		status: row.status,
		unique,
		startedAt: row.startedAt,
		settledAt: row.settledAt,
	},
	tokens,
	now: Date.now(),
	color,
	...size,
});

const jsonLines =
	(deps: Deps, all: boolean): Show =>
	(events) => {
		for (const e of events)
			if (all || STATE_CHANGES.has(e.type)) deps.stdout(JSON.stringify(e));
	};

/** A text line per event: wrapped at the terminal's width on one, else one line each. */
const eventLines =
	(deps: Deps, color: boolean, terminal?: Terminal): Show =>
	(events, row) => {
		const view = viewOf(row, color, terminal && { ...UNFRAMED, ...terminal() });
		const hostText = hostTextOf(deps.hosts, row.ir);
		for (const e of annotated(events, hostText))
			deps.stdout(eventLine(row.ir, e, view));
	};

/** Redraws the frame in place, over the one before, when it changed. */
function frames(
	deps: Deps,
	store: Records,
	terminal: Terminal,
	color: boolean,
): Show {
	let state: Seen = new Map();
	let last: string | undefined;
	const ids = store.ids();
	return (events, row) => {
		const hostText = hostTextOf(deps.hosts, row.ir);
		state = seen(state, annotated(events, hostText));
		const view = viewOf(row, color, {
			...terminal(),
			tokens: tokensOf(store.metrics(row.id)),
			unique: uniqueLength(row.id, ids),
		});
		const agents = agentsOf(
			store.instances(row.id).map((i) => ({
				...i,
				actor: actorOf(i.enrichment, i.node, hostText),
			})),
		);
		const text = frame(row.ir, state, view, agents);
		if (text === last) return;
		const erase =
			last === undefined
				? ""
				: `${cursorUp(last.split("\n").length)}${CLEAR_BELOW}`;
		deps.stdout(`${erase}${text}`);
		last = text;
	};
}

/**
 * How a watch shows events; `text` when as text, on a terminal or for `--events` without `--json`, else JSON lines, and
 * `live` when on a terminal.
 */
function showOf(
	deps: Deps,
	store: Records,
	values: Values,
	json: boolean,
): { show: Show; text: boolean; live: boolean } {
	const all = isSet(values, "events");
	const terminal = json ? undefined : deps.terminal;
	const live = terminal !== undefined;
	if (!terminal && (json || !all))
		return { show: jsonLines(deps, all), text: false, live };
	const color = live && colorOn(deps, values.color !== false);
	const show =
		!all && terminal
			? frames(deps, store, terminal, color)
			: eventLines(deps, color, terminal);
	return { show, text: true, live };
}

async function watched({ session, store, values, positionals, json }: Stored) {
	const { deps } = session;
	const prefix = only(positionals, "concert", "Name the concert to watch");
	let row = concertOf(store, prefix);
	const { id } = row;
	const { show, text, live } = showOf(deps, store, values, json);
	if (live && row.status === "running")
		deps.stderr(
			`watching concert ${id}; ctrl-c stops watching, not the concert`,
		);
	let cursor = 0;
	for (;;) {
		// The row is read before the events: every event of a settled concert is committed before its row settles.
		const events = store.events(id, cursor);
		cursor = events.at(-1)?.seq ?? cursor;
		show(events, row);
		if (row.status !== "running") break;
		await Bun.sleep(WATCH_POLL_MS);
		row = store.find(id) ?? row;
	}
	return closed(deps, store, row, text);
}

/** Ends the watch of the settled `row`: the concert document on stdout after JSON lines, else the closing line on stderr. */
function closed(deps: Deps, store: Records, row: ConcertRecord, text: boolean) {
	const result = store.result(row.id);
	const doc = resultDoc(row.id, result);
	if (!text) deps.stdout(JSON.stringify({ type: "concert", ...doc }));
	else if (result) deps.stderr(closingLine(row.ir, row.id, result));
	return exitOf(doc.status);
}

export const watch: Command = {
	usage: "watch <concert> [flags]  (alias: wt)",
	options: WATCH_OPTIONS,
	execute: (args, deps) =>
		withStore(
			WATCH_OPTIONS,
			args,
			deps,
			"Flags are listed in 'maestro watch --help'",
			watched,
		),
};
