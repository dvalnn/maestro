import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	HarnessEvent,
	HarnessRequest,
} from "@maestro/host-agents/harness";
import { piHarness } from "./index";

const FIXTURES = join(import.meta.dir, "../fixtures/1.0.2");
const dirs: string[] = [];
const tmp = (name: string) => {
	const d = mkdtempSync(join(tmpdir(), `pi-${name}-`));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const request = (
	prompt: string,
	over: Partial<HarnessRequest> = {},
): HarnessRequest => ({
	role: { harness: "pi", model: "stand/in", thinking: "low" },
	prompt,
	lane: tmp("lane"),
	outbox: tmp("out"),
	session: { dir: tmp("session"), id: crypto.randomUUID() },
	...over,
});

/** A stand-in `pi`: records its argv and stdin to the outbox, then replays `lines` on stdout. */
function standIn(lines: string[]) {
	const home = tmp("bin");
	const bin = join(home, "pi");
	writeFileSync(join(home, "run.jsonl"), `${lines.join("\n")}\n`);
	writeFileSync(
		bin,
		`#!/bin/sh\nprintf '%s\\n' "$@" > /out/argv\ncat > /out/stdin\ncat "$(dirname "$0")/run.jsonl"\n`,
		{ mode: 0o755 },
	);
	return { bin, agentDir: tmp("agent") };
}

const fixture = (name = "run") =>
	readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
		.trim()
		.split("\n");

async function drain(events: AsyncIterable<HarnessEvent>) {
	const seen: HarnessEvent[] = [];
	for await (const e of events) seen.push(e);
	return seen;
}

describe("stand-in pi", () => {
	test("the recorded 1.0.2 run is read into turns, tools, usage and a reply", async () => {
		const req = request("write hello.txt");
		const unknown = '{"type":"future_event","extra":{"a":1}}';
		const run = piHarness(standIn([...fixture(), unknown])).run(req);
		const seen = await drain(run.events);
		const result = await run.result;

		expect(result).toEqual({
			outcome: "ok",
			reply: "done",
			metrics: {
				tokens_in: 1251,
				tokens_out: 56,
				tokens_cache_read: 1152,
				tokens_cache_write: 0,
				tokens_reasoning: 0,
			},
		});
		expect(seen.filter((e) => e.kind === "turn")).toHaveLength(2);
		expect(seen.filter((e) => e.kind === "tool")).toEqual([
			{ kind: "tool", name: "write" },
		]);
		expect(seen.at(-1)).toEqual({
			kind: "raw",
			data: { type: "future_event", extra: { a: 1 } },
		});
		expect(seen.map((e) => e.kind)).toContain("settled");
		// only the two assistant messages count, and every ignored event type stays out of the stream
		expect(seen.filter((e) => e.kind === "usage")).toHaveLength(2);
		expect(seen.filter((e) => e.kind === "raw")).toHaveLength(1);
	});

	test("the prompt goes on stdin, never argv, and the session is addressed by dir and id", async () => {
		const req = request("a secret prompt");
		await piHarness(standIn(fixture())).run(req).result;
		expect(readFileSync(join(req.outbox, "stdin"), "utf8")).toBe(
			"a secret prompt",
		);
		expect(readFileSync(join(req.outbox, "argv"), "utf8").split("\n")).toEqual([
			"-p",
			"--mode",
			"json",
			"--session-dir",
			"/session",
			"--session-id",
			req.session.id,
			"--model",
			"stand/in",
			"--thinking",
			"low",
			"",
		]);
	});

	test("a session version other than the pinned one fails the run, naming it", async () => {
		const lines = fixture().map((l) => l.replace('"version":3', '"version":4'));
		const result = await piHarness(standIn(lines)).run(request("x")).result;
		expect(result.outcome).toBe("failed");
		expect(result.reason).toContain("session version 4");
	});

	test("a provider error that pi reports as a clean exit fails with its message", async () => {
		const result = await piHarness(standIn(fixture("error-401"))).run(
			request("x"),
		).result;
		expect(result.outcome).toBe("failed");
		expect(result.reason).toContain("401");
	});

	test("reply is the last assistant message's text, empty when it has none", async () => {
		const lines = fixture().map((l) => {
			const e = JSON.parse(l);
			if (e.type !== "message_end" || e.message.role !== "assistant") return l;
			const early = e.message.content.some(
				(p: { type: string }) => p.type === "toolCall" || p.type === "thinking",
			);
			e.message.content = early ? [{ type: "text", text: "early" }] : [];
			return JSON.stringify(e);
		});
		const result = await piHarness(standIn(lines)).run(request("x")).result;
		expect(result).toMatchObject({ outcome: "ok", reply: "" });
	});

	test("a stream that does not open with the session header fails, naming what it found", async () => {
		const lines = fixture().map((l) =>
			l.replace('"type":"session"', '"type":"header"'),
		);
		const result = await piHarness(standIn(lines)).run(request("x")).result;
		expect(result.outcome).toBe("failed");
		expect(result.reason).toContain('"header"');
	});

	test("a missing agent dir says to run pi once and log in", () => {
		const { bin } = standIn(fixture());
		const missing = join(tmp("none"), "agent");
		expect(() =>
			piHarness({ bin, agentDir: missing }).run(request("x")),
		).toThrow(
			`pi config dir does not exist: ${missing}. Run pi once and log in`,
		);
	});

	test("a run whose stream never settles fails", async () => {
		const lines = fixture().filter((l) => !l.includes("agent_settled"));
		const result = await piHarness(standIn(lines)).run(request("x")).result;
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "harness ended without settling",
		});
	});
});

describe.skipIf(!process.env.MAESTRO_PI)("real pi", () => {
	const model = process.env.MAESTRO_PI_MODEL ?? "github-copilot/gpt-5-mini";
	const harness = () => piHarness();
	const ask = (prompt: string, base: HarnessRequest) =>
		harness().run({
			...base,
			prompt,
			role: { harness: "pi", model, thinking: "low" },
		});

	test("writes to /out, reports tokens, resumes its session", async () => {
		const base = request("");
		const first = ask(
			"Use the write tool to write the word hello to /out/note.txt. Remember the word pumpernickel. Reply with ok.",
			base,
		);
		const firstResult = await first.result;
		console.log(JSON.stringify(firstResult));
		expect(firstResult.outcome).toBe("ok");
		expect(readFileSync(join(base.outbox, "note.txt"), "utf8")).toContain(
			"hello",
		);
		expect(firstResult.metrics.tokens_in).toBeGreaterThan(0);
		expect(firstResult.metrics.tokens_out).toBeGreaterThan(0);

		const second = await ask(
			"Which word did I ask you to remember? Reply with that word only.",
			base,
		).result;
		console.log(JSON.stringify(second));
		expect(second.outcome).toBe("ok");
		expect(second.reply.toLowerCase()).toContain("pumpernickel");
	}, 180_000);

	test("a cancelled run leaves no survivors", async () => {
		const run = ask(
			"Run the bash command `sleep 4711` with a timeout of 600 seconds. Do nothing else.",
			request(""),
		);
		for await (const e of run.events) if (e.kind === "tool") break;
		await run.cancel(); // kill rejects if any process of the run survives
		expect(await run.result).toMatchObject({
			outcome: "failed",
			reason: "cancelled",
		});
	}, 180_000);
});
