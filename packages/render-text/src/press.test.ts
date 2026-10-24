import { describe, expect, test } from "bun:test";
import type { ConcertEvent } from "@maestro/ir";
import { END_S, MID_S, PANEL_IR, panelEvents, START } from "./fixtures/panel";
import { navigated } from "./inspect";
import { browse, seen, type View } from "./live";
import {
	type Browsed,
	ends,
	type Input,
	keysOf,
	NAV,
	type Nav,
	press,
	SCROLL_MARGIN,
} from "./press";

const MS_PER_S = 1_000;
const ESC = "\u001b";

const viewOf = (settled: boolean, rows: number, columns = 120): View => ({
	concert: {
		id: "01a154df-b99f-72ca-8f73-b1fc195571b6",
		label: "fixtures.audit",
		status: settled ? "ok" : "running",
		unique: 3,
		startedAt: START,
		...(settled && { settledAt: START + END_S * MS_PER_S }),
	},
	tokens: 0,
	now: START + MID_S * MS_PER_S,
	color: false,
	columns,
	rows,
});
/** A terminal tall enough for every row of the panel concert. */
const TALL = 40;

/** The panel concert in its second repair round, with its first round's test `failed` instead of `rejected`. */
const FAILED_ROUND = panelEvents(MID_S).map(
	(e): ConcertEvent =>
		e.node === "test-loop/test" && e.type === "settled"
			? { ...e, outcome: "failed" }
			: e,
);

/** The panel concert browsed from `nav`, settled or in its second repair round, or as `events` say. */
const browsed = (
	nav: Nav,
	{
		settled = false,
		events = panelEvents(settled ? undefined : MID_S),
		rows = TALL,
		columns = 120,
	} = {},
): Browsed =>
	browse(
		PANEL_IR,
		seen(new Map(), events),
		viewOf(settled, rows, columns),
		new Map(),
		nav,
	);

/** Not following, the cursor on the row keyed `cursor`. */
const on = (cursor: string, over: Partial<Nav> = {}): Nav => ({
	...NAV,
	follow: false,
	cursor,
	...over,
});

const cursorOf = (f: Browsed) => f.rows[f.nav.index]?.key;

/** `keys` pressed in turn on the view drawn from `nav`, each drawn again. */
function pressed(
	nav: Nav,
	keys: readonly Input[],
	over: Parameters<typeof browsed>[1] = {},
): Browsed {
	return keys.reduce(
		(f, key) => browsed(press(key, f), over),
		browsed(nav, over),
	);
}

/** What a case expects: the cursor's row, `nav` fields, the open and pinned entries in order, and a row's drawn fold. */
type Expected = Partial<Omit<Nav, "open" | "pins">> & {
	at?: string;
	open?: [string, boolean][];
	pins?: [string, string][];
	folded?: [key: string, open: boolean];
	given?: Parameters<typeof browsed>[1];
};

