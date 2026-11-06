import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compose } from "@maestro/core/compose";
import { CORE_CONFIG } from "@maestro/core/config";
import { openRecord } from "@maestro/core/perform";
import { OUTBOX } from "../harness/index";
import * as sandbox from "../sandbox/index";
import { repoSetup } from "./config";
import { TAIL_LINES } from "./run-lines";
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
	ROOTS,
	sandboxed,
	setupOf,
	start,
	stubHost,
	tmp,
	toyTarget,
} from "./test-support";

afterEach(cleanup);

/** Prints the node instance whose lane the shell is in, read from the lane's `.git` file. */
const NODE = `basename "$(dirname "$(sed 's/^gitdir: //' .git)")"`;

/** Config whose target is `target` with `prepare`, and no checks. */
const prepared = (target: string, prepare: unknown) =>
	configOf(target, { target: { repo: target, base: "main", prepare } });

const inline = (
	id: string,
	lane: object,
	run: unknown,
	from?: string,
): NodeSpec => ({
	id,
	kind: "check",
	config: { lane, check: typeof run === "object" ? run : { run } },
	...(from && { lane: from }),
});

const agent = (id: string, mode: string, from?: string): NodeSpec => ({
	id,
	kind: "agent",
	config: { profile: "builder", seat: "builder", lane: { mode } },
	literals: { prompt: id },
	...(from && { lane: from }),
});

const laneOf = (
	config: ReturnType<typeof configOf>,
	id: string,
	node: string,
) =>
	join(
		openTarget(setupOf(config).store, config.values.target.repo).root,
		"lanes",
		id,
		node,
	);

/** The prepare events of `concert` in the record at `recordPath`. */
function prepareEvents(recordPath: string, concert: string) {
	const record = openRecord(recordPath);
	const events = record
		.events(concert)
		.flatMap((e) => (e.type === "progress" ? [e.event] : []));
	record.close();
	return events.filter((e) => e.kind === "prepare");
}

