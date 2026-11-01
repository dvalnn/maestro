import { describe, expect, test } from "bun:test";
import { type ConcertEvent, indexGraph } from "@maestro/ir";
import { END_S, MID_S, PANEL_IR, panelEvents, START } from "./fixtures/panel";
import {
	type Held,
	inspectorLines,
	type Kept,
	navigated,
	selected,
} from "./inspect";
import { eventLine, painted, seen, type View } from "./live";
import { NAV } from "./press";

const MS_PER_S = 1_000;
const GRAPH = indexGraph(PANEL_IR);

const viewOf = (settled: boolean, at = MID_S): View => ({
	concert: {
		id: "01a154df-b99f-72ca-8f73-b1fc195571b6",
		label: "fixtures.audit",
		status: settled ? "ok" : "running",
		unique: 3,
		startedAt: START,
		...(settled && { settledAt: START + END_S * MS_PER_S }),
	},
	tokens: 0,
	now: START + at * MS_PER_S,
	color: false,
	columns: 120,
	rows: 40,
});

const REPAIR: Kept = {
	node: "test-loop/repair",
	expansion: "[1]",
	stale: false,
	actor: "pi · haiku",
	metrics: { tokens_in: 1_200, tokens_out: 30 },
	artifacts: [{ path: "out/report.md", contentHash: "sha256:9f2c" }],
};

/**
 * The inspector on the row keyed `key` as plain text, of the panel concert's events `only` keeps: settled, or `at`
 * seconds in, its second repair round by default.
 */
function inspected(
	key: string,
	{
		settled = false,
		instances = [] as Kept[],
		at = MID_S,
		columns = 120,
		only = (_: ConcertEvent): boolean => true,
	} = {},
) {
	const events = panelEvents(settled ? undefined : at).filter(only);
	const view = { ...viewOf(settled, at), columns };
	const {
		head,
		events: lines,
		count,
	} = inspectorLines(PANEL_IR, seen(new Map(), events), view, key, {
		events,
		instances,
	});
	return {
		head: head.map((segs) => painted(segs, false, view.columns - 1)),
		lines,
		count,
	};
}

const instancesOf = (events: readonly ConcertEvent[]) => [
	...new Set(events.map((e) => `${e.node}${e.expansion}`)),
];

describe("selected", () => {
	const events = panelEvents();
	test.each<[what: string, key: string, instances: string[]]>([
		[
			"an item row, its one instance",
			"panel/lenses/lens#[spec]",
			["panel/lenses/lens[spec]"],
		],
		[
			"an aggregated row, each of its items",
			"panel/lenses/lens@*",
			[
				"panel/lenses/lens[correctness]",
				"panel/lenses/lens[spec]",
				"panel/lenses/lens[tests]",
			],
		],
		[
			"a member of a loop round, that round's instance",
			"test-loop/test@0",
			["test-loop/test[0]"],
		],
		[
			"a scope, every instance under it",
			"panel@",
			[
				"panel/lenses",
				"panel/lenses/lens[correctness]",
				"panel/lenses/lens[spec]",
				"panel/lenses/lens[tests]",
				"panel/lenses/lens_json[correctness]",
				"panel/lenses/skeptic[correctness]",
				"panel/lenses/lens_json[spec]",
				"panel/lenses/skeptic[spec]",
				"panel/lenses/lens_json[tests]",
				"panel/lenses/skeptic[tests]",
				"panel/consolidator",
			],
		],
	])("%s", (_what, key, instances) => {
		const picked = selected(GRAPH, key, events);
		expect(instancesOf(picked).toSorted()).toEqual(instances.toSorted());
		expect(picked.map((e) => e.seq)).toEqual(
			picked.map((e) => e.seq).toSorted((a, b) => a - b),
		);
	});

	test("a loop's row, its own instance and every round's", () => {
		const picked = instancesOf(selected(GRAPH, "test-loop@", events));
		expect(picked).toContain("test-loop");
		expect(picked).toContain("test-loop/test[0]");
		expect(picked).toContain("test-loop/test[1]");
		expect(picked).not.toContain("test");
	});
});

