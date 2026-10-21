import type { Focus, Folds, Row } from "./tree";

/**
 * Where a reader is in the tree. `follow` keeps the cursor on the follow target; `cursor` is the key of the row under
 * it, `index` that row's place among the rows, and `top` the first row in the viewport.
 */
export type Nav = Folds & {
	follow: boolean;
	cursor?: string;
	index: number;
	top: number;
};

/** The navigation a watch starts from: following, nothing folded by hand. */
export const NAV: Nav = {
	follow: true,
	path: [],
	index: 0,
	top: 0,
	open: new Map(),
	pins: new Map(),
};

/** A drawn view: its lines, the navigation resolved against its rows, and the viewport's height in rows. */
export type Browsed = {
	lines: string[];
	nav: Nav;
	rows: readonly Row[];
	body: number;
	/** The focus of the last failure, none without one. */
	failure?: Focus;
};

/** What input can ask for: a key `press` takes, or `quit`, which ends the view. */
export const INPUTS = [
	"up",
	"down",
	"left",
	"right",
	"toggle",
	"pageUp",
	"pageDown",
	"first",
	"last",
	"previous",
	"next",
	"failure",
	"follow",
	"quit",
] as const;
export type Input = (typeof INPUTS)[number];
export type Key = Exclude<Input, "quit">;

export const isInput = (text: string): text is Input =>
	(INPUTS as readonly string[]).includes(text);

const ESC = "\u001b";
/** Raw input bytes by key: vi keys, arrows, paging, Home and End as terminals send them, and Ctrl-C. */
const KEYS: ReadonlyMap<string, Input> = new Map([
	["k", "up"],
	[`${ESC}[A`, "up"],
	[`${ESC}OA`, "up"],
	["j", "down"],
	[`${ESC}[B`, "down"],
	[`${ESC}OB`, "down"],
	["h", "left"],
	[`${ESC}[D`, "left"],
	[`${ESC}OD`, "left"],
	["l", "right"],
	[`${ESC}[C`, "right"],
	[`${ESC}OC`, "right"],
	[" ", "toggle"],
	[`${ESC}[5~`, "pageUp"],
	[`${ESC}[6~`, "pageDown"],
	["g", "first"],
	[`${ESC}[H`, "first"],
	[`${ESC}OH`, "first"],
	[`${ESC}[1~`, "first"],
	[`${ESC}[7~`, "first"],
	["G", "last"],
	[`${ESC}[F`, "last"],
	[`${ESC}OF`, "last"],
	[`${ESC}[4~`, "last"],
	[`${ESC}[8~`, "last"],
	["[", "previous"],
	["]", "next"],
	["e", "failure"],
	["f", "follow"],
	["q", "quit"],
	["\u0003", "quit"],
]);
/** One key's input: a CSI or SS3 escape sequence whole, else one character. */
const KEY_INPUT = new RegExp(
	`${ESC}\\[[0-9;]*[A-Za-z~]|${ESC}O[A-Za-z]|.`,
	"gsu",
);

/** The keys in a chunk of raw input, in order; input bound to no key, a lone Esc among it, is left out. */
export const keysOf = (chunk: string): Input[] =>
	[...chunk.matchAll(KEY_INPUT)].flatMap(([input]) => KEYS.get(input) ?? []);

/** The rows kept between the cursor and the viewport's edge while rows remain beyond it. */
export const SCROLL_MARGIN = 2;

/** Where the row keyed `key` is in `rows`, -1 when absent. */
const indexOf = (rows: readonly Row[], key: string | undefined) =>
	rows.findIndex((r) => r.key === key);

/** The cursor's index: its row's, else the nearest drawn row above it on its path, else its old index within `rows`. */
function cursorIndex(nav: Nav, rows: readonly Row[]): number {
	const own = indexOf(rows, nav.cursor);
	if (own >= 0) return own;
	for (const key of [...nav.path].reverse()) {
		const at = indexOf(rows, key);
		if (at >= 0) return at;
	}
	return Math.max(0, Math.min(nav.index, rows.length - 1));
}

/** `nav` against `rows` in a viewport of `body` rows: its cursor on a drawn row, kept `SCROLL_MARGIN` rows from the edge. */
export function resolve(nav: Nav, rows: readonly Row[], body: number): Nav {
	const index = cursorIndex(nav, rows);
	const low = index - body + 1 + SCROLL_MARGIN;
	const high = index - SCROLL_MARGIN;
	const top = Math.max(
		0,
		Math.min(Math.max(nav.top, low), high, rows.length - body),
	);
	return { ...nav, index, top, cursor: rows[index]?.key };
}

