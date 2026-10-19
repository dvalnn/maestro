import type { ConcertRecord, Records } from "@maestro/core/perform";
import type { ConcertEvent } from "@maestro/ir";
import {
	agentsOf,
	eventLine,
	frame,
	type Seen,
	seen,
	shortIds,
	tokensOf,
} from "@maestro/render-text/live";
import {
	COMMON,
	type Colors,
	type Command,
	colorOf,
	type Deps,
	isSet,
	type Options,
	only,
	type Values,
} from "./command";
import { actorOf, annotated, hostTextOf } from "./host-text";
import { exitOf, printClosing, resultDoc, UNFRAMED, viewOf } from "./output";
import {
	artifactsOf,
	concertOf,
	type Session,
	type Stored,
	withStore,
} from "./session";

/** How often `watch` reads the record, in milliseconds. */
const WATCH_POLL_MS = 100;
const ESC = "\u001b";
/** Erases from the cursor to the end of the screen. */
const CLEAR_BELOW = `${ESC}[J`;
/** Moves the cursor up `lines` lines, to column 1. */
const cursorUp = (lines: number) => `${ESC}[${lines}F`;
/** The event types a view's JSON lines show without `--events`: those that change an instance's state. */
const STATE_CHANGES = new Set(["running", "settled", "reused"]);

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
} as const satisfies Options;

type Terminal = NonNullable<Deps["terminal"]>;
type Show = (events: readonly ConcertEvent[], row: ConcertRecord) => void;

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
	const short = shortIds(store.ids());
	return (events, row) => {
		const hostText = hostTextOf(deps.hosts, row.ir);
		state = seen(state, annotated(events, hostText));
		const view = viewOf(row, color, {
			...terminal(),
			tokens: tokensOf(store.metrics(row.id)),
			unique: short.unique(row.id),
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
 * How a watch ends: with the concert document after JSON lines, the closing block after the graph, else the closing
 * block's `concert` row alone.
 */
type WatchEnd = "json" | "block" | "row";

/**
 * How a watch shows events: as text on a terminal or for `--events` without `--json`, else as JSON lines; `live` when
 * on a terminal, and how it ends.
 */
function showOf(
	deps: Deps,
	store: Records,
	values: Values,
	json: boolean,
): { show: Show; live: boolean; ending: WatchEnd } {
	const all = isSet(values, "events");
	const terminal = json ? undefined : deps.terminal;
	const live = terminal !== undefined;
	const color = live && colorOf(deps, values).out;
	if (!terminal && (json || !all))
		return { show: jsonLines(deps, all), live, ending: "json" };
	return !all && terminal
		? { show: frames(deps, store, terminal, color), live, ending: "block" }
		: { show: eventLines(deps, color, terminal), live, ending: "row" };
}

async function watched({ session, store, values, positionals, json }: Stored) {
	const { deps } = session;
	const prefix = only(positionals, "concert", "Name the concert to watch");
	let row = concertOf(store, prefix);
	const { id } = row;
	const { show, live, ending } = showOf(deps, store, values, json);
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
	return closed(session, store, row, {
		color: colorOf(deps, values),
		ending,
	});
}

/** Ends the watch of the settled `row` as `ending` says, colored on the streams `color` names, and gives its exit code. */
function closed(
	session: Session,
	store: Records,
	row: ConcertRecord,
	{ color, ending }: { color: Colors; ending: WatchEnd },
) {
	const result = store.result(row.id);
	const doc = resultDoc(row.id, result);
	if (ending === "json")
		session.deps.stdout(JSON.stringify({ type: "concert", ...doc }));
	else if (result)
		printClosing(session.deps, store, row, result, {
			color,
			artifacts: ending === "block" ? artifactsOf(session, row.id) : undefined,
		});
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
