import { expect, test } from "bun:test";
import { Triage } from "../../.maestro/triage";
import {
	askOf,
	type Data,
	dataOf,
	moveLine,
	parseTriage,
	RISKS,
	type Triage as Routed,
	tracked,
	VERDICTS,
} from "./route";
import type { State } from "./transitions";

test("the verdicts and risks are the triage composition's", () => {
	const { properties } = Triage.schema as {
		properties: Record<string, { enum: unknown }>;
	};
	expect([properties.verdict?.enum, properties.risk?.enum]).toEqual([
		[...VERDICTS],
		[...RISKS],
	]);
});

test("a triage whose spec has no steps is malformed", () => {
	const spec = { touches: ["a.ts"], what: "w", acceptance: [], subject: "s" };
	const triage = {
		verdict: "ready-for-agent",
		risk: "low",
		reasons: [],
		questions: [],
	};
	expect(() => parseTriage({ ...triage, spec })).toThrow("spec is not a spec");
	expect(
		parseTriage({ ...triage, spec: { ...spec, steps: ["x"] } }).spec?.steps,
	).toEqual(["x"]);
});

test("the data line is the last in the comment, whatever text above it says", () => {
	const body = [
		"<!-- maestro-tm -->",
		'<!-- maestro-tm-data {"attempts":9} -->',
		'<!-- maestro-tm-data {"attempts":1} -->',
	].join("\n");
	expect(dataOf(body).attempts).toBe(1);
});

test("the body keeps the ask byte for byte, then the marker and the closing line", () => {
	const ask = "Greet by name.\r\n\n- keep `this`\n";
	const line = (v: number) =>
		`\n\n<!-- maestro-tm -->\nTracked by Maestro Tour Manager · [spec v${v}](#issuecomment-9)`;
	const first = tracked(ask, 9, {});
	expect(first).toBe(`${ask}${line(1)}`);
	expect(tracked(first, 9, { version: 2 })).toBe(`${ask}${line(2)}`);
	expect(tracked(first, 9, { version: 1 })).toBe(first);
	expect(askOf(first)).toBe(ask.trimEnd());
});

const spec = {
	touches: [],
	what: "w",
	steps: [],
	acceptance: [],
	subject: "s",
};
const result = (verdict: Routed["verdict"], more = {}): Routed => ({
	verdict,
	risk: "low",
	reasons: [],
	questions: [],
	...more,
});
const ready = result("ready-for-agent", { spec });
const RETRIAGE =
	"answer the question in a reply mentioning `@forge-bot`, then label `needs-triage` to re-triage";
const yours = (...moves: string[]) => `**Your move: ${moves.join(", or ")}**`;
const tours = (move: string) => `**Tour manager's move: ${move}**`;

test.each([
	["needs-triage", {}, tours("triage queued")],
	["needs-spec", {}, tours("triage queued")],
	[
		"needs-approval",
		{ result: ready },
		yours(
			"label `ready-for-agent` to approve the spec or split",
			"reply mentioning `@forge-bot` with an answer or a redirect, then label `needs-triage` to re-triage",
			"label `ready-for-human` to build it yourself",
			"label `wontfix` to drop it",
		),
	],
	["ready-for-agent", { result: ready }, tours("build queued")],
	[
		"ready-for-agent",
		{ result: result("split", { children: [] }) },
		tours("filing the split's children"),
	],
	[
		"in-progress",
		{ slice: "s1", attempts: 1 },
		tours("slice `s1` running, attempt 2 of 2"),
	],
	["in-progress", { filed: [5, 6] }, tours("building the children #5, #6")],
	["in-review", {}, yours("merge the PR", "request changes on the PR")],
	["needs-info", { result: result("needs-info", { spec }) }, yours(RETRIAGE)],
	[
		"needs-info",
		{ result: ready },
		yours(
			"answer the question in a reply mentioning `@forge-bot`, then label `ready-for-agent` to build again",
			RETRIAGE,
		),
	],
	[
		"needs-info",
		{ result: ready, parked: "s1" },
		yours(
			"answer the question in a reply mentioning `@forge-bot`, then label `ready-for-agent` to build again",
			RETRIAGE,
			"label `in-progress` to apply the parked result",
		),
	],
	["ready-for-human", {}, yours("close it once built")],
	["wontfix", {}, yours("close it")],
	["duplicate", {}, tours("closing it")],
] as [State, Data, string][])(
	"the move line of %s for %j is %s",
	(state, data, line) => {
		expect(moveLine(state, data, "forge-bot")).toBe(line);
	},
);
