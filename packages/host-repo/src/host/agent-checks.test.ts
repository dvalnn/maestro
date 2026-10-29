import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { compose } from "@maestro/core/compose";
import { CORE_CONFIG } from "@maestro/core/config";
import { repoSetup } from "./config";
import {
	cleanup,
	configOf,
	fresh,
	irOf,
	type NodeSpec,
	noCode,
	OK,
	performed,
	ROOTS,
	stubHost,
	tmp,
	toyTarget,
} from "./test-support";

afterEach(cleanup);

/** The whole agent run: it waits out two 500ms check timeouts and a kill, each slower on a loaded machine. */
const AGENT_RUN_TEST_MS = 60_000;

const builder = { profile: "builder", seat: "builder" };
type Dirs = { store: string; dataRoot: string; repo: string };
const markdown = (file: string) => ({ file, format: "markdown" });

/** A target config whose checks are `checks`. */
function configWith(checks: Record<string, unknown>) {
	const config = configOf(toyTarget());
	return {
		...config,
		values: {
			...config.values,
			target: {
				...config.values.target,
				checks,
			} as typeof config.values.target,
		},
	};
}

describe("agent-runnable checks and attachments", () => {
	test(
		"an agent reads an attachment at /in, runs `check` from its sandbox, and the staged prompt lists both",
		async () => {
			const cache = tmp("cache");
			const config = configWith({
				lint: {
					run: [
						"echo linting $MODE",
						"pwd",
						"echo base=$MAESTRO_LANE_BASE",
						`echo ran > ${cache}/lint-ran`,
					],
					env: { MODE: "ci", MAESTRO_LANE_BASE: "spoofed" },
					writable: [cache],
				},
				red: ["true", "exit 1"],
				slow: { run: "sleep 5", timeout: "500ms" },
				stubborn: { run: "trap '' TERM; sleep 30", timeout: "500ms" },
				crash: "kill -SEGV $$",
				killed: "exit 137",
			});
			const { host, requests } = stubHost((req) =>
				req.prompt.startsWith("write")
					? [{ write: "/out/n.md", content: "the notes" }, OK]
					: [
							{ sh: "cat /in/notes > /out/ref.md" },
							{
								sh: `(cd /tmp; check lint; check red; check slow; check stubborn; check crash; check killed; check nope) > /out/check.md 2>&1; echo "env:\${MODE-unset}" >> /out/check.md`,
							},
							{ sh: `echo hi > ${cache}/agent.txt` },
							{
								sh: "(echo x > /in/notes) 2>/dev/null || echo readonly > /out/ro.md",
							},
							OK,
						],
			);
			const specs: NodeSpec[] = [
				{
					id: "writer",
					kind: "agent",
					config: {
						...builder,
						lane: fresh,
						out: { notes: markdown("n.md") },
					},
					literals: { prompt: "write" },
				},
				{
					id: "reader",
					kind: "agent",
					config: {
						...builder,
						lane: fresh,
						checks: ["lint", "red", "slow", "stubborn", "crash", "killed"],
						attachments: {
							notes: {
								hint: "read when you need the notes",
								type: "core.markdown",
							},
						},
						out: {
							ref: markdown("ref.md"),
							check: markdown("check.md"),
							ro: markdown("ro.md"),
						},
					},
					literals: { prompt: "read" },
					wires: { notes: "writer.notes" },
				},
			];
			const { result, artifact } = await performed(
				host,
				irOf(host, specs, "reader"),
				config,
			);

			expect(result).toMatchObject({ outcome: "ok", node: "reader" });
			expect(readFileSync(artifact("reader", "ref"), "utf8")).toBe("the notes");
			const log = readFileSync(artifact("reader", "check"), "utf8");
			expect(log).toContain("$ echo linting $MODE\nlinting ci\n");
			expect(log).toContain("\n/lane\n");
			const main = Bun.spawnSync(["git", "rev-parse", "main"], {
				cwd: config.values.target.repo,
			});
			expect(log).toContain(`\nbase=${main.stdout.toString().trim()}\n`);
			expect(log).toContain("check 'lint': ok");
			expect(log).toContain("[check red line 2 exited 1]");
			expect(log).toContain("check 'red': rejected");
			expect(log).toContain("check 'slow': failed");
			expect(log).toContain("check 'stubborn': failed");
			expect(log).toContain("check 'crash': rejected");
			expect(log).toContain("check 'killed': failed");
			expect(log).toContain(
				"check: 'nope' is not one of: 'lint', 'red', 'slow', 'stubborn', 'crash', 'killed'",
			);
			expect(log).toContain("env:unset");
			expect(readFileSync(artifact("reader", "ro"), "utf8")).toBe("readonly\n");
			expect(readFileSync(join(cache, "agent.txt"), "utf8")).toBe("hi\n");
			expect(readFileSync(join(cache, "lint-ran"), "utf8")).toBe("ran\n");
			const prompt = requests[1]?.prompt ?? "";
			expect(prompt).toContain("- /in/notes: read when you need the notes");
			expect(prompt).toContain("`check <name>`, and do not write your own");
			expect(prompt).toContain("- check red: true && exit 1");
		},
		AGENT_RUN_TEST_MS,
	);

	test("a check with no timeout has no deadline in its spec", () => {
		const target = repoSetup({
			config: {
				target: {
					repo: ".",
					checks: { open: "true", capped: { run: "true", timeout: "2s" } },
				},
			},
			sources: [],
			layers: [],
			commandLine: { values: {}, replaced: [] },
			store: "",
			roots: ROOTS,
		}).target;
		expect(target?.checks.open?.timeout).toBeUndefined();
	});

	test("an attachment is an input port of its artifact type, so its content is part of the resume key", () => {
		const { host } = stubHost(() => [OK]);
		const kind = host.kinds.find((k) => k.name === "repo.agent");
		const ports = kind?.ports({
			id: "x",
			kind: "repo.agent",
			config: {
				...builder,
				lane: fresh,
				attachments: {
					spec: { hint: "you change the API" },
					docs: { hint: "you need them", type: "core.dir" },
				},
			},
		});

		expect(ports?.in).toMatchObject({
			spec: { "x-maestro-type": "core.file" },
			docs: { "x-maestro-type": "core.dir" },
		});
	});

	test("a check with a writable bind writes there, and its lock file is seen by a second lane", async () => {
		const cache = tmp("cache");
		const config = configWith({
			put: {
				run: [
					`echo $GREETING > ${cache}/lock`,
					`echo $MAESTRO_LANE_BASE > ${cache}/base`,
					"echo b > a.txt",
				],
				writable: [cache],
				env: { GREETING: "hi", MAESTRO_LANE_BASE: "spoofed" },
			},
			see: {
				run: [
					`test -f ${cache}/lock`,
					`test "$MAESTRO_LANE_BASE" = "$(cat ${cache}/base)"`,
					"git diff --quiet HEAD",
					"! git diff --quiet $MAESTRO_LANE_BASE",
				],
				readOnly: [cache],
			},
		});
		const { host } = stubHost(() => [OK]);
		const specs: NodeSpec[] = [
			{ id: "put", kind: "check", config: { lane: fresh, check: "put" } },
			{
				id: "see",
				kind: "check",
				config: { lane: { mode: "fork" }, check: "see" },
				lane: "put",
			},
		];
		const { result, instances } = await performed(
			host,
			irOf(host, specs, "see"),
			config,
		);

		expect(result).toMatchObject({ outcome: "ok", node: "see" });
		expect(instances.map((i) => i.status)).toEqual(["ok", "ok"]);
		expect(readFileSync(join(cache, "lock"), "utf8")).toBe("hi\n");
		const main = Bun.spawnSync(["git", "rev-parse", "main"], {
			cwd: config.values.target.repo,
		});
		expect(readFileSync(join(cache, "base"), "utf8").trim()).toBe(
			main.stdout.toString().trim(),
		);
	});

	test.each([
		["passes", "true", "ok"],
		["fails", "exit 1", "rejected"],
	])(
		"a check that %s keeps what its lines wrote to $MAESTRO_CHECK_OUTPUT as `output`, whatever its env says",
		async (_, last, outcome) => {
			const config = configWith({
				report: {
					run: [
						"echo found > $MAESTRO_CHECK_OUTPUT/report.txt",
						"echo $MAESTRO_CHECK_OUTPUT > $MAESTRO_CHECK_OUTPUT/where",
						"echo x > in-lane.txt",
						last,
					],
					env: { MAESTRO_CHECK_OUTPUT: "/spoofed" },
				},
			});
			const { host } = stubHost(() => [OK]);
			const specs: NodeSpec[] = [
				{
					id: "report",
					kind: "check",
					config: { lane: fresh, check: "report" },
				},
			];
			const { result, artifact } = await performed(
				host,
				irOf(host, specs, "report"),
				config,
			);

			expect(result).toMatchObject({ outcome, node: "report" });
			const out = artifact("report", "output");
			expect(readFileSync(join(out, "report.txt"), "utf8")).toBe("found\n");
			expect(readFileSync(join(out, "where"), "utf8").trim()).not.toBe(
				"/spoofed",
			);
			expect(readdirSync(out).sort()).toEqual(["report.txt", "where"]);
		},
	);

	test("a check that writes nothing has an empty `output`", async () => {
		const config = configWith({ quiet: "true" });
		const { host } = stubHost(() => [OK]);
		const specs: NodeSpec[] = [
			{ id: "quiet", kind: "check", config: { lane: fresh, check: "quiet" } },
		];
		const { artifact } = await performed(
			host,
			irOf(host, specs, "quiet"),
			config,
		);

		expect(readdirSync(artifact("quiet", "output"))).toEqual([]);
	});

	test("an agent's `check` command sets a writable MAESTRO_CHECK_OUTPUT outside the lane", async () => {
		const config = configWith({
			probe: {
				run: [
					"echo hi > $MAESTRO_CHECK_OUTPUT/f",
					"echo $MAESTRO_CHECK_OUTPUT > /tmp/probe-dir",
				],
				env: { MAESTRO_CHECK_OUTPUT: "/spoofed" },
			},
		});
		const { host } = stubHost(() => [
			{
				sh: '(check probe; echo "$MAESTRO_CHECK_OUTPUT"; cat /tmp/probe-dir) > /out/c.md 2>&1',
			},
			OK,
		]);
		const specs: NodeSpec[] = [
			{
				id: "a",
				kind: "agent",
				config: {
					...builder,
					lane: fresh,
					checks: ["probe"],
					out: { c: markdown("c.md") },
				},
				literals: { prompt: "go" },
			},
		];
		const { result, artifact } = await performed(
			host,
			irOf(host, specs, "a"),
			config,
		);

		expect(result).toMatchObject({ outcome: "ok", node: "a" });
		const log = readFileSync(artifact("a", "c"), "utf8");
		expect(log).toContain("check 'probe': ok");
		const dir = log.trim().split("\n").at(-1) ?? "";
		expect(dir).toMatch(/^\/tmp\//);
		expect(dir).not.toBe("/spoofed");
		expect(existsSync(dir)).toBe(false);
	});

	test.each([
		["a missing path", () => "/no/such/dir", "does not exist"],
		["inside the lanes", (c: Dirs) => c.store, "is inside a lane"],
		["containing the lanes", (c: Dirs) => c.dataRoot, "contains the lanes"],
		[
			"containing the target",
			(c: Dirs) => dirname(c.repo),
			"contains the target repository",
		],
		[
			"inside the target",
			(c: Dirs) => join(c.repo, "sub"),
			"is inside the target repository",
		],
	])(
		"a writable bind %s is a HOST.bind error naming the check",
		async (_, pick, why) => {
			const config = configWith({});
			const { dataRoot } = config.values;
			const store = join(dataRoot, "hosts", "repo");
			const repo = join(tmp("outer"), "repo");
			config.values.target.repo = repo;
			mkdirSync(store, { recursive: true });
			mkdirSync(join(repo, "sub"), { recursive: true });
			mkdirSync(join(repo, ".git"));
			const bind = pick({ store, dataRoot, repo });
			Object.assign(config.values.target.checks, {
				put: { run: "true", writable: [bind] },
			});
			const { host } = stubHost(() => [OK]);
			const ir = irOf(
				host,
				[{ id: "x", kind: "check", config: { lane: fresh, check: "put" } }],
				"x",
			);
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

			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.message]),
			).toEqual([["HOST.bind", `check 'put' writable bind '${bind}' ${why}`]]);
		},
	);
});