describe("press", () => {
	test.each<[what: string, from: Nav, keys: Input[], expected: Expected]>([
		[
			"j moves down, which turns follow off",
			NAV,
			["down"],
			{ at: "test-loop/test@1", follow: false },
		],
		["k moves up", NAV, ["up"], { at: "test-loop@", follow: false }],
		["g goes to the first row", NAV, ["first"], { at: "request@" }],
		["G goes to the last row", NAV, ["last"], { at: "ruling@" }],
		[
			"PgDn moves a viewport, held within the rows",
			on("request@"),
			["pageDown"],
			{ at: "ruling@" },
		],
		[
			"PgUp moves a viewport, held within the rows",
			on("ruling@"),
			["pageUp"],
			{ at: "request@" },
		],
		[
			"l opens a closed row",
			on("panel@"),
			["right"],
			{ at: "panel@", open: [["panel@", true]], folded: ["panel@", true] },
		],
		[
			"l on an open row steps to its first member",
			on("test-loop@"),
			["right"],
			{ at: "test-loop/repair@1" },
		],
		[
			"h closes an open row",
			NAV,
			["up", "left"],
			{
				at: "test-loop@",
				open: [["test-loop@", false]],
				folded: ["test-loop@", false],
			},
		],
		[
			"h on a closed row steps to its parent",
			on("panel/lenses/skeptic@*"),
			["left"],
			{ at: "panel/lenses@", path: ["panel@"], given: { settled: true } },
		],
		[
			"space opens a closed row",
			on("gate-loop@"),
			["toggle"],
			{
				at: "gate-loop@",
				open: [["gate-loop@", true]],
				folded: ["gate-loop@", true],
			},
		],
		[
			"space again closes it",
			on("gate-loop@"),
			["toggle", "toggle"],
			{ open: [["gate-loop@", false]], folded: ["gate-loop@", false] },
		],
		[
			"[ shows the loop's previous round, its row under the cursor",
			NAV,
			["previous"],
			{ at: "test-loop@", follow: false, pins: [["test-loop@", "0"]] },
		],
		[
			"] back to the latest round drops the pin",
			NAV,
			["previous", "next"],
			{ at: "test-loop@", pins: [] },
		],
		[
			"e goes to the last failure, its path open and its round pinned",
			NAV,
			["failure"],
			{
				at: "test-loop/test@0",
				follow: false,
				path: ["test-loop@"],
				pins: [["test-loop@", "0"]],
				given: { events: FAILED_ROUND },
			},
		],
		[
			"f turned on drops the pins and keeps the folds",
			on("ruling@", {
				pins: new Map([["test-loop@", "0"]]),
				open: new Map([["panel@", true]]),
			}),
			["follow"],
			{
				at: "test-loop/repair@1",
				follow: true,
				pins: [],
				open: [["panel@", true]],
			},
		],
		[
			"f turned off keeps the cursor where it is",
			NAV,
			["follow"],
			{ at: "test-loop/repair@1", follow: false },
		],
		[
			"following a settled concert goes to the last failure",
			NAV,
			[],
			{ at: "panel/lenses/lens#[spec]", given: { settled: true } },
		],
		[
			"Esc leaves the tree as it is",
			on("request@"),
			["esc"],
			{ at: "request@", follow: false },
		],
		[
			"a closed container on the cursor's path opens",
			on("gate-loop/repair@0", { path: ["gate-loop@"] }),
			[],
			{ at: "gate-loop/repair@0", folded: ["gate-loop@", true] },
		],
		[
			"a cursor whose row is not drawn goes to the nearest drawn row on its path",
			on("panel/lenses/lens#[spec]", {
				path: ["panel@", "panel/lenses@", "panel/lenses/lens@*"],
				open: new Map([["panel/lenses/lens@*", false]]),
			}),
			[],
			{ at: "panel/lenses/lens@*", given: { settled: true } },
		],
	])("%s", (_what, from, keys, expected) => {
		const { at, open, pins, folded, given, ...nav } = expected;
		const f = pressed(from, keys, given);
		if (at !== undefined) expect(cursorOf(f)).toBe(at);
		expect(f.nav).toMatchObject(nav);
		if (open) expect([...f.nav.open]).toEqual(open);
		if (pins) expect([...f.nav.pins]).toEqual(pins);
		if (folded)
			expect(f.rows.find((r) => r.key === folded[0])?.open).toBe(folded[1]);
	});

	test("[ at the first round stays put", () => {
		const f = pressed(NAV, ["previous"]);
		expect(press("previous", f)).toEqual(f.nav);
	});

	test("a pinned round is marked history, and its members show that round", () => {
		const f = pressed(NAV, ["previous"]);
		const text = f.lines.join("\n");
		expect(text).toMatch(/● test-loop .*⟲ 1\/3 \(history\) {3}1✗ 2●/);
		expect(text).toMatch(/✗ test +code +rejected/);
	});
});

