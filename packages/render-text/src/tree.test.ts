import { describe, expect, test } from "bun:test";
import {
	type ConcertEvent,
	type EventBody,
	type Ir,
	indexGraph,
} from "@maestro/ir";
import { END_S, MID_S, PANEL_IR, panelEvents, START } from "./fixtures/panel";
import { shapeOf } from "./layout";
import { markerOf, seen } from "./live";
import { contextOf, focusOf, GLYPH, lastFailureOf, rowsOf } from "./tree";

const golden = async (name: string): Promise<Ir> =>
	structuredClone((await import(`@maestro/ir/plans/${name}`)).default.ir);

const RUNNING = { type: "running" } as const;
const OK = { type: "settled", outcome: "ok" } as const;
const settled = (outcome: "rejected" | "failed", reason: string) =>
	({ type: "settled", outcome, reason }) as const;

/** Events with their seq in list order, each at `ms` after the start. */
const eventsOf = (
	list: readonly [node: string, expansion: string, ms: number, EventBody][],
): ConcertEvent[] =>
	list.map(([node, expansion, ms, body], i) => ({
		seq: i + 1,
		at: START + ms,
		node,
		expansion,
		...body,
	}));

/** Each row as `<indent><marker><glyph> <name>  <state>  <note>`. */
const drawn = (
	ir: Ir,
	events: readonly ConcertEvent[],
	{ done = false } = {},
) => {
	const graph = indexGraph(ir);
	return rowsOf(shapeOf(ir, graph), {
		graph,
		seen: seen(new Map(), events),
		agents: new Map(),
		settled: done,
		now: START + END_S * 1_000,
	}).map((r) =>
		`${"  ".repeat(r.depth)}${markerOf(r)}${GLYPH[r.shown]} ${r.name}  ${r.shown}  ${r.note}`.trimEnd(),
	);
};

const FANOUT = eventsOf([
	["topics", "", 0, RUNNING],
	["topics/draft", "[a]", 0, RUNNING],
	["topics/draft", "[b]", 0, RUNNING],
	["topics/draft", "[c]", 0, RUNNING],
	["topics/draft", "[a]", 1_000, OK],
	["topics/draft", "[b]", 1_000, OK],
	["topics/draft", "[c]", 2_000, settled("failed", "flaky")],
	["topics", "", 2_000, OK],
	["best", "", 2_100, { type: "reused" }],
	["refine/loop", "", 3_000, RUNNING],
	["refine/loop/step", "[0]", 3_000, RUNNING],
	["refine/loop/step", "[0]", 4_000, OK],
	["refine/loop/done", "[0]", 4_000, RUNNING],
	["refine/loop/done", "[0]", 4_100, OK],
	["refine/loop/more", "[0]", 4_100, RUNNING],
	["refine/loop/more", "[0]", 4_200, OK],
	["refine/loop/step", "[1]", 4_200, RUNNING],
]);

const NESTED = eventsOf([
	["angles", "", 0, RUNNING],
	["angles/draft", "[wide]", 0, RUNNING],
	["angles/draft", "[deep]", 0, RUNNING],
	["angles/draft", "[wide]", 1_000, OK],
	["angles/draft", "[deep]", 2_000, OK],
	["angles/polish", "[wide]", 1_000, RUNNING],
	["angles/polish/step", "[wide][0]", 1_000, RUNNING],
	["angles/polish/step", "[wide][0]", 2_000, settled("rejected", "rough")],
	["angles/polish/step", "[wide][1]", 2_000, RUNNING],
	["angles/polish", "[deep]", 2_000, RUNNING],
	["angles/polish/step", "[deep][0]", 2_000, RUNNING],
	["angles/polish/step", "[deep][0]", 3_000, OK],
	["angles/polish", "[deep]", 3_000, OK],
	["angles/critique", "[deep]", 3_000, RUNNING],
]);