/** The keys of the container rows above `row`, outermost first. */
function pathTo(rows: readonly Row[], row: Row): string[] {
	const byKey = new Map(rows.map((r) => [r.key, r]));
	const path: string[] = [];
	for (let p = row.parent; p !== undefined; p = byKey.get(p)?.parent)
		path.unshift(p);
	return path;
}

/** The cursor moved to row `index`, held within the rows, and follow off. */
function moved(nav: Nav, f: Browsed, index: number): Nav {
	const at = Math.max(0, Math.min(f.rows.length - 1, index));
	const row = f.rows[at];
	if (row === undefined) return nav;
	return {
		...nav,
		follow: false,
		index: at,
		cursor: row.key,
		path: pathTo(f.rows, row),
	};
}

const withOpen = (nav: Nav, keys: readonly string[], open: boolean): Nav => ({
	...nav,
	open: new Map([
		...nav.open,
		...keys.map((k): [string, boolean] => [k, open]),
	]),
});

/** `l`: a closed row opens, an open one steps to its first member. */
function opened(nav: Nav, f: Browsed, row: Row | undefined): Nav {
	if (row?.open === false) return withOpen(nav, [row.key], true);
	return row?.open ? moved(nav, f, nav.index + 1) : nav;
}

/** `h`: an open row closes, another steps to its container's row. */
function closed(nav: Nav, f: Browsed, row: Row | undefined): Nav {
	if (row?.open) return withOpen(nav, [row.key], false);
	const parent = indexOf(f.rows, row?.parent);
	return parent < 0 ? nav : moved(nav, f, parent);
}

/** The row of the nearest sequential group at or above `row`. */
function sequentialOf(f: Browsed, row: Row | undefined): Row | undefined {
	const byKey = new Map(f.rows.map((r) => [r.key, r]));
	let at = row;
	while (at !== undefined && at.iterations === undefined)
		at = at.parent === undefined ? undefined : byKey.get(at.parent);
	return at;
}

/** `[` and `]`: the nearest sequential group shows the iteration `by` from its shown one, its row under the cursor. */
function stepped(nav: Nav, f: Browsed, by: number): Nav {
	const group = sequentialOf(f, f.rows[nav.index]);
	if (group?.iterations === undefined) return nav;
	const { keys, shown } = group.iterations;
	const to = keys[keys.indexOf(shown) + by];
	if (to === undefined) return nav;
	const pins = new Map(nav.pins);
	if (to === keys.at(-1)) pins.delete(group.key);
	else pins.set(group.key, to);
	const at = moved(nav, f, f.rows.indexOf(group));
	return { ...withOpen(at, [group.key], true), pins };
}

/** `e`: the cursor on the last failure, its path opened and each iteration on the way pinned. */
function failed(nav: Nav, failure: Focus | undefined): Nav {
	if (failure === undefined) return nav;
	return {
		...withOpen(nav, failure.path, true),
		follow: false,
		cursor: failure.key,
		path: failure.path,
		pins: new Map([...nav.pins, ...failure.pins]),
	};
}

/** `f`: follow toggled; turned on, it drops the pinned iterations and keeps the folds. */
const followed = (nav: Nav): Nav =>
	nav.follow
		? { ...nav, follow: false }
		: { ...nav, follow: true, pins: new Map() };

/** The navigation after `key` on the view `f`, from the navigation `f` was drawn with. */
export function press(key: Key, f: Browsed): Nav {
	const { nav } = f;
	const row = f.rows[nav.index];
	switch (key) {
		case "up":
			return moved(nav, f, nav.index - 1);
		case "down":
			return moved(nav, f, nav.index + 1);
		case "pageUp":
			return moved(nav, f, nav.index - f.body);
		case "pageDown":
			return moved(nav, f, nav.index + f.body);
		case "first":
			return moved(nav, f, 0);
		case "last":
			return moved(nav, f, f.rows.length - 1);
		case "right":
			return opened(nav, f, row);
		case "left":
			return closed(nav, f, row);
		case "toggle":
			return row?.open === undefined
				? nav
				: withOpen(nav, [row.key], !row.open);
		case "previous":
			return stepped(nav, f, -1);
		case "next":
			return stepped(nav, f, 1);
		case "failure":
			return failed(nav, f.failure);
		case "follow":
			return followed(nav);
	}
}