describe("press in the inspector", () => {
	const events = panelEvents(MID_S);
	/** The panel concert in its second repair round, the tree or the inspector as `nav` says, on `rows` lines. */
	const shown = (nav: Nav, rows = TALL) =>
		navigated(
			PANEL_IR,
			seen(new Map(), events),
			viewOf(false, rows),
			new Map(),
			nav,
			{ events, instances: [] },
		);
	const keyed = (nav: Nav, keys: readonly Input[], rows = TALL) =>
		keys.reduce((f, key) => shown(press(key, f), rows), shown(nav, rows));
	/** A terminal on which the loop's events overflow the inspector. */
	const SHORT = 14;

	test("Enter opens the inspector on the cursor row, tailing, and leaves follow as it was", () => {
		const f = keyed(NAV, ["enter"]);
		expect(f.nav).toMatchObject({
			follow: true,
			inspect: { key: "test-loop/repair@1", tail: true },
		});
		expect(f.lines[3]).toStartWith("◆ inspect  test-loop[1]/repair ");
	});

	test.each<Input>(["esc", "enter", "left", "quit"])(
		"%s goes back to the tree, its cursor where it was",
		(key) => {
			const f = keyed(on("test-loop@"), ["enter", key]);
			expect(f.nav.inspect).toBeUndefined();
			expect(cursorOf(f)).toBe("test-loop@");
		},
	);

	test("Ctrl-C ends the view from either, q only from the tree", () => {
		const tree = shown(NAV).nav;
		const inspector = keyed(NAV, ["enter"]).nav;
		expect(ends("interrupt", tree)).toBe(true);
		expect(ends("interrupt", inspector)).toBe(true);
		expect(ends("quit", tree)).toBe(true);
		expect(ends("quit", inspector)).toBe(false);
	});

	test("scrolling clears tail, reaching the newest line or G restores it, and g goes to the top", () => {
		const open = keyed(on("test-loop@"), ["enter"], SHORT);
		const max = open.scrollMax ?? 0;
		expect(max).toBeGreaterThan(1);
		expect(open.nav.inspect).toMatchObject({ scroll: max, tail: true });
		const at = (keys: Input[]) =>
			keyed(on("test-loop@"), ["enter", ...keys], SHORT).nav.inspect;
		expect(at(["up"])).toMatchObject({ scroll: max - 1, tail: false });
		expect(at(["up", "down"])).toMatchObject({ scroll: max, tail: true });
		expect(at(["first"])).toMatchObject({ scroll: 0, tail: false });
		expect(at(["first", "last"])).toMatchObject({ scroll: max, tail: true });
		expect(at(["pageUp"])).toMatchObject({
			scroll: max - open.body,
			tail: false,
		});
		expect(at(["first", "pageDown"])).toMatchObject({ tail: false });
	});

	test("a scrolled inspector keeps its place as events arrive, a tailing one shows the newest", () => {
		const nav = keyed(on("test-loop@"), ["enter", "up"], SHORT).nav;
		const later = (n: Nav) =>
			navigated(
				PANEL_IR,
				seen(new Map(), panelEvents()),
				viewOf(false, SHORT),
				new Map(),
				n,
				{ events: panelEvents(), instances: [] },
			);
		expect(later(nav).nav.inspect?.scroll).toBe(nav.inspect?.scroll);
		const tailing = later({
			...nav,
			inspect: { key: "test-loop@", scroll: 0, tail: true },
		});
		expect(tailing.lines.at(-3)).toMatch(/test-loop +ok$/);
	});
});

describe("keysOf", () => {
	test.each<[what: string, input: string, keys: Input[]]>([
		["vi keys", "jkhlgG", ["down", "up", "left", "right", "first", "last"]],
		[
			"arrows, in normal and application mode",
			`${ESC}[A${ESC}[B${ESC}[D${ESC}[C${ESC}OA${ESC}OB${ESC}OD${ESC}OC`,
			["up", "down", "left", "right", "up", "down", "left", "right"],
		],
		[
			"paging, as PgUp and PgDn or u and d",
			`${ESC}[5~${ESC}[6~ud`,
			["pageUp", "pageDown", "pageUp", "pageDown"],
		],
		[
			"Home and End as terminals send them",
			`${ESC}[H${ESC}[1~${ESC}[7~${ESC}OH${ESC}[F${ESC}[4~${ESC}[8~${ESC}OF`,
			["first", "first", "first", "first", "last", "last", "last", "last"],
		],
		[
			"space, rounds, failure, follow, Enter, q and Ctrl-C",
			" []ef\rq\u0003",
			[
				"toggle",
				"previous",
				"next",
				"failure",
				"follow",
				"enter",
				"quit",
				"interrupt",
			],
		],
		[
			"a lone Esc kept, an unbound sequence left out",
			`${ESC}j${ESC}[Zx`,
			["esc", "down"],
		],
	])("%s", (_what, input, keys) => {
		expect(keysOf(input)).toEqual(keys);
	});
});