describe("rowsOf", () => {
	test("draws each golden node once: a loop at its round with its round strip, a parMap body node aggregated with its item strip", async () => {
		expect(drawn(await golden("fanout-fanin-loop"), FANOUT)).toEqual([
			"▸ ✓ topics  ok  3/3 items · 2 ok · 1 failed",
			"▾ ● refine  running  refine-until-done · 1 running · 2 ok",
			"  ▾ ● loop  running  ⟲ 2/2   1✓ 2●",
			"      ● step  running",
			"      ○ done  pending",
		]);
		expect(drawn(await golden("nested-groups"), NESTED)).toEqual([
			"▾ ● angles  running  2/2 items · 2 running",
			"  ▸ ✓ draft ×2  ok  wide ✓  deep ✓",
			"  ▾ ● polish  running  ⟲ 2/3   1✗ 2●",
			"    ▸ ● step ×1  running  wide ●",
			"  ▸ ● critique ×1  running  deep ●",
			"  ○ tally  pending",
			"  ○ enough  pending",
		]);
	});

	test("draws the panel fixture as authored, the loop in its second round, then settled with the failure's path open", () => {
		expect(drawn(PANEL_IR, panelEvents(MID_S))).toEqual([
			"  ✓ request  ok",
			"  ✓ draft  ok",
			"▸ ✓ gate-loop  ok  ⟲ 0/2",
			"  ✗ test  rejected  3 of 41 tests fail",
			"▾ ● test-loop  running  ⟲ 2/3   1✗ 2●",
			"    ● repair  running  tool",
			"    ○ test  pending",
			"▸ ○ panel  pending  verification-panel",
			"  ○ ruling  pending",
		]);
		expect(drawn(PANEL_IR, panelEvents(), { done: true })).toEqual([
			"  ✓ request  ok",
			"  ✓ draft  ok",
			"▸ ✓ gate-loop  ok  ⟲ 0/2",
			"  ✗ test  rejected  3 of 41 tests fail",
			"▸ ✓ test-loop  ok  ⟲ 2/3   1✗ 2✓",
			"▾ ✓ panel  ok  verification-panel · 4 ok · 1 rejected · 1 failed · 1 skipped",
			"  ▾ ✓ lenses  ok  3/3 items · 1 ok · 1 rejected · 1 failed",
			"    ▾ ! lens ×3  failed  correctness ✓  spec !  tests ✓",
			"        ✓ [correctness]  ok",
			"        ! [spec]  failed  harness exited 137: killed, out of memory",
			"        ✓ [tests]  ok",
			"    ▸ ✗ skeptic ×3  rejected  spec -  correctness ✓  tests ✗",
			"    ✓ consolidator  ok",
			"  ✓ ruling  ok",
		]);
	});

	test("contextOf gives each enclosing group's latest iteration, a pinned one in its place, and ANY for a parallel group", () => {
		const graph = indexGraph(PANEL_IR);
		const state = seen(new Map(), panelEvents(MID_S));
		expect(contextOf(graph, state, "test-loop/repair")).toEqual(["1"]);
		expect(
			contextOf(
				graph,
				state,
				"test-loop/repair",
				new Map([["test-loop@", "0"]]),
			),
		).toEqual(["0"]);
		expect(contextOf(graph, state, "panel/lenses/lens")).toEqual(["*"]);
	});

	test("counts an upTo fan-out's items against its bound as n/≤N", () => {
		const ir = structuredClone(PANEL_IR);
		const lenses = ir.nodes.find((n) => n.id === "panel/lenses");
		if (lenses && "cardinality" in lenses) lenses.cardinality = { upTo: 8 };
		expect(drawn(ir, panelEvents(), { done: true })[6]).toBe(
			"  ▾ ✓ lenses  ok  3/≤8 items · 1 ok · 1 rejected · 1 failed",
		);
	});

	test("leaves a stdlib helper out while it is pending or ok, and draws it once it fails", () => {
		const failing = panelEvents(MID_S).map((e) =>
			e.node === "test-loop/again" &&
			e.expansion === "[1]" &&
			e.type === "settled"
				? { ...e, ...settled("failed", "no state") }
				: e,
		);
		expect(drawn(PANEL_IR, panelEvents(MID_S)).join("\n")).not.toContain(
			"again",
		);
		expect(drawn(PANEL_IR, failing)).toContain("    ! again  failed  no state");
	});

	test("keeps the last failed instance as the last failure when a rejected one settles after it", () => {
		const graph = indexGraph(PANEL_IR);
		const last = lastFailureOf(graph, seen(new Map(), panelEvents()));
		expect(last).toMatchObject({
			node: "panel/lenses/lens",
			expansion: "[spec]",
		});
		expect(
			lastFailureOf(graph, seen(new Map(), panelEvents(MID_S))),
		).toBeUndefined();
	});

	test("gives a scope the worst outcome of its rows, each group by its own instance, so a member its group tolerated does not worsen it", () => {
		expect(drawn(PANEL_IR, panelEvents(), { done: true })[5]).toStartWith(
			"▾ ✓ panel  ok",
		);
		const rejected = panelEvents().map((e) =>
			e.node === "panel/consolidator" && e.type === "settled"
				? { ...e, ...settled("rejected", "thin") }
				: e,
		);
		expect(drawn(PANEL_IR, rejected, { done: true })[5]).toStartWith(
			"▾ ✗ panel  rejected",
		);
	});
});

describe("focusOf", () => {
	test("gives the row showing an instance, the container rows above it, and the round each loop on the way must show", () => {
		const graph = indexGraph(PANEL_IR);
		expect(
			focusOf(graph, { node: "test-loop/repair", expansion: "[1]" }),
		).toEqual({
			key: "test-loop/repair@1",
			path: ["test-loop@"],
			pins: [["test-loop@", "1"]],
		});
		expect(
			focusOf(graph, { node: "panel/lenses/lens", expansion: "[spec]" }),
		).toEqual({
			key: "panel/lenses/lens#[spec]",
			path: ["panel@", "panel/lenses@", "panel/lenses/lens@*"],
			pins: [],
		});
		expect(focusOf(graph, { node: "ruling", expansion: "" })).toEqual({
			key: "ruling@",
			path: [],
			pins: [],
		});
	});

	test("marks the rows showing running instances and the last failure, and every row above them, as pinned", () => {
		const graph = indexGraph(PANEL_IR);
		const pinned = (events: readonly ConcertEvent[], done: boolean) =>
			rowsOf(shapeOf(PANEL_IR, graph), {
				graph,
				seen: seen(new Map(), events),
				agents: new Map(),
				settled: done,
				now: START,
			})
				.filter((r) => r.pinned)
				.map((r) => r.key);
		expect(pinned(panelEvents(MID_S), false)).toEqual([
			"test-loop@",
			"test-loop/repair@1",
		]);
		expect(pinned(panelEvents(), true)).toEqual([
			"panel@",
			"panel/lenses@",
			"panel/lenses/lens@*",
			"panel/lenses/lens#[spec]",
		]);
	});
});
