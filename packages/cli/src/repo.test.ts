import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoHost } from "@maestro/host-repo";
import { stubHarness } from "@maestro/host-repo/harness";
import { cleanup, FIXTURES, scratch } from "./fixtures/packs";
import { idOf, json, world } from "./fixtures/world";
import { builtinHosts } from "./hosts";
import { diffColored } from "./output";

afterEach(cleanup);

const REPO = join(FIXTURES, "repo");

const GIT_ENV = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "op",
	GIT_AUTHOR_EMAIL: "op@x",
	GIT_COMMITTER_NAME: "op",
	GIT_COMMITTER_EMAIL: "op@x",
};

/** A git repository with one commit on `main`. */
async function toyTarget(): Promise<string> {
	const target = await scratch();
	for (const args of [
		["init", "-q", "-b", "main"],
		["commit", "-q", "--allow-empty", "-m", "one"],
	]) {
		const p = Bun.spawnSync(["git", ...args], { cwd: target, env: GIT_ENV });
		if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr}`);
	}
	return target;
}

/** Writes workspace profile `name` in `cwd`: its `profile.yaml`, and `files` beside it by path. */
function profileIn(
	cwd: string,
	name: string,
	yaml: string,
	files: Record<string, string> = {},
) {
	const dir = join(cwd, ".maestro/profiles", name);
	mkdirSync(dir, { recursive: true });
	for (const [path, text] of Object.entries({ "profile.yaml": yaml, ...files }))
		writeFileSync(join(dir, path), text);
}

/** Config lines that run profile `smoke` on `harness` and `model`. */
const SMOKE_RUNTIME = (harness: string, model = "none") =>
	`profiles:\n  smoke:\n    runtime:\n      harness: ${harness}\n      model: ${model}\n`;

/**
 * A world whose workspace config points the repo host at a toy target, with `extra` config lines, and whose workspace
 * holds profile `smoke` with instructions and no runtime.
 */
async function repoWorld(extra = "", env: Record<string, string> = {}) {
	const w = await world();
	const target = await toyTarget();
	writeFileSync(
		join(w.cwd, ".maestro/config.yaml"),
		`target:\n  repo: ${target}\n  base: main\n${extra}`,
	);
	profileIn(w.cwd, "smoke", "instructions: instructions.md\n", {
		"instructions.md": "terse",
	});
	const stubbed = builtinHosts({ ...process.env, ...env });
	const call = (args: string[], over: Parameters<typeof w.call>[1] = {}) =>
		w.call(args, { hosts: stubbed, ...over });
	return { ...w, call, target };
}

test("a missing target.repo exits 2 when -c gave it, and 1 when a config file did", async () => {
	const w = await repoWorld();
	const missing = join(w.cwd, "gone");
	const script = join(REPO, "mark.ts");
	const flagged = await w.call([
		"compose",
		script,
		"-c",
		`target.repo=${missing}`,
	]);
	expect(flagged.code).toBe(2);
	expect(flagged.err).toContain("does not exist");
	writeFileSync(
		join(w.cwd, ".maestro/config.yaml"),
		`target:\n  repo: ${missing}\n  base: main\n`,
	);
	const filed = await w.call(["compose", script]);
	expect(filed.code).toBe(1);
	expect(filed.err).toContain("does not exist");
});

test("a lane ref names a version by the instance id ls shows, ls shows its disk use and prune frees it", async () => {
	const w = await repoWorld();
	const marked = await w.call(["perform", join(REPO, "mark.ts")]);
	expect(marked).toMatchObject({ code: 0 });
	const id = idOf(marked);

	const shown = "parMap[risk]/skeptic";
	expect((await w.call(["ls", id])).out).toContain(shown);
	const { instances } = json(await w.call(["ls", id, "--json"]));
	const ref = `${id}.${shown}`;
	expect(
		instances.find((i: { node: string }) => i.node === "parMap/skeptic")
			?.outputs.lane,
	).toBe(ref);
	const followed = await w.call([
		"perform",
		join(REPO, "follow.ts"),
		"--from",
		ref,
	]);
	expect(followed).toMatchObject({ code: 0 });

	const diskOf = async () =>
		json(await w.call(["ls", "--json"])).find(
			(r: { id: string }) => r.id === id,
		)?.diskUse;
	expect(await diskOf()).toBeGreaterThan(64 * 1024);
	expect(await w.call(["prune", id, "--yes"])).toMatchObject({ code: 0 });
	expect(await diskOf()).toBeUndefined();
	expect(
		await w.call(["perform", join(REPO, "follow.ts"), "--from", ref]),
	).toMatchObject({ code: 1 });
});

/** A composition of one stub agent declaring outputs, then a check. */
async function smokeFile() {
	const file = join(await scratch(), "smoke.ts");
	writeFileSync(
		file,
		`import { check, fresh, JsonOut, MarkdownOut, read, seat } from "@maestro/host-repo-sdk";
import { composition, List, Struct, Text } from "@maestro/sdk";

const Rows = Struct({ rows: List(Struct({ name: Text() })) });

export const smoke = composition("smoke", { examples: [{}] }, () => {
	const a = seat("smoke")({
		label: "a",
		task: "nothing",
		lane: fresh(),
		out: { rows: JsonOut("rows.json", Rows), notes: MarkdownOut("notes.md") },
	});
	return check(read(a.out.lane), { run: "true" }, { label: "ok" });
});
`,
	);
	return file;
}

const STUB_DELAY_MS = 700;

test("the built-in stub harness, delayed per turn, performs an agent that declares outputs, and the check after it settles ok", async () => {
	const file = await smokeFile();
	const w = await repoWorld(SMOKE_RUNTIME("stub"), {
		MAESTRO_STUB_DELAY: `${STUB_DELAY_MS}ms`,
	});
	const began = Date.now();
	const done = await w.call(["perform", file]);
	expect(Date.now() - began).toBeGreaterThanOrEqual(STUB_DELAY_MS);
	expect(done).toMatchObject({ code: 0 });
	const { instances } = json(await w.call(["ls", idOf(done), "--json"]));
	expect(instances.map((i: { status: string }) => i.status)).toEqual([
		"ok",
		"ok",
	]);
});

test("a malformed MAESTRO_STUB_DELAY fails the stub agent, naming it", async () => {
	const w = await repoWorld(SMOKE_RUNTIME("stub"), {
		MAESTRO_STUB_DELAY: "soon",
	});
	const done = await w.call(["perform", await smokeFile()]);
	expect(done.code).not.toBe(0);
	expect(done.out + done.err).toContain("MAESTRO_STUB_DELAY");
});

/** A composition of a stub agent with a markdown output in a scope, and two more under a parMap. */
async function artsFile() {
	const file = join(await scratch(), "arts.ts");
	writeFileSync(
		file,
		`import { fresh, MarkdownOut, seat } from "@maestro/host-repo-sdk";
import { composition, iter, use } from "@maestro/sdk";

const smoke = seat("smoke");

const inner = composition("inner", { examples: [{}] }, () =>
	smoke({
		label: "a",
		task: "nothing",
		lane: fresh(),
		out: { notes: MarkdownOut("notes.md") },
	}),
);

export const arts = composition("arts", { examples: [{}] }, () => {
	use(inner, {});
	return iter.parMap(["x", "y"], () =>
		smoke({ label: "b", task: "nothing", lane: fresh() }),
		{ onError: "stop" },
	);
});
`,
	);
	return file;
}

test("artifact lists a concert's artifacts, prints an instance's files by a unique ending, and refuses what names none", async () => {
	const w = await repoWorld(SMOKE_RUNTIME("stub"));
	const done = await w.call(["perform", await artsFile()]);
	expect(done).toMatchObject({ code: 0 });
	const id = idOf(done);
	const area = join(w.root, "data/maestro/concerts", id, "artifacts");
	const listed: { instance: string; port: string; path: string }[] = json(
		await w.call(["art", "ls", id, "--json"]),
	);
	expect(
		listed
			.filter((a) => a.instance === "inner/a")
			.map((a) => [a.port, a.path.startsWith(`${area}/`)]),
	).toEqual([
		["notes", true],
		["staged", true],
	]);
	const table = (await w.call(["artifact", "ls", id])).out.split("\n");
	expect(table[0]).toMatch(/^instance +port +stale +path$/);
	expect(table).toContain(
		`inner/a      notes          ${listed.find((a) => a.port === "notes")?.path}`,
	);
	expect((await w.call(["art", "ls", id, "--path"])).out).toBe(
		listed.map((a) => a.path).join("\n"),
	);

	const staged = (name: string) =>
		readFileSync(
			join(listed.find((a) => a.port === "staged")?.path ?? "", name),
			"utf8",
		);
	const notes = listed.find((a) => a.port === "notes")?.path ?? "";
	/** Stdout of `art show <id> ...args` exactly as written. */
	const raw = async (...args: string[]) => {
		const written: string[] = [];
		const done = await w.call(["art", "show", id, ...args], {
			stdout: (line) => written.push(`${line}\n`),
			stdoutBytes: (bytes) => written.push(new TextDecoder().decode(bytes)),
		});
		expect(done.code).toBe(0);
		return written.join("");
	};
	const patch =
		"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n";
	writeFileSync(
		join(listed.find((a) => a.port === "staged")?.path ?? "", "x.patch"),
		patch,
	);
	expect(await raw("a", "staged/x.patch")).toBe(patch);
	expect(await raw("a", "staged/x.patch", "--color")).toBe(diffColored(patch));
	expect(await raw("a", "staged/x.patch", "--color", "--no-color")).toBe(patch);
	expect(await raw("a", "staged/prompt.md", "--color")).toBe(
		staged("prompt.md"),
	);
	const latin1 = Buffer.from(
		"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-caf\xe9\n+na\xefve\n",
		"latin1",
	);
	writeFileSync(
		join(listed.find((a) => a.port === "staged")?.path ?? "", "x.patch"),
		latin1,
	);
	const bytes: Buffer[] = [];
	await w.call(["art", "show", id, "a", "staged/x.patch", "--color"], {
		stdoutBytes: (b) => bytes.push(Buffer.from(b)),
	});
	expect(Buffer.concat(bytes).includes(Buffer.from("caf\xe9", "latin1"))).toBe(
		true,
	);
	rmSync(join(listed.find((a) => a.port === "staged")?.path ?? "", "x.patch"));
	const prompt = staged("prompt.md");
	expect(await raw("a", "staged/prompt.md")).toBe(prompt);
	const ended = (text: string) =>
		text === "" || text.endsWith("\n") ? text : `${text}\n`;
	expect(await raw("inner/a")).toBe(
		`══ notes.md\n${ended(readFileSync(notes, "utf8"))}══ staged/instructions.md\n${ended(staged("instructions.md"))}══ staged/prompt.md\n${prompt}`,
	);
	expect(await raw("a", "notes.md", "--path")).toBe(`${notes}\n`);
	const bStaged = listed.find((a) => a.instance === "parMap[x]/b")?.path ?? "";
	expect(await raw("parMap[x]/b")).toBe(
		`══ staged/instructions.md\n${readFileSync(join(bStaged, "instructions.md"), "utf8")}══ staged/prompt.md\n${readFileSync(join(bStaged, "prompt.md"), "utf8")}`,
	);

	expect(await w.call(["art", "show", id, "parMap"])).toMatchObject({
		code: 1,
		err: `error: instance 'parMap' of concert ${id} has no artifacts yet\n  See where it stands with 'maestro ls ${id}'`,
	});
	for (const ending of ["b", "parMap/b"])
		expect(await w.call(["art", "show", id, ending])).toMatchObject({
			code: 2,
			err: `error: '${ending}' ends 2 instances: parMap[x]/b, parMap[y]/b\n  Name one of them in full`,
		});
	const HELP = "or see 'maestro artifact --help' for examples";
	const LS = `Name one as 'maestro ls' lists it, ${HELP}`;
	const SHOW = `Name one as 'maestro artifact ls <concert>' lists it, ${HELP}`;
	const MANY = `Name a file by its name, or leave it out to print every file, ${HELP}`;
	const FIX =
		"Run 'maestro artifact ls <concert>', or 'maestro artifact show <concert> <instance>'";
	for (const [args, last] of [
		[["ls"], LS],
		[["ls", id, "a"], LS],
		[["show", id], SHOW],
		[["show", id, "a", "b", "c"], MANY],
		[["show", id, "nope"], `List them with 'maestro ls ${id}'`],
		[
			["show", id, "a", "nope.md"],
			`List them with maestro art show ${id} inner/a --path`,
		],
		[["show", id, "a", "--json"], "Drop --json to print the instance's files"],
		[["ls", id, "--json", "--path"], "Drop one of them"],
		[[id], FIX],
		[[id, "a"], FIX],
		[[], FIX],
	] as const) {
		const refused = await w.call(["art", ...args]);
		expect(refused.code).toBe(2);
		const text: string = refused.err || json(refused).error;
		expect(text.split("\n").at(-1)?.trim()).toBe(last);
	}
	expect((await w.call(["art", id])).err).toStartWith(
		`error: expected ls or show, got '${id}'`,
	);
	const db = new Database(join(w.root, "data/maestro/record.db"));
	db.run(
		"UPDATE instances SET stale = 1 WHERE (node, expansion) IN (SELECT node, expansion FROM artifacts WHERE path LIKE '%notes.md')",
	);
	db.close();
	const note = "warning: instance 'inner/a' is stale, from an earlier attempt";
	const marked: { instance: string; stale?: true }[] = json(
		await w.call(["art", "ls", id, "--json"]),
	);
	expect(
		marked.map((a) => [a.instance === "inner/a", "stale" in a, a.stale]),
	).toEqual(
		marked.map((a) =>
			a.instance === "inner/a" ? [true, true, true] : [false, false, undefined],
		),
	);
	expect(
		(await w.call(["art", "ls", id])).out
			.split("\n")
			.filter((l) => /^\S+ +\S+ +stale +\//.test(l))
			.map((l) => l.split(" ")[0]),
	).toEqual(["inner/a", "inner/a"]);
	for (const args of [["a"], ["a", "notes.md"], ["a", "--path"]])
		expect((await w.call(["art", "show", id, ...args])).err).toBe(note);
	expect((await w.call(["art", "show", id, "parMap[x]/b"])).err).toBe("");
	rmSync(notes);
	expect(await w.call(["art", "show", id, "a", "notes.md"])).toMatchObject({
		code: 1,
		err: `error: the artifact is not at ${notes}\n  Perform the concert again, or pick another instance`,
	});
});

/** A composition of an agent of profile smoke, after a code node that fails while `gate` is missing. */
async function gated(gate = "/"): Promise<string> {
	const file = join(await scratch(), "gated.ts");
	writeFileSync(
		file,
		`import { existsSync } from "node:fs";
import { check, fresh, read, seat } from "@maestro/host-repo-sdk";
import { code, composition, Text } from "@maestro/sdk";

export function opened() {
	if (!existsSync("${gate}")) throw new Error("gate closed");
	return { text: "go" };
}

export const gated = composition("gated", { examples: [{}] }, () => {
	const gate = code(opened, { in: {}, out: { text: Text() } });
	const a = seat("smoke")({ label: "a", task: gate.out.text, lane: fresh() });
	return check(read(a.out.lane), { run: "true" }, { label: "ok" });
});
`,
	);
	return file;
}

/** A composition of two stub agents, of profiles smoke and other. */
async function pairFile() {
	const file = join(await scratch(), "pair.ts");
	writeFileSync(
		file,
		`import { fresh, seat } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const pair = composition("pair", { examples: [{}] }, () => {
	seat("smoke")({ label: "a", task: "nothing", lane: fresh() });
	return seat("other")({ label: "b", task: "nothing", lane: fresh() });
});
`,
	);
	return file;
}

/** A composition of three stub agents, of profiles smoke, other and third. */
async function trioFile() {
	const file = join(await scratch(), "trio.ts");
	writeFileSync(
		file,
		`import { fresh, seat } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const trio = composition("trio", { examples: [{}] }, () => {
	seat("smoke")({ label: "a", task: "nothing", lane: fresh() });
	seat("other")({ label: "b", task: "nothing", lane: fresh() });
	return seat("third")({ label: "c", task: "nothing", lane: fresh() });
});
`,
	);
	return file;
}

describe("profiles with no runtime", () => {
	test("--json on a gapped composition gives one JSON document", async () => {
		const w = await repoWorld();
		const composed = await w.call(["compose", await smokeFile(), "--json"]);
		expect(composed.code).toBe(1);
		expect(json(composed)).toMatchObject({ ok: false });
	});

	test("several gaps end on one line naming every preset that sets all of them", async () => {
		const w = await repoWorld();
		for (const name of ["other", "third"])
			profileIn(w.cwd, name, "instructions: instructions.md\n", {
				"instructions.md": "terse",
			});
		const both =
			"profiles:\n  '*':\n    runtime: { harness: stub, model: none }\n";
		await Bun.write(join(w.cwd, ".maestro/presets/alpha.yaml"), both);
		await Bun.write(join(w.cwd, ".maestro/presets/beta.yaml"), both);
		const composed = await w.call(["compose", await trioFile()]);
		expect(composed.err.split("\n")).toEqual([
			"error: profile smoke: no harness or model",
			"error: profile other: no harness or model",
			"error: profile third: no harness or model",
			"  Pass --preset alpha or --preset beta, which each set all of these",
		]);
		const closing =
			"Pass --preset alpha or --preset beta, which each set all of these";
		const { diagnostics } = json(
			await w.call(["compose", await trioFile(), "--json"]),
		);
		expect(diagnostics.map((d: { hint: string }) => d.hint)).toEqual([
			closing,
			closing,
			closing,
		]);
	});

	test("with no preset setting every gap, each gap gets the presets that set it, else the config fix", async () => {
		const w = await repoWorld();
		profileIn(w.cwd, "other", "instructions: instructions.md\n", {
			"instructions.md": "terse",
		});
		await Bun.write(
			join(w.cwd, ".maestro/presets/harness.yaml"),
			"profiles:\n  '*':\n    runtime: { harness: stub }\n",
		);
		await Bun.write(
			join(w.cwd, ".maestro/presets/just-smoke.yaml"),
			"profiles:\n  smoke:\n    runtime: { harness: stub, model: none }\n",
		);
		const composed = await w.call(["compose", await pairFile()]);
		expect(composed.err.split("\n")).toEqual([
			"error: profile smoke: no harness or model",
			"  Pass --preset just-smoke",
			"error: profile other: no harness or model",
			"  Set profiles.other.runtime.harness and profiles.other.runtime.model",
		]);
	});

	test("compose prints the graph on stdout, the gaps on stderr ending on the preset that sets them all, and exits 1", async () => {
		const w = await repoWorld();
		profileIn(w.cwd, "other", "instructions: instructions.md\n", {
			"instructions.md": "terse",
		});
		const both =
			"profiles:\n  '*':\n    runtime: { harness: stub, model: none }\n";
		await Bun.write(join(w.cwd, ".maestro/presets/all.yaml"), both);
		await Bun.write(
			join(w.cwd, ".maestro/presets/some.yaml"),
			"profiles:\n  smoke:\n    runtime: { harness: stub, model: none }\n",
		);
		const file = await pairFile();
		const out = join(await scratch(), "saved.json");
		const composed = await w.call(["compose", file, "--graph", "--out", out]);
		expect(composed.code).toBe(1);
		expect(composed.out).toContain("flowchart");
		expect(composed.err.split("\n")).toEqual([
			"error: profile smoke: no harness or model",
			"error: profile other: no harness or model",
			"  Pass --preset all, which sets all of these",
		]);
		expect(await Bun.file(out).exists()).toBe(false);
		expect(
			(await w.call(["compose", file, "--graph", "--preset", "all"])).code,
		).toBe(0);
	});

	test("a refusal from a -c exits as --json does", async () => {
		const w = await repoWorld();
		const args = [
			"compose",
			await smokeFile(),
			"-c",
			"profiles.smoke.runtime.harness=gone",
			"-c",
			"profiles.smoke.runtime.model=none",
		];
		const text = await w.call(args);
		expect(text.code).toBe((await w.call([...args, "--json"])).code);
	});

	test("one profile with neither is one error", async () => {
		const w = await repoWorld();
		const composed = await w.call(["compose", await smokeFile()]);
		expect(composed.code).toBe(1);
		expect(composed.out).toContain("instances");
		expect(composed.err.split("\n")).toEqual([
			"error: profile smoke: no harness or model",
			"  Set profiles.smoke.runtime.harness and profiles.smoke.runtime.model",
		]);
	});

	test("perform refuses a gap naming the preset that fills it", async () => {
		const w = await repoWorld();
		await Bun.write(
			join(w.cwd, ".maestro/presets/all.yaml"),
			"profiles:\n  '*':\n    runtime: { harness: stub, model: none }\n",
		);
		const refused = await w.call(["perform", await smokeFile()]);
		expect(refused.code).toBe(1);
		expect(refused.err.split("\n")).toEqual([
			"error: profile smoke: no harness or model",
			"  Pass --preset all",
		]);
	});

	test("a check config lacks is a gap carrying the setting it lacks, and a preset that sets it is the fix", async () => {
		const w = await repoWorld(SMOKE_RUNTIME("stub"));
		const file = (await smokeFile()).replace(".ts", "-checked.ts");
		writeFileSync(
			file,
			readFileSync(await smokeFile(), "utf8").replace(
				'task: "nothing",',
				'task: "nothing", checks: ["absent"],',
			),
		);
		await Bun.write(
			join(w.cwd, ".maestro/presets/checked.yaml"),
			'target:\n  checks:\n    absent: { run: "true", hint: it passes }\n',
		);
		const composed = await w.call(["compose", file]);
		expect(composed.code).toBe(1);
		expect(composed.err.split("\n")).toEqual([
			"error: 'a' may run check 'absent', which config 'target.checks' does not have",
			"  Pass --preset checked",
		]);
		const { diagnostics } = json(await w.call(["compose", file, "--json"]));
		expect(diagnostics[0].unset).toEqual([[["target", "checks", "absent"]]]);
		expect((await w.call(["compose", file, "--preset", "checked"])).code).toBe(
			0,
		);
	});
});

describe("profiles", () => {
	test("a runtime field on the command line or in a preset beats the config file's", async () => {
		const w = await repoWorld(SMOKE_RUNTIME("gone"));
		const file = await gated();
		await Bun.write(
			join(w.cwd, ".maestro/presets/free.yaml"),
			"profiles:\n  smoke:\n    runtime:\n      harness: stub\n",
		);
		const refused = await w.call(["perform", file]);
		expect(refused).toMatchObject({ code: 1 });
		expect(refused.err).toContain(
			"profile smoke runs on harness 'gone', which is not loaded",
		);
		for (const flags of [
			["--preset", "free"],
			["-c", "profiles.smoke.runtime.harness=stub"],
		])
			expect(await w.call(["perform", file, ...flags])).toMatchObject({
				code: 0,
			});
	});

	test("compose lists each agent's node, seat, profile, harness, model and thinking, in text and JSON", async () => {
		const w = await repoWorld(
			"profiles:\n  smoke:\n    runtime:\n      harness: stub\n      model: none\n      thinking: low\n",
		);
		const file = await smokeFile();
		expect(
			json(
				await w.call([
					"compose",
					file,
					"--json",
					"-c",
					"profiles.smoke.runtime.model=big",
				]),
			).agents,
		).toEqual([
			{
				node: "a",
				seat: "smoke/smoke",
				profile: "smoke",
				harness: "stub",
				model: "big",
				thinking: "low",
			},
		]);
		expect((await w.call(["compose", file, "--plan"])).out).toMatch(
			/\nagents:\n {2}node +seat +profile +harness +model +thinking\n {2}a +smoke\/smoke +smoke +stub +none +low$/,
		);
	});

	test("--plan with a profile that leaves its harness and model unset prints the plan, then the diagnostics, and exits 1", async () => {
		const w = await repoWorld();
		const file = await smokeFile();
		profileIn(w.cwd, "smoke", "limits: { tokens: 1 }\n");
		const done = await w.call(["compose", file, "--plan"]);
		expect(done.code).toBe(1);
		expect(done.out).toMatch(
			/\nagents:\n {2}node +seat +profile +harness +model +thinking\n {2}a +smoke\/smoke +smoke +- +- +-$/,
		);
		expect(done.err).toContain("profile smoke: no harness or model");
	});

	test("--plan with a profile config refuses for another fault still prints the plan, its runtime shown as dashes", async () => {
		const w = await repoWorld(SMOKE_RUNTIME("stub"));
		const done = await w.call([
			"compose",
			await smokeFile(),
			"-c",
			"profiles.smoke.limits.timeout=bogus",
			"--plan",
		]);
		expect(done.code).not.toBe(0);
		expect(done.out).toMatch(/\n {2}a +smoke\/smoke +smoke +- +- +-$/);
		expect(done.err).toContain("limits.timeout 'bogus'");
	});

	test("seats rebinds a seat by <composition>/<seat>: the preset over the workspace config, -c over the preset", async () => {
		const w = await repoWorld("seats:\n  smoke/smoke: ws\n");
		for (const name of ["ws", "pre", "flag"])
			profileIn(w.cwd, name, `runtime: { harness: stub, model: ${name} }\n`);
		await Bun.write(
			join(w.cwd, ".maestro/presets/p.yaml"),
			"seats:\n  smoke/smoke: pre\n",
		);
		const file = await smokeFile();
		const bound = async (...flags: string[]) =>
			json(await w.call(["compose", file, "--json", ...flags])).agents[0]
				.profile;
		expect(await bound()).toBe("ws");
		expect(await bound("--preset", "p")).toBe("pre");
		expect(await bound("--preset", "p", "-c", "seats.smoke/smoke=flag")).toBe(
			"flag",
		);
	});

	test("a resume resolves its profiles anew", async () => {
		const w = await repoWorld();
		const gate = join(w.cwd, "gate");
		const runtime = (harness: string) =>
			profileIn(
				w.cwd,
				"smoke",
				`runtime: { harness: ${harness}, model: none }\n`,
			);
		runtime("stub");
		const failed = await w.call(["perform", await gated(gate)]);
		expect(failed).toMatchObject({ code: 1 });
		expect(failed.err).toContain("gate closed");
		writeFileSync(gate, "");
		runtime("gone");
		const resume = ["resume", idOf(failed)];
		expect(await w.call(resume)).toMatchObject({
			code: 1,
			err: expect.stringContaining("harness 'gone', which is not loaded"),
		});
		runtime("stub");
		expect(await w.call(resume)).toMatchObject({ code: 0 });
	});

	test("a concert or an IR built before profiles is refused, to be performed anew", async () => {
		const w = await repoWorld(SMOKE_RUNTIME("stub"));
		const gate = join(w.cwd, "gate");
		const file = await gated(gate);
		const legacy = (ir: {
			irVersion: string;
			nodes: { id: string; config?: unknown }[];
		}) => {
			const agent = ir.nodes.find((n) => n.id === "a");
			if (agent)
				agent.config = { role: { name: "smoke" }, lane: { mode: "fresh" } };
			return { ...ir, irVersion: "1.0" };
		};
		const refusal =
			"agent node 'a' names a role: it was built before profiles replaced roles\n  Perform its composition anew with this maestro";

		const irFile = join(w.cwd, "old.json");
		writeFileSync(
			irFile,
			JSON.stringify(
				legacy(
					json(await w.call(["compose", await smokeFile(), "--json"])).plan.ir,
				),
			),
		);
		expect(await w.call(["perform", irFile])).toMatchObject({
			code: 1,
			err: expect.stringContaining(refusal),
		});

		const failed = await w.call(["perform", file]);
		expect(failed).toMatchObject({ code: 1 });
		const db = new Database(join(w.root, "data/maestro/record.db"));
		const id = idOf(failed);
		const { ir } = db.query("SELECT ir FROM concerts WHERE id = ?").get(id) as {
			ir: string;
		};
		db.run("UPDATE concerts SET ir = ? WHERE id = ?", [
			JSON.stringify(legacy(JSON.parse(ir))),
			id,
		]);
		db.close();
		writeFileSync(gate, "");
		expect(await w.call(["resume", id])).toMatchObject({
			code: 1,
			err: expect.stringContaining(refusal),
		});
	});
});

/** Each real harness behind its gate: the agent's instructions and file, and the metrics it reports. */
const REAL_HARNESSES = [
	{
		gate: "MAESTRO_PI",
		harness: "pi",
		model: process.env.MAESTRO_PI_MODEL ?? "github-copilot/gpt-5-mini",
	},
	{
		gate: "MAESTRO_CLAUDE",
		harness: "claude",
		model: process.env.MAESTRO_CLAUDE_MODEL ?? "haiku",
	},
];

for (const { gate, harness, model } of REAL_HARNESSES) {
	test.skipIf(!process.env[gate])(
		`${harness} performs an agent with instructions, and its file is in the version a check reads`,
		async () => {
			const w = await repoWorld();
			profileIn(
				w.cwd,
				"writer",
				`runtime: { harness: ${harness}, model: ${model}, thinking: low }\ninstructions: instructions.md\n`,
				{
					"instructions.md":
						"You end every report summary you give with the word kumquat.",
				},
			);
			const done = await w.call(["perform", join(REPO, "write.ts")]);
			expect(done).toMatchObject({ code: 0 });
			const { instances } = json(await w.call(["ls", idOf(done), "--json"]));
			const agent = instances.find((i: { node: string }) => i.node === "write");
			expect(agent.outputs.report.summary.toLowerCase()).toContain("kumquat");
			expect(agent.metrics.tokens_in).toBeGreaterThan(0);
			const [instructions] = [
				...new Bun.Glob("**/staged/instructions.md").scanSync({
					cwd: w.root,
					absolute: true,
				}),
			];
			expect(readFileSync(instructions ?? "", "utf8")).toContain("kumquat");
		},
		180_000,
	);
}

describe("changeset", () => {
	/** Git `args` in `repo`, its stdout trimmed. */
	const git = (repo: string, ...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", repo, ...args], { env: GIT_ENV });
		if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr}`);
		return p.stdout.toString().trim();
	};

	/** A concert of `file` whose changeset rewrites `a.txt` of the target, committed as `base` before it, and `cs`. */
	async function edited(file = "edit.ts", base = "one\n") {
		const w = await repoWorld();
		writeFileSync(join(w.target, "a.txt"), base);
		git(w.target, "add", "a.txt");
		git(w.target, "commit", "-q", "-m", "two");
		const done = await w.call(["perform", join(REPO, file)]);
		expect(done).toMatchObject({ code: 0 });
		const cs = (...args: string[]) => w.call(["cs", ...args], { env: GIT_ENV });
		return { ...w, id: idOf(done), cs };
	}

	const a = (repo: string) => readFileSync(join(repo, "a.txt"), "utf8");

	test("show prints the diff byte for byte, so a patch ending on a blank context line applies", async () => {
		const w = await edited("blank.ts", "one\n\n");
		const shown = await w.cs("show", w.id);
		expect(shown).toMatchObject({ code: 0 });
		expect(shown.out.endsWith("+edited\n ")).toBe(true);
		const patch = join(w.root, "shown.patch");
		writeFileSync(patch, `${shown.out}\n`);
		git(w.target, "apply", "--check", patch);
		expect(a(w.target)).toBe("one\n\n");
	});

	test("show prints the diff on its base and leaves the checkout as it is; --node takes a named instance's", async () => {
		const w = await edited();
		const shown = await w.cs("show", w.id);
		const diff = shown.out;
		expect(shown).toMatchObject({
			code: 0,
			out: expect.stringContaining("-one\n+edited"),
			err: expect.stringMatching(/\(node \S+, concert ok\) on base \w+ two$/),
		});
		expect(a(w.target)).toBe("one\n");
		expect(git(w.target, "status", "--porcelain")).toBe("");
		expect((await w.cs("show", w.id, "--stat")).out).toContain("a.txt | 2");
		expect((await w.cs("show", w.id, "--summary")).out).toMatch(
			/^tour {3}-\ntitle {2}-\nM\ta\.txt$/,
		);

		const { instances } = json(await w.call(["ls", w.id, "--json"]));
		const made = instances.find(
			(i: { outputs?: object }) => i.outputs && "changeset" in i.outputs,
		);
		expect((await w.cs("show", w.id, "--node", made.node)).out).toBe(diff);
		expect(await w.cs("show", w.id, "--node", "edit")).toMatchObject({
			code: 1,
			err: expect.stringContaining("instance 'edit' of concert"),
		});
		expect(await w.cs("show", w.id, "--node", "nope")).toMatchObject({
			code: 2,
		});

		const fan = idOf(await w.call(["perform", join(REPO, "fan.ts")]));
		expect((await w.cs("show", fan, "--node", "innerSet")).out).toContain(
			"+inner",
		);
		expect(await w.cs("show", fan, "--node", "set")).toMatchObject({
			code: 2,
			err: "error: 'set' ends 2 instances: parMap[x]/set, parMap[y]/set\n  Name one of them in full",
		});

		const checked = await w.call([
			"perform",
			join(REPO, "edit.ts"),
			"-c",
			'target.checks.lint={run: "true"}',
		]);
		const unset = ["-c", "target.checks.lint=!delete"];
		expect(await w.cs("show", idOf(checked), ...unset)).toMatchObject({
			code: 0,
		});
	});

	test("the closing block shows what the changeset touches on a terminal stdout only", async () => {
		const w = await edited();
		const terminal = () => ({ columns: 80, rows: 24 });
		const env = { ...GIT_ENV, NO_COLOR: "1" };
		expect((await w.call(["wait", w.id], { terminal, env })).out).toMatch(
			/\nchanges {4}1 file {2}\+1 \u22121\nmaestro ls \S+ --json$/,
		);
		expect((await w.call(["wait", w.id], { env })).out).not.toMatch(
			/^changes /m,
		);
	});

	test("a changeset's message is shown first, and apply --commit makes one commit with it, refusing a changeset without one", async () => {
		const bare = await edited();
		expect(await bare.cs("apply", bare.id, "--commit")).toMatchObject({
			code: 1,
			err: expect.stringContaining("Drop --commit"),
		});
		expect(git(bare.target, "diff", "--cached", "--name-only")).toBe("");
		expect(a(bare.target)).toBe("one\n");

		const w = await edited("message.ts");
		expect((await w.cs("show", w.id)).out).toMatch(
			/^Edit a\.txt\n\nIt now says edited\.\n/,
		);
		const head = git(w.target, "rev-parse", "HEAD");
		expect(await w.cs("apply", w.id, "--commit")).toMatchObject({
			code: 0,
			err: expect.stringMatching(/and committed it as \w+$/),
		});
		expect(git(w.target, "rev-list", "--count", `${head}..HEAD`)).toBe("1");
		expect(git(w.target, "log", "-1", "--format=%B")).toBe(
			"Edit a.txt\n\nIt now says edited.",
		);
		expect(git(w.target, "log", "-1", "--format=%an")).toBe("op");
		expect(git(w.target, "status", "--porcelain")).toBe("");
		expect(a(w.target)).toBe("edited\n");
	});

	test("apply stages the changeset on HEAD, refuses uncommitted changes, and drop resets it", async () => {
		const w = await edited();
		const applied = await w.cs("apply", w.id);
		expect(applied).toMatchObject({
			code: 0,
			out: expect.stringContaining("a.txt | 2"),
			err: expect.stringMatching(
				/^applied \S+ \(node \S+, concert ok\) on \w+, staged\. Next: commit it, or 'maestro cs drop'$/,
			),
		});
		expect(git(w.target, "diff", "--cached", "--name-only")).toBe("a.txt");
		expect(await w.cs("apply", w.id)).toMatchObject({
			code: 1,
			err: `error: ${w.target} has uncommitted changes\n  Commit or stash them first`,
		});
		for (const refused of [
			["apply", w.id, "--stat"],
			["show", w.id, "--stat", "--summary"],
			["drop", w.id],
		])
			expect(await w.cs(...refused)).toMatchObject({ code: 2 });
		expect(await w.cs("drop")).toMatchObject({
			code: 2,
			err: expect.stringContaining("Pass --yes"),
		});
		expect(await w.cs("drop", "--yes")).toMatchObject({ code: 0 });
		expect(a(w.target)).toBe("one\n");
		expect(await w.cs("drop", "--yes")).toMatchObject({
			code: 0,
			err: `nothing to drop: ${w.target} has no uncommitted changes`,
		});
	});

	test("a patch that conflicts with HEAD exits 3 and leaves the markers", async () => {
		const w = await edited();
		writeFileSync(join(w.target, "a.txt"), "other\n");
		git(w.target, "commit", "-q", "-am", "three");
		expect(await w.cs("apply", w.id)).toMatchObject({
			code: 3,
			err: expect.stringContaining("Resolve the conflicts and commit"),
		});
		expect(a(w.target)).toContain("<<<<<<<");
	});

	test("-C works in another checkout, and refuses one without the base", async () => {
		const w = await edited();
		const clone = join(await scratch(), "clone");
		git(w.target, "clone", "-q", w.target, clone);
		expect(await w.cs("apply", w.id, "-C", clone)).toMatchObject({ code: 0 });
		expect(git(clone, "diff", "--cached", "--name-only")).toBe("a.txt");
		expect(git(w.target, "status", "--porcelain")).toBe("");

		const other = await toyTarget();
		const base = git(w.target, "rev-parse", "HEAD");
		expect(await w.cs("show", w.id, "-C", other)).toMatchObject({
			code: 1,
			err: `error: base ${base} is not in ${other}\n  Fetch it first`,
		});
	});

	test("a preset-performed concert's changeset reads from outside its workspace with -C, and without it names the workspace", async () => {
		const w = await edited();
		await Bun.write(join(w.cwd, ".maestro/presets/free.yaml"), "{}\n");
		const id = idOf(
			await w.call(["perform", join(REPO, "edit.ts"), "--preset", "free"]),
		);
		const outside = { env: GIT_ENV, cwd: await scratch() };
		const cs = (...args: string[]) =>
			w.call(["cs", "show", id, ...args], outside);
		expect(await cs("-C", w.target)).toMatchObject({
			code: 0,
			out: expect.stringContaining("+edited"),
		});
		expect(await cs("-c", `target.repo=${w.target}`)).toMatchObject({
			code: 0,
		});
		const refused = await cs();
		expect(refused.code).toBe(1);
		expect(refused.err).toMatch(
			/preset needs its workspace\n {2}Pass -C <repo>, or run from inside workspace 'ws'$/,
		);
		expect(refused.err).not.toContain("Resume");

		const ambient = join(w.root, "config/maestro/config.yaml");
		await Bun.write(ambient, `target:\n  repo: ${w.target}\n`);
		expect(await cs()).toMatchObject({ code: 1, err: refused.err });
		rmSync(ambient);

		rmSync(join(w.cwd, ".maestro/presets/free.yaml"));
		const missing = await w.call(["cs", "show", id], { env: GIT_ENV });
		expect(missing.err).toContain("Restore");
		expect(missing.err).not.toContain("needs its workspace");
	});

	test("changeset takes the result's changeset, else the last ok one with a warning, and refuses an empty one", async () => {
		const w = await edited("pick.ts");
		expect((await w.cs("show", w.id)).out).toContain("+kept");
		expect(await w.cs("show", w.id, "--node", "emptySet")).toMatchObject({
			code: 1,
			err: expect.stringContaining("is empty\n  Pick another node with --node"),
		});
		const failed = await w.call(["perform", join(REPO, "reject.ts")]);
		expect(failed).toMatchObject({ code: 3 });
		const shown = await w.cs("show", idOf(failed));
		expect(shown.out).toContain("+kept");
		expect(shown.err).toMatch(
			/^warning: concert \S+ is rejected; this is keptSet's changeset, not a delivered result$/m,
		);
	});
});