describe("inspectorLines", () => {
	test.each<
		[
			what: string,
			key: string,
			given: Parameters<typeof inspected>[1],
			head: string[],
		]
	>([
		[
			"a running instance: its times, tokens and actor from the record, and its latest progress",
			"test-loop/repair@1",
			{
				instances: [
					{
						...REPAIR,
						artifacts: [],
					},
				],
			},
			[
				"◆ inspect  test-loop[1]/repair  fake.agent  running  10s  pi · haiku  1.2k tok",
				"  context  test-loop ⟲2 › repair",
				"  state    running   started +1m50s   ran 10s   1.2k tok   pi · haiku",
				"  latest   tool",
				"  metrics  tokens_in 1.2k · tokens_out 30",
			],
		],
		[
			"an ok instance",
			"request@",
			{},
			[
				"◆ inspect  request  code  ok  1.0s",
				"  context  request",
				"  state    ok   started +0.0s   ran 1.0s",
			],
		],
		[
			"a failed instance, its reason",
			"panel/lenses/lens#[spec]",
			{ settled: true },
			[
				"◆ inspect  panel/lenses[spec]/lens  fake.agent  failed  29s",
				"  context  panel › lenses[spec] › lens",
				"  state    failed   started +2m41s   ran 29s",
				"  reason   harness exited 137: killed, out of memory",
			],
		],
		[
			"a stale instance, marked",
			"request@",
			{
				instances: [
					{
						node: "request",
						expansion: "",
						stale: true,
						metrics: {},
						artifacts: [],
					},
				],
			},
			[
				"◆ inspect  request  code  ok  1.0s",
				"  context  request",
				"  state    ok   stale   started +0.0s   ran 1.0s",
			],
		],
		[
			"a group: its instances counted, their tokens and span",
			"test-loop@",
			{ instances: [REPAIR] },
			[
				"◆ inspect  test-loop  loop  2 running · 3 ok · 1 rejected",
				"  context  6 instances",
				"  states   2 running · 3 ok · 1 rejected   1.2k tok",
				"  span     started +1m10s   ran 50s",
			],
		],
		[
			"a scope whose one instance is a member: counted under the scope, not summarised as the member",
			"panel@",
			{ at: 170, only: (e) => !e.node.startsWith("panel/lenses/") },
			[
				"◆ inspect  panel  scope  1 running",
				"  context  1 instance",
				"  states   1 running",
				"  span     started +2m40s   ran 10s",
			],
		],
		[
			"a row with no instance yet",
			"ruling@",
			{},
			["◆ inspect  ruling  code", "  context  no instance yet"],
		],
	])("%s", (_what, key, given, head) => {
		expect(inspected(key, given).head).toEqual(head);
	});

	test("hints at maestro art with the short concert id and instance when the instance has artifacts, none without", () => {
		const lines = (kept: Kept) =>
			inspected("test-loop/repair@1", { instances: [kept] }).head;
		expect(lines(REPAIR).at(-1)).toBe(
			"  files    maestro art kswoykny 'test-loop[1]/repair'",
		);
		expect(
			lines({ ...REPAIR, artifacts: [] }).some((l) =>
				l.includes("maestro art"),
			),
		).toBe(false);
	});

	test("cuts each event line at one cell short of the terminal, and counts an event drawn on several lines once", () => {
		const columns = 40;
		const { lines, count } = inspected("panel/lenses/lens#[spec]", {
			settled: true,
			columns,
		});
		expect(count).toBe(2);
		expect(lines.length).toBeGreaterThan(count);
		expect(lines.map((l) => Bun.stringWidth(l))).toContain(columns - 1);
		expect(lines.every((l) => Bun.stringWidth(l) < columns)).toBe(true);
	});

	test("draws each event as eventLine does, in seq order", () => {
		const events = panelEvents(MID_S);
		const view = { ...viewOf(false), columns: 119 };
		expect(inspected("test-loop@").lines).toEqual(
			selected(GRAPH, "test-loop@", events).map((e) =>
				eventLine(PANEL_IR, e, view),
			),
		);
	});
});

describe("navigated", () => {
	const events = panelEvents(MID_S);
	const held: Held = { events, instances: [] };
	const drawn = (rows: number, tail: boolean) =>
		navigated(
			PANEL_IR,
			seen(new Map(), events),
			{ ...viewOf(false), rows },
			new Map(),
			{ ...NAV, inspect: { key: "test-loop@", scroll: 0, tail } },
			held,
		);

	test("fills the terminal, the newest event line last in view while tailing, and the rule counting the lines in view", () => {
		const rows = 14;
		const f = drawn(rows, true);
		expect(f.lines).toHaveLength(rows);
		expect(f.scrollMax).toBeGreaterThan(0);
		expect(f.nav.inspect?.scroll).toBe(f.scrollMax);
		expect(f.lines.at(-3)).toMatch(/test-loop\[1\]\/repair +tool$/);
		expect(f.lines.at(-2)).toStartWith(
			`── 11 events · lines ${(f.scrollMax ?? 0) + 1}–11 of 11 ─`,
		);
		expect(f.lines.at(-1)).toStartWith("◆ tail ");
		const scrolled = drawn(rows, false);
		expect(scrolled.lines.at(-1)).toStartWith("◆ scrolled ");
		expect(scrolled.lines.at(7)).toMatch(/test-loop +running$/);
	});

	test("caps a summary too tall for the terminal, counting the lines left out, so the events keep their rows", () => {
		const f = navigated(
			PANEL_IR,
			seen(new Map(), events),
			{ ...viewOf(false), rows: 13 },
			new Map(),
			{ ...NAV, inspect: { key: "test-loop/repair@1", scroll: 0, tail: true } },
			{ events, instances: [REPAIR] },
		);
		expect(f.lines.slice(3, 8)).toEqual([
			"◆ inspect  test-loop[1]/repair  fake.agent  running  10s  pi · haiku  1.2k tok",
			"  context  test-loop ⟲2 › repair",
			"  state    running   started +1m50s   ran 10s   1.2k tok   pi · haiku",
			"  latest   tool",
			"  … 2 more lines",
		]);
		expect(f.body).toBe(3);
		expect(f.lines.slice(8, 11)).toEqual([
			expect.stringMatching(/test-loop\[1\]\/repair +running$/),
			expect.stringMatching(/test-loop\[1\]\/repair +tool$/),
			"",
		]);
	});
});
