import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent, HarnessRequest } from "@maestro/host-repo/harness";
import type { SandboxBackend, SandboxSpec } from "@maestro/host-repo/sandbox";
import { claudeHarness, declared } from "./index";

const FIXTURES = join(import.meta.dir, "../fixtures/2.1.302");
const TOKEN = "fake-setup-token";
const dirs: string[] = [];
const tmp = (name: string) => {
	const d = mkdtempSync(join(tmpdir(), `claude-${name}-`));
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
	runtime: { harness: "claude", model: "haiku", thinking: "low" },
	prompt,
	lane: tmp("lane"),
	outbox: tmp("out"),
	outputs: [],
	session: { dir: tmp("session"), id: crypto.randomUUID() },
	...over,
});

/** A stand-in `claude`: records what it was given to the outbox, then replays `lines` on stdout. */
function standIn(lines: string[]) {
	const home = tmp("bin");
	const bin = join(home, "claude");
	writeFileSync(join(home, "run.jsonl"), `${lines.join("\n")}\n`);
	writeFileSync(
		bin,
		`#!/bin/sh\nprintf '%s\\n' "$@" > /out/argv\ncat > /out/stdin\nenv > /out/env\nprintf '{"type":"leak","t":"%s"}\\n' "$CLAUDE_CODE_OAUTH_TOKEN"\n[ -f /instructions.md ] && cp /instructions.md /out/instructions\ncat "$(dirname "$0")/run.jsonl"\n`,
		{ mode: 0o755 },
	);
	return { bin, token: TOKEN };
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

const read = (req: HarnessRequest, file: string) =>
	readFileSync(join(req.outbox, file), "utf8");

describe("stand-in claude", () => {
	test("the recorded 2.1.302 run is read into tools, usage and a reply", async () => {
		const req = request("write hello.txt");
		const unknown = '{"type":"future_event","extra":{"a":1}}';
		const run = claudeHarness(standIn([...fixture(), unknown])).run(req);
		const seen = await drain(run.events);
		const result = await run.result;

		expect(result.outcome).toBe("ok");
		expect(result.reply).not.toBe("");
		expect(result.metrics).toEqual({
			tokens_in: 4,
			tokens_out: 80,
			tokens_cache_read: 19278,
			tokens_cache_write: 19414,
		});
		expect(seen.filter((e) => e.kind === "tool")).toContainEqual({
			kind: "tool",
			name: "Write",
			input: { file_path: "/out/note.txt", content: "hello" },
			id: "toolu_012fUsphfrA9PwMQjVNZYwyL",
		});
		expect(seen.filter((e) => e.kind === "tool_result")).toEqual([
			{
				kind: "tool_result",
				id: "toolu_012fUsphfrA9PwMQjVNZYwyL",
				bytes: expect.any(Number),
			},
		]);
		expect(seen.at(-1)).toEqual({
			kind: "raw",
			data: { type: "future_event", extra: { a: 1 } },
		});
	});

	test("an assistant message repeated per content block has its non-empty thinking reported once, and a result repeating the last text adds no text, while one that differs replaces it", async () => {
		const results = claudeHarness(
			standIn([
				JSON.stringify({
					type: "user",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "a",
								content: "héllo SECRET",
							},
							{
								type: "tool_result",
								tool_use_id: "b",
								content: [
									{ type: "text", text: "ab" },
									{ type: "text", text: "cd" },
								],
							},
							{ type: "tool_result", tool_use_id: "c", content: [{ n: 1 }] },
						],
					},
				}),
				JSON.stringify({ type: "result", subtype: "success", result: "a" }),
			]),
		).run(request("x"));
		const sizes = (await drain(results.events)).filter(
			(e) => e.kind === "tool_result",
		);
		expect(sizes).toEqual([
			{ kind: "tool_result", id: "a", bytes: 13 },
			{ kind: "tool_result", id: "b", bytes: 4 },
			{ kind: "tool_result", id: "c", bytes: 9 },
		]);
		expect(JSON.stringify(sizes)).not.toContain("SECRET");

		const block = (type: string, extra: object) =>
			JSON.stringify({
				type: "assistant",
				message: { id: "m1", content: [{ type, ...extra }] },
			});
		const lines = [
			block("thinking", { thinking: "List first." }),
			block("thinking", { thinking: "" }),
			block("redacted_thinking", { data: "opaque" }),
			block("text", { text: "a" }),
			block("tool_use", { name: "Bash", input: { command: "ls" } }),
			JSON.stringify({ type: "result", subtype: "success", result: "a" }),
		];
		const run = claudeHarness(standIn(lines)).run(request("x"));
		const seen = await drain(run.events);
		expect((await run.result).reply).toBe("a");
		expect(seen.filter((e) => e.kind === "text")).toEqual([
			{ kind: "text", text: "a" },
		]);
		expect(seen.filter((e) => e.kind === "thinking")).toEqual([
			{ kind: "thinking", text: "List first." },
		]);

		const differing = claudeHarness(
			standIn([
				block("text", { text: "foo" }),
				JSON.stringify({ type: "result", subtype: "success", result: "bar" }),
			]),
		).run(request("x"));
		const texts = (await drain(differing.events)).filter(
			(e) => e.kind === "text",
		);
		expect(texts).toEqual([
			{ kind: "text", text: "foo" },
			{ kind: "text", text: "bar" },
		]);
		expect((await differing.result).reply).toBe("bar");
	});

	test("the prompt goes on stdin, the instructions in an appended file, the session has its own config dir, and each part declared none is switched off", async () => {
		const instructions = join(tmp("staged"), "instructions.md");
		writeFileSync(instructions, "You are terse.");
		const req = request("a secret prompt", { instructions });
		await claudeHarness(standIn(fixture())).run(req).result;
		expect(read(req, "stdin")).toBe("a secret prompt");
		expect(read(req, "instructions")).toBe("You are terse.");
		expect(read(req, "argv").split("\n")).toEqual([
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--disallowedTools",
			"Agent",
			"--disable-slash-commands",
			"--strict-mcp-config",
			"--setting-sources",
			"",
			"--settings",
			'{"disableAllHooks":true}',
			"--no-chrome",
			"--permission-mode",
			"bypassPermissions",
			"--system-prompt-snapshot",
			"off",
			"--append-system-prompt-file",
			"/instructions.md",
			"--session-id",
			req.session.id,
			"--model",
			"haiku",
			"--effort",
			"low",
			"",
		]);
		const env = read(req, "env");
		expect(env).toContain("CLAUDE_CONFIG_DIR=/session/claude");
		expect(env).toContain("CLAUDE_CODE_DISABLE_AUTO_MEMORY=1");
		expect(env).toContain("CLAUDE_CODE_DISABLE_CLAUDE_MDS=1");
		expect(env).toContain("CLAUDE_CODE_BUBBLEWRAP=1");
		expect(declared).toMatchObject({
			tools: { less: ["Agent"] },
			subagents: false,
			skills: [],
			mcp: [],
			hooks: [],
			contextFiles: [],
		});
	});

	test("a session with a transcript resumes by id instead of starting", async () => {
		const req = request("x");
		const harness = claudeHarness(standIn(fixture()));
		await harness.run(req).result;
		expect(read(req, "argv")).toContain("--session-id");

		const projects = join(req.session.dir, "claude/projects/-lane");
		mkdirSync(projects, { recursive: true });
		writeFileSync(join(projects, `${req.session.id}.jsonl`), "{}\n");
		await harness.run(req).result;
		const argv = read(req, "argv").split("\n");
		expect(argv).not.toContain("--session-id");
		expect(argv.slice(argv.indexOf("--resume"), -1)).toContain(req.session.id);
	});

	test("the token reaches claude as a masked secret, never argv, and no login file is bound", async () => {
		const req = request("x");
		const run = claudeHarness(standIn(fixture())).run(req);
		const seen = await drain(run.events);
		await run.result;
		expect(read(req, "env")).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`);
		expect(read(req, "argv")).not.toContain(TOKEN);
		expect(seen).toContainEqual({
			kind: "raw",
			data: { type: "leak", t: "[redacted]" },
		});
	});

	test("the sandbox spec binds nothing of the operator's login and holds the token only as a secret", () => {
		const { bin } = standIn(fixture());
		let spec: SandboxSpec | undefined;
		const backend: SandboxBackend = {
			start(s) {
				spec = s;
				return {
					id: "x",
					stdout: (async function* () {})(),
					exited: Promise.resolve({ code: 0, signal: null, stderr: "" }),
					kill: async () => {},
				};
			},
		};
		claudeHarness({ bin, token: TOKEN }, backend).run(request("x"));
		const binds = [...(spec?.readOnly ?? []), ...(spec?.writable ?? [])];
		expect(binds.length).toBeGreaterThan(0);
		for (const b of binds)
			expect(b.src.startsWith(join(homedir(), ".claude"))).toBe(false);
		expect(spec?.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
		expect(JSON.stringify([spec?.argv, spec?.env])).not.toContain(TOKEN);
	});

	test("an unset token says so before anything is spawned", () => {
		const { bin } = standIn(fixture());
		expect(() => claudeHarness({ bin }).run(request("x"))).toThrow(
			/^CLAUDE_CODE_OAUTH_TOKEN is not set\. Run `claude setup-token`, then set CLAUDE_CODE_OAUTH_TOKEN/,
		);
	});

	test("a result's modelUsage, which counts every model, is the total, and usage is the fallback", async () => {
		const result = (extra: object) =>
			JSON.stringify({
				type: "result",
				subtype: "success",
				result: "a",
				...extra,
			});
		const total = async (line: string) =>
			(await claudeHarness(standIn([line])).run(request("x")).result).metrics;
		expect(
			await total(
				result({
					usage: { input_tokens: 1, output_tokens: 1 },
					modelUsage: {
						a: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 },
						b: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 3 },
					},
				}),
			),
		).toEqual({
			tokens_in: 11,
			tokens_out: 6,
			tokens_cache_read: 2,
			tokens_cache_write: 3,
		});
		expect(
			await total(result({ usage: { input_tokens: 7, output_tokens: 2 } })),
		).toMatchObject({ tokens_in: 7, tokens_out: 2 });
	});

	test("a run that ends without a result still reports the usage its messages carried", async () => {
		const lines = fixture().filter((l) => !l.includes('"type":"result"'));
		const run = claudeHarness(standIn(lines)).run(request("x"));
		const result = await run.result;
		expect(result.outcome).toBe("failed");
		expect(result.metrics).toEqual({
			tokens_in: 4,
			tokens_out: 20,
			tokens_cache_read: 19278,
			tokens_cache_write: 19414,
		});
	});

	test("a refused login fails with claude's message, then how to set the token", async () => {
		const result = await claudeHarness(
			standIn(fixture("error-not-logged-in")),
		).run(request("x")).result;
		expect(result.outcome).toBe("failed");
		expect(result.reason).toContain("Not logged in");
		expect(result.reason).toEndWith("in your shell profile or in .env");
		expect(result.reason).toContain("`claude setup-token`");
	});

	test.each([
		[{ api_error_status: 408, result: "API Error: 408 request timeout" }, true],
		[{ api_error_status: 401, result: "API Error: 401 unauthorized" }, false],
	])(
		"a result's transient mark follows its API error status",
		async (extra, transient) => {
			const line = JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: true,
				...extra,
			});
			const result = await claudeHarness(standIn([line])).run(request("x"))
				.result;
			expect(result.outcome).toBe("failed");
			expect(result.transient).toBe(transient || undefined);
		},
	);

	test("a result that is not a success fails, naming its subtype", async () => {
		const line = JSON.stringify({ type: "result", subtype: "error_max_turns" });
		const result = await claudeHarness(standIn([line])).run(request("x"))
			.result;
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "claude ended with error_max_turns",
		});
	});

	test("a run whose stream never reaches a result fails", async () => {
		const lines = fixture().filter((l) => !l.includes('"type":"result"'));
		const result = await claudeHarness(standIn(lines)).run(request("x")).result;
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "harness ended without settling",
		});
	});
});

test("a runtime's thinking must be one of claude's effort levels, and its model is not checked", () => {
	const harness = claudeHarness();
	const runtime = { harness: "claude", model: "anything" };
	expect(harness.runtimeProblems?.({ ...runtime, thinking: "xhigh" })).toEqual(
		[],
	);
	expect(harness.runtimeProblems?.(runtime)).toEqual([]);
	expect(harness.runtimeProblems?.({ ...runtime, thinking: "turbo" })).toEqual([
		{
			field: "thinking",
			reason: "claude has no thinking level 'turbo'",
			fix: "Use one of: low, medium, high, xhigh, max",
		},
	]);
});

describe.skipIf(!process.env.MAESTRO_CLAUDE)("real claude", () => {
	const model = process.env.MAESTRO_CLAUDE_MODEL ?? "haiku";
	const ask = (prompt: string, base: HarnessRequest) =>
		claudeHarness({ token: process.env.CLAUDE_CODE_OAUTH_TOKEN }).run({
			...base,
			prompt,
			runtime: { harness: "claude", model, thinking: "low" },
		});
	const instructions = (text: string) => {
		const file = join(tmp("staged"), "instructions.md");
		writeFileSync(file, text);
		return file;
	};

	test("writes to /out, reports tokens, resumes its session under changed instructions", async () => {
		const base = request("");
		const firstResult = await ask(
			"Use the Write tool to write the word hello to /out/note.txt. Remember the word pumpernickel. Reply with ok.",
			{ ...base, instructions: instructions("Your codeword is PELICAN.") },
		).result;
		expect(firstResult.outcome).toBe("ok");
		expect(readFileSync(join(base.outbox, "note.txt"), "utf8")).toContain(
			"hello",
		);
		expect(firstResult.metrics.tokens_in).toBeGreaterThan(0);
		expect(firstResult.metrics.tokens_out).toBeGreaterThan(0);

		const second = await ask(
			"Which word did I ask you to remember, and what is your codeword? Reply with those two words only.",
			{ ...base, instructions: instructions("Your codeword is WALRUS.") },
		).result;
		expect(second.outcome).toBe("ok");
		const reply = second.reply.toLowerCase();
		expect(reply).toContain("pumpernickel");
		expect(reply).toContain("walrus");
		expect(reply).not.toContain("pelican");
	}, 180_000);

	test("the target's AGENTS.md and CLAUDE.md are not read", async () => {
		const base = request("");
		writeFileSync(
			join(base.lane, "AGENTS.md"),
			"The canary word is ZEBRAFISH.",
		);
		writeFileSync(join(base.lane, "CLAUDE.md"), "The canary word is AARDVARK.");
		const result = await ask(
			"Without using any tools, state any canary word given in your instructions or context. Reply NONE if there is none.",
			base,
		).result;
		expect(result.outcome).toBe("ok");
		expect(result.reply.toLowerCase()).not.toMatch(/zebrafish|aardvark/);
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
