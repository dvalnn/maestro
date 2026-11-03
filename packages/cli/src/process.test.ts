import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
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
const SPEC = join(import.meta.dir, "fixtures/spec.ts");
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
		stdoutBytes: (bytes) => void process.stdout.write(bytes),
		stderr: (line) => void process.stderr.write(\`\${line}\\n\`),
	}),
);
`,
	);
	return file;
}

/** The session id of process `pid`, the sixth field of its `/proc/<pid>/stat`. */
function sessionOf(pid: number) {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
}

async function until(done: () => Promise<boolean>) {
	for (let waited = 0; waited < WAIT_LIMIT_MS; waited += WAIT_STEP_MS) {
		if (await done()) return;
		await Bun.sleep(WAIT_STEP_MS);
	}
	throw new Error("timed out waiting for the concert to reach echo/echo");
}

describe("a concert in another process", () => {
	test("--detach prints the id of a concert it leaves running in its own session, or its document under --json, for perform and resume, and passes a refusal through", async () => {
		const w = await world();
		const self = [process.execPath, await hanging()];
		const started = await w.call(["perform", ...GREET, "--detach"], { self });
		expect(started.code).toBe(0);
		const id = started.out;
		const row = json(await w.call(["ls", id, "--json"]));
		expect(row.status).toBe("running");
		expect(sessionOf(row.pid)).toBe(row.pid);
		expect((await w.call(["kill", id])).code).toBe(0);
		const resumed = await w.call(["resume", id, "--detach", "--json"], {
			self,
		});
		expect([resumed.code, json(resumed)]).toEqual([
			0,
			{ id, status: "running" },
		]);
		expect((await w.call(["kill", id])).code).toBe(0);
		expect(await w.call(["perform", "nope.ts", "--detach"], { self })).toEqual({
			code: 2,
			out: "",
			err: "error: no such file: nope.ts\n  Check the path",
		});
	});

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
			tokens: 0,
			artifacts: join(w.env.XDG_DATA_HOME, "maestro/concerts", id, "artifacts"),
		});
		expect(await w.call(["resume", id])).toEqual({
			code: 1,
			out: "",
			err: `error: concert ${id} is still running in process ${child.pid}\n  Wait for it with 'maestro wait ${id}', or stop it with 'maestro kill ${id}'`,
		});
		const pruned = await w.call(["prune", id, "--yes"]);
		expect(pruned.code).toBe(1);
		expect(pruned.err).toMatch(
			new RegExp(
				`^error: concert ${id} is still running.*\n {2}Wait for it with 'maestro wait ${id}', or stop it with 'maestro kill ${id}'$`,
			),
		);

		expect(json(await w.call(["k", id, "--json"]))).toEqual({
			id,
			status: "failed",
			reason: "the concert was cancelled",
		});
		expect(await child.exited).toBe(143);
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
		const resumed = await w.call(["resume", id], {
			hosts: [host],
		});
		expect(resumed).toMatchObject({
			code: 0,
			out: "text       done",
			err: expect.stringMatching(
				new RegExp(
					`^warning: composition changed since concert ${id}; resuming its recorded graph\nconcert ${id}${closingOf(id, "ok").source}`,
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
		expect(await w.call(["resume", id])).toEqual({
			code: 1,
			out: "",
			err: `error: concert ${id} finished ok, so it has nothing to resume\n  Perform its composition as a new concert with 'maestro perform <composition>'`,
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
		const resumed = await w.call(["resume", id], {
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
					`^warning: composition changed since concert ${id}; resuming its recorded graph\nconcert ${id}${closingOf(id, "ok").source}`,
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
			(await w.call(["resume", again], { hosts: [failAfter] })).err,
		).not.toContain("warning:");
		await Bun.write(file, source.replace("v1", "v3"));
		expect(
			(
				await w.call(["resume", again, "--json"], {
					hosts: [failAfter],
				})
			).err,
		).not.toContain("warning:");
		await rm(file);
		expect((await w.call(["resume", again])).err).toBe(
			`error: the code of concert ${again} was in ${file}, which is gone\n  Restore it, or perform its composition as a new concert`,
		);
	});

	test("reapplies the concert's recorded presets in order and -c, the resume's own -c on top", async () => {
		const w = await world();
		await Bun.write(
			join(w.cwd, ".maestro/presets/stub.yaml"),
			"mode:\n  from: stub\n  keep: stub\n  only: stub\n",
		);
		await Bun.write(
			join(w.cwd, ".maestro/presets/risky.yaml"),
			"mode:\n  from: risky\n  risky: true\n",
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
				[
					"perform",
					...GREET,
					"--preset",
					"stub",
					"--preset",
					"risky",
					"-c",
					"mode.keep=perform",
				],
				{ hosts: [host] },
			),
		);
		expect(json(await w.call(["ls", id, "--json"]))).toMatchObject({
			presets: ["stub", "risky"],
			config: ["mode.keep=perform"],
		});
		await w.call(["resume", id], { hosts: [host] });
		await w.call(["resume", id, "-c", "mode.keep=resume"], {
			hosts: [host],
		});
		expect(seen).toEqual([
			{ from: "risky", keep: "perform", only: "stub", risky: true },
			{ from: "risky", keep: "perform", only: "stub", risky: true },
			{ from: "risky", keep: "resume", only: "stub", risky: true },
		]);
	});

	test("limits a -c sets reach the concert and its record, and a resume reads them as the config stands", async () => {
		const w = await world();
		const spent = { tokens_input: 11 };
		const host = hostOf(ECHO, {
			steps: { first: [{ ...FIRST, metrics: spent }], "echo/echo": [ECHO] },
		});
		const limits = ["-c", "limits.tokens=10", "-c", "limits.timeout=2h"];
		const performed = await w.call(["perform", ...GREET, ...limits], {
			hosts: [host],
		});
		const id = idOf(performed);
		expect(performed.code).toBe(1);
		expect(performed.err).toContain("passed limits.tokens (10): 11 tokens");
		expect(json(await w.call(["ls", id, "--json"]))).toMatchObject({
			limits: { timeout: 7_200_000, tokens: 10 },
		});
		const resumed = ["resume", id, "-c", "limits.tokens=20"];
		expect(await w.call(resumed, { hosts: [host] })).toMatchObject({
			code: 0,
		});
		expect(json(await w.call(["ls", id, "--json"]))).toMatchObject({
			limits: { timeout: 7_200_000, tokens: 20 },
		});
	});

	test("names a recorded -c or --preset that no longer holds as the concert's, with a fix the resume can apply", async () => {
		const w = await world();
		const presets = join(w.cwd, ".maestro/presets");
		await Bun.write(join(presets, "stub.yaml"), "mode:\n  from: stub\n");
		const claiming = (namespaces: string[], over: object = {}): Host => ({
			...fakeHost(over),
			config: Object.fromEntries(namespaces.map((ns) => [ns, {}])),
		});
		const failFirst = claiming(["mode", "extra"], {
			steps: { first: [{ outcome: "failed", reason: "flaky" }] },
		});
		const perform = async (...flags: string[]) =>
			idOf(
				await w.call(["perform", ...GREET, "--preset", "stub", ...flags], {
					hosts: [failFirst],
				}),
			);
		const id = await perform("-c", "extra.x=1");
		const resume = (concert: string, ...flags: string[]) =>
			w.call(["resume", concert, ...flags], {
				hosts: [
					claiming(["mode"], {
						steps: { first: [FIRST], "echo/echo": [ECHO] },
					}),
				],
			});
		expect(await resume(id)).toMatchObject({
			code: 1,
			err: `error: config key 'extra' is claimed by no installed host, pack or core (from -c extra.x of concert ${shortOf(id)})\n  Set that key, or !delete it, with -c on the resume, or perform the composition as a new concert`,
		});
		expect(await resume(id, "-c", "extra=!delete")).toMatchObject({ code: 0 });

		const again = await perform();
		await rm(join(presets, "stub.yaml"));
		expect(await resume(again)).toMatchObject({
			code: 1,
			err: `error: concert ${shortOf(again)} was performed with --preset stub, and no stub.yaml is in ${presets} or ${join(w.env.XDG_CONFIG_HOME, "maestro/presets")}\n  Restore stub.yaml, or perform the composition as a new concert`,
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
		const refused = await w.call(["resume", id]);
		expect(refused.code).toBe(1);
		expect(refused.err).toBe(
			`error: the code of concert ${id} was in ${w.pack}, which is gone\n  Restore it, or perform its composition as a new concert`,
		);
	});
});

describe("encore", () => {
	test("performs a concert's composition again, linked to it, its params kept unless a flag overrides one, refusing one that changes nothing", async () => {
		const w = await world();
		const encore = (...args: string[]) =>
			w.call(["encore", ...args], { hosts: [hostOf()] });
		const first = idOf(
			await w.call(["perform", ...GREET], { hosts: [hostOf()] }),
		);
		expect(await encore(first)).toEqual({
			code: 1,
			out: "",
			err: `error: nothing changed since concert ${first}: its params, config and target revision are the same\n  Change a param, the config or the target`,
		});
		const flaky = idOf(
			await w.call(["perform", "demo.greet", "--name", "z"], {
				hosts: [
					fakeHost({
						steps: { first: [{ outcome: "failed", reason: "flaky" }] },
					}),
				],
			}),
		);
		expect((await encore(flaky)).err).toEndWith(
			`\n  Change a param, the config or the target, or resume it with 'maestro resume ${flaky}'`,
		);
		expect(await encore(first, "demo.greet")).toMatchObject({
			code: 2,
			err: expect.stringContaining(
				"encore takes no composition: it performs its concert's own",
			),
		});
		const renamed = idOf(await encore(first, "--name", "y"));
		const chained = idOf(await encore("-c", "concurrency=2", renamed));
		expect((await encore(chained)).err).toStartWith(
			`error: nothing changed since concert ${chained}`,
		);
		const stacked = idOf(await encore(chained, "-c", "concurrency=3"));
		const recorded = async (id: string) => {
			const { encoreOf, params, config } = json(
				await w.call(["ls", id, "--json"]),
			);
			return { encoreOf, params, config };
		};
		expect(await recorded(first)).toEqual({
			encoreOf: undefined,
			params: { name: "x" },
			config: undefined,
		});
		expect(await recorded(renamed)).toEqual({
			encoreOf: first,
			params: { name: "y" },
			config: undefined,
		});
		expect(await recorded(chained)).toEqual({
			encoreOf: renamed,
			params: { name: "y" },
			config: ["concurrency=2"],
		});
		expect(await recorded(stacked)).toMatchObject({
			encoreOf: chained,
			config: ["concurrency=2", "concurrency=3"],
		});
	});

	test("the encore's presets replace the concert's whole list, under the concert's -c, and none keeps the list", async () => {
		const w = await world();
		const presets = join(w.cwd, ".maestro/presets");
		await Bun.write(join(presets, "a.yaml"), "mode:\n  from: a\n  keep: a\n");
		await Bun.write(join(presets, "b.yaml"), "mode:\n  keep: b\n");
		const seen: unknown[] = [];
		const host: Host = {
			...fakeHost({
				steps: {
					first: (_instance, _inputs, { setup }) => {
						seen.push(setup.config.mode);
						return FIRST;
					},
				},
			}),
			config: { mode: { type: "object" } },
		};
		const first = idOf(
			await w.call(
				[
					"perform",
					...GREET,
					...["--preset", "a", "--preset", "b", "-c", "mode.c=1"],
				],
				{ hosts: [host] },
			),
		);
		const encore = idOf(
			await w.call(["encore", first, "--preset", "b"], {
				hosts: [host],
			}),
		);
		const kept = idOf(
			await w.call(["encore", first, "-c", "mode.c=2"], {
				hosts: [host],
			}),
		);
		expect(seen).toEqual([
			{ from: "a", keep: "b", c: 1 },
			{ keep: "b", c: 1 },
			{ from: "a", keep: "b", c: 2 },
		]);
		expect(json(await w.call(["ls", encore, "--json"]))).toMatchObject({
			presets: ["b"],
			config: ["mode.c=1"],
		});
		expect(json(await w.call(["ls", kept, "--json"]))).toMatchObject({
			presets: ["a", "b"],
			config: ["mode.c=1", "mode.c=2"],
		});
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
					`^error: the process ${other.pid} of concert ${id} is gone, and its pid now belongs to another program\n {2}`,
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
			expect(await w.call(["resume", id])).toMatchObject({
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

describe("a file param", () => {
	test("reaches a node as its staged copy, which a resume keeps and an encore reads anew", async () => {
		const w = await world();
		const spec = join(w.cwd, "spec.md");
		const stop = join(w.root, "stop");
		await Bun.write(spec, "v1");
		await Bun.write(stop, "");
		const id = idOf(
			await w.call(["perform", SPEC, "--spec", "spec.md", "--stop", stop]),
		);
		const hex = new Bun.CryptoHasher("sha256").update("v1").digest("hex");
		const area = join(w.env.XDG_DATA_HOME, "maestro/concerts", id, "artifacts");
		expect(await Bun.file(join(area, hex, "spec.md")).text()).toBe("v1");
		const { instances } = json(await w.call(["ls", id, "--json"]));
		expect(
			instances.find((i: { node: string }) => i.node === "read"),
		).toMatchObject({ status: "ok", outputs: { text: "v1" } });

		await Bun.write(spec, "v2");
		await rm(stop);
		const resumed = await w.call(["resume", id, "--json"]);
		expect(json(resumed)).toMatchObject({ outputs: { text: "v1|v1" } });
		expect(json(await w.call(["ls", id, "--json"])).params).toEqual({
			spec,
			stop,
		});
		const elsewhere = { cwd: w.root };
		const encore = await w.call(["encore", id, "--json"], elsewhere);
		expect(json(encore)).toMatchObject({ outputs: { text: "v2|v2" } });
	});

	test("held by a saved IR refuses to perform, sending the caller to the composition file", async () => {
		const w = await world();
		await Bun.write(join(w.cwd, "spec.md"), "v1");
		const out = join(w.root, "spec.json");
		await w.call(["compose", SPEC, "--spec", "spec.md", "--out", out]);
		expect(await w.call(["perform", out])).toMatchObject({
			code: 2,
			err: expect.stringContaining(
				`${out} feeds input 'spec' of node 'read' the file param 'spec.md', which an IR file cannot stage\n  Perform the composition file instead, passing the file to its param`,
			),
		});
	});

	test("of JsonFile refuses a file that is not JSON at compose", async () => {
		const w = await world();
		await Bun.write(join(w.cwd, "items.json"), "[oops");
		const composed = await w.call([
			"compose",
			SPEC,
			"--spec",
			"items.json",
			"--items",
			"items.json",
		]);
		expect(composed.code).toBe(2);
		expect(composed.err).toContain(
			`param 'items' (--items) of 'spec.spec' names '${join(w.cwd, "items.json")}', which is not JSON`,
		);
	});
});
