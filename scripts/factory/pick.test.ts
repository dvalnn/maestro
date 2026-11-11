import { expect, test } from "bun:test";
import type { Issue } from "./forge";
import { buildable, pick, tierOf } from "./pick";

const free = async () => true;

import type { Data } from "./route";

const issue = (number: number, state: string): Issue => ({
	number,
	title: `T${number}`,
	body: "",
	labels: [`state/${state}`],
});
const ready = (number: number) => ({
	issue: issue(number, "ready-for-agent"),
	data: { result: { spec: {} } } as unknown as Data,
});
const numbers = (entries: { issue: Issue }[]) =>
	entries.map((e) => e.issue.number);

test("a pinned newer issue is built before an older unpinned one, and pinned ones in pinned order", () => {
	const entries = [ready(2), ready(5), ready(9)];
	expect(numbers(buildable(entries))).toEqual([2, 5, 9]);
	expect(numbers(buildable(entries, [9, 5]))).toEqual([9, 5, 2]);
});

test("a pinned issue not eligible to build is skipped", () => {
	const entries = [ready(2), ready(5)];
	expect(numbers(buildable(entries, [7, 5]))).toEqual([5, 2]);
});

test("a pinned newer issue is triaged before an older unpinned one, and pinned ones in pinned order", async () => {
	const issues = [
		issue(2, "needs-triage"),
		issue(5, "needs-triage"),
		issue(9, "needs-triage"),
	];
	expect((await pick(issues, [], free))?.number).toBe(2);
	expect((await pick(issues, [9], free))?.number).toBe(9);
	expect((await pick(issues, [5, 9], free))?.number).toBe(5);
});

test("a ticket with an open dependency is skipped by triage, a pinned one included", async () => {
	const issues = [
		issue(2, "needs-triage"),
		issue(5, "needs-triage"),
		issue(9, "needs-triage"),
	];
	const open = [2];
	const free = async (n: number) => !open.includes(n);
	expect((await pick(issues, [], free))?.number).toBe(5);
	expect((await pick(issues, [2], free))?.number).toBe(5);
	open.push(5, 9);
	expect(await pick(issues, [], free)).toBeUndefined();
});

test("a pinned issue not in intake is skipped by triage", async () => {
	const issues = [issue(2, "needs-triage"), issue(5, "ready-for-agent")];
	expect((await pick(issues, [5], free))?.number).toBe(2);
});

test.each([
	["low risk", "low", undefined, [], "small"],
	["high risk that triage made risky", "high", "risky", [], "risky"],
	["high risk that triage made ordinary", "high", "ordinary", [], "ordinary"],
	["high risk triaged before tiers", "high", undefined, [], "ordinary"],
	[
		"high risk the owner relabelled medium",
		"high",
		"risky",
		["risk/medium"],
		"ordinary",
	],
] as const)(
	"a ticket at %s builds at its tier",
	(_, risk, tier, labels, built) => {
		const ticket = { ...issue(1, "ready-for-agent"), labels: [...labels] };
		expect(tierOf(ticket, { risk, tier })).toBe(built);
	},
);
