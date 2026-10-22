import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Host } from "@maestro/core/host";
import { fakeHost } from "@maestro/testkit";
import { cleanup, demoSource, packOf, scratch } from "./fixtures/packs";
import {
	closingOf,
	ECHO,
	FIRST,
	GREET,
	hostOf,
	idOf,
	json,
	shortOf,
	world,
} from "./fixtures/world";
import { isMaestro } from "./session";

afterEach(cleanup);

const CLI = join(import.meta.dir, "cli");
const TESTKIT = join(import.meta.dir, "../../testkit/src/index");
const WAIT_STEP_MS = 25;
const WAIT_LIMIT_MS = 5000;
const SLOW_READER_MS = 500;

/** An executable named `maestro.ts`, as the real one is, whose `echo/echo` node never settles. */
async function hanging() {
	const file = join(await scratch(), "maestro.ts");
	await Bun.write(
		file,
		`import { main } from "${CLI}";
import { fakeHost } from "${TESTKIT}";
const host = fakeHost({
	steps: {
		first: [{ outcome: "ok", outputs: { text: "hi" } }],
		"echo/echo": [new Promise(() => {})],
	},
});
process.exit(
	await main(process.argv.slice(2), {
		hosts: [host],
		cwd: process.cwd(),
		env: process.env,
		stdout: (line) => void process.stdout.write(\`\${line}\\n\`),
		stderr: (line) => void process.stderr.write(\`\${line}\\n\`),
	}),
);
`,
	);
	return file;
}

async function until(done: () => Promise<boolean>) {
	for (let waited = 0; waited < WAIT_LIMIT_MS; waited += WAIT_STEP_MS) {
		if (await done()) return;
		await Bun.sleep(WAIT_STEP_MS);
	}
	throw new Error("timed out waiting for the concert to reach echo/echo");
}

describe("a concert in another process", () => {
	test("is waited on, refused a resume and a prune while running, killed, then resumed from the changed pack without redoing settled nodes", async () => {
		const w = await world();
		const child = w.spawn(["perform", ...GREET], await hanging());
		const reader = child.stderr.getReader();
		const id =
			/^concert (\S+)$/m.exec(
				new TextDecoder().decode((await reader.read()).value),
			)?.[1] ?? "";
		const reached = async () =>
			json(await w.call(["ls", id, "--json"])).instances.some(
				(i: { node: string }) => i.node === "echo/echo",
			);
		await until(reached);

		const waited = await w.call(["wait", id, "--timeout", "1s"]);
		expect(waited.code).toBe(124);
		expect(waited.err).toMatch(
			new RegExp(
				`^concert ${id} is still running after 1s\nWait again, or stop it with 'maestro kill ${id}'$`,
			),
		);
		expect(
			json(await w.call(["wait", id, "--timeout", "1s", "--json"])),
		).toEqual({
			id,
			status: "running",
			metrics: {},
		});
		expect(await w.call(["perform", "--resume", id])).toEqual({
			code: 1,
			out: "",
			err: `concert ${id} is still running in process ${child.pid}\nWait for it with 'maestro wait ${id}', or stop it with 'maestro kill ${id}'`,
		});
		const pruned = await w.call(["prune", id, "--yes"]);
		expect(pruned.code).toBe(1);
		expect(pruned.err).toMatch(
			new RegExp(
				`^concert ${id} is still running.*\nWait for it with 'maestro wait ${id}', or stop it with 'maestro kill ${id}'$`,
			),
		);

		expect(json(await w.call(["k", id, "--json"]))).toEqual({
			id,
			status: "failed",
			reason: "the concert was cancelled",
		});
		expect(await child.exited).toBe(1);
		expect(await w.call(["wait", id])).toMatchObject({
			code: 1,
			out: "",
			err: expect.stringMatching(
				closingOf(id, "failed", ["reason", "the concert was cancelled"]),
			),
		});
		expect((await w.call(["kill", id])).err).toMatch(
			/is not running, it settled failed/,
		);

		await packOf(
			join(await demoSource((t) => t.replace('"v1"', '"v2"')), "index.ts"),
			w.pack,
		);
		const started: string[] = [];
		const host = fakeHost({
			steps: {
				first: () => {
					started.push("first");
					return FIRST;
				},
				"echo/echo": () => {
					started.push("echo/echo");
					return ECHO;
				},
			},
		});
		const resumed = await w.call(["perform", "--resume", id], {
			hosts: [host],
		});
		expect(resumed).toMatchObject({
			code: 0,
			out: "text       done",
			err: expect.stringMatching(
				new RegExp(
					`^warning: the composition changed since concert ${id} was performed; resuming its recorded graph\nconcert ${id}${closingOf(id, "ok").source}`,
				),
			),
		});
		expect(started).toEqual(["echo/echo"]);
		const shape = json(await w.call(["ls", id, "--json"])).instances.filter(
			(i: { node: string; stale: boolean }) => i.node === "shape" && !i.stale,
		);
		expect(shape.map((i: { outputs: unknown }) => i.outputs)).toEqual([
			{ text: "hi v2" },
		]);

		await rm(w.pack, { recursive: true });
		expect(await w.call(["perform", "--resume", id])).toEqual({
			code: 1,
			out: "",
			err: `concert ${id} finished ok, so it has nothing to resume\nPerform its composition as a new concert with 'maestro perform <composition>'`,
		});
	}, 30_000);
});