describe("changeset --partial", () => {
	const failer = repoHost({
		harnesses: [
			stubHarness([
				{ write: "a.txt", content: "lost\n" },
				{ emit: { type: "fault", reason: "boom" } },
			]),
		],
	});

	async function failed() {
		const w = await repoWorld(SMOKE_RUNTIME("stub"));
		const done = await w.call(["perform", join(REPO, "failing.ts")], {
			hosts: [failer],
		});
		expect(done).toMatchObject({ code: 1 });
		const cs = (...args: string[]) => w.call(["cs", ...args], { env: GIT_ENV });
		return { ...w, id: idOf(done), cs };
	}

	test("show and apply take the work a failed agent left", async () => {
		const w = await failed();
		expect(
			await w.cs("show", w.id, "--node", "build", "--partial"),
		).toMatchObject({ code: 0, out: expect.stringContaining("+lost") });
		expect(await w.cs("show", w.id, "--node", "build")).toMatchObject({
			code: 1,
			err: expect.stringContaining("made no changeset"),
		});
		expect(
			await w.cs("apply", w.id, "--node", "build", "--partial"),
		).toMatchObject({ code: 0 });
		expect(readFileSync(join(w.target, "a.txt"), "utf8")).toBe("lost\n");
	});

	test("--partial without --node is a usage error, and an instance with no partial is refused", async () => {
		const w = await failed();
		expect(await w.cs("show", w.id, "--partial")).toMatchObject({
			code: 2,
			err: expect.stringContaining("--partial needs --node"),
		});
		const ok = idOf(await w.call(["perform", join(REPO, "edit.ts")]));
		expect(await w.cs("show", ok, "--node", "edit", "--partial")).toMatchObject(
			{
				code: 1,
				err: expect.stringMatching(
					/kept no partial work\n {2}Pick a failed agent from 'maestro ls \S+'$/,
				),
			},
		);
	});
});

