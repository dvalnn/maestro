import type { ConcertEvent, EventBody, Ir, IrNode, Outcome } from "@maestro/ir";
import { lastSegment } from "../layout";

const STDLIB = "maestro:stdlib";
const MS_PER_S = 1_000;
export const START = 1_792_285_440_000;

const worker = (module: string, name: string) => ({
	runtime: "ts",
	module,
	export: name,
	codeHash: "",
});
const code = (id: string): IrNode => ({
	id,
	kind: "code",
	worker: worker("audit.ts", lastSegment(id)),
});
const helper = (id: string): IrNode => ({
	id,
	kind: "code",
	worker: worker(STDLIB, "not"),
});
const agent = (id: string): IrNode => ({ id, kind: "fake.agent" });
const loop = (id: string, upTo: number): IrNode => ({
	id,
	kind: "loop",
	inner: {},
	members: { result: `${id}/repair` },
	cardinality: { upTo },
	test: { at: "start", port: { node: `${id}/again`, port: "value" } },
});

/** An audit composition with two repair loops, a panel scope holding a fan-out of lenses, and stdlib helpers. */
export const PANEL_IR: Ir = {
	irVersion: "1.0",
	composition: { id: "audit", version: "1", pack: "fixtures" },
	emitter: { name: "test", version: "0" },
	scopes: [{ id: "panel", composition: "verification-panel", ports: {} }],
	nodes: [
		code("request"),
		agent("draft"),
		loop("gate-loop", 2),
		helper("gate-loop/again"),
		agent("gate-loop/repair"),
		code("test"),
		loop("test-loop", 3),
		helper("test-loop/again"),
		agent("test-loop/repair"),
		code("test-loop/test"),
		{
			id: "panel/lenses",
			kind: "parMap",
			inner: {},
			members: { result: "panel/lenses/skeptic" },
			cardinality: { exact: 3 },
			onError: "continue",
		},
		agent("panel/lenses/lens"),
		helper("panel/lenses/lens_json"),
		agent("panel/lenses/skeptic"),
		agent("panel/consolidator"),
		code("ruling"),
	],
	edges: [],
	result: { node: "ruling" },
};

type Step = [s: number, node: string, expansion: string, body: EventBody];

/** `node`'s instance running from `from` seconds, settled `outcome` at `to`. */
const ran = (
	from: number,
	to: number,
	node: string,
	expansion = "",
	outcome: Outcome = "ok",
	reason?: string,
): Step[] => [
	[from, node, expansion, { type: "running" }],
	[to, node, expansion, { type: "settled", outcome, reason }],
];

const LENS_FAILURE = "harness exited 137: killed, out of memory";

const STEPS: Step[] = [
	...ran(0, 1, "request"),
	...ran(1, 60, "draft"),
	[60, "gate-loop", "", { type: "running" }],
	...ran(60, 60, "gate-loop/again", "[0]"),
	[61, "gate-loop", "", { type: "settled", outcome: "ok" }],
	...ran(61, 70, "test", "", "rejected", "3 of 41 tests fail"),
	[70, "test-loop", "", { type: "running" }],
	...ran(70, 70, "test-loop/again", "[0]"),
	...ran(70, 100, "test-loop/repair", "[0]"),
	...ran(100, 110, "test-loop/test", "[0]", "rejected", "1 of 41 tests fail"),
	...ran(110, 110, "test-loop/again", "[1]"),
	...ran(110, 150, "test-loop/repair", "[1]"),
	[
		120,
		"test-loop/repair",
		"[1]",
		{ type: "progress", event: { kind: "tool" } },
	],
	...ran(150, 160, "test-loop/test", "[1]"),
	...ran(160, 160, "test-loop/again", "[2]"),
	[160, "test-loop", "", { type: "settled", outcome: "ok" }],
	[160, "panel/lenses", "", { type: "running" }],
	...ran(160, 200, "panel/lenses/lens", "[correctness]"),
	...ran(200, 200, "panel/lenses/lens_json", "[correctness]"),
	...ran(200, 220, "panel/lenses/skeptic", "[correctness]"),
	...ran(161, 190, "panel/lenses/lens", "[spec]", "failed", LENS_FAILURE),
	[
		190,
		"panel/lenses/lens_json",
		"[spec]",
		{ type: "settled", outcome: "skipped" },
	],
	[
		190,
		"panel/lenses/skeptic",
		"[spec]",
		{ type: "settled", outcome: "skipped" },
	],
	...ran(162, 210, "panel/lenses/lens", "[tests]"),
	...ran(210, 210, "panel/lenses/lens_json", "[tests]"),
	...ran(
		210,
		230,
		"panel/lenses/skeptic",
		"[tests]",
		"rejected",
		"weak evidence",
	),
	[230, "panel/lenses", "", { type: "settled", outcome: "ok" }],
	...ran(230, 260, "panel/consolidator"),
	...ran(260, 261, "ruling"),
];

/** The concert's events up to `until` seconds after its start, in time order, each with its seq. */
export const panelEvents = (until = Number.POSITIVE_INFINITY): ConcertEvent[] =>
	STEPS.map((step, i) => ({ step, i }))
		.filter(({ step: [s] }) => s <= until)
		.sort((a, b) => a.step[0] - b.step[0] || a.i - b.i)
		.map(({ step: [s, node, expansion, body] }, i) => ({
			seq: i + 1,
			at: START + s * MS_PER_S,
			node,
			expansion,
			...body,
		}));

/** Seconds after the start: in the second round's repair, and once the concert settled. */
export const MID_S = 120;
export const END_S = 261;
