import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compose } from "@maestro/core/compose";
import { CORE_CONFIG } from "@maestro/core/config";
import { openRecord } from "@maestro/core/perform";
import { type HarnessRequest, OUTBOX, type StubStep } from "../harness/index";
import { runProcesses } from "../sandbox/bubblewrap";
import { openTarget } from "./store";
import {
	changed,
	cleanup,
	configOf,
	fresh,
	irOf,
	type NodeSpec,
	noCode,
	OK,
	performed,
	reply,
	setupOf,
	snapshot,
	start,
	stubHost,
	tmp,
	toyTarget,
} from "./test-support";

afterEach(cleanup);

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
			],
			"c",
		);
		const composed = await compose({
			ir,
			config: configOf(target),
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

	const applied: NodeSpec = {
		id: "ap",
		kind: "apply",
		config: { lane: { mode: "fork" } },
		lane: "root",
		wires: { changeset: "cs.changeset" },
	};
	test.each([
		[
			"an apply",
			[{ ...applied, id: "w" }],
			"'r' resumes 'w', which carries 'w', a 'repo.apply' node and no agent session",
		],
		[
			"a check on a fresh lane",
			[{ id: "w", kind: "check", config: { lane: fresh, check: "hello" } }],
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
			],
			"'r' resumes 'w', which carries 'ap', a 'repo.apply' node and no agent session",
		],
	] as [string, NodeSpec[], string][])(
		"a resume of the version of %s is a HOST error",
		async (_, writers, message) => {
			const { host } = stubHost(() => [OK]);
			const task = { prompt: "go" };
			const specs: NodeSpec[] = [
				{
					id: "root",
					kind: "agent",
					config: { role: { name: "builder" }, lane: fresh },
					literals: task,
				},
				{ id: "cs", kind: "changeset", config: {}, lane: "root" },
				...writers,
				{
					id: "r",
					kind: "agent",
					config: {
						role: { name: "builder" },
						lane: { mode: "extend", resume: true },
					},
					literals: task,
					lane: "w",
				},
			];
			const composed = await compose({
				ir: irOf(host, specs, "r"),
				config: configOf(toyTarget()),
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.message]),
			).toEqual([["HOST.resume", message]]);
		},
	);

	test.each([
		[
			"agent",
			{ role: { name: "builder" }, lane: fresh, refs: {} },
			"config 'refs' is now 'attachments'",
		],
		[
			"apply",
			{ lane: fresh, strategy: "ff" },
			"config strategy 'ff' is now 'clean'",
		],
	])(
		"a retired %s config shape is refused, naming its replacement",
		(kind, config, message) => {
			const { host } = stubHost(() => [OK]);
			const found = host.kinds.find((k) => k.name === `repo.${kind}`);
			expect(() =>
				found?.ports({ id: "x", kind: `repo.${kind}`, config }),
			).toThrow(`${message}\nRebuild the composition with the current SDK`);
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
			"Set 'target.repo' relative to the config file's directory",
			() => join(tmp("gone"), "missing"),
		],
	])(
		"an agent naming %s is a HOST error",
		async (_, config, code, hint, target) => {
			const { host } = stubHost(() => [OK]);
			const ir = irOf(
				host,
				[{ id: "x", kind: "agent", config, literals: { prompt: "go" } }],
				"x",
			);
			const composed = await compose({
				ir,
				config: configOf(target()),
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.hint]),
			).toEqual([[code, hint]]);
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
		["missing", "failed", "check 'missing' line 1 exited 127"],
		[
			undefined,
			"failed",
			"check 'hello' line 1 exited 1; check 'red' line 2 exited 1",
		],
		[
			{ run: "sleep 5", timeout: "1s" },
			"failed",
			"check 'inline' line 1 exited 124",
		],
		[{ run: "exit 137" }, "failed", "check 'inline' line 1 exited 137"],
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
		expect(result.outcome === "ok" ? "" : result.reason).toContain(reason);
		expect(readFileSync(artifact("x", "logs"), "utf8")).toContain("$ ");
	});

	test("a rejecting agent is rejected with its reason and outputs", async () => {
		const { host } = stubHost(() => [
			reply({ outcome: "rejected", reason: "not doable", report: "tried" }),
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
		const { result } = await performed(host, ir, configOf(toyTarget()));
		expect(result).toMatchObject({
			outcome: "rejected",
			reason: "not doable",
			outputs: { report: "tried" },
		});
	});

	test("a rejecting agent that misses a declared output is rejected at once, with no outputs", async () => {
		const { host, requests } = stubHost(() => [
			reply({ outcome: "rejected", reason: "not doable", report: "tried" }),
		]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: {
						role: { name: "builder" },
						lane: { mode: "fresh" },
						out: { notes: { file: "notes.md", format: "markdown" } },
					},
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const { result } = await performed(host, ir, configOf(toyTarget()));
		expect(requests).toHaveLength(1);
		expect(result).toMatchObject({ outcome: "rejected", reason: "not doable" });
		expect("outputs" in result).toBe(false);
	});

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
			expect(existsSync(join(root, "lanes", first.concert.id, "x"))).toBe(
				false,
			);
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

const parentOf = (pid: number) =>
	Number(/\) \S (\d+)/.exec(readFileSync(`/proc/${pid}/stat`, "utf8"))?.[1]);

/** Whether `pid` descends from this process, by its parent chain. */
function ownedProcess(pid: number): boolean {
	try {
		for (let p = pid; p > 1; p = parentOf(p))
			if (p === process.pid) return true;
	} catch {} // exited while walking
	return false;
}

/** Live sandbox processes this process started, so a run in another checkout does not count. */
const sandboxed = () => runProcesses("").filter(ownedProcess);

test("param reads a lane ref and refuses other text", () => {
	const { host } = stubHost(() => []);
	expect(host.param?.("repo.lane", "c1.lens[risk]/skeptic")).toEqual({
		value: "c1.lens[risk]/skeptic",
	});
	expect(host.param?.("repo.lane", "nodot")).toMatchObject({
		diagnostics: [{ code: "HOST.param" }],
	});
});
