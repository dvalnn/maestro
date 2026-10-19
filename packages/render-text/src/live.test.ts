import { describe, expect, test } from "bun:test";
import { styleText } from "node:util";
import type { ConcertEvent, EventBody, Ir } from "@maestro/ir";
import {
	agentsOf,
	agentText,
	arranged,
	closingBlock,
	eventLine,
	frame,
	seen,
	shortId,
	shortIds,
	type View,
} from "./live";

const GOLDEN = "fanout-fanin-loop";
const ir: Ir = structuredClone(
	(await import(`@maestro/ir/plans/${GOLDEN}`)).default.ir,
);

const START = 1_792_285_440_000;
const CONCERT = "01a154df-b99f-72ca-8f73-b1fc195571b6";
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
		id: CONCERT,
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
			'● fixtures.fanout-fanin-loop  "greeting"  kswoykny   running  1m04s',
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
			'! fixtures.fanout-fanin-loop  "greeting"  kswoykny   failed  4.5s',
		);
		expect(settled[8]).toBe("  - loop      loop       skipped");
		expect(settled.at(-1)).toMatch(
			/^── 1 running · 3 ok · 1 failed · 5 skipped ─+ 39\.3k tok ──$/,
		);
	});

	test("shows the short id at least 8 letters, its unique part bold and the rest dim", () => {
		const header = drawn({ color: true }).split("\n")[0];
		expect(header).toContain(
			`${SGR.bold}ksw${SGR.plain}${SGR.dim}oykny${SGR.plain}`,
		);
		expect(header).not.toContain("quus");
		const long = drawn({ concert: { ...VIEW.concert, unique: 10 } });
		expect(long.split("\n")[0]).toContain("  kswoyknyqu   running");
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
			actor: "pi · haiku · medium",
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
			["best", "", 10, { type: "progress", event: { kind: "agent" } }],
			["best", "", 20, { type: "progress", event: { kind: "settled" } }],
		]).map((e) => (e.seq === 2 ? { ...e, actor: "pi · b · low" } : e));
		const line = frame(ir, seen(new Map(), announced), VIEW, new Map()).split(
			"\n",
		)[4];
		expect(line).toBe(
			"● best      code       running  1m04s  pi · b · low  settled",
		);
	});

	test("shows a host's line as a running instance's note, on one line, in place of the generic one", () => {
		const noted = (extra: object) => {
			const events = eventsOf([
				["best", "", 0, { type: "running" }],
				[
					"best",
					"",
					10,
					{ type: "progress", event: { kind: "text", text: "hi" } },
				],
			]).map((e) => (e.seq === 2 ? { ...e, ...extra } : e));
			return frame(ir, seen(new Map(), events), VIEW, new Map())
				.split("\n")[4]
				?.split("  ")
				.at(-1);
		};
		expect(noted({})).toBe("text hi");
		expect(
			noted({ wording: { word: "step", detail: "1/2:\nbun install" } }),
		).toBe("step 1/2: bun install");
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
	const progress = (event: Record<string, unknown>, extra: object = {}) =>
		({
			...eventsOf([["best", "", 0, { type: "progress", event }]])[0],
			...extra,
		}) as ConcertEvent;
	const TIME = 7;
	/** Where the detail column starts: time 7, node 20 (`refine/loop/step` and a round), word 8, each then a gap of 2. */
	const DETAIL = 41;

	test("aligns the time, the instance, the word and the detail across nodes of every path length, a loop's round on its segment", () => {
		const [round] = eventsOf([
			["refine/loop/step", "[1]", 13_000, { type: "running" }],
		]);
		const lines = [
			EVENTS[0],
			EVENTS[5],
			EVENTS[8],
			EVENTS[9],
			EVENTS[11],
			round,
		].map((e) => line(e));
		expect(lines).toEqual([
			"  +0.0s  topics                running",
			"  +0.5s  topics[c]/draft       failed    flaky",
			'  +2.1s  topics[b]/draft       tool      bash {"command":"ls"}',
			"  +2.2s  topics[b]/draft       log       noise",
			" +12.1s  best                  ok        reused",
			" +13.0s  refine/loop[1]/step   running",
		]);
	});

	test("shows a host's word and detail, a kind without one as the word, an announced actor as an agent's detail", () => {
		const worded = (word: string, detail: string) => ({
			wording: { word, detail },
		});
		expect(
			line(progress({ kind: "step", n: 1 }, worded("step", "1/2: b"))),
		).toBe("  +0.0s  best                  step      1/2: b");
		expect(
			line(progress({ kind: "step" }, worded("tool", "step it"))),
		).toEndWith("tool      step it");
		expect(line(progress({ kind: "step", n: 1 }))).toEndWith("step      1");
		expect(line(progress({ kind: `${ESC}[2Jx` }))).toEndWith(
			"best                  \\u001b[2Jx",
		);
		expect(
			line(progress({ kind: "agent", harness: "pi" }, { actor: "pi · b" })),
		).toEndWith("agent     pi · b");
	});

	test("shows a multi-line detail's first line, marked when more text follows", () => {
		const [failed] = eventsOf([
			["best", "", 0, { type: "settled", outcome: "failed", reason: "a\nb" }],
		]);
		expect(line(failed)).toEndWith("failed    a …");
		const [blank] = eventsOf([
			[
				"best",
				"",
				0,
				{
					type: "settled",
					outcome: "failed",
					reason: "\n \nTypeError boom\nat x",
				},
			],
		]);
		expect(line(blank)).toEndWith("failed    TypeError boom …");
		expect(line(progress({ kind: "thinking", text: "one\ntwo" }))).toEndWith(
			"thinking  one …",
		);
		expect(line(progress({ kind: "text", text: "one\n\n" }))).toEndWith(
			"text      one",
		);
		expect(
			line(
				progress(
					{ kind: "prepare" },
					{ wording: { word: "prepare", detail: "1: a\nb" } },
				),
			),
		).toEndWith("prepare   1: a …");
	});

	test("on a terminal wraps a long detail at a space, under the detail column; off one keeps it on one line", () => {
		const long = progress({
			kind: "text",
			text: "aaaa bbbb cccc dddddd eeee",
		});
		expect(line(long, { columns: DETAIL + 20 }).split("\n")).toEqual([
			"  +0.0s  best                  text      aaaa bbbb cccc",
			`${" ".repeat(DETAIL)}dddddd eeee`,
		]);
		expect(line(long, { columns: DETAIL + 5 })).toBe(
			line(long, { columns: DETAIL + 20 }),
		);
		expect(line(long, { columns: 0 })).toEndWith("cccc dddddd eeee");
	});

	test("shows the time in seconds under a minute, minutes and seconds under an hour, else hours and minutes, in 7 columns", () => {
		const at = (ms: number) =>
			line(eventsOf([["best", "", ms, { type: "running" }]])[0]).slice(0, TIME);
		expect([59_999, 60_000, 3_599_999, 3_600_000, 7_500_000].map(at)).toEqual([
			" +59.9s",
			" +1m00s",
			"+59m59s",
			" +1h00m",
			" +2h05m",
		]);
	});

	test("shows a control character as its escape, so no text moves the cursor", () => {
		const [log] = eventsOf([
			["best", "", 0, { type: "log", line: `a${ESC}[2Jb` }],
		]);
		expect(line(log)).toEndWith("log       a\\u001b[2Jb");
	});

	describe("with color", () => {
		const p = (style: Parameters<typeof styleText>[0], text: string) =>
			styleText(style, text, { validateStream: false });
		const grey = (text: string) => `${ESC}[38;5;250m${text}${ESC}[39m`;
		const painted = (event: ConcertEvent | undefined) =>
			line(event, { color: true });
		/** The painted detail of an event at the start whose word has no style: all after the dim time and the plain columns. */
		const detailOf = (event: ConcertEvent | undefined) =>
			painted(event).slice(p("dim", "  +0.0s").length + DETAIL - TIME);

		test("dims the time, and styles each word and its detail", () => {
			expect(painted(EVENTS[0])).toStartWith(p("dim", "  +0.0s"));
			expect(painted(EVENTS[5])).toEndWith(
				`${p(["red", "bold"], "failed")}    ${p("yellow", "flaky")}`,
			);
			expect(painted(EVENTS[6])).toContain(p(["green", "bold"], "ok"));
			expect(painted(progress({ kind: "thinking", text: "hm" }))).toEndWith(
				`${p(["dim", "italic"], "thinking")}  ${p(["dim", "italic"], "hm")}`,
			);
			expect(painted(EVENTS[9])).toEndWith(`log       ${grey("noise")}`);
			expect(painted(progress({ kind: "agent" }, { actor: "pi" }))).toContain(
				p("cyan", "agent"),
			);
		});

		test("shows a word outside its style table unstyled, an inherited key among them", () => {
			expect(painted(progress({ kind: "constructor", n: 1 }))).toEndWith(
				`  best                  constructor  ${grey("1")}`,
			);
			expect(painted(progress({ kind: "step" }))).toEndWith(
				"  best                  step",
			);
		});

		test("highlights a JSON detail: keys, strings, numbers, literals and punctuation; other text in soft grey", () => {
			const input = { a: "s", n: -150, t: true, z: null };
			expect(detailOf(progress({ kind: "tool", name: "bash", input }))).toBe(
				[
					p("bold", "bash"),
					" ",
					p("dim", "{"),
					p("blue", '"a"'),
					p("dim", ":"),
					p("green", '"s"'),
					p("dim", ","),
					p("blue", '"n"'),
					p("dim", ":"),
					p("yellow", "-150"),
					p("dim", ","),
					p("blue", '"t"'),
					p("dim", ":"),
					p("cyan", "true"),
					p("dim", ","),
					p("blue", '"z"'),
					p("dim", ":"),
					p("cyan", "null"),
					p("dim", "}"),
				].join(""),
			);
			expect(detailOf(progress({ kind: "text", text: '{"a":' }))).toBe(
				grey('{"a":'),
			);
			expect(detailOf(progress({ kind: "text", text: "42" }))).toBe(grey("42"));
		});
	});
});