describe("target.prepare", () => {
	test("runs in every lane checked out from a commit, on every kind, and not in a lane extended in place", async () => {
		const runs = tmp("runs");
		const { host } = stubHost(() => [{ write: "b.txt", content: "b" }, OK]);
		const ir = irOf(
			host,
			[
				inline("f", fresh, "true"),
				agent("a", "fork", "f"),
				inline("r", { mode: "read" }, "true", "f"),
				inline("e", { mode: "extend" }, "test -f b.txt", "a"),
				{ id: "cs", kind: "changeset", config: {}, lane: "a" },
				{
					id: "ap",
					kind: "apply",
					config: { lane: { mode: "fork" } },
					lane: "f",
					wires: { changeset: "cs.changeset" },
				},
			],
			"e",
		);
		const config = prepared(toyTarget(), {
			run: `${NODE} >> ${runs}/log`,
			writable: [runs],
		});
		const { result, instances } = await performed(host, ir, config);
		expect(result).toMatchObject({ outcome: "ok" });
		expect(instances.every((i) => i.status === "ok")).toBe(true);
		const log = readFileSync(join(runs, "log"), "utf8").trim().split("\n");
		expect(log.sort()).toEqual(["a", "ap", "f", "r"]);
	});

	test("runs again when a retried instance re-opens the version it extended", async () => {
		const runs = tmp("runs");
		let attempt = 0;
		const watched = { file: "w.json", format: "json", schema: {} };
		const { host } = stubHost(() =>
			++attempt > 3 ? [{ write: `${OUTBOX}/w.json`, content: "{}" }, OK] : [OK],
		);
		const x = agent("x", "extend", "base");
		const ir = irOf(
			host,
			[
				inline("base", fresh, "true"),
				{ ...x, config: { ...x.config, out: { watched } } },
			],
			"x",
		);
		const config = prepared(toyTarget(), {
			run: `${NODE} >> ${runs}/log`,
			writable: [runs],
		});
		const first = await performed(host, ir, config);
		expect(first.result).toMatchObject({ outcome: "failed", node: "x" });
		const log = () => readFileSync(join(runs, "log"), "utf8");
		expect(log()).toBe("base\n");
		const again = await performed(host, ir, config, { resume: first.id });
		expect(again.result).toMatchObject({ outcome: "ok" });
		expect(log()).toBe("base\nx\n");
	});

	test("runs before the node's work, and the ignored files it makes are carried by an extend and never sealed", async () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				inline("k", fresh, "test -f deps/ready"),
				inline("e", { mode: "extend" }, "test -f deps/ready", "k"),
			],
			"e",
		);
		const target = toyTarget({ ".gitignore": "deps/\n" });
		const config = prepared(target, "mkdir -p deps && touch deps/ready");
		const { id, result } = await performed(host, ir, config);
		expect(result).toMatchObject({ outcome: "ok" });
		expect(await changed(config, target, `${id}.e`)).toBe("");
	});

	test("a cache at an existing host path is read and written at its variable in prepare alone, and the host directory gains no file", async () => {
		const cache = tmp("cache");
		writeFileSync(join(cache, "pkg"), "cached\n");
		const marks = tmp("marks");
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				inline("x", fresh, {
					run: `echo "\${C_DIR-unset}" > ${marks}/check`,
					writable: [marks],
				}),
			],
			"x",
		);
		const config = prepared(toyTarget(), {
			run: [`cat "$C_DIR/pkg" > ${marks}/read`, `touch "$C_DIR/new"`],
			writable: [marks],
			cache: { path: cache, at: "/c", env: "C_DIR" },
		});
		const { result } = await performed(host, ir, config);
		expect(result).toMatchObject({ outcome: "ok" });
		expect(readFileSync(join(marks, "read"), "utf8")).toBe("cached\n");
		expect(readdirSync(cache)).toEqual(["pkg"]);
		expect(readFileSync(join(marks, "check"), "utf8")).toBe("unset\n");
	});

	test("a cache whose host path does not exist is skipped: prepare succeeds with its variable unset", async () => {
		const marks = tmp("marks");
		const { host } = stubHost(() => [OK]);
		const ir = irOf(host, [inline("x", fresh, "true")], "x");
		const config = prepared(toyTarget(), {
			run: `echo "\${C_DIR-unset}" > ${marks}/seen`,
			writable: [marks],
			cache: { path: join(tmp("gone"), "missing"), at: "/c", env: "C_DIR" },
		});
		const { result } = await performed(host, ir, config);
		expect(result).toMatchObject({ outcome: "ok" });
		expect(readFileSync(join(marks, "seen"), "utf8")).toBe("unset\n");
	});

	test("a cache is skipped when bwrap cannot overlay: prepare succeeds with its variable unset", async () => {
		const marks = tmp("marks");
		const { host } = stubHost(() => [OK]);
		const ir = irOf(host, [inline("x", fresh, "true")], "x");
		const config = prepared(toyTarget(), {
			run: `echo "\${C_DIR-unset}" > ${marks}/seen`,
			writable: [marks],
			cache: { path: tmp("cache"), at: "/c", env: "C_DIR" },
		});
		const probe = spyOn(sandbox, "canOverlay").mockReturnValue(false);
		try {
			const { result } = await performed(host, ir, config);
			expect(result).toMatchObject({ outcome: "ok" });
		} finally {
			probe.mockRestore();
		}
		expect(readFileSync(join(marks, "seen"), "utf8")).toBe("unset\n");
	});

	test.each(["/lanes", "/lane-cache"])(
		"a cache at %s, beside the lane, parses",
		(at) => {
			const cache = { path: "/tmp", at, env: "C_DIR" };
			const config = prepared(toyTarget(), { run: "true", cache });
			expect(repoSetup(setupOf(config)).target?.prepare?.cache).toEqual(cache);
		},
	);

	test("a cache path under ~/ is the host user's home", () => {
		const config = prepared(toyTarget(), {
			run: "true",
			cache: { path: "~/x", at: "/c", env: "C_DIR" },
		});
		expect(repoSetup(setupOf(config)).target?.prepare?.cache).toEqual({
			path: join(homedir(), "x"),
			at: "/c",
			env: "C_DIR",
		});
	});

	test.each([
		["exit 1", undefined, 1, "45"],
		["no-such-command", undefined, 127, "sh: .*no-such-command: .*not found"],
		["sleep 30", "1s", 124, "45"],
	])(
		"a line running '%s' fails the node with its exit and the last output line, drops the lane and never starts the node's work",
		async (line, timeout, code, last) => {
			const marks = tmp("marks");
			const { host } = stubHost(() => [OK]);
			const ir = irOf(
				host,
				[
					inline("x", fresh, {
						run: `touch ${marks}/worked`,
						writable: [marks],
					}),
				],
				"x",
			);
			const run = ["echo started", `seq ${TAIL_LINES + 5}; ${line}`];
			const config = prepared(toyTarget(), { run, timeout });
			const { concert, recordPath } = await start(host, ir, config);
			expect(await concert.done).toMatchObject({
				outcome: "failed",
				reason: expect.stringMatching(
					new RegExp(`^target\\.prepare line 2 exited ${code}: ${last}$`),
				),
			});
			expect(readdirSync(marks)).toEqual([]);
			expect(existsSync(laneOf(config, concert.id, "x"))).toBe(false);
			const events = prepareEvents(recordPath, concert.id);
			expect(events).toEqual([
				{ kind: "prepare", line: 1, of: 2, run: run[0] },
				{
					kind: "prepare",
					line: 1,
					of: 2,
					run: run[0],
					ended: "exited 0",
					tail: "started",
				},
				{ kind: "prepare", line: 2, of: 2, run: run[1] },
				expect.objectContaining({ line: 2, ended: `exited ${code}` }),
			]);
			const tail = String(events[3]?.tail).split("\n");
			expect(tail).toHaveLength(TAIL_LINES);
			expect(tail).toContain(String(TAIL_LINES + 5));
			expect(tail).not.toContain("5");
		},
	);

	test.each([
		[["echo b >> a.txt", "touch new.txt"], "a.txt, new.txt"],
		[
			"touch n00 n01 n02 n03 n04 n05 n06 n07 n08 n09 n10 n11",
			"n00, n01, n02, n03, n04, n05, n06, n07, n08, n09 and 2 more",
		],
	])(
		"a prepare that changes tracked or unignored files fails the node, naming them",
		async (prepare, named) => {
			const { host } = stubHost(() => [OK]);
			const ir = irOf(host, [inline("x", fresh, "true")], "x");
			const { result } = await performed(
				host,
				ir,
				prepared(toyTarget(), prepare),
			);
			expect(result).toMatchObject({
				outcome: "failed",
				reason: `target.prepare changed lane content: ${named}. Ignore those paths, or keep target.prepare from writing them`,
			});
		},
	);

	test("a prepare cannot write the lane's git directory, so the host never follows a link it plants there", async () => {
		const victim = join(tmp("victim"), "file");
		writeFileSync(victim, "kept\n");
		const { host } = stubHost(() => [OK]);
		const ir = irOf(host, [inline("x", fresh, "true")], "x");
		const config = prepared(
			toyTarget(),
			`ln -sf ${victim} "$(git rev-parse --git-dir)/HEAD"`,
		);
		const { result } = await performed(host, ir, config);
		expect(result).toMatchObject({
			outcome: "failed",
			reason: expect.stringMatching(/^target\.prepare line 1 exited 1: ln: /),
		});
		expect(readFileSync(victim, "utf8")).toBe("kept\n");
	});

	test.each([
		[
			"cone-mode directories",
			["packages/app"],
			"test -f packages/app/x && test ! -e packages/lib",
			"packages/lib/y",
		],
		[
			"non-cone patterns with a negation",
			{ patterns: ["/*", "!/b/", "/b/keep.txt"] },
			"test -f root.txt && test -f b/keep.txt && test ! -e b/drop.txt",
			"b/drop.txt",
		],
	])(
		"target.sparse as %s narrows a checked-out lane, which seals the full tree with no change and stays sparse across an in-place extend",
		async (_name, sparse, check, dropped) => {
			const { host } = stubHost(() => [OK]);
			const ir = irOf(
				host,
				[
					inline("s", fresh, check),
					inline("e", { mode: "extend" }, check, "s"),
				],
				"e",
			);
			const target = toyTarget({
				"root.txt": "r\n",
				"packages/app/x": "x\n",
				"packages/lib/y": "y\n",
				"b/keep.txt": "k\n",
				"b/drop.txt": "d\n",
			});
			const config = configOf(target, {
				target: { repo: target, base: "main", sparse },
			});
			const { id, result } = await performed(host, ir, config);
			expect(result).toMatchObject({ outcome: "ok" });
			expect(await changed(config, target, `${id}.e`)).toBe("");
			const { lanes } = openTarget(setupOf(config).store, target);
			const full = await lanes.fork(`${id}.e`, `${id}.probe`);
			expect(existsSync(join(full.dir, dropped))).toBe(true);
			full.discard();
		},
	);

	const relative = "List directories relative to the repo root";
	test.each([
		[
			"a bad prepare shape",
			() => ({ prepare: { run: [] } }),
			{ code: "CFG.schema", message: "config 'target.prepare" },
		],
		...(
			[
				["at the root", { path: "/tmp", at: "/", env: "C" }],
				["at the lane", { path: "/tmp", at: "/lane", env: "C" }],
				["in the lane", { path: "/tmp", at: "/lane/c", env: "C" }],
				["with a relative path", { path: "rel", at: "/c", env: "C" }],
			] as const
		).map(
			([what, cache]) =>
				[
					`a prepare cache ${what}`,
					() => ({ prepare: { run: "true", cache } }),
					{ code: "CFG.schema", message: "config 'target.prepare" },
				] as const,
		),
		[
			"a cache on a check",
			() => ({
				checks: {
					c: { run: "true", cache: { path: "/tmp", at: "/c", env: "C" } },
				},
			}),
			{ code: "CFG.schema", message: "config 'target.checks" },
		],
		[
			"a bad prepare timeout",
			() => ({ prepare: { run: "true", timeout: "soon" } }),
			{
				code: "HOST.validate",
				message: "target.prepare timeout 'soon' is not a duration",
			},
		],
		[
			"a relative prepare bind",
			() => ({ prepare: { run: "true", readOnly: ["deps"] } }),
			{
				code: "HOST.bind",
				message: "target.prepare read-only bind 'deps' is not an absolute path",
			},
		],
		[
			"a missing prepare bind",
			() => ({ prepare: { run: "true", writable: ["/no/such/path"] } }),
			{
				code: "HOST.bind",
				message: "target.prepare writable bind '/no/such/path' does not exist",
			},
		],
		[
			"a lane-reaching prepare bind",
			(store: string) => ({ prepare: { run: "true", writable: [store] } }),
			{ code: "HOST.bind", message: "' is inside a lane" },
		],
		[
			"an empty sparse list",
			() => ({ sparse: [] }),
			{ code: "CFG.schema", message: "config 'target.sparse" },
		],
		[
			"an empty sparse patterns list",
			() => ({ sparse: { patterns: [] } }),
			{ code: "CFG.schema", message: "config 'target.sparse" },
		],
		[
			"a sparse pattern spanning lines",
			() => ({ sparse: { patterns: ["/a\n/b"] } }),
			{ code: "CFG.schema", message: "config 'target.sparse" },
		],
		[
			"a duplicate sparse entry",
			() => ({ sparse: ["a", "a"] }),
			{ code: "CFG.schema", message: "config 'target.sparse" },
		],
		[
			"an absolute sparse entry",
			() => ({ sparse: ["/abs"] }),
			{
				code: "HOST.target",
				message: "target.sparse entry '/abs' is absolute",
				hint: relative,
			},
		],
		[
			"a sparse entry with a '..' segment",
			() => ({ sparse: ["packages/../x"] }),
			{
				code: "HOST.target",
				message: "target.sparse entry 'packages/../x' has a '..' segment",
				hint: relative,
			},
		],
	])("compose refuses %s, naming its setting", async (_, patch, expected) => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(host, [inline("x", fresh, "true")], "x");
		const config = configOf(toyTarget());
		const { store } = setupOf(config);
		mkdirSync(store, { recursive: true });
		Object.assign(config.values.target, patch(store));
		const composed = await compose({
			ir,
			config,
			roots: ROOTS,
			core: CORE_CONFIG,
			packs: {},
			hosts: [host],
			loadCode: noCode,
			caps: {},
		});
		const found = composed.ok ? [] : composed.diagnostics;
		expect(found.length).toBeGreaterThan(0);
		for (const d of found)
			expect(d).toMatchObject({
				...expected,
				message: expect.stringContaining(expected.message),
			});
	});

	test("a sparse step git refuses fails the node with git's message, leaving no lane", async () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(host, [inline("x", fresh, "true")], "x");
		const target = toyTarget();
		const config = configOf(target, {
			target: { repo: target, base: "main", sparse: ["*"] },
		});
		const { id, result } = await performed(host, ir, config);
		expect(result).toMatchObject({ outcome: "failed" });
		expect(result.outcome === "failed" && result.reason).toMatch(
			/^target\.sparse: fatal: specify directories rather than patterns/,
		);
		expect(existsSync(laneOf(config, id, "x"))).toBe(false);
	});

	test.each([
		["an agent", [agent("x", "fresh")]],
		["a check", [inline("x", fresh, "true")]],
		[
			"an apply",
			[
				inline("root", fresh, "true"),
				{ id: "cs", kind: "changeset", config: {}, lane: "root" },
				{
					id: "x",
					kind: "apply",
					config: { lane: { mode: "fork" } },
					lane: "root",
					wires: { changeset: "cs.changeset" },
				},
			],
		],
	] as [string, NodeSpec[]][])(
		"cancelling a long prepare line of %s node ends its processes",
		async (_, nodes) => {
			const { host, requests } = stubHost(() => [OK]);
			const ir = irOf(host, nodes, "x");
			const config = prepared(
				toyTarget(),
				`[ "$(${NODE})" != x ] || sleep 300`,
			);
			const { concert } = await start(host, ir, config);
			let pids: number[] = [];
			while (!pids.length) {
				await Bun.sleep(20);
				pids = sandboxed();
			}
			await concert.cancel();
			expect(await concert.done).toMatchObject({ outcome: "failed" });
			expect(sandboxed().filter((p) => pids.includes(p))).toEqual([]);
			expect(requests).toEqual([]);
		},
	);
});
