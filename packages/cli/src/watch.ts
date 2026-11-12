import type { ConcertRecord, Records } from "@maestro/core/perform";
import {
	type ConcertEvent,
	indexGraph,
	parseInstance,
	tokensOf,
} from "@maestro/ir";
import { navigated, selectedUnder } from "@maestro/render-text/inspect";
import {
	type Annotated,
	agentsOf,
	eventLine,
	frame,
	type Seen,
	seen,
	shortIds,
} from "@maestro/render-text/live";
import {
	type Browsed,
	ends,
	type Input,
	isInput,
	keysOf,
	NAV,
	type Nav,
	press,
} from "@maestro/render-text/press";
import { changesOf } from "./changeset";
import {
	COMMON,
	type Colors,
	type Command,
	colorOf,
	type Deps,
	isSet,
	type Options,
	only,
	type Screen,
	textOf,
	type Values,
} from "./command";
import { actorOf, annotated, hostTextOf, summaryOf } from "./host-text";
import {
	concertDoc,
	EXIT,
	exitOf,
	NAME_CONCERT,
	nameOf,
	printClosing,
	UNFRAMED,
	usageError,
	viewOf,
} from "./output";
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
/** A height no frame reaches, so the final frame of a browsed watch shows every row. */
const EVERY_ROW = Number.POSITIVE_INFINITY;
/** The terminal `--frames` draws for when stdout is none. */
const FRAMES_TERMINAL = { columns: 120, rows: 40 };
/** What separates the frames `--frames` prints, before the key that drew the next. */
const FRAMES_RULE = "──";
const KEY_TOKENS = /\s+/;

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
	instance: {
		type: "string",
		arg: "id",
		desc: "Show only this instance's events, or a unique ending of its id; a group or scope id takes all under it; sets --events",
	},
	frames: {
		type: "string",
		arg: "keys",
		desc: "Print the browsed graph, then again after each of the space-separated keys",
		hidden: true,
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
		for (const e of annotated(events, hostTextOf(deps.hosts, row.ir)))
			deps.stdout(eventLine(row.ir, e, view));
	};

/** What a graph view folds in and draws of a concert, read afresh from the record on each call. */
function drawingOf(
	deps: Deps,
	store: Records,
	terminal: Terminal,
	color: boolean,
) {
	let state: Seen = new Map();
	const short = shortIds(store.ids());
	return {
		/** The instance states with `events` folded in, each annotated event also added to `sink` when given. */
		fold(
			events: readonly ConcertEvent[],
			row: ConcertRecord,
			sink?: Annotated[],
		): Seen {
			const read = annotated(events, hostTextOf(deps.hosts, row.ir));
			if (sink) sink.push(...read);
			state = seen(state, read);
			return state;
		},
		/** Concert `row` at the terminal's size, what executes each agent instance and its tokens, and each instance's record. */
		read(row: ConcertRecord) {
			const hostText = hostTextOf(deps.hosts, row.ir);
			const view = viewOf(row, color, {
				...terminal(),
				tokens: tokensOf(store.metrics(row.id)),
				unique: short.unique(row.id),
			});
			const instances = store.instances(row.id).map((i) => ({
				...i,
				actor: actorOf(i.enrichment, i.node, hostText),
				summary: summaryOf(i.enrichment, i.node, hostText),
			}));
			return { view, agents: agentsOf(instances), instances };
		},
	};
}

