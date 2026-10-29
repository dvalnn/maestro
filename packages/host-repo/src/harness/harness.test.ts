import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settledSchema } from "@maestro/ir";
import { probe } from "../host/probe";
import {
	type HarnessEvent,
	OUTBOX,
	SESSION_DIR,
	stubHarness,
	subprocessHarness,
} from "./index";
import { placeholder, placeholderOutputs } from "./stub";

const dirs: string[] = [];
const tmp = (name: string) => {
	const d = mkdtempSync(join(tmpdir(), `hrn-${name}-`));
	dirs.push(d);
	return d;
};
const lane = () => tmp("lane");
const request = (prompt: string, l = lane()) => ({
	runtime,
	prompt,
	lane: l,
	outbox: tmp("out"),
	outputs: [],
	session: { dir: tmp("session"), id: crypto.randomUUID() },
});
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const runtime = { harness: "stub", model: "none" };

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
		{ emit: { type: "text", text: "hi" }, delayMs: 400 },
		{ emit: { type: "usage" } },
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
		"text",
		"usage",
		"tool",
		"usage",
		"settled",
	]);
	expect(end - (arrivals[1] as { at: number }).at).toBeGreaterThan(400); // text arrived well before the run ended
	const result = await run.result;
	expect(result.metrics).toEqual({ tokens_in: 15, tokens_out: 5 });
});

test("a usage event of zeros and a blank text stay out of the stream but are folded into the result", async () => {
	const run = stubHarness([
		{ emit: { type: "usage" } },
		{ emit: { type: "text", text: "last" } },
		{ emit: { type: "text", text: " \n" } },
	]).run(request("x"));
	const kinds: string[] = [];
	for await (const e of run.events) kinds.push(e.kind);
	expect(kinds).not.toContain("usage");
	expect(kinds.filter((k) => k === "text")).toEqual(["text"]);
	expect(await run.result).toMatchObject({
		metrics: { tokens_in: 0, tokens_out: 0 },
		reply: " \n",
	});
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

test("a run that exits cleanly without settling fails as transient", async () => {
	const silent = subprocessHarness({
		name: "silent",
		spec: () => ({ argv: ["true"] }),
		parser: () => () => [],
	});
	expect(await silent.run(request("x")).result).toMatchObject({
		outcome: "failed",
		reason: "harness ended without settling",
		transient: true,
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
	const run = stubHarness([{ emit: { type: "text", text: "x" } }]).run(
		request("x"),
	);
	for await (const _ of run.events) break;
	expect((await run.result).outcome).toBe("ok");
});

test("cancel after the run finished keeps the success", async () => {
	const run = stubHarness([]).run(request("x"));
	expect((await run.result).outcome).toBe("ok");
	await run.cancel();
	expect((await run.result).outcome).toBe("ok");
});

test.each<[string, unknown, unknown]>([
	[
		"required properties, a bounded array and enums",
		{
			type: "object",
			required: ["name", "ok", "items", "kind"],
			properties: {
				name: { type: "string" },
				ok: { type: "boolean" },
				items: {
					type: "array",
					minItems: 2,
					items: { type: "integer", minimum: 3 },
				},
				kind: { enum: ["a", "b"] },
				extra: { type: "string" },
			},
		},
		{ name: "stub", ok: false, items: [3, 3], kind: "a" },
	],
	[
		"a schema with type and required beside oneOf",
		settledSchema({ type: "string" }),
		{ outcome: "ok", value: "stub" },
	],
	[
		"an array with no minimum",
		{ type: "array", items: { type: "string" } },
		[],
	],
	["a string of a minimum length", { type: "string", minLength: 6 }, "stub__"],
	[
		"the first of anyOf",
		{ anyOf: [{ type: "null" }, { type: "string" }] },
		null,
	],
])("a stub placeholder fills %s", (_, schema, expected) => {
	expect(placeholder(schema)).toEqual(expected);
});

test("the stub writes each declared output to the outbox before it replies", async () => {
	const req = {
		...request("x"),
		outputs: [
			{ file: "a.json", format: "json" as const, schema: { type: "array" } },
			{ file: "b.md", format: "markdown" as const },
		],
	};
	const run = stubHarness(placeholderOutputs).run(req);
	expect((await run.result).outcome).toBe("ok");
	expect(readFileSync(join(req.outbox, "a.json"), "utf8")).toBe("[]");
	expect(readFileSync(join(req.outbox, "b.md"), "utf8")).toBe("stub\n");
});

test("a probe stops the harness once it has reported its environment and window, keeps what it reported before its run ended, and fails with a run that fails first or never reports", async () => {
	const report = { type: "environment", tools: ["sh"], extra: 1 };
	const reported = await probe(
		stubHarness([{ emit: { ...report, window: 200_000 } }, { hang: true }]),
		request("x"),
	);
	expect(reported).toEqual({ observed: { tools: ["sh"] }, window: 200_000 });
	expect(
		await probe(
			stubHarness([{ emit: report }, { hang: true }]),
			request("x"),
			50,
		),
	).toEqual({ observed: { tools: ["sh"] } });
	expect(await probe(stubHarness([]), request("x"))).toEqual({});
	const failing = stubHarness([
		{ emit: { type: "fault", reason: "no token" } },
	]);
	await expect(probe(failing, request("x"))).rejects.toThrow("no token");
	await expect(
		probe(stubHarness([{ hang: true }]), request("x"), 50),
	).rejects.toThrow("no startup report within 0.05s");
});
