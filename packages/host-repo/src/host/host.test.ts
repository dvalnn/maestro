import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { compose } from "@maestro/core/compose";
import { CORE_CONFIG } from "@maestro/core/config";
import type { Host, HostSetup } from "@maestro/core/host";
import { concertDirs, openRecord, perform } from "@maestro/core/perform";
import { type HostNode, type Ir, type IrEdge, parseIr } from "@maestro/ir";
import {
	type Harness,
	type HarnessRequest,
	OUTBOX,
	type StubStep,
	stubHarness,
} from "../harness/index";
import { runProcesses } from "../sandbox/bubblewrap";
import { repoHost } from "./index";
import { openTarget } from "./store";

const dirs: string[] = [];
const tmp = (name: string) => {
	const d = mkdtempSync(join(tmpdir(), `host-${name}-`));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const GIT_ENV = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "op",
	GIT_AUTHOR_EMAIL: "op@x",
	GIT_COMMITTER_NAME: "op",
	GIT_COMMITTER_EMAIL: "op@x",
};

function toyTarget(): string {
	const t = tmp("target");
	const git = (...args: string[]) => {
		const p = Bun.spawnSync(["git", ...args], { cwd: t, env: GIT_ENV });
		if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr}`);
	};
	git("init", "-q", "-b", "main");
	writeFileSync(join(t, "a.txt"), "a\n");
	git("add", "a.txt");
	git("commit", "-qm", "one");
	return t;
}

/** Every entry under `dir` with its kind, size, mtime, ctime and content. Atime is left out. */
function snapshot(dir: string): string[] {
	const out: string[] = [];
	const walk = (p: string) => {
		const s = lstatSync(p, { bigint: true });
		const body = s.isFile() ? readFileSync(p, "latin1") : "";
		out.push(
			`${relative(dir, p)} ${s.mode} ${s.size} ${s.mtimeNs} ${s.ctimeNs} ${body}`,
		);
		if (s.isDirectory())
			for (const e of readdirSync(p).sort()) walk(join(p, e));
	};
	walk(dir);
	return out;
}

const ROLES = {
	builder: { harness: "stub", model: "none" },
	other: { harness: "other", model: "none" },
};
const CHECKS = {
	hello: "test -f hello.txt && touch from-check.txt",
	red: ["true", "exit 1"],
	missing: "no-such-command",
};

/** A harness named `other` that must never be run. */
const other: Harness = {
	name: "other",
	run: () => {
		throw new Error("other was run");
	},
};

/** A repo host whose stub harness replays what `steps` gives each request, and the requests it got. */
function stubHost(steps: (req: HarnessRequest) => StubStep[]) {
	const requests: HarnessRequest[] = [];
	const host = repoHost({
		harnesses: [
			stubHarness((req) => {
				requests.push(req);
				return steps(req);
			}),
			other,
		],
	});
	return { host, requests };
}

const fresh = { mode: "fresh" };

const reply = (envelope: unknown): StubStep => ({
	emit: { type: "text", text: JSON.stringify(envelope) },
});
const OK = reply({ outcome: "ok", report: "done" });

type NodeSpec = {
	id: string;
	kind: "agent" | "check";
	config: Record<string, unknown>;
	literals?: Record<string, unknown>;
	lane?: string;
	identity?: boolean;
};

/** A node of `host` with the ports its kind gives it, fed by `literals` and, from `lane`, an edge. */
function repoNode(
	host: Host,
	spec: NodeSpec,
): { node: HostNode; edges: IrEdge[] } {
	const kind = `repo.${spec.kind}` as const;
	const draft: HostNode = {
		id: spec.id,
		kind,
		config: spec.config,
		...(spec.identity && { in: { identity: { type: "string" } } }),
	};
	const ports = host.kinds.find((k) => k.name === kind)?.ports(draft);
	const node = {
		...draft,
		in: ports?.in,
		out: ports?.out,
		literals: spec.literals,
	};
	const edges: IrEdge[] = spec.lane
		? [
				{
					kind: "data",
					from: { node: spec.lane, port: "lane" },
					to: { node: spec.id, port: "lane" },
				},
			]
		: [];
	return { node, edges };
}

function irOf(host: Host, specs: NodeSpec[], result: string): Ir {
	const built = specs.map((s) => repoNode(host, s));
	const parsed = parseIr({
		irVersion: "1.0",
		composition: { id: "toy", version: "0.1.0", pack: "test" },
		emitter: { name: "hand", version: "0.1.0" },
		scopes: [],
		nodes: built.map((b) => b.node),
		edges: built.flatMap((b) => b.edges),
		result: { node: result },
	});
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
	return parsed.ir;
}

function configOf(target: string, extra: Record<string, unknown> = {}) {
	const dataRoot = tmp("data");
	return {
		values: {
			concurrency: 4,
			caps: {},
			dataRoot,
			workspace: "",
			target: { repo: target, base: "main", checks: CHECKS },
			roles: ROLES,
			...extra,
		},
		sources: [],
	};
}

const setupOf = (config: ReturnType<typeof configOf>): HostSetup => ({
	config: { target: config.values.target, roles: config.values.roles },
	store: join(config.values.dataRoot, "hosts", "repo"),
});

const noCode = async () => () => ({});

async function start(
	host: Host,
	ir: Ir,
	config: ReturnType<typeof configOf>,
	resume?: string,
) {
	const composed = await compose({
		ir,
		config,
		core: CORE_CONFIG,
		packs: {},
		hosts: [host],
		loadCode: noCode,
		caps: {},
	});
	if (!composed.ok) throw new Error(JSON.stringify(composed.diagnostics));
	const dir = join(config.values.dataRoot, "concerts");
	const recordPath = join(config.values.dataRoot, "record.db");
	const concert = await perform({
		ir,
		hosts: [host],
		config,
		loadCode: noCode,
		recordPath,
		dir,
		concurrency: 4,
		resume,
	});
	return { concert, dir, recordPath };
}

async function performed(
	host: Host,
	ir: Ir,
	config: ReturnType<typeof configOf>,
	resume?: string,
) {
	const { concert, dir, recordPath } = await start(host, ir, config, resume);
	const result = await concert.done;
	const record = openRecord(recordPath);
	const instances = record.instances(concert.id);
	record.close();
	const artifact = (node: string, port: string) => {
		const ref = instances.find((i) => i.node === node)?.outputs?.[port] as {
			path: string;
		};
		return join(concertDirs(dir, concert.id).artifacts, ref.path);
	};
	return { id: concert.id, result, instances, artifact };
}

const changed = async (
	config: ReturnType<typeof configOf>,
	target: string,
	version: string,
) =>
	(
		await openTarget(setupOf(config).store, target).lanes.changeset(version)
	).patches.join("");

describe("compose", () => {
	test("a double join and a resume across harnesses are HOST errors, with no harness run", async () => {
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
					config: { role: { name: "builder" }, lane: { mode: "join" } },
					literals: prompt,
					lane: "a",
				},
				{
					id: "c",
					kind: "agent",
					config: {
						role: { name: "other" },
						lane: { mode: "join" },
						resume: true,
					},
					literals: prompt,
					lane: "a",
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
				"'c' joins 'a.lane', which 'b' joins too; a version is joined at most once",
			],
			[
				"HOST.resume",
				"c",
				"'c' runs on harness 'other' and resumes 'a', written on harness 'stub'",
			],
		]);
		expect(requests).toEqual([]);
	});

	test.each([
		[
			"a role config lacks",
			{ role: { name: "nobody" }, lane: fresh },
			"HOST.role",
			"Use one of: 'builder', 'other'",
		],
		[
			"a harness not loaded",
			{ role: { name: "builder", harness: "gone" }, lane: fresh },
			"HOST.harness",
			"Use one of: 'stub', 'other'",
		],
		[
			"a missing read-only bind",
			{ role: { name: "builder" }, lane: fresh, readOnly: ["/no/such/path"] },
			"HOST.bind",
			"Create it, or drop the bind",
		],
		[
			"a relative read-only bind",
			{ role: { name: "builder" }, lane: fresh, readOnly: ["notes"] },
			"HOST.bind",
			"Give an absolute path",
		],
		[
			"a resume of a fresh lane",
			{ role: { name: "builder" }, lane: fresh, resume: true },
			"HOST.resume",
			"Drop resume from 'x'",
		],
	])("an agent naming %s is a HOST error", async (_, config, code, hint) => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[{ id: "x", kind: "agent", config, literals: { prompt: "go" } }],
			"x",
		);
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
		).toEqual([[code, hint]]);
	});

	test("a check name config lacks is a HOST error listing the target's checks", async () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[{ id: "x", kind: "check", config: { lane: fresh, check: "lint" } }],
			"x",
		);
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
	});
});

describe("perform", () => {
	test("fresh, agent, read check, then an agent joining with resume continues the first agent's session", async () => {
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
						lane: { mode: "join" },
						resume: true,
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
		["red", "rejected", "check 'red' line 2 exited 1: exit 1"],
		["missing", "failed", "check 'missing' line 1 exited 127: no-such-command"],
		[
			undefined,
			"failed",
			"check 'hello' line 1 exited 1: test -f hello.txt && touch from-check.txt; check 'red' line 2",
		],
		[
			{ run: "sleep 5", timeout: "1s" },
			"failed",
			"check 'inline' line 1 exited 124: sleep 5",
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
		["join", "fails"],
		["fresh", "is cancelled"],
		["fork", "is cancelled"],
		["join", "is cancelled"],
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
			reason: "check 'inline' line 1 was killed by signal SIGKILL: sleep 300",
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

/** Live processes of any sandbox. */
const sandboxed = () => runProcesses("");

test("param reads a lane ref and refuses other text", () => {
	const { host } = stubHost(() => []);
	expect(host.param?.("repo.lane", "c1.lens[risk]/skeptic")).toEqual({
		value: "c1.lens[risk]/skeptic",
	});
	expect(host.param?.("repo.lane", "nodot")).toMatchObject({
		diagnostics: [{ code: "HOST.param" }],
	});
});
