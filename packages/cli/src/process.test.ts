import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
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

	test("--detach hints the short id on a terminal, and nothing piped or under --json", async () => {
		const w = await world();
		const self = [process.execPath, await hanging()];
		const stderrTerminal = () => ({ columns: 80 });
		const shown = await w.call(["perform", ...GREET, "--detach"], {
			self,
			stderrTerminal,
		});
		const id = shown.out;
		expect(shown.err).toContain(`Follow it: maestro watch ${shortOf(id)}`);
		expect(id).toHaveLength(id.trim().length);
		const piped = await w.call(["perform", ...GREET, "--detach"], { self });
		const doc = await w.call(["perform", ...GREET, "--detach", "--json"], {
			self,
			stderrTerminal,
		});
		expect(piped.err).not.toContain("Follow it");
		expect(doc.err).not.toContain("Follow it");
		for (const out of [id, piped.out, json(doc).id])
			expect((await w.call(["kill", out])).code).toBe(0);
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
		expect(await w.call(["kill", id])).toMatchObject({
			code: 0,
			err: `concert ${id} already settled failed`,
		});

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
					`^warning: composition changed since concert ${id}; using its recorded graph\nconcert ${id}${closingOf(id, "ok").source}`,
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
	// Seam: result documents expose the config a host received; ls reads each persisted snapshot.
	test("resume overrides last one attempt, and an encore keeps the performed presets and -c with its own -c above them, in its snapshot and resume", async () => {
		const w = await world();
		const host: Host = {
			...fakeHost({
				steps: {
					first: [FIRST],
					"echo/echo": (_instance, _inputs, { setup }) => ({
						outcome: "rejected",
						reason: "again",
						outputs: { text: JSON.stringify(setup.config.mode) },
					}),
				},
			}),
			config: { mode: { type: "object" } },
		};
		const presets = join(w.cwd, ".maestro/presets");
		await Bun.write(join(presets, "a.yaml"), "mode: { source: a, keep: a }\n");
		await Bun.write(join(presets, "b.yaml"), "mode: { keep: b, from: b }\n");
		const performed = await w.call(
			[
				"perform",
				...GREET,
				...["--preset", "a", "--preset", "b", "-c", "mode.keep=perform"],
				"--json",
			],
			{ hosts: [host] },
		);
		expect(performed.code).toBe(3);
		const id = json(performed).id;
		await rm(presets, { recursive: true });
		await Bun.write(join(w.cwd, ".maestro/config.yaml"), "[broken YAML");
		await Bun.write(
			join(w.env.XDG_CONFIG_HOME, "maestro/config.yaml"),
			"[broken YAML",
		);
		const moved = join(await scratch(), "data");
		await cp(w.env.XDG_DATA_HOME, moved, {
			recursive: true,
			verbatimSymlinks: true,
		});
		const outside = {
			cwd: await scratch(),
			hosts: [host],
			env: { XDG_DATA_HOME: moved },
		};
		const modeOf = async (args: string[]) => {
			const ran = await w.call([...args, "--json"], outside);
			expect(ran.code).toBe(3);
			return { id: json(ran).id, mode: JSON.parse(json(ran).outputs.text) };
		};
		const tweaked = await w.call(
			["resume", id, "-c", "mode.keep=attempt", "--json"],
			outside,
		);
		expect(tweaked.code).toBe(3);
		expect(JSON.parse(json(tweaked).outputs.text)).toEqual({
			source: "a",
			keep: "attempt",
			from: "b",
		});
		expect(json(tweaked).artifacts).toBe(
			join(moved, "maestro/concerts", id, "artifacts"),
		);
		expect((await modeOf(["resume", id])).mode).toEqual({
			source: "a",
			keep: "perform",
			from: "b",
		});
		const encore = await modeOf([
			...["encore", id, "--name", "y"],
			...["-c", "mode.keep=encore", "-c", "mode.added=true"],
		]);
		expect(encore.mode).toEqual({
			source: "a",
			keep: "encore",
			from: "b",
			added: true,
		});
		const kept = await modeOf(["encore", id, "-c", "mode.from=again"]);
		expect(kept.mode).toEqual({ source: "a", keep: "perform", from: "again" });
		const row = async (concert: string) =>
			json(await w.call(["ls", concert, "--json"], outside));
		expect(await row(encore.id)).toMatchObject({
			encoreOf: id,
			params: { name: "y" },
			presets: ["a", "b"],
			config: ["mode.keep=perform", "mode.keep=encore", "mode.added=true"],
			snapshot: {
				mode: { source: "a", keep: "encore", from: "b", added: true },
			},
		});
		expect(await row(kept.id)).toMatchObject({
			presets: ["a", "b"],
			config: ["mode.keep=perform", "mode.from=again"],
		});
		expect((await modeOf(["resume", encore.id])).mode).toEqual({
			source: "a",
			keep: "encore",
			from: "b",
			added: true,
		});
	});

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
					`^warning: composition changed since concert ${id}; using its recorded graph\nconcert ${id}${closingOf(id, "ok").source}`,
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

	test("a recorded key the running maestro no longer claims refuses resume and encore, naming the concert and repair, which needs no preset file", async () => {
		const w = await world();
		const presets = join(w.cwd, ".maestro/presets");
		await Bun.write(join(presets, "stub.yaml"), "mode:\n  from: stub\n");
		await Bun.write(
			join(w.cwd, ".maestro/config.yaml"),
			`packs: [${w.pack}]\nextra: { x: 1 }\n`,
		);
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
		const id = await perform("-c", "extra.y=2");
		await Bun.write(
			join(w.cwd, ".maestro/config.yaml"),
			`packs: [${w.pack}]\n`,
		);
		const current = {
			hosts: [
				claiming(["mode"], { steps: { first: [FIRST], "echo/echo": [ECHO] } }),
			],
		};
		const named = (text: string) => {
			const words = text.split(/[\s'"`,:;.()]+/);
			expect(
				words.filter((word) => word === id || word === shortOf(id)),
			).not.toEqual([]);
			expect(words).toEqual(
				expect.arrayContaining(["-c", "resume", "perform"]),
			);
		};
		const refused = await w.call(["resume", id], current);
		expect(refused.code).toBe(1);
		named(refused.err);
		for (const args of [
			["resume", id],
			["encore", id, "-c", "concurrency=2"],
		]) {
			const document = await w.call([...args, "--json"], current);
			expect(document.code).not.toBe(0);
			const diagnostics: { message: string; hint?: string }[] =
				json(document).diagnostics;
			named(diagnostics.map((d) => `${d.message}\n${d.hint}`).join("\n"));
		}
		const repaired = await w.call(
			["resume", id, "-c", "extra=!delete", "--json"],
			current,
		);
		expect(repaired.code).toBe(0);
		expect(json(repaired).outputs).toEqual({ text: "done" });

		const again = await perform();
		await rm(join(presets, "stub.yaml"));
		expect(await w.call(["resume", again], current)).toMatchObject({
			code: 0,
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
	test("measures again the disk of the concert it encores, whose sessions it continues", async () => {
		const w = await world();
		let grown = 0;
		const host = hostOf(ECHO, {
			usage: (id: string) => (id === first ? grown : 0),
		});
		const first = idOf(await w.call(["perform", ...GREET], { hosts: [host] }));
		const diskOf = async () =>
			json(await w.call(["ls", "--json"], { hosts: [host] })).find(
				(r: { id: string }) => r.id === first,
			).diskUse;
		const settled = await diskOf();
		grown = 500;
		expect(await diskOf()).toBe(settled);
		await w.call(["encore", first, "--name", "y"], { hosts: [host] });
		expect(await diskOf()).toBe(settled + 500);
	});

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
	// Seam: file contents in perform and encore result documents, and the snapshot values ls exposes.
	test("a recorded file param keeps its value and base across folders and refuses an unchanged encore", async () => {
		const w = await world();
		const source = await demoSource(
			(
				text,
			) => `${text.replace('import { code, composition, Int, Json, Text, use } from "@maestro/sdk";', 'import { type ArtifactRef, type CodeContext, code, composition, Int, Json, Markdown, Text, use } from "@maestro/sdk";\nimport { readFileSync } from "node:fs";')}
export function readDoc(inputs: { doc: ArtifactRef }, ctx: CodeContext) {
	return { text: readFileSync(ctx.path(inputs.doc), "utf8") };
}
export const doc = composition("doc", { pack: "demo", examples: [{}], params: { doc: Markdown(), round: Int({ default: 0 }) } }, ({ doc }) =>
	code(readDoc, { in: { doc }, out: { text: Text() } }),
);
`,
		);
		await packOf(join(source, "index.ts"), w.pack);
		const user = join(w.env.XDG_CONFIG_HOME, "maestro");
		await Bun.write(join(user, "note.md"), "first");
		await Bun.write(
			join(user, "config.yaml"),
			"demo:\n  doc:\n    doc: note.md\n",
		);
		const performed = await w.call(["perform", "demo.doc", "--json"], {
			hosts: [],
		});
		expect(performed.code).toBe(0);
		expect(json(performed).outputs).toEqual({ text: "first" });
		const id = json(performed).id;
		const moved = join(await scratch(), "config");
		await Bun.write(join(moved, "maestro/note.md"), "other");
		const elsewhere = {
			cwd: await scratch(),
			hosts: [],
			env: { XDG_CONFIG_HOME: moved },
		};
		const unchanged = await w.call(["encore", id, "--json"], elsewhere);
		expect(unchanged.code).toBe(1);
		expect(json(unchanged).ok).toBe(false);
		expect(json(await w.call(["ls", "--json"], elsewhere))).toHaveLength(1);
		const row = json(await w.call(["ls", id, "--json"], elsewhere));
		expect(row.snapshot.demo.doc.doc).toBe("note.md");
		const encore = await w.call(
			["encore", id, "--round", "1", "--json"],
			elsewhere,
		);
		expect(encore.code).toBe(0);
		expect(json(encore).outputs).toEqual({ text: "first" });
	});

	test.each([
		{
			shape: "a list appended across layers",
			schema: "List(Markdown())",
			user: "[first.md]",
			workspace: "!append [second.md]",
			files: "inputs.docs",
			expected: "workspace first|workspace second",
		},
		{
			shape: "a Struct split across layers",
			schema: "Struct({ first: Markdown(), second: Markdown() })",
			user: "{ first: first.md }",
			workspace: "{ second: second.md }",
			files: "[inputs.docs.first, inputs.docs.second]",
			expected: "user first|user second",
		},
		{
			shape: "a scalar merged into a list",
			schema: "List(Markdown())",
			user: "first.md",
			workspace: "!append [second.md]",
			files: "inputs.docs",
			expected: "workspace first|workspace second",
		},
	])(
		"an encore from another folder reads the performed files for $shape",
		async (scenario) => {
			const w = await world();
			const source = join(await scratch(), "index.ts");
			await Bun.write(
				source,
				`import { readFileSync } from "node:fs";
import { code, composition, Int, List, Markdown, Struct, Text } from "@maestro/sdk";
export function readDocs(inputs, ctx) {
	return { text: ${scenario.files}.map((ref) => readFileSync(ctx.path(ref), "utf8")).join("|") };
}
export const docs = composition("docs", {
	pack: "demo", examples: [{}],
	params: { docs: ${scenario.schema}, round: Int({ default: 0 }) },
}, ({ docs }) => code(readDocs, { in: { docs }, out: { text: Text() } }));
`,
			);
			await packOf(source, w.pack);
			const user = join(w.env.XDG_CONFIG_HOME, "maestro");
			await Bun.write(
				join(user, "config.yaml"),
				`demo:\n  docs:\n    docs: ${scenario.user}\n`,
			);
			await Bun.write(
				join(w.cwd, ".maestro/config.yaml"),
				`packs: [${w.pack}]\ndemo:\n  docs:\n    docs: ${scenario.workspace}\n`,
			);
			await Bun.write(join(user, "first.md"), "user first");
			await Bun.write(join(user, "second.md"), "user second");
			await Bun.write(join(w.cwd, "first.md"), "workspace first");
			await Bun.write(join(w.cwd, "second.md"), "workspace second");
			const performed = await w.call(["perform", "demo.docs", "--json"], {
				hosts: [],
			});
			expect(performed.code).toBe(0);
			expect(json(performed).outputs).toEqual({ text: scenario.expected });
			const outside = await scratch();
			await Bun.write(join(outside, "first.md"), "outside first");
			await Bun.write(join(outside, "second.md"), "outside second");
			const encore = await w.call(
				["encore", json(performed).id, "--round", "1", "--json"],
				{ cwd: outside, hosts: [] },
			);
			expect(encore.code).toBe(0);
			expect(json(encore).outputs).toEqual({ text: scenario.expected });
		},
	);

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
