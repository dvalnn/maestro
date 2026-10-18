import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
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
	stubHost,
	tmp,
	toyTarget,
} from "./test-support";

afterEach(cleanup);

const builder = { role: { name: "builder" } };
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
	test("an agent reads an attachment at /in, runs `check` from its sandbox, and the staged prompt lists both", async () => {
		const cache = tmp("cache");
		const config = configWith({
			lint: {
				run: ["echo linting $MODE", "pwd", `echo ran > ${cache}/lint-ran`],
				env: { MODE: "ci" },
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
	});

	test("a check with no timeout has no deadline in its spec", () => {
		const target = repoSetup({
			config: {
				target: {
					repo: ".",
					checks: { open: "true", capped: { run: "true", timeout: "2s" } },
				},
			},
			store: "",
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
				run: [`echo $GREETING > ${cache}/lock`],
				writable: [cache],
				env: { GREETING: "hi" },
			},
			see: { run: `test -f ${cache}/lock`, readOnly: [cache] },
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