describe("the real maestro.ts", () => {
	test("delivers every byte of stdout through a slow pipe", async () => {
		const w = await world();
		for (const letter of "abcdefghij")
			await w.call(["perform", ...GREET, "--title", letter.repeat(1_000_000)], {
				hosts: [hostOf()],
			});
		const expected = (await w.call(["ls", "--json"])).out.length + 1;
		const child = w.spawn(["ls", "--json"]);
		await Bun.sleep(SLOW_READER_MS);
		expect((await new Response(child.stdout).text()).length).toBe(expected);
	});

	test("stops quietly, exiting 0, when the reader of stdout is gone", async () => {
		const w = await world();
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const child = w.spawn(["watch", id, "--events"]);
		await child.stdout.cancel();
		expect(await child.exited).toBe(0);
		expect(await new Response(child.stderr).text()).toBe("");
	});
});

describe("resume", () => {
	const failing = (node: string) =>
		fakeHost({ steps: { [node]: [{ outcome: "failed", reason: "flaky" }] } });

	test("a bare file's concert resumes from its current source, warning of the edit and rerunning an edited code node only", async () => {
		const w = await world();
		const file = join(await scratch(), "work.ts");
		const source = `import { code, composition, Text } from "@maestro/sdk";
import { hostNode } from "@maestro/sdk/host";
export function mark(inputs: { text: string }) {
	return { text: \`\${inputs.text} v1\` };
}
export const work = composition("work", { examples: [{}] }, () => {
	const before = hostNode("fake.task", { label: "before", out: { text: Text() } });
	const marked = code(mark, { in: { text: before.out.text }, out: { text: Text() } });
	return hostNode("fake.task", { label: "after", in: { text: marked.out.text } });
});
`;
		await Bun.write(file, source);
		const failAfter = fakeHost({
			steps: {
				before: [{ outcome: "ok", outputs: { text: "hi" } }],
				after: [{ outcome: "failed", reason: "flaky" }],
			},
		});
		const id = idOf(await w.call(["perform", file], { hosts: [failAfter] }));
		expect(json(await w.call(["ls", id, "--json"]))).toMatchObject({
			moduleDir: dirname(file),
			file: "work.ts",
		});

		await Bun.write(file, source.replace("v1", "v2"));
		const started: string[] = [];
		const note = (node: string, outputs: Record<string, unknown>) => () => {
			started.push(node);
			return { outcome: "ok", outputs } as const;
		};
		const resumed = await w.call(["perform", "--resume", id], {
			hosts: [
				fakeHost({
					steps: {
						before: note("before", { text: "hi" }),
						after: note("after", {}),
					},
				}),
			],
		});
		expect(resumed).toMatchObject({
			code: 0,
			err: expect.stringMatching(
				new RegExp(
					`^warning: the composition changed since concert ${id} was performed; resuming its recorded graph\nconcert ${id}${closingOf(id, "ok").source}`,
				),
			),
		});
		expect(started).toEqual(["after"]);
		const marks = json(await w.call(["ls", id, "--json"])).instances.filter(
			(i: { node: string; stale: boolean }) => i.node === "mark" && !i.stale,
		);
		expect(marks.map((i: { outputs: unknown }) => i.outputs)).toEqual([
			{ text: "hi v2" },
		]);

		const again = idOf(await w.call(["perform", file], { hosts: [failAfter] }));
		expect(
			(await w.call(["perform", "--resume", again], { hosts: [failAfter] }))
				.err,
		).not.toContain("warning:");
		await rm(file);
		expect((await w.call(["perform", "--resume", again])).err).toBe(
			`the code of concert ${again} was in ${file}, which is gone\nRestore it, or perform its composition as a new concert`,
		);
	});

	test("reapplies the concert's recorded --profile and -c, the resume's own -c on top", async () => {
		const w = await world();
		await Bun.write(
			join(w.cwd, ".maestro/profiles/stub.yaml"),
			"mode:\n  from: stub\n  keep: stub\n",
		);
		const seen: unknown[] = [];
		const host: Host = {
			...fakeHost({
				steps: {
					first: (_instance, _inputs, { setup }) => {
						seen.push(setup.config.mode);
						return { outcome: "failed", reason: "flaky" };
					},
				},
			}),
			config: { mode: { type: "object" } },
		};
		const id = idOf(
			await w.call(
				["perform", ...GREET, "--profile", "stub", "-c", "mode.keep=perform"],
				{ hosts: [host] },
			),
		);
		expect(json(await w.call(["ls", id, "--json"]))).toMatchObject({
			profile: "stub",
			config: ["mode.keep=perform"],
		});
		await w.call(["perform", "--resume", id], { hosts: [host] });
		await w.call(["perform", "--resume", id, "-c", "mode.keep=resume"], {
			hosts: [host],
		});
		expect(seen).toEqual([
			{ from: "stub", keep: "perform" },
			{ from: "stub", keep: "perform" },
			{ from: "stub", keep: "resume" },
		]);
	});

	test("names a recorded -c or --profile that no longer holds as the concert's, with a fix the resume can apply", async () => {
		const w = await world();
		const profile = join(w.cwd, ".maestro/profiles/stub.yaml");
		await Bun.write(profile, "mode:\n  from: stub\n");
		const claiming = (namespaces: string[], over: object = {}): Host => ({
			...fakeHost(over),
			config: Object.fromEntries(namespaces.map((ns) => [ns, {}])),
		});
		const failFirst = claiming(["mode", "extra"], {
			steps: { first: [{ outcome: "failed", reason: "flaky" }] },
		});
		const perform = async (...flags: string[]) =>
			idOf(
				await w.call(["perform", ...GREET, "--profile", "stub", ...flags], {
					hosts: [failFirst],
				}),
			);
		const id = await perform("-c", "extra.x=1");
		const resume = (concert: string, ...flags: string[]) =>
			w.call(["perform", "--resume", concert, ...flags], {
				hosts: [
					claiming(["mode"], {
						steps: { first: [FIRST], "echo/echo": [ECHO] },
					}),
				],
			});
		expect(await resume(id)).toMatchObject({
			code: 2,
			err: `CFG.unclaimed: concert ${shortOf(id)} was performed with -c extra.x=1: config key 'extra' is claimed by no installed host, pack or core\n  Set that key, or !delete it, with -c on the resume, or perform the composition as a new concert`,
		});
		expect(await resume(id, "-c", "extra=!delete")).toMatchObject({ code: 0 });

		const again = await perform();
		await rm(profile);
		expect(await resume(again)).toMatchObject({
			code: 2,
			err: `CFG.profile: concert ${shortOf(again)} was performed with --profile stub, and ${profile} does not exist\n  Restore ${profile}, or perform the composition as a new concert`,
		});

		const plain = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
		expect(
			db.query("SELECT profile, config FROM concerts WHERE id = ?").get(plain),
		).toEqual({ profile: null, config: null });
		db.close();
	});

	test("a pack's concert whose modules directory is gone is refused, naming it", async () => {
		const w = await world();
		const id = idOf(
			await w.call(["perform", ...GREET], { hosts: [failing("first")] }),
		);
		await rm(w.pack, { recursive: true });
		const refused = await w.call(["perform", "--resume", id]);
		expect(refused.code).toBe(1);
		expect(refused.err).toBe(
			`the code of concert ${id} was in ${w.pack}, which is gone\nRestore it, or perform its composition as a new concert`,
		);
	});
});

