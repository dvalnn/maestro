import { describe, expect, test } from "bun:test";
import { REPORT } from "./frame";
import { repoText } from "./text";

const PREPARE = { kind: "prepare", line: 1, of: 2, run: "bun install" };

describe("repoText.progress", () => {
	test.each([
		[PREPARE, { word: "prepare", detail: "1/2: bun install" }],
		[
			{ ...PREPARE, of: undefined },
			{ word: "prepare", detail: "1: bun install" },
		],
		[
			{ ...PREPARE, ended: "exited 7", tail: "a\nregistry down\n\n" },
			{ word: "prepare", detail: "1/2: registry down" },
		],
		[
			{ ...PREPARE, ended: "exited 7", tail: "" },
			{ word: "prepare", detail: "1/2: exited 7" },
		],
		[
			{ ...PREPARE, ended: "exited 0" },
			{ word: "prepare", detail: "1/2: exited 0" },
		],
		[{ kind: "prepare", run: "x" }, undefined],
		[
			{ kind: "tool", name: "bash", input: { command: "ls" } },
			{ word: "tool", detail: 'bash {"command":"ls"}' },
		],
		[
			{ kind: "tool", name: "bash" },
			{ word: "tool", detail: "bash" },
		],
		[{ kind: "tool" }, undefined],
		[
			{ kind: "tool_result", id: "t1", bytes: 42, error: false },
			{ word: "result", detail: "42 · ok" },
		],
		[
			{ kind: "tool_result", id: "t1", bytes: 42, error: true },
			{ word: "result", detail: "42 · error" },
		],
		[
			{ kind: "tool_result", id: "t1", bytes: 42 },
			{ word: "result", detail: "42" },
		],
		[{ kind: "tool_result" }, undefined],
		[
			{ kind: "context", used: 19416, window: 200000 },
			{ word: "context", detail: "19.4k" },
		],
		[
			{
				kind: "context",
				used: 44_700,
				metrics: {
					tokens_in: 2,
					tokens_out: 683,
					tokens_cache_read: 44_000,
					tokens_cache_write: 697,
				},
			},
			{ word: "context", detail: "44.7k · in 2 · out 683 · cache 44.7k" },
		],
		[{ kind: "context" }, undefined],
		[
			{
				kind: "usage",
				metrics: {
					tokens_in: 120,
					tokens_out: 40,
					tokens_cache_read: 44_000,
					tokens_cache_write: 697,
					tokens_reasoning: 9,
				},
			},
			{ word: "usage", detail: "in 120 · out 40 · cache 44.7k" },
		],
		[
			{ kind: "usage", metrics: { tokens_in: 1 } },
			{ word: "usage", detail: "in 1 · out 0 · cache 0" },
		],
		[{ kind: "usage" }, undefined],
		[
			{ kind: "environment", tools: ["read", "bash"], skills: [] },
			{ word: "environment", detail: "2 tools" },
		],
		[{ kind: "environment", skills: [] }, undefined],
		[{ kind: "text", text: "hi" }, undefined],
		[{ kind: "constructor" }, undefined],
	])("words %j as %j", (event, wording) => {
		expect(repoText.progress?.(event)).toEqual(wording);
	});
});

describe("repoText.actor", () => {
	const ENRICHED = {
		session: "s",
		harness: "pi",
		model: "github-copilot/claude-haiku-5.5",
		thinking: "medium",
	};

	test.each([
		[ENRICHED, "pi · claude-haiku-5.5 · medium"],
		[{ ...ENRICHED, thinking: undefined, model: "none" }, "pi · none"],
		[{ ...ENRICHED, thinking: "" }, "pi · claude-haiku-5.5"],
		[{ session: "s" }, undefined],
		[{ kind: "prepare", line: 1, of: 2, run: "bun install" }, undefined],
	])("names the agent of %j as %j", (enrichment, text) => {
		expect(repoText.actor?.(enrichment)).toBe(text);
	});
});

describe("repoText.report", () => {
	test.each([
		[{ report: { summary: "s", gaps: ["g"] } }, { summary: "s", gaps: ["g"] }],
		[{ report: "as text" }, { summary: "as text" }],
		[{ session: "s" }, undefined],
	])("report of %j is %j", (enrichment, report) => {
		expect(repoText.report?.(enrichment)).toEqual(report);
	});

	test("reportFields names each field of a report", () => {
		expect(Object.keys(repoText.reportFields ?? {})).toEqual(
			Object.keys(REPORT.properties),
		);
	});
});

describe("repoText.notes", () => {
	test.each([
		[
			{
				report: {
					summary: "s",
					gaps: ["g"],
					obstacles: ["no rg"],
					lessons: ["l1", "l2"],
				},
			},
			{ Obstacles: ["no rg"], Lessons: ["l1", "l2"] },
		],
		[{ report: { summary: "s", obstacles: [] } }, {}],
		[{ report: "a report as text" }, {}],
		[{ session: "s" }, {}],
	])("notes of %j are %j", (enrichment, notes) => {
		expect(repoText.notes?.(enrichment)).toEqual(notes);
	});
});
