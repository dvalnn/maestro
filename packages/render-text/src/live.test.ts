import { describe, expect, test } from "bun:test";
import type { ConcertEvent, EventBody, Ir } from "@maestro/ir";
import {
	agentsOf,
	agentText,
	arranged,
	eventLine,
	frame,
	seen,
	uniqueLength,
	type View,
} from "./live";

const GOLDEN = "fanout-fanin-loop";
const ir: Ir = structuredClone(
	(await import(`@maestro/ir/plans/${GOLDEN}`)).default.ir,
);

const START = 1_792_285_440_000;
const ESC = "\u001b";
const SGR = {
	green: `${ESC}[32m`,
	red: `${ESC}[31m`,
	dim: `${ESC}[2m`,
	bold: `${ESC}[1m`,
	plain: `${ESC}[22m`,
};

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
		title: "greeting",
		status: "running",
		unique: 3,
		startedAt: START,
	},
	tokens: 0,
	now: START + 64_000,
	color: false,
	columns: 200,
	rows: 50,
};

const drawn = (view: Partial<View> = {}) =>
	frame(ir, seen(new Map(), EVENTS), { ...VIEW, ...view }, new Map());

describe("frame", () => {
	test("lays out a header, the rows by scope and group, and a footer; instances by first event, pending nodes by short name", () => {
		const lines = drawn().split("\n");
		expect(lines.slice(0, -1)).toEqual([
			'● fixtures.fanout-fanin-loop  "greeting"  7f3a91c2   running  1m04s',
			"",
			"✓ topics      parMap     ok       12s",
			"  ! draft[c]  fake.task  failed   0.4s   flaky",
			"  ✓ draft[a]  fake.task  ok       3.1s",
			'  ● draft[b]  fake.task  running  1m02s  tool bash {"command":"ls"}',
			"✓ best        code       ok              reused",
			"refine",
			"  ○ loop      loop       pending",
			"    ○ step    fake.task  pending",
			"    ○ done    code       pending",
			"    ○ more    code       pending",
			"○ text        code       pending",
			"",
		]);
		expect(lines.at(-1)).toStartWith(
			"── 1 running · 3 ok · 1 failed · 5 pending ──",
		);
		expect(lines.at(-1)).toHaveLength(VIEW.columns - 1);
		expect(drawn()).not.toContain(ESC);
	});

	test("shows the concert's tokens in the footer, and a node that never ran as skipped once it settled", () => {
		const settled = drawn({
			concert: { ...VIEW.concert, status: "failed", settledAt: START + 4_500 },
			tokens: 39_300,
		}).split("\n");
		expect(settled[0]).toBe(
			'! fixtures.fanout-fanin-loop  "greeting"  7f3a91c2   failed  4.5s',
		);
		expect(settled[8]).toBe("  - loop      loop       skipped");
		expect(settled.at(-1)).toMatch(
			/^── 1 running · 3 ok · 1 failed · 5 skipped ─+ 39\.3k tok ──$/,
		);
	});

	test("shows the short id at least 8 characters, its unique part bold and the rest dim", () => {
		const header = drawn({
			color: true,
			concert: { ...VIEW.concert, id: "7f3a91c2-beef", unique: 3 },
		}).split("\n")[0];
		expect(header).toContain(
			`${SGR.bold}7f3${SGR.plain}${SGR.dim}a91c2${SGR.plain}`,
		);
		expect(header).not.toContain("beef");
	});

	test("groups a loop's members under its rounds in node order, with the agent column, and shows a step that never started in a round as pending, then skipped", () => {
		const step = { node: "refine/loop/step", expansion: "[0]" };
		const loop = eventsOf([
			["refine/loop", "", 0, { type: "running" }],
			["refine/loop/done", "[0]", 10, { type: "running" }],
			["refine/loop/done", "[0]", 20, { type: "settled", outcome: "ok" }],
			[step.node, step.expansion, 30, { type: "running" }],
			[step.node, step.expansion, 40, { type: "settled", outcome: "ok" }],
			["refine/loop/done", "[1]", 50, { type: "running" }],
		]);
		const record = {
			...step,
			enrichment: { harness: "pi", model: "a/haiku", thinking: "medium" },
			metrics: { tokens_in: 12_000, tokens_out: 3_500, tokens_reasoning: 900 },
			stale: false,
		};
		const agents = agentsOf([
			record,
			{ ...record, node: "refine/loop/done", stale: true },
		]);
		const show = (view: Partial<View>) =>
			frame(ir, seen(new Map(), loop), { ...VIEW, ...view }, agents)
				.split("\n")
				.slice(5, 16);
		expect(show({})).toEqual([
			"refine",
			"  ● loop    loop       running  1m04s",
			"  round 0",
			"    ✓ step  fake.task  ok       0.0s   pi · haiku · medium  15.5k tok",
			"    ✓ done  code       ok       0.0s",
			"    ○ more  code       pending",
			"  round 1",
			"    ○ step  fake.task  pending",
			"    ● done  code       running  1m03s",
			"    ○ more  code       pending",
			"○ text      code       pending",
		]);
		const settled = show({
			concert: { ...VIEW.concert, status: "ok", settledAt: START + 60_000 },
		});
		expect(settled[5]).toBe("    - more  code       skipped");
		expect(settled[7]).toBe("    - step  fake.task  skipped");
	});

	test("shows the agent a running instance announced, before any tokens, then its note", () => {
		const announced = eventsOf([
			["best", "", 0, { type: "running" }],
			[
				"best",
				"",
				10,
				{
					type: "progress",
					event: {
						kind: "agent",
						harness: "pi",
						model: "a/b",
						thinking: "low",
					},
				},
			],
			["best", "", 20, { type: "progress", event: { kind: "turn" } }],
		]);
		const line = frame(ir, seen(new Map(), announced), VIEW, new Map()).split(
			"\n",
		)[4];
		expect(line).toBe(
			"● best      code       running  1m04s  pi · b · low  turn",
		);
	});

	test("with color, an ok line carries green, a failed one red, a pending one dim, a heading bold", () => {
		const lines = drawn({ color: true }).split("\n");
		expect(lines[4]).toContain(`${SGR.green}✓`);
		expect(lines[3]).toContain(`${SGR.red}!`);
		expect(lines[3]).toContain(`${SGR.red}flaky`);
		expect(lines[7]).toBe(`${SGR.bold}refine${SGR.plain}`);
		expect(lines[8]).toStartWith(SGR.dim);
	});

	test("cuts lines at columns - 1, and past rows - 1 lines keeps the header and footer and ends the rows with the count left", () => {
		const narrow = drawn({ columns: 21 }).split("\n");
		expect(narrow[3]).toBe("  ! draft[c]  fake.t");
		expect(Math.max(...narrow.map((l) => l.length))).toBe(20);
		const short = drawn({ rows: 9 }).split("\n");
		expect(short).toHaveLength(8);
		expect(short[0]).toStartWith("● fixtures");
		expect(short[4]).toStartWith("  ✓ draft[a]");
		expect(short[5]).toBe("… 8 more");
		expect(short[7]).toStartWith("── 1 running");
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
			frame(
				ir,
				seen(new Map(), [...EVENTS, ...(wide ? [wide] : [])]),
				{
					...VIEW,
					columns,
				},
				new Map(),
			).split("\n")[5] ?? "";
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

	test("shows a newline in a failure reason as a space", () => {
		const [settled] = eventsOf([
			["best", "", 0, { type: "settled", outcome: "failed", reason: "a\nb" }],
		]);
		expect(line(settled)).toBe("+0.0s   best                    failed: a b");
	});
});

describe("agentText", () => {
	const ENRICHED = {
		session: "s",
		harness: "pi",
		model: "github-copilot/claude-haiku-5.5",
		thinking: "medium",
	};

	test.each([
		[
			ENRICHED,
			{ tokens_in: 12_000, tokens_out: 3_500 },
			"pi · claude-haiku-5.5 · medium  15.5k tok",
		],
		[
			{ ...ENRICHED, thinking: undefined, model: "none" },
			{ tokens_out: 999 },
			"pi · none  999 tok",
		],
		[
			ENRICHED,
			{ tokens_in: 1_200_000, cost: 5 },
			"pi · claude-haiku-5.5 · medium  1.2M tok",
		],
		[
			ENRICHED,
			{ tokens_in: 999_990 },
			"pi · claude-haiku-5.5 · medium  1.0M tok",
		],
		[ENRICHED, {}, "pi · claude-haiku-5.5 · medium"],
		[
			ENRICHED,
			{
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 25,
				tokens_reasoning: 40,
			},
			"pi · claude-haiku-5.5 · medium  175 tok",
		],
		[{ session: "s" }, { tokens_in: 5 }, ""],
	])("shows %j with %j as %j", (enrichment, metrics, text) => {
		expect(agentText(enrichment, metrics)).toBe(text);
	});
});

describe("uniqueLength", () => {
	test("is the shortest prefix no other id starts with", () => {
		const ids = ["0198aa", "0198ab", "02"];
		expect(uniqueLength("0198aa", ids)).toBe(6);
		expect(uniqueLength("02", ids)).toBe(2);
		expect(uniqueLength("02", ["02"])).toBe(1);
	});
});

describe("arranged", () => {
	test("lists a loop's instances round by round, each round's in node order", () => {
		const at = (node: string, expansion: string) => ({ node, expansion });
		const started = [
			at("refine/loop/done", "[0]"),
			at("refine/loop/done", "[1]"),
			at("refine/loop/step", "[1]"),
			at("refine/loop/step", "[0]"),
			at("refine/loop", ""),
		];
		expect(arranged(ir, started)).toEqual([
			at("refine/loop", ""),
			at("refine/loop/step", "[0]"),
			at("refine/loop/done", "[0]"),
			at("refine/loop/step", "[1]"),
			at("refine/loop/done", "[1]"),
		]);
	});
});
