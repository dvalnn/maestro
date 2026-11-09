import { afterEach, describe, expect, test } from "bun:test";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent, HarnessRequest } from "@maestro/host-repo/harness";
import { declared, piHarness } from "./index";

const FIXTURES = join(import.meta.dir, "../fixtures/1.5.0");
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

/** A stand-in `pi`: records its argv and stdin to the outbox, runs `script`, then replays `lines` on stdout. */
function standIn(lines: string[], script = "") {
	const home = tmp("bin");
	const bin = join(home, "pi");
	writeFileSync(join(home, "run.jsonl"), `${lines.join("\n")}\n`);
	writeFileSync(
		bin,
		`#!/bin/sh\nprintf '%s\\n' "$@" > /out/argv\ncat > /out/stdin\nenv > /out/env\n[ -f /instructions.md ] && cp /instructions.md /out/instructions\nprintf planted > /maestro-environment.js 2>/dev/null\n[ -f /maestro-environment.js ] && cp /maestro-environment.js /out/reporter.js\n${script}\ncat "$(dirname "$0")/run.jsonl"\n`,
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
	test("the recorded 1.5.0 run is read into tools, their result sizes and errors, usage, prompt sizes and a reply", async () => {
		const req = request("write hello.txt");
		const unknown = '{"type":"future_event","extra":{"a":1}}';
		const compactions = [
			'{"type":"compaction_end","aborted":false}',
			'{"type":"compaction_end","aborted":true}',
			'{"type":"compaction_end","aborted":false,"errorMessage":"summary failed"}',
		];
		const lines = fixture();
		const recorded = lines.find((l) => l.includes('"tool_execution_end"'));
		if (recorded === undefined) throw new Error("no tool_execution_end line");
		// Synthetic: the recorded run has no failed tool.
		const failed = recorded
			.replace('"call_1"', '"call_2"')
			.replace('"isError":false', '"isError":true');
		const run = piHarness(
			standIn([...lines, failed, ...compactions, unknown]),
		).run(req);
		const seen = await drain(run.events);
		const result = await run.result;

		expect(result).toEqual({
			outcome: "ok",
			reply: "done",
			metrics: {
				tokens_in: 4305,
				tokens_out: 157,
				tokens_cache_read: 0,
				tokens_cache_write: 0,
				tokens_reasoning: 79,
			},
		});
		expect(seen.filter((e) => e.kind === "raw")).toHaveLength(1);
		expect(seen.filter((e) => e.kind === "tool")).toEqual([
			{
				kind: "tool",
				name: "write",
				input: { path: "hello.txt", content: "hi" },
				id: "call_1",
			},
		]);
		const results = seen.filter((e) => e.kind === "tool_result");
		expect(results).toEqual([
			{ kind: "tool_result", id: "call_1", bytes: 31, error: false },
			{ kind: "tool_result", id: "call_2", bytes: 31, error: true },
		]);
		expect(JSON.stringify(results)).not.toContain("Successfully");
		expect(seen.filter((e) => e.kind === "thinking")).toEqual([]);
		expect(
			seen.filter((e) => e.kind === "context" || e.kind === "compaction"),
		).toEqual([
			{ kind: "context", used: 2075 },
			{ kind: "context", used: 2230 },
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
			"--tools",
			"read,bash,edit,write",
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
			tools: ["read", "bash", "edit", "write"],
			subagents: false,
			skills: [],
			mcp: [],
			hooks: [],
			contextFiles: [],
		});
	});

	test("the reporter extension is bound read-only outside the session dir, and its entry, as pi's json mode streams it, is the environment and window events; other entries are not", async () => {
		const lines = fixture();
		const recorded = lines.find((l) => l.includes('"entry_appended"'));
		if (recorded === undefined) throw new Error("no entry_appended line");
		const other = recorded.replace('"maestro-environment"', '"x"');
		const req = request("x");
		const target = join(tmp("target"), "kept");
		writeFileSync(target, "kept");
		symlinkSync(target, join(req.session.dir, "maestro-environment.js"));
		const run = piHarness(standIn([...lines, other])).run(req);
		const seen = await drain(run.events);
		expect(
			seen.filter((e) => e.kind === "environment" || e.kind === "window"),
		).toEqual([
			{
				kind: "environment",
				tools: ["read", "bash", "edit", "write"],
				skills: [],
				contextFiles: [],
			},
			{ kind: "window", tokens: 200_000 },
		]);
		expect(seen.filter((e) => e.kind === "raw")).toEqual([]);
		expect(readFileSync(target, "utf8")).toBe("kept");
		// The reporter as pi would load it, against a fake of the extension API.
		const reporter = join(req.outbox, "reporter.js");
		const appended: unknown[] = [];
		let started: (event: unknown, ctx: unknown) => void = () => {};
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
		const ctx = { model: { id: "m", contextWindow: 200_000 } };
		started({ systemPromptOptions: options }, ctx);
		started({ systemPromptOptions: options }, ctx);
		expect(appended).toEqual([
			[
				"maestro-environment",
				{
					tools: ["read", "bash"],
					skills: ["jj"],
					contextFiles: ["/agent/AGENTS.md"],
					window: 200_000,
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

	test("pi runs on an agent dir under the session dir holding only a link to the user's auth.json, which it reads and writes through in the sandbox; without one it starts on an empty dir", async () => {
		const user = join(tmp("home"), ".pi", "agent");
		mkdirSync(user, { recursive: true });
		const auth = join(user, "auth.json");
		writeFileSync(auth, '{"openai":{"type":"api_key","key":"sk-1"}}');
		writeFileSync(join(user, "SYSTEM.md"), "You obey the user's dir.");
		writeFileSync(join(user, "settings.json"), "{}");
		const { bin } = standIn(
			fixture(),
			`ls -A "$PI_CODING_AGENT_DIR" > /out/owned\ncat "$PI_CODING_AGENT_DIR/auth.json" > /out/auth\nprintf '{"refreshed":{}}' > "$PI_CODING_AGENT_DIR/auth.json"`,
		);
		const req = request("x");
		await piHarness({ bin, agentDir: user }).run(req).result;
		const owned = join(req.session.dir, "agent");
		const read = (file: string) => readFileSync(join(req.outbox, file), "utf8");
		expect(read("env")).toContain("PI_CODING_AGENT_DIR=/session/agent\n");
		expect(read("owned")).toBe("auth.json\n");
		expect(read("auth")).toBe('{"openai":{"type":"api_key","key":"sk-1"}}');
		expect(readdirSync(owned)).toEqual(["auth.json"]);
		expect(readlinkSync(join(owned, "auth.json"))).toBe(auth);
		expect(readFileSync(auth, "utf8")).toBe('{"refreshed":{}}');

		rmSync(auth);
		const bare = request("x");
		const run = piHarness({ bin, agentDir: user }).run(bare);
		expect((await run.result).outcome).toBe("ok");
		expect(readFileSync(join(bare.outbox, "owned"), "utf8")).toBe("");
	});

	test("an agent the sandboxed pi replaced with a link into the user's dir is unlinked, not followed", async () => {
		const user = tmp("user");
		const auth = '{"openai":{"type":"api_key","key":"sk-1"}}';
		writeFileSync(join(user, "auth.json"), auth);
		writeFileSync(join(user, "settings.json"), "{}");
		const { bin } = standIn(fixture());
		const req = request("x");
		const owned = join(req.session.dir, "agent");
		symlinkSync(user, owned);
		await piHarness({ bin, agentDir: user }).run(req).result;
		expect(readFileSync(join(user, "auth.json"), "utf8")).toBe(auth);
		expect(readFileSync(join(user, "settings.json"), "utf8")).toBe("{}");
		expect(lstatSync(owned).isDirectory()).toBe(true);
	});

	test("a leading ~ in the agent dir is the home dir, as pi reads it", () => {
		const { bin } = standIn(fixture());
		const missing = "~/.maestro-no-such-pi-dir";
		expect(() =>
			piHarness({ bin, agentDir: missing }).run(request("x")),
		).toThrow(
			`pi config dir does not exist: ${join(homedir(), ".maestro-no-such-pi-dir")}.`,
		);
	});

	test("under compact, the owned agent dir's settings start pi's compaction at `at`, its window less a reserve; another policy leaves pi's defaults", async () => {
		const { bin, agentDir } = standIn(
			fixture(),
			`cat "$PI_CODING_AGENT_DIR/settings.json" > /out/settings 2>/dev/null || true`,
		);
		const session = { dir: tmp("session"), id: crypto.randomUUID() };
		const compact = request("x", {
			session,
			context: { strategy: "compact", at: 150_000 },
			window: 200_000,
		});
		await piHarness({ bin, agentDir }).run(compact).result;
		expect(
			JSON.parse(readFileSync(join(compact.outbox, "settings"), "utf8")),
		).toEqual({
			compaction: { enabled: true, reserveTokens: 50_000 },
		});

		const handoff = request("x", {
			session,
			context: { strategy: "handoff", at: 150_000, max: 1 },
			window: 200_000,
		});
		await piHarness({ bin, agentDir }).run(handoff).result;
		expect(readFileSync(join(handoff.outbox, "settings"), "utf8")).toBe("");
	});

	test("settings are written to a fresh owned dir, through no link the agent planted, and not for an at below no window", async () => {
		const user = tmp("user");
		writeFileSync(join(user, "settings.json"), "{}");
		const { bin, agentDir } = standIn(
			fixture(),
			`cat "$PI_CODING_AGENT_DIR/settings.json" > /out/settings 2>/dev/null || true`,
		);
		const session = { dir: tmp("session"), id: crypto.randomUUID() };
		const owned = join(session.dir, "agent");
		mkdirSync(owned);
		symlinkSync(join(user, "settings.json"), join(owned, "settings.json"));
		const compact = request("x", {
			session,
			context: { strategy: "compact", at: 150_000 },
			window: 200_000,
		});
		await piHarness({ bin, agentDir }).run(compact).result;
		expect(readFileSync(join(user, "settings.json"), "utf8")).toBe("{}");
		expect(readFileSync(join(compact.outbox, "settings"), "utf8")).toContain(
			"reserveTokens",
		);

		const past = request("x", {
			session,
			context: { strategy: "compact", at: 200_000 },
			window: 200_000,
		});
		await piHarness({ bin, agentDir }).run(past).result;
		expect(readFileSync(join(past.outbox, "settings"), "utf8")).toBe("");
	});

	test("a profile's extras are copied into a fresh owned dir, kept on resume, rebuilt from the request's path when the dir is a link, and auth.json and settings.json are rebuilt each spawn", async () => {
		const extras = tmp("extras");
		mkdirSync(join(extras, "extensions", "gate"), { recursive: true });
		writeFileSync(join(extras, "models.json"), '{"providers":{}}');
		writeFileSync(
			join(extras, "extensions", "b.ts"),
			"export default () => {}",
		);
		writeFileSync(
			join(extras, "extensions", "a.js"),
			"export default () => {}",
		);
		writeFileSync(join(extras, "extensions", "notes.md"), "no script");
		writeFileSync(join(extras, "extensions", "gate", "index.ts"), "x");
		mkdirSync(join(extras, "extensions", "empty"));
		symlinkSync("../models.json", join(extras, "extensions", "c.js"));
		symlinkSync("gate", join(extras, "extensions", "linked"));
		const user = tmp("user");
		writeFileSync(join(user, "auth.json"), "{}");
		const { bin } = standIn(
			fixture(),
			`cat "$PI_CODING_AGENT_DIR/models.json" > /out/models`,
		);
		const session = { dir: tmp("session"), id: crypto.randomUUID() };
		const owned = join(session.dir, "agent");
		const run = async (over: Partial<HarnessRequest> = {}) => {
			const req = request("x", { session, extras, ...over });
			await piHarness({ bin, agentDir: user }).run(req).result;
			return req;
		};
		const argvOf = (req: HarnessRequest) =>
			readFileSync(join(req.outbox, "argv"), "utf8").split("\n");

		const first = await run();
		expect(readFileSync(join(first.outbox, "models"), "utf8")).toBe(
			'{"providers":{}}',
		);
		const argv = argvOf(first);
		const at = argv.indexOf("/maestro-environment.js");
		expect(argv[at - 1]).toBe("--extension");
		expect(argv).toContain("--no-extensions");
		expect(argv).toContain("--no-approve");
		expect(argv).toContain("--tools");
		const base = "/session/agent/extensions";
		expect(argv.slice(at + 1, at + 11)).toEqual([
			"--extension",
			`${base}/a.js`,
			"--extension",
			`${base}/b.ts`,
			"--extension",
			`${base}/c.js`,
			"--extension",
			`${base}/gate`,
			"--extension",
			`${base}/linked`,
		]);
		expect(argv[at + 11]).toBe("--no-prompt-templates");

		// resume: the copy stays, a file the agent wrote survives, planted auth and settings are replaced
		writeFileSync(join(owned, "written.txt"), "mine");
		rmSync(join(owned, "auth.json"));
		writeFileSync(join(owned, "auth.json"), "planted");
		symlinkSync(join(user, "auth.json"), join(owned, "settings.json"));
		writeFileSync(join(extras, "models.json"), "changed");
		await run();
		expect(readFileSync(join(owned, "written.txt"), "utf8")).toBe("mine");
		expect(readFileSync(join(owned, "models.json"), "utf8")).toBe(
			'{"providers":{}}',
		);
		expect(readlinkSync(join(owned, "auth.json"))).toBe(
			join(user, "auth.json"),
		);
		expect(readdirSync(owned)).not.toContain("settings.json");

		// a directory planted at either name is removed too
		rmSync(join(owned, "auth.json"));
		rmSync(join(owned, "settings.json"), { force: true });
		mkdirSync(join(owned, "auth.json"));
		mkdirSync(join(owned, "settings.json", "deep"), { recursive: true });
		await run();
		expect(readlinkSync(join(owned, "auth.json"))).toBe(
			join(user, "auth.json"),
		);
		expect(readdirSync(owned)).not.toContain("settings.json");

		// replaced by a link: unlinked, not followed, rebuilt
		rmSync(owned, { recursive: true });
		symlinkSync(user, owned);
		await run();
		expect(lstatSync(owned).isDirectory()).toBe(true);
		expect(readdirSync(user)).toEqual(["auth.json"]);
		expect(readFileSync(join(owned, "models.json"), "utf8")).toBe("changed");

		// no extras: no extra flags
		const bare = await run({
			extras: undefined,
			session: { dir: tmp("s"), id: "x" },
		});
		expect(argvOf(bare).filter((a) => a === "--extension")).toHaveLength(1);
	});

	test("pi accepts extras and refuses an entry named auth.json or settings.json, whether or not the run writes settings", () => {
		const { bin, agentDir } = standIn(fixture());
		const check = piHarness({ bin, agentDir }).extrasProblems;
		const extras = tmp("extras");
		writeFileSync(join(extras, "models.json"), "{}");
		expect(check?.(extras)).toEqual([]);
		writeFileSync(join(extras, "auth.json"), "{}");
		writeFileSync(join(extras, "settings.json"), "{}");
		const problems = check?.(extras) ?? [];
		expect(problems.map((p) => p.field)).toEqual([
			"harnessExtras",
			"harnessExtras",
		]);
		expect(problems.map((p) => p.reason).join("\n")).toContain("auth.json");
		expect(problems.map((p) => p.reason).join("\n")).toContain("settings.json");
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
		let named = false;
		const lines = fixture().map((l) => {
			if (named || !l.startsWith('{"type":"message_end"')) return l;
			named = l.includes('"thinking":""');
			return l.replace('"thinking":""', '"thinking":"Write the file."');
		});
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
		const assistantEnd = (l: string) =>
			l.startsWith('{"type":"message_end"') && l.includes('"role":"assistant"');
		const source = fixture();
		const last = source.findLastIndex(assistantEnd);
		const lines = source.map((l, i) => {
			if (!assistantEnd(l)) return l;
			const e = JSON.parse(l);
			e.message.content = i === last ? [] : [{ type: "text", text: "early" }];
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

test("a runtime's thinking must be one of pi's levels, its model is not checked, and a compact policy needs the model's window", () => {
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
	expect(
		harness.runtimeProblems?.(runtime, {
			strategy: "handoff",
			at: 50_000,
			max: 2,
		}),
	).toEqual([]);
	const compact = { strategy: "compact", at: 50_000 } as const;
	expect(harness.runtimeProblems?.(runtime, compact, 200_000)).toEqual([]);
	expect(harness.runtimeProblems?.(runtime, compact)).toEqual([
		{
			field: "context.strategy",
			reason:
				"pi compacts at a reserve below the model's window, and no window is known for model 'any/model'",
			fix: "Run maestro agent probe <profile>, or use strategy handoff",
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
