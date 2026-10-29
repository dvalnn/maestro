import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compose } from "@maestro/core/compose";
import { CORE_CONFIG } from "@maestro/core/config";
import { openRecord } from "@maestro/core/perform";
import { indexGraph } from "@maestro/ir";
import { type HarnessRequest, OUTBOX, type StubStep } from "../harness/index";
import { openTarget } from "./store";
import {
	APPROVED,
	changed,
	cleanup,
	commitTo,
	configOf,
	fresh,
	irOf,
	type NodeSpec,
	noCode,
	OK,
	performed,
	ROOTS,
	reply,
	sandboxed,
	setupOf,
	snapshot,
	start,
	stubHost,
	tmp,
	toyTarget,
} from "./test-support";

afterEach(cleanup);

/** Waits until the lane directory `lane` is gone. */
async function dropped(lane: string) {
	for (let i = 0; i < 100 && existsSync(lane); i++) await Bun.sleep(20);
}

describe("compose", () => {
	test("a double extension and a resume across harnesses are HOST errors, with no harness run", async () => {
		const target = toyTarget();
		const { host, requests } = stubHost(() => [OK]);
		const prompt = { prompt: "go" };
		const ir = irOf(
			host,
			[
				{
					id: "a",
					kind: "agent",
					config: { role: { name: "builder" }, lane: { mode: "fresh" } },
					literals: prompt,
				},
				{
					id: "b",
					kind: "agent",
					config: { role: { name: "builder" }, lane: { mode: "extend" } },
					literals: prompt,
					lane: "a",
				},
				{
					id: "c",
					kind: "agent",
					config: {
						role: { name: "other" },
						lane: { mode: "extend", resume: true },
					},
					literals: prompt,
					lane: "a",
				},
				{
					id: "e",
					kind: "agent",
					config: { role: { name: "builder" }, lane: { mode: "fresh" } },
					literals: prompt,
				},
				{
					id: "k",
					kind: "check",
					config: { lane: { mode: "extend" }, check: "hello" },
					lane: "e",
				},
				{
					id: "d",
					kind: "agent",
					config: {
						role: { name: "other" },
						lane: { mode: "extend", resume: true },
					},
					literals: prompt,
					lane: "k",
				},
				{ id: "m", kind: "commits", config: { revs: "main^!" } },
				{
					id: "f",
					kind: "agent",
					config: { role: { name: "builder" }, lane: { mode: "extend" } },
					literals: prompt,
					lane: "m",
				},
			],
			"c",
		);
		const composed = await compose({
			ir,
			config: configOf(target),
			roots: ROOTS,
			core: CORE_CONFIG,
			packs: {},
			hosts: [host],
			loadCode: noCode,
			caps: {},
		});
		expect(composed.ok).toBe(false);
		const found = composed.ok
			? []
			: composed.diagnostics.map((d) => [d.code, d.node, d.message]);
		expect(found).toEqual([
			[
				"HOST.lane",
				"c",
				"'c' extends 'a.lane', which 'b' extends too; a version is extended at most once",
			],
			[
				"HOST.lane",
				"f",
				"'f' extends 'm.lane', a version of target commits, which only a fork or a read can take",
			],
			[
				"HOST.resume",
				"c",
				"'c' runs on harness 'other' and resumes 'a', written on harness 'stub'",
			],
			[
				"HOST.resume",
				"d",
				"'d' runs on harness 'other' and resumes 'k', written on harness 'stub'",
			],
		]);
		expect(requests).toEqual([]);
	});

	test("a profile name in config that is neither bare nor <pack id>/<name> is refused at compose", async () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "a",
					kind: "agent",
					config: { role: { name: "builder" }, lane: fresh },
					literals: { prompt: "go" },
				},
			],
			"a",
		);
		const profiles = { Foo: {}, "a/b/c": {}, "classics/builder": {} };
		const composed = await compose({
			ir,
			config: configOf(toyTarget(), { profiles }),
			roots: ROOTS,
			core: CORE_CONFIG,
			packs: {},
			hosts: [host],
			loadCode: noCode,
			caps: {},
		});
		expect(
			composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.message]),
		).toEqual([
			["CFG.schema", "config 'profiles.Foo' is not an allowed name"],
			["CFG.schema", "config 'profiles.a/b/c' is not an allowed name"],
		]);
	});

	test("needs names the role of each agent and each check a node names", () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "a",
					kind: "agent",
					config: {
						role: { name: "builder" },
						lane: { mode: "fresh" },
						checks: ["lint"],
					},
					literals: { prompt: "go" },
				},
				{
					id: "k",
					kind: "check",
					config: { lane: { mode: "extend" }, check: "hello" },
					lane: "a",
				},
			],
			"k",
		);
		expect(host.needs?.(indexGraph(ir))).toEqual([
			["roles", "builder"],
			["target", "checks", "lint"],
			["target", "checks", "hello"],
		]);
	});

	const task = { prompt: "go" };
	const applied: NodeSpec = {
		id: "ap",
		kind: "apply",
		config: { lane: { mode: "fork" } },
		lane: "root",
		wires: { changeset: "cs.changeset" },
	};
	const writer: NodeSpec = {
		id: "w",
		kind: "agent",
		config: { role: { name: "builder" }, lane: fresh },
		literals: task,
	};
	/** An agent that resumes the version out of `from`. */
	const resumer = (id: string, from: string, role = "builder"): NodeSpec => ({
		id,
		kind: "agent",
		config: { role: { name: role }, lane: { mode: "extend", resume: true } },
		literals: task,
		lane: from,
	});
	const stepCheck = (lane: Record<string, unknown>): NodeSpec => ({
		id: "lp/step",
		kind: "check",
		config: { lane, check: "hello" },
		...(lane.mode === "extend" && { lane: "lp" }),
	});
	const checkOnFresh: NodeSpec = {
		id: "w",
		kind: "check",
		config: { lane: fresh, check: "hello" },
	};
	/** A row: the nodes after `root` and its changeset, the result node, the loop `lp` and where its state starts. */
	type Row = [string, NodeSpec[], string, string | undefined, string?];
	test.each([
		[
			"an apply",
			[{ ...applied, id: "w" }, resumer("r", "w")],
			"r",
			undefined,
			"'r' resumes 'w', which carries 'w', a 'repo.apply' node and no agent session",
		],
		[
			"a check on a fresh lane",
			[checkOnFresh, resumer("r", "w")],
			"r",
			undefined,
			"'r' resumes 'w', which carries 'w', a check on a 'fresh' lane and no agent session",
		],
		[
			"a check extending an apply",
			[
				applied,
				{
					id: "w",
					kind: "check",
					config: { lane: { mode: "extend" }, check: "hello" },
					lane: "ap",
				},
				resumer("r", "w"),
			],
			"r",
			undefined,
			"'r' resumes 'w', which carries 'ap', a 'repo.apply' node and no agent session",
		],
		[
			"loop state started by an apply, resumed by the step",
			[applied, resumer("lp/step", "lp")],
			"lp",
			"ap",
			"'lp/step' resumes 'lp', which carries 'ap', a 'repo.apply' node and no agent session",
		],
		[
			"loop state, resumed by a step on another harness than its starter",
			[writer, resumer("lp/step", "lp", "other")],
			"lp",
			"w",
			"'lp/step' runs on harness 'other' and resumes 'lp', written on harness 'stub'",
		],
		[
			"loop state whose step is a check on a fresh lane",
			[writer, stepCheck(fresh), resumer("r", "lp")],
			"r",
			"w",
			"'r' resumes 'lp', which carries 'lp/step', a check on a 'fresh' lane and no agent session",
		],
		[
			"loop state whose step is a check extending it, started by an apply",
			[applied, stepCheck({ mode: "extend" }), resumer("r", "lp")],
			"r",
			"ap",
			"'r' resumes 'lp', which carries 'ap', a 'repo.apply' node and no agent session",
		],
		[
			"loop state started by an agent on the same harness, resumed by the step",
			[writer, resumer("lp/step", "lp")],
			"lp",
			"w",
			undefined,
		],
	] as Row[])(
		"a resume of the version of %s",
		async (_, nodes, result, start, message) => {
			const { host } = stubHost(() => [OK]);
			const specs: NodeSpec[] = [
				{
					id: "root",
					kind: "agent",
					config: { role: { name: "builder" }, lane: fresh },
					literals: task,
				},
				{ id: "cs", kind: "changeset", config: {}, lane: "root" },
				...nodes,
			];
			const composed = await compose({
				ir: irOf(host, specs, result, start ? { id: "lp", start } : undefined),
				config: configOf(toyTarget()),
				roots: ROOTS,
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.message]),
			).toEqual(message ? [["HOST.resume", message]] : []);
		},
	);

	/** An agent that extends the version out of `from`, without resuming. */
	const extender = (id: string, from: string): NodeSpec => ({
		...resumer(id, from),
		config: { role: { name: "builder" }, lane: { mode: "extend" } },
	});
	const innerCheck: NodeSpec = {
		id: "lp/chk",
		kind: "check",
		config: { lane: { mode: "extend" }, check: "hello" },
		lane: "lp",
	};
	test.each([
		[
			"a step and a node after the loop extend its lane",
			[writer, extender("lp/step", "lp"), extender("r", "lp")],
			[],
		],
		[
			"two nodes after the loop extend its lane",
			[
				writer,
				extender("lp/step", "lp"),
				extender("r", "lp"),
				extender("s", "lp"),
			],
			[
				"'s' extends 'lp.lane', which 'r' extends too; a version is extended at most once",
			],
		],
		[
			"two nodes in the loop extend its state",
			[writer, extender("lp/step", "lp"), innerCheck],
			[
				"'lp/chk' extends 'lp.lane', which 'lp/step' extends too; a version is extended at most once",
			],
		],
	] as [string, NodeSpec[], string[]][])(
		"when %s, compose refuses only a double extension of one side",
		async (_, nodes, messages) => {
			const { host } = stubHost(() => [OK]);
			const specs: NodeSpec[] = [
				{
					id: "root",
					kind: "agent",
					config: { role: { name: "builder" }, lane: fresh },
					literals: task,
				},
				...nodes,
			];
			const result = nodes.some((n) => n.id === "r") ? "r" : "lp";
			const composed = await compose({
				ir: irOf(host, specs, result, { id: "lp", start: "w" }),
				config: configOf(toyTarget()),
				roots: ROOTS,
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => d.message),
			).toEqual(messages);
		},
	);

	test.each([
		[
			"a role config lacks",
			{ role: { name: "nobody" }, lane: fresh },
			"HOST.role",
			"Use one of: 'builder', 'other'",
			toyTarget,
		],
		[
			"a harness not loaded",
			{ role: { name: "builder", harness: "gone" }, lane: fresh },
			"HOST.harness",
			"Use one of: 'stub', 'other'",
			toyTarget,
		],
		[
			"a missing read-only bind",
			{ role: { name: "builder" }, lane: fresh, readOnly: ["/no/such/path"] },
			"HOST.bind",
			"Create it, or drop the bind",
			toyTarget,
		],
		[
			"a relative read-only bind",
			{ role: { name: "builder" }, lane: fresh, readOnly: ["notes"] },
			"HOST.bind",
			"Give an absolute path",
			toyTarget,
		],
		[
			"a relative sandbox.path directory",
			{ role: { name: "builder" }, lane: fresh },
			"HOST.bind",
			"Give an absolute path",
			toyTarget,
			{ sandbox: { path: ["tools"] } },
			"sandbox.path",
		],
		[
			"a target that is no git repository",
			{ role: { name: "builder" }, lane: fresh },
			"HOST.target",
			"Point 'target.repo' at a git repository",
			() => tmp("plain"),
		],
		[
			"a target that does not exist",
			{ role: { name: "builder" }, lane: fresh },
			"HOST.target",
			"Set 'target.repo' relative to the file's workspace root, or the user config's directory",
			() => join(tmp("gone"), "missing"),
		],
	] as [
		string,
		Record<string, unknown>,
		string,
		string,
		() => string,
		Record<string, unknown>?,
		string?,
	][])(
		"an agent naming %s is a HOST error",
		async (_, config, code, hint, target, extra = {}, named = "") => {
			const { host } = stubHost(() => [OK]);
			const ir = irOf(
				host,
				[{ id: "x", kind: "agent", config, literals: { prompt: "go" } }],
				"x",
			);
			const composed = await compose({
				ir,
				config: configOf(target(), extra),
				roots: ROOTS,
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.hint]),
			).toEqual([[code, hint]]);
			expect(composed.ok ? "" : composed.diagnostics[0]?.message).toContain(
				named,
			);
		},
	);

	test.each([
		[
			"a check node",
			{ id: "x", kind: "check", config: { lane: fresh, check: "lint" } },
		],
		[
			"an agent allowed to run it",
			{
				id: "x",
				kind: "agent",
				config: { role: { name: "builder" }, lane: fresh, checks: ["lint"] },
				literals: { prompt: "go" },
			},
		],
	] as [string, NodeSpec][])(
		"%s naming a check config lacks is a HOST error listing the target's checks",
		async (_, spec) => {
			const { host } = stubHost(() => [OK]);
			const ir = irOf(host, [spec], "x");
			const composed = await compose({
				ir,
				config: configOf(toyTarget()),
				roots: ROOTS,
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.hint]),
			).toEqual([["HOST.check", "Use one of: 'hello', 'red', 'missing'"]]);
		},
	);
});

