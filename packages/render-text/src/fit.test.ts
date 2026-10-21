import { describe, expect, test } from "bun:test";
import { indexGraph } from "@maestro/ir";
import { type Fitted, fitted } from "./fit";
import { END_S, MID_S, PANEL_IR, panelEvents, START } from "./fixtures/panel";
import { shapeOf } from "./layout";
import { seen } from "./live";
import { type Row, rowsOf, type Shown } from "./tree";

const row = (name: string, shown: Shown, depth = 0, pinned = false): Row => ({
	key: name,
	depth,
	shown,
	name,
	kind: "code",
	tokens: 0,
	note: "",
	pinned,
});

/** Each line as its row's name, or `… ` and the hidden rows' states. */
const names = (lines: readonly Fitted[]) =>
	lines.map((l) =>
		l.type === "row"
			? l.row.name
			: `${" ".repeat(l.depth)}… ${l.states.join(",")}`,
	);

const panelRows = (s: number) => {
	const graph = indexGraph(PANEL_IR);
	return rowsOf(shapeOf(PANEL_IR, graph), {
		graph,
		seen: seen(new Map(), panelEvents(s)),
		agents: new Map(),
		settled: s >= END_S,
		now: START + s * 1_000,
	});
};

describe("fitted", () => {
	test.each([
		["in a loop's second round", MID_S],
		["settled on a failure", END_S],
	])(
		"at every budget fits the panel %s, keeping every pinned row while they fit",
		(_, at) => {
			const rows = panelRows(at);
			const pinned = rows.filter((r) => r.pinned);
			expect(pinned.length).toBeGreaterThan(1);
			for (let budget = 1; budget <= rows.length; budget++) {
				const lines = fitted(rows, budget);
				const kept = lines.flatMap((l) => (l.type === "row" ? [l.row] : []));
				const room = budget >= pinned.length;
				expect(lines.length).toBeLessThanOrEqual(budget);
				expect(pinned.filter((p) => room && !kept.includes(p))).toEqual([]);
			}
			expect(fitted(rows, rows.length)).toEqual(
				rows.map((r) => ({ type: "row", row: r })),
			);
		},
	);

	test("hides settled rows from the top, then pending rows from the bottom, each stretch as one line of its states at its least depth", () => {
		const rows = [
			row("a", "ok"),
			row("b", "skipped", 1),
			row("c", "rejected"),
			row("loop", "running", 0, true),
			row("d", "pending", 1),
			row("e", "pending"),
			row("f", "pending"),
		];
		expect(names(fitted(rows, 6))).toEqual([
			"… ok,skipped",
			"c",
			"loop",
			"d",
			"e",
			"f",
		]);
		expect(names(fitted(rows, 4))).toEqual([
			"… ok,skipped,rejected",
			"loop",
			"d",
			"… pending,pending",
		]);
	});

	test("shows a stretch of one hidden row as that row, which takes the same line", () => {
		const rows = [
			row("a", "ok"),
			row("work", "running", 0, true),
			row("b", "ok"),
			row("c", "pending"),
			row("d", "pending"),
		];
		expect(names(fitted(rows, 4))).toEqual([
			"a",
			"work",
			"b",
			"… pending,pending",
		]);
	});

	test("keeps every pinned row while they fit, counting the rest on a line left, else the deepest and one line for the rest", () => {
		const rows = [
			row("a", "ok"),
			row("x", "running", 0, true),
			row("b", "ok"),
			row("y", "running", 1, true),
			row("c", "ok"),
			row("z", "failed", 2, true),
		];
		expect(names(fitted(rows, 4))).toEqual(["x", "y", "z", "… ok,ok,ok"]);
		expect(names(fitted(rows, 3))).toEqual(["x", "y", "z"]);
		expect(names(fitted(rows, 2))).toEqual(["z", "… ok,running,ok,running,ok"]);
		const all = ["… ok,running,ok,running,ok,failed"];
		expect(names(fitted(rows, 1))).toEqual(all);
		expect(names(fitted(rows, 0))).toEqual(all);
		expect(fitted([], 0)).toEqual([]);
	});
});