describe("MAESTRO_STUB_OUTPUTS", () => {
	/** A fixture dir holding `files`, each keyed by its path under it. */
	async function fixtures(files: Record<string, string>) {
		const dir = await scratch();
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), text);
		}
		return dir;
	}

	const perform = async (dir: string | undefined, file: string) => {
		const w = await repoWorld(
			SMOKE_RUNTIME("stub"),
			dir === undefined ? {} : { MAESTRO_STUB_OUTPUTS: dir },
		);
		const done = await w.call(["perform", file]);
		const listing = (await w.call(["ls", idOf(done)])).out;
		const instances = listing
			.split("\n")
			.map((l) => l.trim().split(/\s+/))
			.filter(([id]) => id?.endsWith("review"))
			.map(([id, status]) => ({ id: id ?? "", status: status ?? "" }));
		return { w, done, instances };
	};

	const ROUNDS = join(REPO, "rounds.ts");

	test("fixtures that reject round 0 and approve round 1 end a loop after two rounds", async () => {
		const dir = await fixtures({
			"review/verdict": "rejected missing a test\n",
			"rounds[0]/review/verdict": "ok",
		});
		const { done, instances } = await perform(dir, ROUNDS);
		expect(done).toMatchObject({ code: 0 });
		expect(instances.map((i) => [i.id, i.status])).toEqual([
			["review", "rejected"],
			["rounds[0]/review", "ok"],
		]);
	});

	test("a node id's fixture serves every round, and a node without one gets the placeholder", async () => {
		const dir = await fixtures({
			"review/verdict": "rejected never good enough",
			"rounds/review/verdict": "rejected still not",
		});
		const { instances } = await perform(dir, ROUNDS);
		expect(instances.map((i) => i.id)).toEqual([
			"review",
			"rounds[0]/review",
			"rounds[1]/review",
			"rounds[2]/review",
		]);
		const bare = await perform(await fixtures({ "x/y/z": "" }), ROUNDS);
		expect(bare.instances.map((i) => i.status)).toEqual(["ok"]);
	});

	test("an instance id's fixture wins over its node id's", async () => {
		const dir = await fixtures({
			"review/verdict": "rejected first",
			"rounds/review/verdict": "rejected every round",
			"rounds[0]/review/verdict": "ok",
		});
		const { instances } = await perform(dir, ROUNDS);
		expect(instances.map((i) => [i.id, i.status])).toEqual([
			["review", "rejected"],
			["rounds[0]/review", "ok"],
		]);
	});

	test("a scripted output is copied as is, and one the schema refuses fails the node naming it", async () => {
		const dir = await fixtures({ "a/rows.json": "not json" });
		const { done } = await perform(dir, await smokeFile());
		expect(done.code).not.toBe(0);
		expect(done.out + done.err).toContain("rows.json");
	});

	test("a verdict file that is neither ok nor rejected with a reason fails the agent naming the file", async () => {
		const dir = await fixtures({ "review/verdict": "maybe" });
		const { done } = await perform(dir, ROUNDS);
		expect(done.code).not.toBe(0);
		expect(done.out + done.err).toContain("verdict");
	});

	test("an events file's tool calls and results reach watch, and a line that is not an object fails the agent", async () => {
		const dir = await fixtures({
			"review/events.jsonl": [
				'{"type":"tool","id":"t1","name":"Bash","input":{"command":"ls"}}',
				'{"type":"tool_result","id":"t1","bytes":120,"error":true}',
				'{"type":"usage","tokens_in":2,"tokens_out":1500}',
				'{"type":"context","used":44699}',
				'{"type":"usage","tokens_in":3,"tokens_out":900}',
				"",
			].join("\n"),
		});
		const { w, done } = await perform(dir, ROUNDS);
		const events = (await w.call(["watch", idOf(done), "--events"])).out;
		expect(events).toMatch(/Bash.*ls/);
		expect(events).toMatch(/result +120 · error/);
		expect(events).toMatch(/context +44\.7k · in 2 · out 1\.5k · cache 0\n/);
		expect(events).toMatch(/usage +in 3 · out 900 · cache 0\n/);
		expect(events).not.toMatch(/usage +in 2 · out 1\.5k/);
		const bad = await perform(
			await fixtures({ "review/events.jsonl": "[1]\n" }),
			ROUNDS,
		);
		expect(bad.done.code).not.toBe(0);
		expect(bad.done.out + bad.done.err).toContain("events.jsonl");
	});

	test("ls shows the faults of an instance's latest environment report only", async () => {
		const dir = await fixtures({
			"review/events.jsonl": [
				'{"type":"environment","mcp":["github"]}',
				'{"type":"environment","skills":["deploy"]}',
				"",
			].join("\n"),
		});
		const { w, done } = await perform(dir, ROUNDS);
		const id = idOf(done);
		const listed = (await w.call(["ls", id])).out;
		expect(listed).toContain(
			"\nEnvironment\nreview  skills: deploy loaded, not declared",
		);
		expect(listed).not.toContain("github");
		const { review } = json(await w.call(["ls", id, "--json"])).reports;
		expect(
			review.environment.flatMap((c: { faults: string[] }) => c.faults),
		).toEqual(["deploy loaded, not declared"]);
	});

	test("a missing directory fails the stub agent naming the variable and the path", async () => {
		const missing = join(await scratch(), "nowhere");
		const { done } = await perform(missing, ROUNDS);
		expect(done.code).not.toBe(0);
		expect(done.out + done.err).toContain("MAESTRO_STUB_OUTPUTS");
		expect(done.out + done.err).toContain(missing);
	});
});

