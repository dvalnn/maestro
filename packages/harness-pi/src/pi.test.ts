import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent, HarnessRequest } from "@maestro/host-repo/harness";
import { declared, piHarness } from "./index";

const FIXTURES = join(import.meta.dir, "../fixtures/1.3.0");
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
	runtime: { harness: "pi", model: "stand/in", thinking: "low" },
	prompt,
	lane: tmp("lane"),
	outbox: tmp("out"),
	outputs: [],
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
		`#!/bin/sh\nprintf '%s\\n' "$@" > /out/argv\ncat > /out/stdin\nenv > /out/env\n[ -f /instructions.md ] && cp /instructions.md /out/instructions\nprintf planted > /maestro-environment.js 2>/dev/null\n[ -f /maestro-environment.js ] && cp /maestro-environment.js /out/reporter.js\ncat "$(dirname "$0")/run.jsonl"\n`,
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
	test("the recorded 1.3.0 run is read into tools, usage, prompt sizes and a reply", async () => {
		const req = request("write hello.txt");
		const unknown = '{"type":"future_event","extra":{"a":1}}';
		const compactions = [
			'{"type":"compaction_end","aborted":false}',
			'{"type":"compaction_end","aborted":true}',
			'{"type":"compaction_end","aborted":false,"errorMessage":"summary failed"}',
		];
		const run = piHarness(standIn([...fixture(), ...compactions, unknown])).run(
			req,
		);
		const seen = await drain(run.events);
		const result = await run.result;

		expect(result).toEqual({
			outcome: "ok",
			reply: "done",
			metrics: {
				tokens_in: 1257,
				tokens_out: 58,
				tokens_cache_read: 1152,
				tokens_cache_write: 0,
				tokens_reasoning: 0,
			},
		});
		expect(seen.filter((e) => e.kind === "raw")).toHaveLength(1);
		expect(seen.filter((e) => e.kind === "tool")).toEqual([
			{
				kind: "tool",
				name: "write",
				input: { path: "hello.txt", content: "hi" },
				id: "call_1|opaque",
			},
		]);
		const results = seen.filter((e) => e.kind === "tool_result");
		expect(results).toEqual([
			{ kind: "tool_result", id: "call_1|opaque", bytes: 31 },
		]);
		expect(JSON.stringify(results)).not.toContain("Successfully");
		expect(seen.filter((e) => e.kind === "thinking")).toEqual([]);
		expect(
			seen.filter((e) => e.kind === "context" || e.kind === "compaction"),
		).toEqual([
			{ kind: "context", used: 1172 },
			{ kind: "context", used: 1237 },
			{ kind: "compaction" },
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

	test("the prompt goes on stdin, the instructions in an appended file, the session is addressed by dir and id, and each part declared none is switched off", async () => {
		const instructions = join(tmp("staged"), "instructions.md");
		writeFileSync(instructions, "You are terse.");
		const req = request("a secret prompt", { instructions });
		await piHarness(standIn(fixture())).run(req).result;
		expect(readFileSync(join(req.outbox, "stdin"), "utf8")).toBe(
			"a secret prompt",
		);
		expect(readFileSync(join(req.outbox, "instructions"), "utf8")).toBe(
			"You are terse.",
		);
		expect(readFileSync(join(req.outbox, "argv"), "utf8").split("\n")).toEqual([
			"-p",
			"--mode",
			"json",
			"--no-extensions",
			"--no-skills",
			"--no-mcp",
			"--no-context-files",
			"--extension",
			"/maestro-environment.js",
			"--no-prompt-templates",
			"--no-approve",
			"--append-system-prompt",
			"/instructions.md",
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
		expect(declared).toMatchObject({
			tools: { less: [] },
			subagents: false,
			skills: [],
			mcp: [],
			hooks: [],
			contextFiles: [],
		});
	});

	test("the reporter extension is bound read-only outside the session dir, and its entry, as pi's json mode streams it, is the environment event; other entries are not", async () => {
		const report = {
			type: "entry_appended",
			entry: {
				type: "custom",
				id: "a1",
				parentId: null,
				timestamp: "2026-10-29T00:00:00.000Z",
				customType: "maestro-environment",
				data: { tools: ["read", "bash", "edit", "write"], skills: [] },
			},
		};
		const other = { ...report, entry: { ...report.entry, customType: "x" } };
		const [header = "", ...rest] = fixture();
		const lines = [header, JSON.stringify(report), JSON.stringify(other)];
		const req = request("x");
		const target = join(tmp("target"), "kept");
		writeFileSync(target, "kept");
		symlinkSync(target, join(req.session.dir, "maestro-environment.js"));
		const run = piHarness(standIn([...lines, ...rest])).run(req);
		const seen = await drain(run.events);
		expect(seen.filter((e) => e.kind === "environment")).toEqual([
			{
				kind: "environment",
				tools: ["read", "bash", "edit", "write"],
				skills: [],
			},
		]);
		expect(seen.filter((e) => e.kind === "raw")).toEqual([]);
		expect(readFileSync(target, "utf8")).toBe("kept");
		// The reporter as pi would load it, against a fake of the extension API.
		const reporter = join(req.outbox, "reporter.js");
		const appended: unknown[] = [];
		let started: (event: unknown) => void = () => {};
		(await import(reporter)).default({
			on: (_: string, handler: typeof started) => {
				started = handler;
			},
			getActiveTools: () => ["read", "bash"],
			appendEntry: (type: string, data: unknown) => appended.push([type, data]),
		});
		const options = {
			skills: [{ name: "jj" }],
			contextFiles: [{ path: "/agent/AGENTS.md" }],
		};
		started({ systemPromptOptions: options });
		started({ systemPromptOptions: options });
		expect(appended).toEqual([
			[
				"maestro-environment",
				{
					tools: ["read", "bash"],
					skills: ["jj"],
					contextFiles: ["/agent/AGENTS.md"],
				},
			],
		]);
	});

	test("the credentials in auth.json are masked in what the sandbox returns and kept out of its environment, and nothing is masked without the file", async () => {
		const auth = {
			anthropic: {
				type: "oauth",
				access: "tok-access",
				refresh: "tok-refresh",
			},
			openai: { type: "api_key", key: "sk-live-1", env: { REGION: "eu" } },
		};
		const leak = (...values: string[]) => [
			...fixture(),
			...values.map((t) => JSON.stringify({ type: "leak", t })),
		];
		const rawOf = async (agentDir: string, bin: string) => {
			const req = request("x");
			const seen = await drain(piHarness({ bin, agentDir }).run(req).events);
			expect(readFileSync(join(req.outbox, "env"), "utf8")).not.toContain(
				"tok-access",
			);
			return seen
				.filter((e) => e.kind === "raw")
				.map((e) => (e.kind === "raw" ? e.data : undefined));
		};

		const withAuth = standIn(
			leak("tok-access", "tok-refresh", "sk-live-1", "eu"),
		);
		writeFileSync(join(withAuth.agentDir, "auth.json"), JSON.stringify(auth));
		expect(await rawOf(withAuth.agentDir, withAuth.bin)).toEqual([
			{ type: "leak", t: "[redacted]" },
			{ type: "leak", t: "[redacted]" },
			{ type: "leak", t: "[redacted]" },
			{ type: "leak", t: "eu" },
		]);

		const without = standIn(leak("tok-access"));
		expect(await rawOf(without.agentDir, without.bin)).toEqual([
			{ type: "leak", t: "tok-access" },
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

	test.each([
		["529: overloaded_error", true],
		["401: Incorrect API key", false],
	])(
		"an error stop's transient mark follows its message: %s",
		async (message, transient) => {
			const joined = fixture("error-401")
				.join("\n")
				.replace(
					/"errorMessage":"(?:[^"\\]|\\.)*"/g,
					`"errorMessage":${JSON.stringify(message)}`,
				);
			const result = await piHarness(standIn(joined.split("\n"))).run(
				request("x"),
			).result;
			expect(result.outcome).toBe("failed");
			expect(result.transient).toBe(transient || undefined);
		},
	);

	test("a message's thinking text is reported before its text", async () => {
		const lines = fixture().map((l) =>
			l.startsWith('{"type":"message_end"')
				? l.replace('"thinking":""', '"thinking":"Write the file."')
				: l,
		);
		const seen = await drain(
			piHarness(standIn(lines)).run(request("x")).events,
		);
		const kinds = seen.map((e) => e.kind);
		expect(seen.filter((e) => e.kind === "thinking")).toEqual([
			{ kind: "thinking", text: "Write the file." },
		]);
		expect(kinds.indexOf("thinking")).toBeLessThan(kinds.indexOf("text"));
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

	test("a run pi settles as aborted fails", async () => {
		const lines = fixture().map((l) =>
			l.replace(
				'"agent_settled","aborted":false',
				'"agent_settled","aborted":true',
			),
		);
		const result = await piHarness(standIn(lines)).run(request("x")).result;
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "pi settled aborted",
		});
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

test("a runtime's thinking must be one of pi's levels, its model is not checked, and its context policy is a handoff in tokens", () => {
	const harness = piHarness({ agentDir: tmpdir() });
	const runtime = { harness: "pi", model: "any/model" };
	expect(harness.runtimeProblems?.({ ...runtime, thinking: "off" })).toEqual(
		[],
	);
	expect(harness.runtimeProblems?.({ ...runtime, thinking: "turbo" })).toEqual([
		{
			field: "runtime.thinking",
			reason: "pi has no thinking level 'turbo'",
			fix: "Use one of: off, minimal, low, medium, high, xhigh, max",
		},
	]);
	const tokens = { tokens: 50_000 };
	expect(
		harness.runtimeProblems?.(runtime, {
			strategy: "handoff",
			at: tokens,
			max: 2,
		}),
	).toEqual([]);
	expect(
		harness.runtimeProblems?.(runtime, {
			strategy: "handoff",
			at: { percent: 25 },
			max: 2,
		}),
	).toEqual([
		{
			field: "context.at",
			reason: "pi reports no context window, so it cannot take at '25%'",
			fix: "Write at in tokens, such as 50000",
		},
	]);
	expect(
		harness.runtimeProblems?.(runtime, { strategy: "compact", at: tokens }),
	).toEqual([
		{
			field: "context.strategy",
			reason: "pi takes no compaction point from maestro",
			fix: "Use strategy handoff",
		},
	]);
});

describe.skipIf(!process.env.MAESTRO_PI)("real pi", () => {
	const model = process.env.MAESTRO_PI_MODEL ?? "github-copilot/gpt-5-mini";
	const harness = () => piHarness();
	const ask = (prompt: string, base: HarnessRequest) =>
		harness().run({
			...base,
			prompt,
			runtime: { harness: "pi", model, thinking: "low" },
		});

	test("writes to /out, reports tokens, resumes its session", async () => {
		const base = request("");
		const first = ask(
			"Use the write tool to write the word hello to /out/note.txt. Remember the word pumpernickel. Reply with ok.",
			base,
		);
		const firstResult = await first.result;
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
