import { expect, test } from "bun:test";
import type { Issue } from "./forge";
import { buildable, pick } from "./pick";
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

test("a pinned newer issue is triaged before an older unpinned one, and pinned ones in pinned order", () => {
	const issues = [
		issue(2, "needs-triage"),
		issue(5, "needs-triage"),
		issue(9, "needs-triage"),
	];
	expect(pick(issues)?.number).toBe(2);
	expect(pick(issues, [9])?.number).toBe(9);
	expect(pick(issues, [5, 9])?.number).toBe(5);
});

test("a pinned issue not in intake is skipped by triage", () => {
	const issues = [issue(2, "needs-triage"), issue(5, "ready-for-agent")];
	expect(pick(issues, [5])?.number).toBe(2);
});
