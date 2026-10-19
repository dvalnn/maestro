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
/** What a view holds beside the record's row, which `eventLine` ignores. */
const UNFRAMED = { columns: 0, rows: 0, tokens: 0, unique: 0 };

const WATCH_OPTIONS = {
	...COMMON,
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

const eventLines =
	(deps: Deps, color: boolean): Show =>
	(events, row) => {
		const view = viewOf(row, color);
		for (const e of events) deps.stdout(eventLine(row.ir, e, view));
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
		state = seen(state, events);
		const view = viewOf(row, color, {
			...terminal(),
			tokens: tokensOf(store.metrics(row.id)),
			unique: uniqueLength(row.id, ids),
		});
		const agents = agentsOf(store.instances(row.id));
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

function showOf(
	deps: Deps,
	store: Records,
	values: Values,
	terminal?: Terminal,
): Show {
	const all = isSet(values, "events");
	if (!terminal) return jsonLines(deps, all);
	const color = colorOn(deps, values.color !== false);
	return all ? eventLines(deps, color) : frames(deps, store, terminal, color);
}

async function watched({ session, store, values, positionals, json }: Stored) {
	const { deps } = session;
	const prefix = only(positionals, "concert", "Name the concert to watch");
	let row = concertOf(store, prefix);
	const { id } = row;
	const terminal = json ? undefined : deps.terminal;
	const show = showOf(deps, store, values, terminal);
	if (terminal && row.status === "running")
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
	const result = store.result(id);
	const doc = resultDoc(id, result);
	if (!terminal) deps.stdout(JSON.stringify({ type: "concert", ...doc }));
	else if (result) deps.stderr(closingLine(row.ir, id, result));
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