/** Redraws the frame in place, over the one before, when it changed. */
function frames(
	deps: Deps,
	store: Records,
	terminal: Terminal,
	color: boolean,
): Show {
	const drawing = drawingOf(deps, store, terminal, color);
	let last: string | undefined;
	return (events, row) => {
		const state = drawing.fold(events, row);
		const { view, agents } = drawing.read(row);
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
	const all =
		isSet(values, "events") || textOf(values, "instance") !== undefined;
	const terminal = json ? undefined : deps.terminal;
	const live = terminal !== undefined;
	const color = live && colorOf(deps, values).out;
	if (!terminal && (json || !all))
		return { show: jsonLines(deps, all), live, ending: "json" };
	return !all && terminal
		? { show: frames(deps, store, terminal, color), live, ending: "block" }
		: { show: eventLines(deps, color, terminal), live, ending: "row" };
}

/** Shows the events of the concert `first` names until it settles or `quit` resolves, and gives its row as last read. */
async function polled(
	store: Records,
	first: ConcertRecord,
	show: Show,
	quit?: Promise<void>,
): Promise<ConcertRecord> {
	let row = first;
	let cursor = 0;
	let quitting = false;
	void quit?.then(() => {
		quitting = true;
	});
	for (;;) {
		// The row is read before the events: every event of a settled concert is committed before its row settles.
		const events = store.events(row.id, cursor);
		cursor = events.at(-1)?.seq ?? cursor;
		show(events, row);
		if (row.status !== "running") return row;
		await Bun.sleep(WATCH_POLL_MS);
		if (quitting) return row;
		row = store.find(row.id) ?? row;
	}
}

/** Concert `row` browsed from `nav`, as the record holds it now. */
type Render = (nav: Nav) => Browsed;

/** `rendered` after each of `inputs` in turn, each drawn again before the next; none once one `ends` the view. */
function pressed(
	render: Render,
	rendered: Browsed,
	inputs: readonly Input[],
): Browsed | undefined {
	let next = rendered;
	for (const input of inputs) {
		if (ends(input, next.nav)) return undefined;
		next = render(press(input, next));
	}
	return next;
}

/**
 * Browses concert `first` on `screen` until `q`, keys moving the cursor and the poll stopping once it settled. Then
 * prints the frame with every row and the closing block on the main screen, and gives the concert's exit code, or
 * `EXIT.interrupted` when it had not settled.
 */
async function browsed(
	{ session, store, values }: Stored,
	screen: Screen,
	first: ConcertRecord,
	terminal: Terminal,
): Promise<number> {
	const color = colorOf(session.deps, values);
	const drawing = drawingOf(session.deps, store, terminal, color.out);
	const quit = Promise.withResolvers<void>();
	let row = first;
	let state: Seen = new Map();
	let shown: Browsed | undefined;
	let drawn: string | undefined;
	const kept: Annotated[] = [];
	const render: Render = (nav) => {
		const { view, agents, instances } = drawing.read(row);
		return navigated(row.ir, state, view, agents, nav, {
			events: kept,
			instances,
		});
	};
	/** Draws `next`, unless it is what is drawn and `force` is off. */
	const paint = (next: Browsed, force: boolean) => {
		shown = next;
		const text = next.lines.join("\n");
		if (force || text !== drawn) screen.draw(next.lines);
		drawn = text;
	};
	const onKey = (chunk: string) => {
		const next = pressed(render, render(shown?.nav ?? NAV), keysOf(chunk));
		if (next === undefined) quit.resolve();
		else paint(next, chunk === "");
	};
	try {
		screen.enter(onKey);
		row = await polled(
			store,
			row,
			(events, read) => {
				row = read;
				state = drawing.fold(events, read, kept);
				paint(render(shown?.nav ?? NAV), false);
			},
			quit.promise,
		);
		await quit.promise;
	} finally {
		screen.leave();
	}
	const { view, agents } = drawing.read(row);
	session.deps.stdout(
		frame(row.ir, state, { ...view, rows: EVERY_ROW }, agents),
	);
	if (row.status === "running") return EXIT.interrupted;
	return closed(session, store, values, row, { color, ending: "block" });
}

/**
 * The inputs `keys` names, space-separated: each an input's name, such as `down`, or keys as typed, such as `j` or `[`.
 * @throws CliError, a usage error naming a token that names none.
 */
function inputsOf(keys: string): Input[] {
	return keys
		.split(KEY_TOKENS)
		.filter(Boolean)
		.flatMap((token) => {
			const inputs = isInput(token) ? [token] : keysOf(token);
			if (inputs.length > 0) return inputs;
			throw usageError(
				`--frames names no key: '${token}'`,
				"Name keys as typed, such as j or [, or as down, enter or esc",
			);
		});
}

/**
 * `--frames`: concert `row` as the record holds it now, browsed, then again after each of `inputs`, a rule naming
 * it before each; until one ends the view. Gives the concert's exit code once it settled, else `EXIT.ok`.
 */
function framed(
	{ session, store, values }: Stored,
	row: ConcertRecord,
	inputs: readonly Input[],
): number {
	const { deps } = session;
	const terminal = deps.terminal ?? (() => FRAMES_TERMINAL);
	const drawing = drawingOf(deps, store, terminal, colorOf(deps, values).out);
	const kept: Annotated[] = [];
	const state = drawing.fold(store.events(row.id, 0), row, kept);
	const { view, agents, instances } = drawing.read(row);
	const render: Render = (nav) =>
		navigated(row.ir, state, view, agents, nav, { events: kept, instances });
	let shown = render(NAV);
	deps.stdout(shown.lines.join("\n"));
	for (const input of inputs) {
		const next = pressed(render, shown, [input]);
		if (next === undefined) break;
		shown = next;
		deps.stdout(`${FRAMES_RULE} ${input}`);
		deps.stdout(shown.lines.join("\n"));
	}
	return row.status === "running" ? EXIT.ok : exitOf(row.status);
}

/**
 * `show`, fed only the events under the instance `id` names, as the inspector selects them: `id` as `ls <concert>`
 * prints it, or a whole-segment ending of one node or scope id.
 * @throws CliError, a usage error, as `nameOf` does when `id` is neither, such as when it misplaces a key.
 */
function narrowed(show: Show, row: ConcertRecord, id: string): Show {
	const graph = indexGraph(row.ir);
	const has = (node: string) => graph.nodes.has(node) || graph.scopes.has(node);
	const exact = parseInstance(id, graph.groupsOf);
	const { node, keys } =
		exact !== undefined && has(exact.node)
			? exact
			: {
					node: nameOf(
						id,
						[...graph.nodes.keys(), ...graph.scopes.keys()],
						row.id,
					),
					keys: [],
				};
	return (events, read) => show(selectedUnder(graph, node, keys, events), read);
}

/**
 * The concert to watch, and the inputs `--frames` names, if given.
 * @throws CliError, a usage error, other than one concert, or a key `--frames`
 * names none of.
 */
function watchChecked(values: Values, positionals: readonly string[]) {
	const prefix = only(positionals, "concert", NAME_CONCERT);
	const keys = textOf(values, "frames");
	return { prefix, inputs: keys === undefined ? undefined : inputsOf(keys) };
}

async function watched(
	stored: Stored,
	{ prefix, inputs }: ReturnType<typeof watchChecked>,
) {
	const { session, store, values, json } = stored;
	const { deps } = session;
	const instance = textOf(values, "instance");
	const row = concertOf(store, prefix);
	if (inputs !== undefined) return framed(stored, row, inputs);
	const { show: all, live, ending } = showOf(deps, store, values, json);
	const show = instance === undefined ? all : narrowed(all, row, instance);
	if (live && row.status === "running")
		deps.stderr(
			`watching concert ${row.id}; ctrl-c stops watching, not the concert`,
		);
	if (deps.screen && deps.terminal && ending === "block")
		return browsed(stored, deps.screen, row, deps.terminal);
	const settled = await polled(store, row, show);
	return closed(session, store, values, settled, {
		color: colorOf(deps, values),
		ending,
	});
}

/** Ends the watch of the settled `row` as `ending` says, colored on the streams `color` names, and gives its exit code. */
async function closed(
	session: Session,
	store: Records,
	values: Values,
	row: ConcertRecord,
	{ color, ending }: { color: Colors; ending: WatchEnd },
) {
	const result = store.result(row.id);
	const doc = concertDoc(store, row.id, result, artifactsOf(session, row.id));
	if (ending === "json")
		session.deps.stdout(JSON.stringify({ type: "concert", ...doc }));
	else if (result)
		printClosing(session.deps, store, row, result, {
			color,
			artifacts: ending === "block" ? artifactsOf(session, row.id) : undefined,
			changes:
				ending === "block"
					? await changesOf({ session, store, values }, row.id)
					: undefined,
		});
	return exitOf(doc.status);
}

export const watch: Command = {
	usage: "watch <concert> [flags]  (alias: w)",
	arguments: [["<concert>", "A concert, as 'maestro ls' lists it"]],
	options: WATCH_OPTIONS,
	execute: (args, deps) =>
		withStore(
			WATCH_OPTIONS,
			args,
			deps,
			"Flags are listed in 'maestro watch --help'",
			watchChecked,
			watched,
		),
};