describe("agentText", () => {
	const ACTOR = "pi · claude-haiku-5.5 · medium";

	test.each([
		[ACTOR, { tokens_in: 12_000, tokens_out: 3_500 }, `${ACTOR}  15.5k tok`],
		[ACTOR, { tokens_in: 1_200_000, cost: 5 }, `${ACTOR}  1.2M tok`],
		[ACTOR, { tokens_in: 999_990 }, `${ACTOR}  1.0M tok`],
		[ACTOR, {}, ACTOR],
		[
			ACTOR,
			{
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 25,
				tokens_reasoning: 40,
			},
			`${ACTOR}  175 tok`,
		],
		[undefined, { tokens_in: 5 }, ""],
	])("shows %j with %j as %j", (actor, metrics, text) => {
		expect(agentText(actor, metrics)).toBe(text);
	});
});

describe("closingBlock", () => {
	const p = (style: Parameters<typeof styleText>[0], text: string) =>
		styleText(style, text, { validateStream: false });
	const settled = (
		status: View["concert"]["status"],
		view: Partial<View> = {},
	) => ({
		...VIEW,
		concert: { ...VIEW.concert, status, settledAt: START + 8_200 },
		columns: 0,
		...view,
	});
	const REASON =
		"check 'test' line 1 exited 1, and the spec says nothing of it";

	test.each([
		["ok", 27_800, {}, ["concert    kswoykny  ok  8.2s · 27.8k tokens"]],
		[
			"rejected",
			0,
			{ at: "repair/recheck", reason: "not today" },
			[
				"concert    kswoykny  rejected  8.2s",
				"at         repair/recheck",
				"reason     not today",
			],
		],
		[
			"failed",
			0,
			{ at: "repair", reason: "flaky\nnow\u001b[2J" },
			[
				"concert    kswoykny  failed  8.2s",
				"at         repair",
				"reason     flaky now\\u001b[2J",
			],
		],
	] as const)(
		"leads a %s concert's block with its row, then where and why, all escaped, the tokens only when counted",
		(status, tokens, ending, head) => {
			const block = closingBlock(settled(status, { tokens }), {
				...ending,
				outputs: [],
			});
			expect(block).toEqual({ head: head.join("\n") });
		},
	);

	test("lines its outputs up under the label column, widened for a longer port, and ends with the row alone without an ending", () => {
		const outputs = [
			["changeset", "/data/changeset"],
			["text", "done"],
		] as const;
		expect(closingBlock(settled("ok"), { outputs }).outputs).toBe(
			"changeset  /data/changeset\ntext       done",
		);
		const wide = closingBlock(settled("ok"), {
			outputs: [...outputs, ["description", '{"a":1}']],
		});
		expect(wide.outputs?.split("\n")).toEqual([
			"changeset    /data/changeset",
			"text         done",
			'description  {"a":1}',
		]);
		expect(wide.head).toStartWith("concert      kswoykny");
		expect(closingBlock(settled("failed"))).toEqual({
			head: "concert    kswoykny  failed  8.2s",
		});
	});

	test("colors the outcome as the events do, dims the labels and the time, a reason yellow and a path soft grey", () => {
		const view = settled("failed", { color: true });
		const { head, outputs } = closingBlock(view, {
			reason: "flaky",
			outputs: [["logs", "/data/check.log"]],
		});
		const [row, reason] = head.split("\n");
		expect(row).toBe(
			`${p("dim", "concert    ")}${p("bold", "ksw")}${p("dim", "oykny")}  ${p(["red", "bold"], "failed")}${p("dim", "  8.2s")}`,
		);
		expect(reason).toBe(`${p("dim", "reason     ")}${p("yellow", "flaky")}`);
		expect(outputs).toBe(
			`${p("dim", "logs       ")}${ESC}[38;5;250m/data/check.log${ESC}[39m`,
		);
		expect(closingBlock(settled("ok", { color: true })).head).toContain(
			p(["green", "bold"], "ok"),
		);
	});

	test("shows a value piped as it is, wide and joined characters and trailing spaces kept, and wraps one whole", () => {
		const family = "family 👨‍👩‍👧 done  ";
		const piped = closingBlock(settled("failed"), {
			reason: family,
			outputs: [["text", family]],
		});
		expect(piped.head).toEndWith(`reason     ${family}`);
		expect(piped.outputs).toBe(`text       ${family}`);
		const long = `${family}and words enough to wrap it`;
		const rows = closingBlock(settled("failed", { columns: 31 }), {
			reason: long,
			outputs: [],
		})
			.head.split("\n")
			.slice(1);
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows)
			expect(Bun.stringWidth(row)).toBeLessThanOrEqual(31);
		expect(rows.map((row) => row.slice(11)).join(" ")).toBe(long);
	});

	test("colors the head and the outputs each as its own stream allows", () => {
		const { head, outputs } = closingBlock(
			settled("ok", { color: true }),
			{ outputs: [["text", "done"]] },
			false,
		);
		expect(head).toContain(ESC);
		expect(outputs).toBe("text       done");
		expect(
			closingBlock(settled("ok"), { outputs: [["text", "done"]] }, true)
				.outputs,
		).toContain(ESC);
	});

	test("wraps a reason under the value column at the view's width, and keeps it on one line at width 0", () => {
		const outputs = [
			["logs", "/a/very/long/path/to/the/check/log/of/this/concert"],
		] as const;
		const narrow = closingBlock(settled("failed", { columns: 40 }), {
			reason: REASON,
			outputs,
		});
		const [, first, ...more] = narrow.head.split("\n");
		expect(first).toBe("reason     check 'test' line 1 exited 1,");
		expect(more.length).toBeGreaterThan(0);
		for (const row of more) expect(row).toMatch(/^ {11}\S/);
		expect(narrow.outputs).toBe(`logs       ${outputs[0][1]}`);
		expect(
			closingBlock(settled("failed"), { reason: REASON, outputs }).head,
		).toEndWith(`reason     ${REASON}`);
	});
});

describe("short ids", () => {
	test("spell a UUID's last 15 hex digits in reverse-hex letters", () => {
		expect(shortId(CONCERT)).toBe("kswoyknyquusyot");
		expect(shortId("01a154df-0000-7000-8000-0123456789ab")).toBe(
			"zzzzyxwvutsrqpo",
		);
	});

	test("are told apart by the shortest prefix no other concert's short id starts with", () => {
		const ids = [
			"01a154df-0000-7000-8000-0000000000ab",
			"01a154df-0000-7000-8000-0000000000ac",
			"01a154df-0000-7000-8000-1000000000ab",
		];
		const [aa = "", ab = "", other = ""] = ids;
		const short = shortIds(ids);
		expect([aa, ab, other].map(short.unique)).toEqual([15, 15, 4]);
		expect(shortIds([ab]).unique(ab)).toBe(1);
		expect(short.label(other, false)).toBe("zzzyzzzz");
		expect(short.label(aa, false)).toBe("zzzzzzzzzzzzzpo");
		expect(short.label(other, true)).toBe(
			`${SGR.bold}zzzy${SGR.plain}${SGR.dim}zzzz${SGR.plain}`,
		);
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
