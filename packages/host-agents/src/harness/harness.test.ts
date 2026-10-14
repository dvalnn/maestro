import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HarnessEvent, stubHarness } from "./index";

const dirs: string[] = [];
const lane = () => {
	const d = mkdtempSync(join(tmpdir(), "hrn-lane-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const role = { harness: "stub", model: "none" };

test("a 300 KB prompt reaches the stub intact", async () => {
	const prompt = "line of prompt text ".repeat(16_000).slice(0, 300 * 1024);
	const run = stubHarness([]).run({ role, prompt, lane: lane() });
	const seen: HarnessEvent[] = [];
	for await (const e of run.events) seen.push(e);
	expect((await run.result).outcome).toBe("ok");
	expect(seen[0]).toEqual({
		kind: "raw",
		data: {
			type: "prompt",
			bytes: 300 * 1024,
			sha256: createHash("sha256").update(prompt).digest("hex"),
		},
	});
});

test("events stream incrementally and usage surfaces as metrics", async () => {
	const run = stubHarness([
		{ emit: { type: "turn" }, delayMs: 400 },
		{ emit: { type: "usage", tokens_in: 10, tokens_out: 3 }, delayMs: 400 },
		{ emit: { type: "tool", name: "bash" }, delayMs: 400 },
		{ emit: { type: "usage", tokens_in: 5, tokens_out: 2 } },
	]).run({ role, prompt: "hi", lane: lane() });
	const arrivals: { kind: string; at: number }[] = [];
	for await (const e of run.events)
		arrivals.push({ kind: e.kind, at: performance.now() });
	const end = performance.now();
	expect(arrivals.map((a) => a.kind)).toEqual([
		"raw",
		"turn",
		"usage",
		"tool",
		"usage",
	]);
	expect(end - (arrivals[1] as { at: number }).at).toBeGreaterThan(400); // turn arrived well before the run ended
	const result = await run.result;
	expect(result.metrics).toEqual({ tokens_in: 15, tokens_out: 5 });
});

test("declared outputs are collected, and a missing one fails the run", async () => {
	const l = lane();
	const ok = await stubHarness([
		{ write: "out/report.md", content: "it's done" },
	]).run({
		role,
		prompt: "x",
		lane: l,
		outputs: ["out/report.md"],
	}).result;
	expect(ok.outcome).toBe("ok");
	expect(new TextDecoder().decode(ok.outputs["out/report.md"])).toBe(
		"it's done",
	);

	const bad = await stubHarness([]).run({
		role,
		prompt: "x",
		lane: l,
		outputs: ["nope.md"],
	}).result;
	expect(bad).toMatchObject({
		outcome: "failed",
		reason: "declared outputs not written: nope.md",
	});
});

test("cancel ends a hung run as failed/cancelled", async () => {
	const run = stubHarness([{ hang: true }]).run({
		role,
		prompt: "x",
		lane: lane(),
	});
	const it = run.events[Symbol.asyncIterator]();
	await it.next(); // prompt event: the process is up
	await run.cancel();
	expect(await run.result).toMatchObject({
		outcome: "failed",
		reason: "cancelled",
	});
});

test("a declared output that is a symlink to a host file is not collected", async () => {
	const secret = join(lane(), "host-secret.txt");
	writeFileSync(secret, "TOP-SECRET");
	const l = lane();
	symlinkSync(secret, join(l, "report-link.md"));
	const run = stubHarness([]).run({
		role,
		prompt: "x",
		lane: l,
		outputs: ["report-link.md"],
	});
	const planted = await run.result;
	expect(planted.outcome).toBe("failed");
	expect(JSON.stringify(planted)).not.toContain("TOP-SECRET");
	expect(planted.outputs).toEqual({});
});

test("cancel after the run finished keeps the success", async () => {
	const run = stubHarness([]).run({ role, prompt: "x", lane: lane() });
	expect((await run.result).outcome).toBe("ok");
	await run.cancel();
	expect((await run.result).outcome).toBe("ok");
});