describe("kill", () => {
	test("never signals a live process that is not maestro, and settles its concert failed", async () => {
		const w = await world();
		const id = idOf(await w.call(["perform", ...GREET], { hosts: [hostOf()] }));
		const other = Bun.spawn(["sh", "-c", "sleep 30; true", "maestro.md"]);
		try {
			const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
			db.exec(
				"UPDATE concerts SET status = 'running', settled_at = NULL, pid = ? WHERE id = ?",
				[other.pid, id],
			);
			db.close();
			expect(json(await w.call(["ls", "--json"]))[0].status).toBe("running");
			const killed = await w.call(["kill", id]);
			expect(killed.code).toBe(1);
			expect(killed.err).toMatch(
				new RegExp(
					`^the process ${other.pid} of concert ${id} is gone, and its pid now belongs to another program\n`,
				),
			);
			expect(() => process.kill(other.pid, 0)).not.toThrow();
			expect(await w.call(["wait", id])).toMatchObject({
				code: 1,
				out: "",
				err: expect.stringMatching(
					closingOf(
						id,
						"failed",
						["at", "echo/echo"],
						["reason", "process exited"],
					),
				),
			});
			expect(await w.call(["perform", "--resume", id])).toMatchObject({
				code: 0,
			});
			expect((await w.call(["prune", id, "--yes"])).code).toBe(0);
		} finally {
			other.kill();
		}
	});

	test("a process running this program's own executable is maestro, any other is not", () => {
		const sleep = realpathSync(Bun.which("sleep") ?? "sleep");
		const other = Bun.spawn([sleep, "30"]);
		try {
			expect(isMaestro(other.pid, sleep)).toBe(true);
			expect(isMaestro(other.pid, process.execPath)).toBe(false);
			expect(isMaestro(process.pid, process.execPath)).toBe(false);
		} finally {
			other.kill();
		}
	});
});
