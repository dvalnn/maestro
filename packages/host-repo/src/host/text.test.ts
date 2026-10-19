import { describe, expect, test } from "bun:test";
import { repoText } from "./text";

const PREPARE = { kind: "prepare", line: 1, of: 2, run: "bun install" };

describe("repoText.progress", () => {
	test.each([
		[PREPARE, "prepare 1/2: bun install"],
		[{ ...PREPARE, of: undefined }, "prepare 1: bun install"],
		[
			{ ...PREPARE, ended: "exited 7", tail: "a\nregistry down\n\n" },
			"prepare 1/2: registry down",
		],
		[{ ...PREPARE, ended: "exited 7", tail: "" }, "prepare 1/2: exited 7"],
		[{ ...PREPARE, ended: "exited 0" }, "prepare 1/2: exited 0"],
		[{ kind: "tool", name: "bash" }, undefined],
		[{ kind: "prepare", run: "x" }, undefined],
	])("words %j as %j", (event, text) => {
		expect(repoText.progress?.(event)).toBe(text);
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