describe("browse", () => {
	/** A terminal whose viewport holds 5 rows. */
	const SHORT = 12;
	const ABOVE = 3;
	const BELOW = 4;
	/** The fewest rows a viewport shows. */
	const MIN_BODY = 3;

	test("keeps the cursor SCROLL_MARGIN rows inside the viewport while rows remain beyond it, down and back up, and counts the rows in view", () => {
		const given = { settled: true, rows: SHORT };
		let f = browsed(on("request@"), given);
		const last = f.rows.length - f.body;
		const check = () => {
			const { index, top } = f.nav;
			const offset = index - top;
			if (top > 0) expect(offset).toBeGreaterThanOrEqual(SCROLL_MARGIN);
			if (top < last)
				expect(offset).toBeLessThanOrEqual(f.body - 1 - SCROLL_MARGIN);
			expect(f.lines[ABOVE + offset]).toStartWith(">");
			expect(f.lines[ABOVE + f.body]).toContain(
				`rows ${top + 1}–${top + f.body} of ${f.rows.length}`,
			);
		};
		for (const key of ["down", "up"] as const) {
			for (let step = 0; step < f.rows.length; step++) {
				check();
				f = browsed(press(key, f), given);
			}
			expect(f.nav.top).toBe(key === "down" ? last : 0);
		}
	});

	test("shows now and last while the cursor and the running row are off screen, in a viewport of MIN_BODY rows however short the terminal", () => {
		const f = pressed(NAV, ["first"], { events: FAILED_ROUND, rows: 1 });
		expect(f.lines).toHaveLength(ABOVE + MIN_BODY + BELOW);
		expect(f.lines.join("\n")).not.toMatch(/● repair/);
		expect(f.lines[1]).toStartWith("now   ● test-loop ⟲2 › repair");
		expect(f.lines[2]).toStartWith("last  ! test-loop ⟲1 › test   failed");
		expect(f.lines.at(-3)).toBe("› request  code  ok  1.0s");
	});

	test("marks the cursor row in a lead column, which hides no fold marker, in reverse video with color", () => {
		const plain = browsed(on("gate-loop@"));
		expect(plain.lines).toContain(
			">▸ ✓ gate-loop  loop        ok        1.0s  ⟲ 0/2",
		);
		expect(plain.lines).toContain("   ✓ request    code        ok        1.0s");
		const colored = browse(
			PANEL_IR,
			seen(new Map(), panelEvents(MID_S)),
			{ ...viewOf(false, TALL), color: true },
			new Map(),
			NAV,
		);
		expect(colored.lines[ABOVE + colored.nav.index]).toStartWith(`${ESC}[7m>`);
	});

	test("names the mode on the key line, drops f follow once the concert settled, and on a narrow terminal the last hints but q quit", () => {
		expect(browsed(NAV).lines.at(-1)).toBe(
			"● follow   j/k move  h/l fold  ⏎ inspect  f follow  [ ] round  e last failure  q quit",
		);
		expect(browsed(on("request@")).lines.at(-1)).toStartWith("○ browse ");
		expect(browsed(NAV, { settled: true }).lines.at(-1)).toBe(
			"■ settled   j/k move  h/l fold  ⏎ inspect  [ ] round  e last failure  q quit",
		);
		expect(browsed(NAV, { columns: 80 }).lines.at(-1)).toBe(
			"● follow   j/k move  h/l fold  ⏎ inspect  f follow  [ ] round  q quit",
		);
		expect(browsed(NAV, { columns: 40 }).lines.at(-1)).toBe(
			"● follow   j/k move  h/l fold  q quit",
		);
	});
});
