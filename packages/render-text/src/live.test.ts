import { describe, expect, test } from "bun:test";
import type { ConcertEvent, EventBody, Ir } from "@maestro/ir";
import { eventLine, frame, seen, type View } from "./live";

const GOLDEN = "fanout-fanin-loop";
const ir: Ir = structuredClone(
	(await import(`@maestro/ir/plans/${GOLDEN}`)).default.ir,
);

const START = 1_792_285_440_000;
const ESC = "\u001b";
const SGR = { green: `${ESC}[32m`, red: `${ESC}[31m`, dim: `${ESC}[2m` };

/** Events with their seq in list order, each at `ms` after the start. */
const eventsOf = (
	list: readonly [
		node: string,
		expansion: string,
		ms: number,
		body: EventBody,
	][],
): ConcertEvent[] =>
	list.map(([node, expansion, ms, body], i) => ({
		seq: i + 1,
		at: START + ms,
		node,
		expansion,
		...body,
	}));

const TOOL = { kind: "tool", name: "bash", input: { command: "ls" } };

const EVENTS = eventsOf([
	["topics", "", 0, { type: "running" }],
	["topics/draft", "[c]", 100, { type: "running" }],
	["topics/draft", "[a]", 200, { type: "running" }],
	["topics/draft", "[b]", 300, { type: "running" }],
	[
		"topics/draft",
		"[b]",
		400,
		{ type: "settled", outcome: "failed", reason: "early" },
	],
	[
		"topics/draft",
		"[c]",
		500,
		{ type: "settled", outcome: "failed", reason: "flaky" },
	],
	["topics/draft", "[a]", 3_300, { type: "settled", outcome: "ok" }],
	["topics/draft", "[b]", 2_000, { type: "running" }],
	["topics/draft", "[b]", 2_100, { type: "progress", event: TOOL }],
	["topics/draft", "[b]", 2_200, { type: "log", line: "noise" }],
	["topics", "", 12_000, { type: "settled", outcome: "ok" }],
	["best", "", 12_100, { type: "reused" }],
]);

const VIEW: View = {
	concert: {
		id: "7f3a91c2",
		label: "fixtures.fanout-fanin-loop",
		status: "running",
		startedAt: START,
	},
	now: START + 64_000,
	color: false,
	columns: 200,
	rows: 50,
};

const drawn = (view: Partial<View> = {}) =>
	frame(ir, seen(new Map(), EVENTS), { ...VIEW, ...view });

describe("frame", () => {
	test("draws the IR's nodes in order, instances by first event, pending nodes by bare id", () => {
		expect(drawn().split("\n")).toEqual([
			"concert 7f3a91c2 fixtures.fanout-fanin-loop  running  1m04s  1 running, 3 ok, 1 failed, 5 pending",
			"✓ topics                parMap     ok       12s",
			"  ! topics[c]/draft     fake.task  failed   0.4s   flaky",
			"  ✓ topics[a]/draft     fake.task  ok       3.1s",
			'  ● topics[b]/draft     fake.task  running  1m02s  tool bash {"command":"ls"}',
			"✓ best                  code       ok              reused",
			"  ○ refine/loop         loop       pending",
			"    ○ refine/loop/step  fake.task  pending",
			"    ○ refine/loop/done  code       pending",
			"    ○ refine/loop/more  code       pending",
			"○ text                  code       pending",
		]);
		expect(drawn()).not.toContain(ESC);
	});

	test("a settled concert's elapsed time stops at its settling", () => {
		const settled = drawn({
			concert: { ...VIEW.concert, status: "failed", settledAt: START + 4_500 },
		});
		expect(settled.split("\n")[0]).toStartWith(
			"concert 7f3a91c2 fixtures.fanout-fanin-loop  failed  4.5s  ",
		);
	});

	test("with color, an ok line carries green, a failed one red, a pending one dim", () => {
		const lines = drawn({ color: true }).split("\n");
		expect(lines[3]).toContain(`${SGR.green}✓`);
		expect(lines[2]).toContain(`${SGR.red}!`);
		expect(lines[2]).toContain(`${SGR.red}flaky`);
		expect(lines[6]).toStartWith(SGR.dim);
	});

	test("cuts lines at columns - 1, and past rows - 1 lines keeps the header and ends with the count left", () => {
		const narrow = drawn({ columns: 21 }).split("\n");
		expect(narrow[2]).toBe("  ! topics[c]/draft ");
		expect(Math.max(...narrow.map((l) => l.length))).toBe(20);
		const short = drawn({ rows: 6 }).split("\n");
		expect(short).toHaveLength(5);
		expect(short[0]).toStartWith("concert 7f3a91c2");
		expect(short[3]).toStartWith("  ✓ topics[a]/draft");
		expect(short[4]).toBe("… 7 more");
	});

	test("cuts by terminal cells, a wide glyph or an emoji whole or not at all", () => {
		const [wide] = eventsOf([
			[
				"topics/draft",
				"[b]",
				2_300,
				{ type: "progress", event: { kind: "text", text: "漢字😀ok" } },
			],
		]);
		const lineAt = (columns: number) =>
			frame(ir, seen(new Map(), [...EVENTS, ...(wide ? [wide] : [])]), {
				...VIEW,
				columns,
			}).split("\n")[4] ?? "";
		const full = lineAt(VIEW.columns);
		const before = Bun.stringWidth(full.slice(0, full.indexOf("漢")));
		for (const [cells, shown] of [
			[4, "漢字"],
			[5, "漢字"],
			[6, "漢字😀"],
		] as const) {
			const cut = lineAt(before + cells + 1);
			expect(cut).toEndWith(` ${shown}`);
			expect(cut.isWellFormed()).toBe(true);
			expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(before + cells);
		}
	});
});

describe("eventLine", () => {
	const line = (event: ConcertEvent | undefined, view: Partial<View> = {}) =>
		event ? eventLine(ir, event, { ...VIEW, ...view }) : "";

	test("shows the offset, the instance name and what happened", () => {
		expect(line(EVENTS[0])).toBe("+0.0s   topics                  running");
		expect(line(EVENTS[5])).toBe(
			"+0.5s   topics[c]/draft         failed: flaky",
		);
		expect(line(EVENTS[11])).toBe(
			"+12s    best                    ok (reused)",
		);
		expect(line(EVENTS[8])).toBe(
			'+2.1s   topics[b]/draft         tool bash {"command":"ls"}',
		);
		expect(line(EVENTS[9])).toBe("+2.2s   topics[b]/draft         log noise");
	});

	test("continues a multi-line string on the next lines, under the text's start", () => {
		const [thinking] = eventsOf([
			[
				"topics/draft",
				"[b]",
				2_500,
				{ type: "progress", event: { kind: "thinking", text: "one\ntwo" } },
			],
		]);
		expect(line(thinking).split("\n")).toEqual([
			"+2.5s   topics[b]/draft         thinking one",
			`${" ".repeat(32)}two`,
		]);
	});

	test("shows a control character as its escape, so no text moves the cursor", () => {
		const [log] = eventsOf([
			["best", "", 0, { type: "log", line: `a${ESC}[2Jb` }],
		]);
		expect(line(log)).toBe("+0.0s   best                    log a\\u001b[2Jb");
	});
});