describe("agent prompt", () => {
	test("prints the node's system prompt on stdout and its seat binding on stderr, with --json carrying both", async () => {
		const w = await repoWorld(SMOKE_RUNTIME("stub"));
		profileIn(w.cwd, "flag", "runtime: { harness: stub, model: flag }\n");
		const file = await smokeFile();
		const id = idOf(await w.call(["perform", file]));
		const staged = (
			await w.call(["art", "show", id, "a", "staged/instructions.md"])
		).out;
		expect(staged).toStartWith("terse\n\n# Your run");
		const shown = await w.call(["agent", "prompt", file, "a"]);
		expect(shown).toMatchObject({
			code: 0,
			out: staged,
			err: "a · seat smoke/smoke · smoke",
		});
		const rebound = await w.call([
			"agent",
			"prompt",
			file,
			"a",
			"-c",
			"seats.smoke/smoke=flag",
		]);
		expect(rebound.err).toBe("a · seat smoke/smoke · flag [-c]");
		expect(
			json(await w.call(["agent", "prompt", file, "a", "--json"])),
		).toEqual({
			node: "a",
			seat: { key: "smoke/smoke", profile: "smoke" },
			prompt: staged,
		});
	});

	test("an unknown node is a usage error naming the nearest one", async () => {
		const w = await repoWorld(SMOKE_RUNTIME("stub"));
		const file = join(REPO, "rounds.ts");
		expect(await w.call(["agent", "prompt", file, "reviw"])).toMatchObject({
			code: 2,
			err: `error: ${file} has no agent node 'reviw'\n  Did you mean 'review'?`,
		});
	});

	test("a profile with no runtime still gives its node's prompt", async () => {
		const w = await repoWorld();
		const shown = await w.call(["agent", "prompt", await smokeFile(), "a"]);
		expect(shown).toMatchObject({
			code: 0,
			err: "a · seat smoke/smoke · smoke",
		});
		expect(shown.out).toContain("# Your run");
	});

	test("a node whose prompt could not be built fails", async () => {
		const w = await repoWorld(SMOKE_RUNTIME("stub"));
		const file = (await smokeFile()).replace(".ts", "-checked.ts");
		writeFileSync(
			file,
			readFileSync(await smokeFile(), "utf8").replace(
				'task: "nothing",',
				'task: "nothing", checks: ["absent"],',
			),
		);
		expect((await w.call(["agent", "prompt", file, "a"])).code).not.toBe(0);
	});
});

describe("ls Environment notes", () => {
	test("lists the faults of an agent's environment report, one line each, and none for a clean one; --json carries the checks", async () => {
		const faulty = await repoWorld(SMOKE_RUNTIME("stub"), {
			MAESTRO_STUB_ENVIRONMENT: JSON.stringify({ mcp: ["github"] }),
		});
		const file = join(REPO, "rounds.ts");
		const done = await faulty.call(["perform", file]);
		expect(done).toMatchObject({ code: 0 });
		const id = idOf(done);
		const listed = await faulty.call(["ls", id]);
		expect(listed.out).toContain(
			"\nEnvironment\nreview  mcp: github loaded, not declared",
		);
		const reports = json(await faulty.call(["ls", id, "--json"])).reports;
		expect(reports.review.environment).toContainEqual({
			part: "mcp",
			mark: "✗",
			faults: ["github loaded, not declared"],
		});

		const clean = await repoWorld(SMOKE_RUNTIME("stub"));
		const ok = idOf(await clean.call(["perform", file]));
		expect((await clean.call(["ls", ok])).out).not.toContain("Environment");
	});
});