describe("sandbox.path", () => {
	/** A config whose `sandbox.path`, unless `set` is false, is a directory holding a `hello` tool, and the directory lines write their PATH to. */
	function pathed(
		target: (out: string) => Record<string, unknown>,
		set = true,
	) {
		const tools = tmp("tools");
		writeFileSync(join(tools, "hello"), "#!/bin/sh\necho hello\n", {
			mode: 0o755,
		});
		const out = tmp("out");
		const repo = toyTarget();
		const config = configOf(repo, {
			target: { repo, base: "main", ...target(out) },
			...(set ? { sandbox: { path: [tools] } } : {}),
		});
		const read = (file: string) => readFileSync(join(out, file), "utf8");
		return { tools, out, config, read };
	}
	const writes = (out: string, file: string) => ({
		run: `echo "$PATH" > ${out}/${file}; hello > ${out}/${file}.tool`,
		writable: [out],
	});

	test("leads the PATH of an agent, prepare, a check and an agent's `check` command, and binds its directories", async () => {
		const { tools, out, config, read } = pathed((out) => ({
			checks: { path: writes(out, "command") },
			prepare: writes(out, "prepare"),
		}));
		const { host } = stubHost((req) => [
			{
				sh: req.prompt.startsWith("plain")
					? `echo "$PATH" > /out/path.md; hello >> /out/path.md`
					: `echo "$PATH" > ${out}/agent; hello > ${out}/agent.tool; check path`,
			},
			OK,
		]);
		const specs: NodeSpec[] = [
			{
				id: "p",
				kind: "agent",
				config: { ...builder, lane: fresh, out: { path: markdown("path.md") } },
				literals: { prompt: "plain" },
			},
			{
				id: "a",
				kind: "agent",
				config: { ...builder, lane: fresh, checks: ["path"] },
				literals: { prompt: "go" },
			},
			{
				id: "c",
				kind: "check",
				config: {
					lane: fresh,
					check: {
						run: [`echo "$PATH" > ${out}/check`, `hello > ${out}/check.tool`],
						writable: [out],
					},
				},
			},
		];
		const plain: string[] = [];
		for (const id of ["p", "a", "c"]) {
			const run = await performed(host, irOf(host, specs, id), config);
			expect(run.result).toMatchObject({ outcome: "ok" });
			if (id === "p")
				plain.push(readFileSync(run.artifact("p", "path"), "utf8"));
		}

		const path = `${tools}:/usr/bin:/bin\n`;
		expect(plain).toEqual([`${path}hello\n`]);
		expect(read("agent")).toBe(`/maestro/checks/bin:${path}`);
		expect(read("prepare")).toBe(path);
		expect(read("check")).toBe(path);
		expect(read("command")).toBe(`/maestro/checks/bin:${path}`);
		for (const ran of ["agent", "prepare", "check", "command"])
			expect(read(`${ran}.tool`)).toBe("hello\n");
	});

	test.each([
		["a check's own env.PATH wins over it", true, "/opt/own:/usr/bin:/bin"],
		["unset, a check's PATH is the system's", false, undefined],
	])("%s", async (_, set, own) => {
		const { out, config, read } = pathed(() => ({}), set);
		const { host } = stubHost(() => [OK]);
		const check = {
			run: `echo "$PATH" > ${out}/check`,
			writable: [out],
			...(own === undefined ? {} : { env: { PATH: own } }),
		};
		const { result } = await performed(
			host,
			irOf(
				host,
				[{ id: "c", kind: "check", config: { lane: fresh, check } }],
				"c",
			),
			config,
		);
		expect(result).toMatchObject({ outcome: "ok" });
		expect(read("check")).toBe(`${own ?? "/usr/bin:/bin"}\n`);
	});
});