describe("perform", () => {
	test("environment gives code nodes the target, its base and its sparse patterns, null when unset", async () => {
		const { host } = stubHost(() => []);
		const environment = (extra: Record<string, unknown>) => {
			const config = configOf("/repo");
			const target = { ...config.values.target, ...extra };
			return host.environment({ ...setupOf(config), config: { target } });
		};
		expect(await environment({ sparse: ["src"] })).toEqual({
			target: "/repo",
			base: "main",
			sparse: ["src"],
		});
		expect(await environment({})).toMatchObject({ sparse: null });
	});

	test("fresh, agent, read check, then an agent extending with resume continues the first agent's session", async () => {
		const target = toyTarget();
		const before = snapshot(target);
		const { host, requests } = stubHost((req) =>
			req.prompt.startsWith("first")
				? [
						{ write: "hello.txt", content: "hi" },
						{ write: `${OUTBOX}/notes.json`, content: '{"n":1}' },
						{ emit: { type: "usage", tokens_in: 7, tokens_out: 2 } },
						OK,
					]
				: [{ write: "world.txt", content: "w" }, OK],
		);
		const notes = {
			file: "notes.json",
			format: "json",
			schema: { type: "object", required: ["n"] },
		};
		const ir = irOf(
			host,
			[
				{
					id: "first",
					kind: "agent",
					config: {
						role: { name: "builder" },
						lane: { mode: "fresh" },
						out: { notes },
					},
					literals: { prompt: "first task", identity: "You are careful." },
					identity: true,
				},
				{
					id: "look",
					kind: "check",
					config: { lane: { mode: "read" }, check: "hello" },
					lane: "first",
				},
				{
					id: "second",
					kind: "agent",
					config: {
						role: { name: "builder" },
						lane: { mode: "extend", resume: true },
					},
					literals: { prompt: "second task" },
					lane: "first",
				},
			],
			"second",
		);
		const config = configOf(target);
		const { id, result, instances, artifact } = await performed(
			host,
			ir,
			config,
		);

		expect(result).toMatchObject({ outcome: "ok", node: "second" });
		expect(instances.find((i) => i.node === "look")?.status).toBe("ok");
		const [first, second] = requests;
		expect(second?.session).toEqual(
			first?.session as HarnessRequest["session"],
		);
		const series = await changed(config, target, `${id}.second`);
		expect(series).toContain("hello.txt");
		expect(series).toContain("world.txt");
		expect(series).not.toContain("from-check.txt");
		expect(
			JSON.parse(readFileSync(artifact("first", "notes"), "utf8")),
		).toEqual({ n: 1 });
		const staged = artifact("first", "staged");
		expect(readFileSync(join(staged, "identity.md"), "utf8")).toBe(
			"You are careful.",
		);
		expect(readFileSync(join(staged, "prompt.md"), "utf8")).toBe(
			first?.prompt as string,
		);
		expect(first?.prompt).toStartWith("first task\n");
		expect(first?.prompt).toContain(`${OUTBOX}/notes.json`);
		expect(instances.find((i) => i.node === "first")?.metrics).toEqual({
			tokens_in: 7,
			tokens_out: 2,
		});
		expect(snapshot(target)).toEqual(before);
	});

	test.each([
		[1, "ok"],
		[3, "failed"],
	])(
		"%i malformed envelopes end %s, corrected in the same session",
		async (bad, outcome) => {
			const { host, requests } = stubHost(() =>
				requests.length <= bad
					? [{ emit: { type: "text", text: "done!" } }]
					: [OK],
			);
			const ir = irOf(
				host,
				[
					{
						id: "x",
						kind: "agent",
						config: { role: { name: "builder" }, lane: { mode: "fresh" } },
						literals: { prompt: "go" },
					},
				],
				"x",
			);
			const { result } = await performed(host, ir, configOf(toyTarget()));
			expect(result).toMatchObject({ outcome });
			expect(requests).toHaveLength(Math.min(bad + 1, 3));
			expect(new Set(requests.map((r) => r.session.id)).size).toBe(1);
			expect(requests[1]?.prompt).toStartWith(
				"Your final reply is not the envelope: it is not a JSON object.",
			);
		},
	);

	test.each([
		["red", "rejected", "check 'red' line 2 exited 1"],
		[
			"missing",
			"failed",
			"check 'missing' line 1 exited 127: sh: line 1: no-such-command: command not found",
		],
		[
			undefined,
			"failed",
			"check 'hello' line 1 exited 1; check 'red' line 2 exited 1; check 'missing' line 1 exited 127: sh: line 1: no-such-command: command not found",
		],
		[
			{ run: "sleep 5", timeout: "1s" },
			"failed",
			"check 'inline' line 1 exited 124",
		],
		[{ run: "exit 137" }, "failed", "check 'inline' line 1 exited 137"],
		[
			{
				run: ["true", "echo warn >&2; echo bad news; printf '\\n\\n'; exit 1"],
			},
			"rejected",
			"check 'inline' line 2 exited 1: bad news",
		],
		[
			{ run: "echo summary; echo warn >&2; exit 1" },
			"rejected",
			"check 'inline' line 1 exited 1: warn",
		],
		[
			{ run: "printf '\\033[31mred\\033[0m\\tx\\033]0;title\\007\\n'; exit 1" },
			"rejected",
			"check 'inline' line 1 exited 1: red x",
		],
		[
			{ run: "printf '%0250d' 0; exit 1" },
			"rejected",
			`check 'inline' line 1 exited 1: ${"0".repeat(200)}`,
		],
	])("check %j ends %s, naming the line", async (check, outcome, reason) => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "check",
					config: { lane: { mode: "fresh" }, ...(check && { check }) },
				},
			],
			"x",
		);
		const { result, artifact } = await performed(
			host,
			ir,
			configOf(toyTarget()),
		);
		expect(result).toMatchObject({ outcome });
		expect(result.outcome === "ok" ? "" : result.reason).toEndWith(reason);
		expect(readFileSync(artifact("x", "logs"), "utf8")).toContain("$ ");
	});

	/** An IR of one agent `x` that may be a verdict agent and may declare the Markdown output `notes`. */
	const lone = (
		host: Parameters<typeof irOf>[0],
		{ verdict = false, notes = false } = {},
	) =>
		irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: {
						role: { name: "builder" },
						lane: { mode: "fresh" },
						...(verdict && { verdict }),
						...(notes && {
							out: { notes: { file: "notes.md", format: "markdown" } },
						}),
					},
					literals: { prompt: "go" },
				},
			],
			"x",
		);

	test("a verdict agent that rejects is rejected with its reason and outputs", async () => {
		const { host } = stubHost(() => [
			reply({ outcome: "rejected", reason: "not doable", report: "tried" }),
		]);
		const ir = lone(host, { verdict: true });
		const { result } = await performed(host, ir, configOf(toyTarget()));
		expect(result).toMatchObject({
			outcome: "rejected",
			reason: "not doable",
			outputs: { report: "tried" },
		});
	});

	test.each([
		[
			"a verdict agent that rejects",
			true,
			{ outcome: "rejected", reason: "not doable", report: "tried" },
			{ outcome: "rejected", reason: "not doable" },
		],
		[
			"a blocked agent",
			false,
			{ blocked: "no network", report: "tried" },
			{ outcome: "failed", reason: "blocked: no network" },
		],
		[
			"a blocked verdict agent",
			true,
			{ blocked: "no network", report: "tried" },
			{ outcome: "failed", reason: "blocked: no network" },
		],
	])(
		"%s that misses a declared output ends at once as it said, with no outputs",
		async (_, verdict, envelope, ended) => {
			const { host, requests } = stubHost(() => [reply(envelope)]);
			const ir = lone(host, { verdict, notes: true });
			const { result } = await performed(host, ir, configOf(toyTarget()));
			expect(requests).toHaveLength(1);
			expect(result).toMatchObject(ended);
			expect("outputs" in result).toBe(false);
		},
	);

	test.each([
		[
			"a work agent's outcome",
			false,
			{ outcome: "ok", report: "done" },
			"envelope must NOT have additional properties ('outcome')",
			'Add "blocked": "<the cause>" only when you cannot proceed',
			'"outcome"',
		],
		[
			"a verdict agent's missing outcome",
			true,
			{ report: "done" },
			"envelope.outcome is required unless envelope.blocked is set",
			'Set "outcome" to "rejected" when your verdict on the work is negative',
			'Add "blocked"',
		],
		[
			"a verdict agent's blocked beside its verdict",
			true,
			{ blocked: "no network", outcome: "rejected", reason: "x", report: "" },
			"envelope.blocked excludes envelope.outcome and envelope.reason",
			'Set "outcome" to "rejected" when your verdict on the work is negative',
			'Add "blocked"',
		],
	])(
		"%s is corrected, and each prompt states only its kind's fields",
		async (_, verdict, envelope, problem, line, absent) => {
			const { host, requests } = stubHost(() =>
				requests.length <= 1 ? [reply(envelope)] : [verdict ? APPROVED : OK],
			);
			const ir = lone(host, { verdict });
			const { result } = await performed(host, ir, configOf(toyTarget()));
			expect(result).toMatchObject({ outcome: "ok" });
			expect(requests).toHaveLength(2);
			const [first, second] = requests.map((r) => r.prompt);
			expect(second).toStartWith(
				`Your final reply is not the envelope: ${problem}.\n`,
			);
			for (const prompt of [first, second]) {
				expect(prompt).toContain(line);
				expect(prompt).toContain("nothing later in this run will change it");
				expect(prompt).not.toContain(absent);
			}
		},
	);

	test.each([
		["missing", [OK], "output 'notes': the agent wrote no /out/notes.json"],
		[
			"off its schema",
			[{ write: `${OUTBOX}/notes.json`, content: "{}" }, OK],
			"output 'notes': /out/notes.json must have required property 'n'",
		],
		[
			"a link",
			[{ sh: `ln -s /etc/hostname ${OUTBOX}/notes.json` }, OK],
			"output 'notes': /out/notes.json is not a regular file",
		],
	])("a declared output %s fails the agent", async (_, steps, reason) => {
		const { host } = stubHost(() => steps);
		const notes = {
			file: "notes.json",
			format: "json",
			schema: { type: "object", required: ["n"] },
		};
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: {
						role: { name: "builder" },
						lane: { mode: "fresh" },
						out: { notes },
					},
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const { result } = await performed(host, ir, configOf(toyTarget()));
		expect(result).toMatchObject({ outcome: "failed", reason });
	});

	test("cancelling mid-agent kills its processes and records the concert failed", async () => {
		const { host, requests } = stubHost(() => [{ hang: true }]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: { role: { name: "builder" }, lane: { mode: "fresh" } },
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const { concert, recordPath } = await start(
			host,
			ir,
			configOf(toyTarget()),
		);
		while (!requests.length) await Bun.sleep(20);
		let pids: number[] = [];
		while (!pids.length) {
			await Bun.sleep(20);
			pids = sandboxed();
		}
		await concert.cancel();
		const result = await concert.done;
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "the concert was cancelled",
		});
		expect(sandboxed().filter((p) => pids.includes(p))).toEqual([]);
		const record = openRecord(recordPath);
		expect(record.find(concert.id)?.status).toBe("failed");
		expect(record.instances(concert.id).map((i) => [i.node, i.status])).toEqual(
			[["x", "failed"]],
		);
		record.close();
	});

	const watched = {
		file: "w.json",
		format: "json",
		schema: { type: "object" },
	};
	test.each([
		["fresh", "fails"],
		["fork", "fails"],
		["extend", "fails"],
		["fresh", "is cancelled"],
		["fork", "is cancelled"],
		["extend", "is cancelled"],
	])(
		"an agent on a %s lane that %s mid-run resumes to ok in a clean lane",
		async (mode, how) => {
			let attempt = 0;
			const { host, requests } = stubHost(() => {
				attempt++;
				if (attempt > 1)
					return [
						{ write: "done.txt", content: "d" },
						{ write: `${OUTBOX}/w.json`, content: "{}" },
						OK,
					];
				const stale: StubStep = { write: "stale.txt", content: "s" };
				return how === "fails" ? [stale, OK] : [stale, { hang: true }];
			});
			const base = {
				id: "base",
				kind: "check" as const,
				config: { lane: fresh, check: { run: "touch base.txt" } },
			};
			const agent = {
				id: "x",
				kind: "agent" as const,
				config: { role: { name: "builder" }, lane: { mode }, out: { watched } },
				literals: { prompt: "go" },
				...(mode !== "fresh" && { lane: "base" }),
			};
			const ir = irOf(host, [base, agent], "x");
			const config = configOf(toyTarget());
			const first = await start(host, ir, config);
			if (how === "is cancelled") {
				while (!requests.length) await Bun.sleep(20);
				while (!sandboxed().length) await Bun.sleep(20);
				await first.concert.cancel();
			}
			expect(await first.concert.done).toMatchObject({ outcome: "failed" });
			const { root } = openTarget(
				setupOf(config).store,
				config.values.target.repo,
			);
			// A cancelled agent keeps its changes as a partial before its lane is dropped.
			const lane = join(root, "lanes", first.concert.id, "x");
			await dropped(lane);
			expect(existsSync(lane)).toBe(false);
			const { result } = await performed(host, ir, config, first.concert.id);
			expect(result).toMatchObject({ outcome: "ok", node: "x" });
			const series = await changed(
				config,
				config.values.target.repo,
				`${first.concert.id}.x`,
			);
			expect(series).toContain("done.txt");
			expect(series).not.toContain("stale.txt");
			expect(series.includes("base.txt")).toBe(mode !== "fresh");
		},
	);

	test("a rejected check that sealed its version runs again on resume", async () => {
		const flags = tmp("flags");
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "check",
					config: {
						lane: fresh,
						check: { run: [`touch seen.txt`, `test -f ${flags}/go`] },
					},
				},
			],
			"x",
		);
		const config = configOf(toyTarget(), { sandbox: { readOnly: [flags] } });
		const first = await performed(host, ir, config);
		expect(first.result).toMatchObject({ outcome: "rejected" });
		writeFileSync(join(flags, "go"), "");
		const again = await performed(host, ir, config, first.id);
		expect(again.result).toMatchObject({ outcome: "ok" });
		expect(
			await changed(config, config.values.target.repo, `${first.id}.x`),
		).toContain("seen.txt");
	});

	test("a check line killed by a signal fails, naming the signal and the line", async () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "check",
					config: { lane: fresh, check: { run: "sleep 300" } },
				},
			],
			"x",
		);
		const done = performed(host, ir, configOf(toyTarget()));
		let pids: number[] = [];
		while (!pids.length) {
			await Bun.sleep(20);
			pids = sandboxed();
		}
		for (const pid of pids) process.kill(pid, "SIGKILL");
		expect((await done).result).toMatchObject({
			outcome: "failed",
			reason: "check 'inline' line 1 was killed by signal SIGKILL",
		});
	});

	test("usage counts a concert's lanes and sessions, and release frees them", async () => {
		const { host } = stubHost(() => [
			{ write: "big.txt", content: "x".repeat(64 * 1024) },
			OK,
		]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: { role: { name: "builder" }, lane: { mode: "fresh" } },
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const config = configOf(toyTarget());
		const { id, result } = await performed(host, ir, config);
		expect(result.outcome).toBe("ok");
		const setup = setupOf(config);
		expect(await host.resources?.usage(id, setup)).toBeGreaterThan(64 * 1024);
		await host.resources?.release(id, setup);
		expect(await host.resources?.usage(id, setup)).toBe(0);
		const root = openTarget(setup.store, config.values.target.repo).root;
		expect(
			readdirSync(join(root, "sessions")).filter((f) => f !== "written"),
		).toEqual([]);
		expect(readdirSync(join(root, "sessions", "written"))).toEqual([]);
	});
	test("a malformed session record is named by usage, and release still frees the concert", async () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: { role: { name: "builder" }, lane: fresh },
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const config = configOf(toyTarget());
		const { id, result } = await performed(host, ir, config);
		expect(result.outcome).toBe("ok");
		const setup = setupOf(config);
		const root = openTarget(setup.store, config.values.target.repo).root;
		const [session] = readdirSync(join(root, "sessions")).filter(
			(f) => f !== "written",
		);
		const record = join(root, "sessions", session ?? "", "session.json");
		writeFileSync(record, "{not json");
		await expect(host.resources?.usage(id, setup)).rejects.toThrow(
			`session record '${record}' is malformed. Prune concert ${id} to remove it`,
		);
		await host.resources?.release(id, setup);
		expect(await host.resources?.usage(id, setup)).toBe(0);
		expect(readdirSync(join(root, "sessions"))).toEqual(["written"]);
		expect(existsSync(join(root, "lanes", id))).toBe(false);
	});
});

