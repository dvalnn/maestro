import { describe, expect, test } from "bun:test";
import type { ConcertEvent } from "@maestro/ir";
import { END_S, MID_S, PANEL_IR, panelEvents, START } from "./fixtures/panel";
import { browse, seen, type View } from "./live";
import {
	type Browsed,
	type Input,
	type Key,
	keysOf,
	NAV,
	type Nav,
	press,
	SCROLL_MARGIN,
} from "./press";

const MS_PER_S = 1_000;
const ESC = "\u001b";

const viewOf = (settled: boolean, rows: number): View => ({
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
	columns: 120,
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
	} = {},
): Browsed =>
	browse(
		PANEL_IR,
		seen(new Map(), events),
		viewOf(settled, rows),
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
	keys: readonly Key[],
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
	test.each<[what: string, from: Nav, keys: Key[], expected: Expected]>([
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

describe("keysOf", () => {
	test.each<[what: string, input: string, keys: Input[]]>([
		["vi keys", "jkhlgG", ["down", "up", "left", "right", "first", "last"]],
		[
			"arrows, in normal and application mode",
			`${ESC}[A${ESC}[B${ESC}[D${ESC}[C${ESC}OA${ESC}OB${ESC}OD${ESC}OC`,
			["up", "down", "left", "right", "up", "down", "left", "right"],
		],
		["paging", `${ESC}[5~${ESC}[6~`, ["pageUp", "pageDown"]],
		[
			"Home and End as terminals send them",
			`${ESC}[H${ESC}[1~${ESC}[7~${ESC}OH${ESC}[F${ESC}[4~${ESC}[8~${ESC}OF`,
			["first", "first", "first", "first", "last", "last", "last", "last"],
		],
		[
			"space, rounds, failure, follow, q and Ctrl-C",
			" []efq\u0003",
			["toggle", "previous", "next", "failure", "follow", "quit", "quit"],
		],
		[
			"a lone Esc and an unbound sequence left out",
			`${ESC}j${ESC}[Zx`,
			["down"],
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

	test("names the mode on the key line, and drops f follow once the concert settled", () => {
		expect(browsed(NAV).lines.at(-1)).toBe(
			"● follow   j/k move  h/l fold  [ ] round  e last failure  f follow  q quit",
		);
		expect(browsed(on("request@")).lines.at(-1)).toStartWith("○ browse ");
		expect(browsed(NAV, { settled: true }).lines.at(-1)).toBe(
			"■ settled   j/k move  h/l fold  [ ] round  e last failure  q quit",
		);
	});
});
