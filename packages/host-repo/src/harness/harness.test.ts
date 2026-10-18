import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type HarnessEvent,
	OUTBOX,
	SESSION_DIR,
	stubHarness,
	subprocessHarness,
} from "./index";

const dirs: string[] = [];
const tmp = (name: string) => {
	const d = mkdtempSync(join(tmpdir(), `hrn-${name}-`));
	dirs.push(d);
	return d;
};
const lane = () => tmp("lane");
const request = (prompt: string, l = lane()) => ({
	role,
	prompt,
	lane: l,
	outbox: tmp("out"),
	session: { dir: tmp("session"), id: crypto.randomUUID() },
});
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const role = { harness: "stub", model: "none" };

test("a 300 KB prompt reaches the stub intact", async () => {
	const prompt = "line of prompt text ".repeat(16_000).slice(0, 300 * 1024);
	const run = stubHarness([]).run(request(prompt));
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
	]).run(request("hi"));
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
		"settled",
	]);
	expect(end - (arrivals[1] as { at: number }).at).toBeGreaterThan(400); // turn arrived well before the run ended
	const result = await run.result;
	expect(result.metrics).toEqual({ tokens_in: 15, tokens_out: 5 });
});

test("the agent writes to the outbox and the session dir, and the last text is the reply", async () => {
	const req = request("x");
	const result = await stubHarness([
		{ emit: { type: "text", text: "first" } },
		{ write: `${OUTBOX}/report.md`, content: "it's done" },
		{ write: `${SESSION_DIR}/state`, content: "kept" },
		{ emit: { type: "text", text: "last" } },
	]).run(req).result;
	expect(result).toMatchObject({ outcome: "ok", reply: "last" });
	expect(readFileSync(join(req.outbox, "report.md"), "utf8")).toBe("it's done");
	expect(readFileSync(join(req.session.dir, "state"), "utf8")).toBe("kept");
});

test("a fault kills the run and fails it with the reason", async () => {
	const result = await stubHarness([
		{ emit: { type: "fault", reason: "pi session version 4" } },
		{ hang: true },
	]).run(request("x")).result;
	expect(result).toMatchObject({
		outcome: "failed",
		reason: "pi session version 4",
		reply: "",
	});
});

test("a run that exits cleanly without settling fails", async () => {
	const silent = subprocessHarness({
		name: "silent",
		spec: () => ({ argv: ["true"] }),
		parser: () => () => [],
	});
	expect(await silent.run(request("x")).result).toMatchObject({
		outcome: "failed",
		reason: "harness ended without settling",
	});
});

test("cancel ends a hung run as failed/cancelled", async () => {
	const run = stubHarness([{ hang: true }]).run(request("x"));
	const it = run.events[Symbol.asyncIterator]();
	await it.next(); // prompt event: the process is up
	await run.cancel();
	expect(await run.result).toMatchObject({
		outcome: "failed",
		reason: "cancelled",
	});
});

test("abandoning the event stream does not break the run", async () => {
	const run = stubHarness([{ emit: { type: "turn" } }]).run(request("x"));
	for await (const _ of run.events) break;
	expect((await run.result).outcome).toBe("ok");
});

test("cancel after the run finished keeps the success", async () => {
	const run = stubHarness([]).run(request("x"));
	expect((await run.result).outcome).toBe("ok");
	await run.cancel();
	expect((await run.result).outcome).toBe("ok");
});