test("a commits version reads, forks and makes a changeset, and keeps its commits after the branch moves", async () => {
	const { host } = stubHost(() => [OK]);
	const target = toyTarget();
	commitTo(target, { "b.txt": "b\n" });
	const ir = irOf(
		host,
		[
			{ id: "commits", kind: "commits", config: { revs: "main^!" } },
			...["read", "fork"].map((mode) => ({
				id: mode,
				kind: "agent" as const,
				config: { role: { name: "builder" }, lane: { mode } },
				literals: { prompt: "go" },
				lane: "commits",
			})),
			{ id: "patches", kind: "changeset", config: {}, lane: "commits" },
		],
		"patches",
	);
	const config = configOf(target);
	const { id, result, artifact } = await performed(host, ir, config);
	expect(result).toMatchObject({ outcome: "ok" });
	const patches = artifact("patches", "changeset");
	expect(readdirSync(patches)).toEqual(["0001.patch", "base"]);
	expect(readFileSync(join(patches, "0001.patch"), "utf8")).toContain("b.txt");
	expect(await changed(config, target, `${id}.fork`)).toContain("b.txt");
	commitTo(target, { "c.txt": "c\n" });
	const pinned = await changed(config, target, `${id}.commits`);
	expect(pinned).toContain("b.txt");
	expect(pinned).not.toContain("c.txt");
});

test("param reads a lane ref and refuses other text", () => {
	const { host } = stubHost(() => []);
	expect(host.param?.("repo.lane", "c1.lens[risk]/skeptic")).toEqual({
		value: "c1.lens[risk]/skeptic",
	});
	expect(host.param?.("repo.lane", "nodot")).toMatchObject({
		diagnostics: [{ code: "HOST.param" }],
	});
});
