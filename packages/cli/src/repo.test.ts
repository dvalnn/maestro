import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Host } from "@maestro/core/host";
import { openRecord } from "@maestro/core/perform";
import { repoHost } from "@maestro/host-repo";
import { stubHarness } from "@maestro/host-repo/harness";
import { canonicalJson, parseIr } from "@maestro/ir";
import { transcript } from "@maestro/transcript";
import { cleanup, FIXTURES, scratch } from "./fixtures/packs";
import { configValues, idOf, json, shortOf, world } from "./fixtures/world";
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

// Seam: both ls JSON documents place a concert from the record, even when its snapshot cannot be read.
test("ls carries the performed checkout facts without a readable snapshot and omits them for an older concert", async () => {
	const w = await repoWorld();
	writeFileSync(
		join(w.cwd, ".maestro/config.yaml"),
		`target: { repo: ${relative(w.cwd, w.target)}, base: main }\n`,
	);
	const head = Bun.spawnSync(["git", "rev-parse", "main"], {
		cwd: w.target,
		env: GIT_ENV,
	});
	expect(head.exitCode).toBe(0);
	const performed = await w.call(["perform", join(REPO, "mark.ts")]);
	expect(performed.code).toBe(0);
	const id = idOf(performed);
	const legacy = Bun.randomUUIDv7();
	const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
	db.run(
		`INSERT INTO concerts (id, composition, pack, ir, pid, status, started_at, workspace, module_dir)
		SELECT ?, composition, pack, ir, pid, status, started_at, workspace, module_dir FROM concerts WHERE id = ?`,
		[legacy, id],
	);
	db.run("UPDATE concerts SET snapshot = ? WHERE id = ?", ["[", id]);
	db.close();
	const listed = await w.call(["ls", "--json"]);
	expect(listed.code).toBe(0);
	const rows = json(listed);
	const row = rows.find((r: { id: string }) => r.id === id);
	expect(row).toMatchObject({
		facts: {
			repo: {
				target: w.target,
				base: "main",
				sparse: null,
				revision: head.stdout.toString().trim(),
				profiles: expect.any(String),
			},
		},
	});
	expect(rows.find((r: { id: string }) => r.id === legacy)).not.toHaveProperty(
		"facts",
	);
	const single = await w.call(["ls", id, "--json"]);
	expect(single.code).toBe(0);
	expect(json(single).facts).toEqual(row.facts);
	expect(json(single)).not.toHaveProperty("snapshot");
	const old = await w.call(["ls", legacy, "--json"]);
	expect(old.code).toBe(0);
	expect(json(old)).not.toHaveProperty("facts");
});

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
		instances.find((i: { node: string }) => i.node === "parMap/skeptic")?.name,
	).toBe(shown);
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

// Seams: compose's full JSON and saved IR, perform's exit and diagnostics, and the public record reader.
async function schemaFile() {
	const file = join(await scratch(), "schemas.ts");
	await Bun.write(
		file,
		`import { fresh, seat } from "@maestro/host-repo-sdk";
import { composition, iter, Json, Text, use } from "@maestro/sdk";

const First = Json({ type: "object", properties: { name: { type: "string", minLength: 1 } } });
const Second = Json({ properties: { name: { minLength: 1, type: "string" } }, type: "object" });
const inner = composition("inner", { ports: { task: Text() } }, (_, { task }) =>
	seat("smoke")({ task, lane: fresh(), reply: { first: First, second: Second } }),
);
export const schemas = composition("schemas", { examples: [{}] }, () => {
	use(inner, { task: "nothing" });
	return iter.parMap(["x", "y"], () => use(inner, { task: "nothing" }), { onError: "stop" });
});
`,
	);
	return file;
}

test("compose names every node, inner and scope port schema once, merging equal canonical JSON", async () => {
	const w = await repoWorld(SMOKE_RUNTIME("stub"));
	const file = await schemaFile();
	const shown = await w.call(["compose", file, "--json"]);
	expect(shown.code).toBe(0);
	const { ir } = json(shown).plan;
	expect(ir.irVersion).toBe("1.3");
	expect(ir.schemas).toBeObject();
	const maps: Record<string, unknown>[] = [
		...ir.nodes.flatMap((n: { in?: object; out?: object; inner?: object }) => [
			n.in ?? {},
			n.out ?? {},
			n.inner ?? {},
		]),
		...ir.scopes.map((s: { ports: object }) => s.ports),
	];
	const keys = maps.flatMap((ports) => Object.values(ports));
	expect(keys.length).toBeGreaterThan(0);
	expect(keys.filter((key) => typeof key !== "string")).toEqual([]);
	expect(keys.filter((key) => !Object.hasOwn(ir.schemas, String(key)))).toEqual(
		[],
	);
	const entries = Object.values(ir.schemas).map((schema) =>
		canonicalJson(schema),
	);
	expect(new Set(entries).size).toBe(entries.length);
	expect(new Set(keys)).toEqual(new Set(Object.keys(ir.schemas)));
	const equalSchema = {
		type: "object",
		properties: { name: { type: "string", minLength: 1 } },
	};
	expect(
		Object.values(ir.schemas).filter(
			(s) => canonicalJson(s) === canonicalJson(equalSchema),
		),
	).toEqual([equalSchema]);
	const agents = ir.nodes.filter(
		(n: { kind: string }) => n.kind === "repo.agent",
	);
	expect(agents.length).toBeGreaterThan(0);
	expect(
		agents.filter(
			(agent: { out: { first: unknown; second: unknown } }) =>
				agent.out.first !== agent.out.second,
		),
	).toEqual([]);
	expect(
		ir.nodes.some(
			(n: { inner?: object }) => Object.keys(n.inner ?? {}).length > 0,
		),
	).toBe(true);
	expect(
		ir.scopes.some((s: { ports: object }) => Object.keys(s.ports).length > 0),
	).toBe(true);
	const again = await w.call(["compose", file, "--json"]);
	expect(again.code).toBe(0);
	expect(json(again).plan.ir).toEqual(ir);
});

test("compose --out saves the same shared IR as the full JSON document", async () => {
	const w = await repoWorld(SMOKE_RUNTIME("stub"));
	const file = await schemaFile();
	const out = join(w.cwd, "shared.json");
	const shown = await w.call(["compose", file, "--json", "--out", out]);
	expect(shown.code).toBe(0);
	const saved = await Bun.file(out).json();
	expect(saved).toHaveProperty("schemas");
	expect(saved).toEqual(json(shown).plan.ir);
	expect(parseIr(saved).ok).toBe(true);
});

test("perform loads saved shared plan IR and its inline twin with the same record and refusal", async () => {
	const w = await repoWorld(SMOKE_RUNTIME("stub"));
	const shown = await w.call(["compose", await artsFile(), "--json"]);
	expect(shown.code).toBe(0);
	const loaded = parseIr(json(shown).plan.ir);
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) return;
	const inline = loaded.ir;
	const agent = inline.nodes.find((n) => n.kind === "repo.agent");
	expect(agent?.out?.lane).toBeDefined();
	const shared = {
		...inline,
		schemas: { lane: agent?.out?.lane },
		nodes: inline.nodes.map((n) =>
			n.id === agent?.id ? { ...n, out: { ...n.out, lane: "lane" } } : n,
		),
	};
	const file = join(w.cwd, "plan.json");
	await Bun.write(file, JSON.stringify(inline));
	const first = await w.call(["perform", file]);
	expect(first.code).toBe(0);
	const id = idOf(first);
	await Bun.write(file, JSON.stringify(shared));
	const performed = await w.call(["perform", file]);
	expect(performed.code).toBe(0);
	const reader = openRecord(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
	try {
		expect(reader.find(id)?.ir).toEqual(inline);
		expect(reader.find(idOf(performed))?.ir).toEqual(inline);
	} finally {
		reader.close();
	}
	writeFileSync(
		join(w.cwd, ".maestro/config.yaml"),
		`target: { repo: ${w.target}, base: main }\n`,
	);
	const sharedRefusal = await w.call(["perform", file, "--json"]);
	expect(sharedRefusal.code).not.toBe(0);
	await Bun.write(file, JSON.stringify(inline));
	const inlineRefusal = await w.call(["perform", file, "--json"]);
	expect(sharedRefusal).toEqual(inlineRefusal);
});

// Transcript: the plan views of a composition with a group, which read the IR in memory.
test("compose prints the plan, its graph and its flow", async () => {
	const w = await repoWorld();
	const view = async (flag: string) => {
		const shown = await w.call(["compose", join(REPO, "mark.ts"), flag]);
		expect(shown.code).toBe(0);
		expect(shown.err).toBe("");
		return {
			name: `maestro compose mark.ts ${flag}`,
			columns: 100,
			shown: shown.out,
		};
	};
	await transcript(new URL("./transcripts/compose.txt", import.meta.url), [
		await view("--plan"),
		await view("--graph"),
		await view("--flow"),
	]);
});

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

test("a stub seat declaring a reply field ends ok, a code node reads the placeholder, and ls gives both as outputs", async () => {
	const w = await repoWorld(SMOKE_RUNTIME("stub"));
	const file = join(await scratch(), "typed.ts");
	writeFileSync(
		file,
		`import { fresh, seat } from "@maestro/host-repo-sdk";
import { code, composition, Enum, Struct, Text } from "@maestro/sdk";

const smoke = seat("smoke");

export const tierOf = ({ map }: { map: { tier: string } }) => {
	if (map.tier !== "small") throw new Error(\`read \${map.tier}\`);
	return { tier: map.tier };
};

export const typed = composition("typed", { examples: [{}] }, () => {
	const agent = smoke({
		task: "nothing",
		lane: fresh(),
		reply: { map: Struct({ tier: Enum(["small", "large"]) }) },
	});
	return code(tierOf, { in: { map: agent.out.map }, out: { tier: Text() } });
});
`,
	);
	const done = await w.call(["perform", file]);
	expect(done).toMatchObject({ code: 0 });
	const id = idOf(done);
	const outputsOf = async (instance: string) =>
		json(await w.call(["ls", id, instance, "--json"])).outputs;
	expect(await outputsOf("agent")).toEqual({ map: { tier: "small" } });
	expect(await outputsOf("tierOf")).toEqual({ tier: "small" });
	expect(
		(await w.call(["art", "show", id, "agent", "staged/outputs.yaml"])).out,
	).toBe("map:\n  tier: small");
});

function stringLeaves(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (typeof value !== "object" || value === null) return [];
	return Object.values(value).flatMap(stringLeaves);
}

// Seam: ls's agent row and detail documents after real repo-host execution, with artifacts read through art ls.
test("ls <concert> <instance> --json gives one step in full without duplicate report or host bookkeeping", async () => {
	const scripts = await scratch();
	await Bun.write(join(scripts, "a/map.json"), '{"tier":"small"}');
	await Bun.write(join(scripts, "a/notes.md"), "the artifact\n");
	await Bun.write(
		join(scripts, "a/events.jsonl"),
		[
			'{"type":"environment","mcp":["github"]}',
			'{"type":"environment","tools":[],"skills":["deploy"]}',
			'{"type":"usage","tokens_in":12,"tokens_out":3}',
			"",
		].join("\n"),
	);
	const w = await repoWorld(SMOKE_RUNTIME("stub"), {
		MAESTRO_STUB_OUTPUTS: scripts,
	});
	const file = join(await scratch(), "listing.ts");
	await Bun.write(
		file,
		`import { fresh, MarkdownOut, seat } from "@maestro/host-repo-sdk";
import { code, composition, Markdown, Struct, Text } from "@maestro/sdk";

export const task = () => ({ text: "inspect the artifact" });
export const consume = (_: { notes: string }) => ({ text: "consumed" });

export const listing = composition("listing", { examples: [{}] }, () => {
	const source = code(task, { out: { text: Text() } });
	const agent = seat("smoke")({
		label: "a",
		task: source.out.text,
		lane: fresh(),
		reply: { map: Struct({ tier: Text() }) },
		out: { notes: MarkdownOut("notes.md") },
	});
	return code(consume, { in: { notes: agent.out.notes }, out: { text: Text() } });
});
`,
	);
	const done = await w.call(["perform", file]);
	expect(done.code).toBe(0);
	const id = idOf(done);
	const listed = await w.call(["ls", id, "--json"]);
	expect(listed.code).toBe(0);
	const row = json(listed).instances.find(
		(i: { name: string }) => i.name === "a",
	);
	const stepKeys = [
		"name",
		"node",
		"kind",
		"expansion",
		"status",
		"stale",
		"startedAt",
		"settledAt",
		"elapsedMs",
		"tokens",
		"harness",
		"model",
		"profile",
		"notes",
	];
	const shown = await w.call(["ls", id, "a", "--json"]);
	expect(shown.code).toBe(0);
	expect(shown.err).toBe("");
	const detail = json(shown);
	expect(Object.keys(detail).sort()).toEqual(
		[
			...stepKeys,
			"metrics",
			"report",
			"outputs",
			"inputs",
			"artifacts",
			"session",
			"environment",
		].sort(),
	);
	expect(Object.keys(row).sort()).toEqual(stepKeys.sort());
	expect(detail).toMatchObject(row);
	// Bun's toMatchObject writes its asymmetric matchers into the object it is given, so it gets a copy of detail.
	expect(json(shown)).toMatchObject({
		name: "a",
		node: "a",
		expansion: "",
		status: "ok",
		stale: false,
		harness: "stub",
		model: "none",
		profile: "smoke",
		tokens: 15,
		metrics: { tokens_in: 12, tokens_out: 3 },
		report: { summary: "stub" },
		inputs: { prompt: "inspect the artifact" },
		outputs: { map: { tier: "small" }, notes: expect.any(String) },
		notes: { Environment: ["skills: deploy loaded, not declared"] },
		session: { id: `${id}.a`, dir: expect.any(String) },
	});
	expect(detail.report).toEqual({ summary: "stub" });
	for (const port of ["report", "session", "lane"])
		expect(detail.outputs).not.toHaveProperty(port);
	expect(Object.keys(detail.session).sort()).toEqual(["dir", "id"]);
	expect(statSync(detail.session.dir).isDirectory()).toBe(true);
	expect(Object.keys(detail.environment)).toEqual(["faults"]);
	const faults = stringLeaves(detail.environment.faults);
	expect(faults).toContain("deploy loaded, not declared");
	expect(faults).not.toContain("github loaded, not declared");
	const arts = await w.call(["art", "ls", id, "--json"]);
	expect(arts.code).toBe(0);
	const area = join(w.root, "data/maestro/concerts", id, "artifacts");
	const agentArts: { port: string; path: string }[] = json(arts).filter(
		(a: { instance: string }) => a.instance === "a",
	);
	expect(agentArts.map((a) => a.port).sort()).toEqual(["notes", "staged"]);
	const paths = agentArts.map(({ port, path }) => ({
		port,
		path: relative(area, path),
	}));
	expect(
		detail.artifacts.toSorted((a: { port: string }, b: { port: string }) =>
			a.port.localeCompare(b.port),
		),
	).toEqual(paths.toSorted((a, b) => a.port.localeCompare(b.port)));
	const note = agentArts.find((a) => a.port === "notes");
	expect(note).toBeDefined();
	const absolute = note?.path ?? "";
	const relativePath = relative(area, absolute);
	expect([absolute, relativePath]).toContain(detail.outputs.notes);
	const consumed = await w.call(["ls", id, "consume", "--json"]);
	expect(consumed.code).toBe(0);
	expect([absolute, relativePath]).toContain(json(consumed).inputs.notes);
	expect(json(consumed).outputs).toEqual({ text: "consumed" });
});

test("artifact ls dims the dash of an artifact no output port holds, on a terminal only", async () => {
	const w = await repoWorld(SMOKE_RUNTIME("stub"));
	const done = await w.call(["perform", await artsFile()]);
	expect(done).toMatchObject({ code: 0 });
	const id = idOf(done);
	const db = new Database(join(w.root, "data/maestro/record.db"));
	db.run("UPDATE instances SET outputs = NULL");
	db.close();
	const terminal = () => ({ columns: 200, rows: 24 });
	const dash = RegExp.escape("\u001b[2m-\u001b[22m");
	const on = await w.call(["art", "ls", id, "--color"], { terminal });
	expect(on.out).toMatch(new RegExp(`^inner/a +${dash} +\\w+/`, "m"));
	const piped = await w.call(["art", "ls", id]);
	expect(piped.out).toMatch(/^inner\/a +- +\w+\//m);
});

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
	const [head, ...table] = (await w.call(["artifact", "ls", id])).out.split(
		"\n",
	);
	expect(head).toBe(`artifacts  ${area}`);
	expect(table[0]).toMatch(/^instance +port +stale +path$/);
	const notesPath = listed.find((a) => a.port === "notes")?.path ?? "";
	expect(table).toContain(
		`inner/a      notes          ${notesPath.slice(area.length + 1)}`,
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
	const instances = json(await w.call(["ls", id, "--json"])).instances;
	const b = instances.find(
		(i: { node: string; expansion: string }) =>
			i.node === "parMap/b" && i.expansion === "[x]",
	);
	expect(b.name).toBe("parMap[x]/b");
	expect(listed.filter((a) => a.instance === b.name).length).toBeGreaterThan(0);
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
		[["ls"], LS] as const,
		[["ls", id, "a"], LS] as const,
		[["show", id], SHOW] as const,
		[["show", id, "a", "b", "c"], MANY] as const,
		[["show", id, "nope"], `List them with 'maestro ls ${id}'`] as const,
		[
			["show", id, "a", "nope.md"],
			`List them with maestro art show ${id} inner/a --path`,
		] as const,
		[
			["show", id, "a", "--json"],
			"Drop --json to print the instance's files",
		] as const,
		[["ls", id, "--json", "--path"], "Drop one of them"] as const,
		[[id], FIX] as const,
		[[id, "a"], FIX] as const,
		[[], FIX] as const,
	]) {
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
			.filter((l) => /^\S+ +\S+ +stale +\S+\/\S+$/.test(l))
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
	// Seam: real repo-host execution and its CLI record and staged instructions.
	test("resume and encore keep stub profile layers and the recorded workspace outside it", async () => {
		const w = await repoWorld();
		profileIn(
			w.cwd,
			"smoke",
			"runtime: { harness: unavailable, model: expensive, thinking: high }\ninstructions: instructions.md\n",
			{ "instructions.md": "directory instructions" },
		);
		const preset = join(w.cwd, ".maestro/presets/stub.yaml");
		await Bun.write(
			preset,
			'profiles:\n  "*":\n    runtime: !replace { harness: stub }\n    instructions: !delete\n',
		);
		const gate = join(w.root, "gate");
		const file = await gated(gate);
		const performed = await w.call(["perform", file, "--preset", "stub"]);
		expect(performed.code).toBe(1);
		const id = idOf(performed);
		expect(id).not.toBe("");
		writeFileSync(gate, "");
		rmSync(preset);
		writeFileSync(join(w.cwd, ".maestro/config.yaml"), "[broken YAML");
		const foreign = await scratch();
		profileIn(
			foreign,
			"smoke",
			"runtime: { harness: unavailable, model: foreign }\n",
		);
		writeFileSync(join(foreign, ".maestro/config.yaml"), "[broken YAML");
		const outside = { cwd: foreign };
		const resumed = await w.call(["resume", id, "--json"], outside);
		expect(resumed.code).toBe(0);
		const encore = await w.call(
			["encore", id, "-c", "concurrency=2", "--json"],
			outside,
		);
		expect(encore.code).toBe(0);
		const neutral = { cwd: await scratch() };
		for (const concert of [id, json(encore).id]) {
			const listed = await w.call(["ls", concert, "--json"], outside);
			expect(listed.code).toBe(0);
			const instances: { node: string }[] = json(listed).instances;
			const agent = instances.find((instance) => instance.node === "a");
			expect(agent).toMatchObject({ harness: "stub", model: "stub" });
			expect(agent).not.toHaveProperty("thinking");
			const staged = await w.call(
				["art", "show", concert, "a", "staged/instructions.md"],
				neutral,
			);
			expect(staged.code).toBe(0);
			expect(staged.out.split("\n")).not.toContain("directory instructions");
		}
	});

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
				seat: "smoke/smoke/smoke",
				profile: "smoke",
				harness: "stub",
				model: "big",
				thinking: "low",
			},
		]);
		expect((await w.call(["compose", file, "--plan"])).out).toMatch(
			/\nagents:\n {2}node +seat +profile +harness +model +thinking\n {2}a +smoke\/smoke\/smoke +smoke +stub +none +low$/,
		);
	});

	// Seam: compose's JSON for a plan with a resolved agent.
	test("compose --plan --json includes resolved agents in the lean plan", async () => {
		const w = await repoWorld(
			"profiles:\n  smoke:\n    runtime:\n      harness: stub\n      model: none\n      thinking: low\n",
		);
		const shown = await w.call([
			"compose",
			await smokeFile(),
			"--plan",
			"--json",
			"-c",
			"profiles.smoke.runtime.model=big",
		]);
		expect(shown.code).toBe(0);
		const document = json(shown);
		expect(document.agents).toEqual([
			{
				node: "a",
				seat: "smoke/smoke/smoke",
				profile: "smoke",
				harness: "stub",
				model: "big",
				thinking: "low",
			},
		]);
		expect(document.plan.nodes).toEqual(
			expect.arrayContaining([{ id: "a", kind: "repo.agent" }]),
		);
	});

	test("--plan with a profile that leaves its harness and model unset prints the plan, then the diagnostics, and exits 1", async () => {
		const w = await repoWorld();
		const file = await smokeFile();
		profileIn(w.cwd, "smoke", "limits: { tokens: 1 }\n");
		const done = await w.call(["compose", file, "--plan"]);
		expect(done.code).toBe(1);
		expect(done.out).toMatch(
			/\nagents:\n {2}node +seat +profile +harness +model +thinking\n {2}a +smoke\/smoke\/smoke +smoke +- +- +-$/,
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
		expect(done.out).toMatch(/\n {2}a +smoke\/smoke\/smoke +smoke +- +- +-$/);
		expect(done.err).toContain("limits.timeout 'bogus'");
	});

	test("seats rebinds a seat by <pack>/<composition>/<seat>, a bare file's pack its file name less the extension: the preset over the workspace config, -c over the preset, the plan showing the key", async () => {
		const w = await repoWorld("seats:\n  mine/smoke/smoke: ws\n");
		for (const name of ["ws", "pre", "flag"])
			profileIn(w.cwd, name, `runtime: { harness: stub, model: ${name} }\n`);
		await Bun.write(
			join(w.cwd, ".maestro/presets/p.yaml"),
			"seats:\n  mine/smoke/smoke: pre\n",
		);
		const file = join(dirname(await smokeFile()), "mine.ts");
		renameSync(join(dirname(file), "smoke.ts"), file);
		const bound = async (...flags: string[]) =>
			json(await w.call(["compose", file, "--json", ...flags])).agents[0]
				.profile;
		expect(await bound()).toBe("ws");
		expect(await bound("--preset", "p")).toBe("pre");
		expect(
			await bound("--preset", "p", "-c", "seats.mine/smoke/smoke=flag"),
		).toBe("flag");
		const plan = await w.call(["compose", file, "--plan"]);
		expect(plan.out).toMatch(/\n {2}a +mine\/smoke\/smoke +ws +stub +ws +-$/m);
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

/**
 * Each real harness behind its gate: the agent's instructions and file, and the metrics it reports. pi's model is one
 * the presets seat. claude thinks at high: at low, haiku streams no thinking text and drops the instructed word.
 */
type RealHarness = {
	gate: string;
	harness: string;
	model: string;
	thinking: string;
};

const PI: RealHarness = {
	gate: "MAESTRO_PI",
	harness: "pi",
	model: process.env.MAESTRO_PI_MODEL ?? "github-copilot/gpt-6-luna",
	thinking: "low",
};

const CLAUDE: RealHarness = {
	gate: "MAESTRO_CLAUDE",
	harness: "claude",
	model: process.env.MAESTRO_CLAUDE_MODEL ?? "haiku",
	thinking: "high",
};

async function performWriter({ harness, model, thinking }: RealHarness) {
	const w = await repoWorld();
	profileIn(
		w.cwd,
		"writer",
		`runtime: { harness: ${harness}, model: ${model}, thinking: ${thinking} }\ninstructions: instructions.md\n`,
		{
			"instructions.md":
				"You end every report summary you give with the word kumquat.",
		},
	);
	const done = await w.call(["perform", join(REPO, "write.ts")]);
	return { w, done };
}

type Performed = Awaited<ReturnType<typeof performWriter>>;

async function expectWriterPerformed({ w, done }: Performed) {
	expect(done).toMatchObject({ code: 0 });
	const agent = json(await w.call(["ls", idOf(done), "write", "--json"]));
	expect(agent.report.summary.toLowerCase()).toContain("kumquat");
	expect(agent.metrics.tokens_in).toBeGreaterThan(0);
	const [instructions] = [
		...new Bun.Glob("**/staged/instructions.md").scanSync({
			cwd: w.root,
			absolute: true,
		}),
	];
	expect(readFileSync(instructions ?? "", "utf8")).toContain("kumquat");
}

test.skipIf(!process.env[PI.gate])(
	"pi performs an agent with instructions, and its file is in the version a check reads",
	async () => {
		await expectWriterPerformed(await performWriter(PI));
	},
	180_000,
);

test.skipIf(!process.env[CLAUDE.gate])(
	"claude performs an agent with instructions, its file is in the version a check reads, and its thinking is recorded",
	async () => {
		const performed = await performWriter(CLAUDE);
		await expectWriterPerformed(performed);
		const watched = await performed.w.call([
			"watch",
			idOf(performed.done),
			"--events",
			"--json",
		]);
		const events = watched.out
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(
			events.some(
				(e) =>
					e.type === "progress" &&
					e.event?.kind === "thinking" &&
					typeof e.event.text === "string" &&
					e.event.text.length > 0,
			),
		).toBe(true);
	},
	180_000,
);

// Seams: changeset show/apply output and exit, and the instances and pointer in ls <concert> --json.
function seedDroppedInstance(dataHome: string, id: string) {
	const db = new Database(join(dataHome, "maestro/record.db"));
	db.run(
		"INSERT INTO instances (concert, node, expansion, status, stale) VALUES (?, ?, ?, 'ok', 1)",
		[id, "rounds/gone/x", "[0][a]"],
	);
	db.close();
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

	type World = Awaited<ReturnType<typeof edited>>;

	/** The changeset artifact path of `instance` in concert `id`, relative to the concert's artifacts directory. */
	async function artifactPath(w: World, id: string, instance: string) {
		const artifacts = await w.call(["art", "ls", id, "--json"]);
		expect(artifacts.code).toBe(0);
		const artifact = json(artifacts).find(
			(a: { instance: string; port: string }) =>
				a.instance === instance && a.port === "changeset",
		);
		expect(artifact).toBeDefined();
		const waited = await w.call(["wait", id, "--json"]);
		expect(waited.code).toBe(0);
		const path = relative(json(waited).artifacts, artifact.path);
		return { absolute: artifact.path as string, path };
	}

	/** Runs `sql` with `args` against the record of `w`. */
	const amend = (w: World, sql: string, args: (string | number)[]) => {
		const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
		db.run(sql, args);
		db.close();
	};

	/** Performs a composition of two changeset steps, `firstSet` then `laterSet`, whose result makes none. */
	async function twoSets(w: World, name: string) {
		const file = join(await scratch(), `${name}.ts`);
		await Bun.write(
			file,
			`import { changeset, check, fresh } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const ${name} = composition("${name}", { examples: [{}] }, () => {
	changeset(check(fresh(), { run: "echo first > a.txt" }, { label: "first" }).out.lane, { label: "firstSet" });
	changeset(check(fresh(), { run: "echo later > a.txt" }, { label: "later" }).out.lane, { label: "laterSet" });
	return check(fresh(), { run: "true" }, { label: "result" });
});
`,
		);
		const done = await w.call(["perform", file]);
		expect(done).toMatchObject({ code: 0 });
		return idOf(done);
	}

	/** Records `node`'s step of concert `id` as settled at `at`, with `status`. */
	const settle = (
		w: World,
		id: string,
		node: string,
		at: number,
		status = "ok",
	) =>
		amend(
			w,
			"UPDATE instances SET settled_at = ?, status = ? WHERE concert = ? AND node LIKE ?",
			[at, status, id, `%${node}`],
		);

	/** Records the steps of concert `id` in the order of `nodes`, which the record lists by insertion. */
	const recordInOrder = (w: World, id: string, nodes: string[]) => {
		nodes.forEach((node, i) => {
			amend(
				w,
				"UPDATE instances SET rowid = ? WHERE concert = ? AND node LIKE ?",
				[1_000_000 + i, id, `%${node}`],
			);
		});
	};

	/** `instance` of fan.ts with its other item, `lens` for `risk` and back. */
	const swapItem = (instance: string) =>
		instance.includes("[lens]")
			? instance.replace("[lens]", "[risk]")
			: instance.replace("[risk]", "[lens]");

	/** Rewrites the changeset of `instance` in concert `id`, so its diff adds its item's name, not `nested`. */
	async function markDiff(w: World, id: string, instance: string) {
		const item = instance.includes("[lens]") ? "lens" : "risk";
		const { absolute } = await artifactPath(w, id, instance);
		const files = new Bun.Glob("**/*").scanSync({
			cwd: absolute,
			absolute: true,
		});
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			writeFileSync(file, text.replace("+nested", `+${item}`));
		}
	}

	test("changeset show resolves a listed instance beside a dropped group", async () => {
		const w = await edited("fan.ts");
		const name = "rounds[0]/fan[risk]/nestedSet";
		const before = await w.cs("show", w.id, "--node", name);
		const beforeListing = await w.call(["ls", w.id, "--json"]);
		expect(beforeListing.code).toBe(0);
		expect(json(beforeListing).changeset).toBeDefined();
		expect(before.code).toBe(0);
		expect(before.out).toContain("+nested");
		seedDroppedInstance(w.env.XDG_DATA_HOME, w.id);

		const listed = await w.call(["ls", w.id, "--json"]);
		expect(listed.code).toBe(0);
		expect(
			json(listed).instances.map((i: { name: string }) => i.name),
		).toContain(name);
		expect(json(listed).changeset).toEqual(json(beforeListing).changeset);
		const shown = await w.cs("show", w.id, "--node", name);
		expect(shown.code).toBe(0);
		expect(shown.out).toBe(before.out);
		expect(shown.err).toContain(`(node ${name}, concert ok)`);
	});

	test("changeset apply stages a listed instance beside a dropped group", async () => {
		const w = await edited("fan.ts");
		const name = "rounds[0]/fan[risk]/nestedSet";
		seedDroppedInstance(w.env.XDG_DATA_HOME, w.id);
		const applied = await w.cs("apply", w.id, "--node", name);
		expect(applied.code).toBe(0);
		expect(applied.err).toContain(`(node ${name}, concert ok)`);
		expect(a(w.target)).toBe("nested\n");
		expect(git(w.target, "diff", "--cached", "--name-only")).toBe("a.txt");
	});

	test("a dropped instance is unknown to changeset --node", async () => {
		const w = await edited("fan.ts");
		seedDroppedInstance(w.env.XDG_DATA_HOME, w.id);
		const name = "rounds[0]/gone[a]/x";
		for (const action of ["show", "apply"]) {
			const refused = await w.cs(action, w.id, "--node", name);
			expect(refused.code).toBe(2);
			expect(refused.out).toBe("");
			expect(refused.err.split(/[\s'"`,:;()]+/)).toContain(name);
		}
	});

	test("equal settle times choose the changeset recorded last", async () => {
		const w = await edited();
		const id = await twoSets(w, "tiedsets");
		recordInOrder(w, id, ["laterSet", "firstSet"]);
		settle(w, id, "firstSet", 1000);
		settle(w, id, "laterSet", 1000);
		const shown = await w.cs("show", id);
		expect(shown.code).toBe(0);
		expect(shown.out).toContain("+first");
		const { path } = await artifactPath(w, id, "firstSet");
		expect(json(await w.call(["ls", id, "--json"])).changeset).toEqual({
			name: "firstSet",
			path,
		});
	});

	test("default changesets exclude an instance the listing cannot reach", async () => {
		const w = await edited();
		const file = join(await scratch(), "nestedfans.ts");
		await Bun.write(
			file,
			`import { changeset, check, fresh } from "@maestro/host-repo-sdk";
import { composition, iter } from "@maestro/sdk";
export const nestedfans = composition("nestedfans", { examples: [{}] }, () => {
	iter.parMap(["lens", "risk"], () => iter.parMap(["a", "b"], () =>
		changeset(check(fresh(), { run: "echo nested > a.txt" }).out.lane, { label: "nestedSet" }),
		{ label: "inner", onError: "stop" }), { label: "outer", onError: "stop" });
	return check(fresh(), { run: "true" }, { label: "result" });
});
`,
		);
		const performed = await w.call(["perform", file]);
		expect(performed).toMatchObject({ code: 0 });
		const id = idOf(performed);
		amend(
			w,
			`INSERT INTO instances (concert, node, expansion, status, outputs, settled_at, stale)
			SELECT concert, node, '[ghost][a]', 'ok', outputs, 9999999999999, 1 FROM instances
			WHERE concert = ? AND node = 'outer/inner/nestedSet' AND expansion = '[risk][a]'`,
			[id],
		);
		const listed = await w.call(["ls", id, "--json"]);
		expect(listed.code).toBe(0);
		const listing = json(listed);
		expect(
			listing.instances.map((i: { name: string }) => i.name),
		).not.toContain("outer[ghost]/inner[a]/nestedSet");
		expect(listing.instances.map((i: { name: string }) => i.name)).toContain(
			listing.changeset.name,
		);
		const shown = await w.cs("show", id);
		const named = await w.cs("show", id, "--node", listing.changeset.name);
		expect(shown.code).toBe(0);
		expect(named.code).toBe(0);
		expect(shown.out).toBe(named.out);
		expect(shown.err).toContain(`(node ${listing.changeset.name}, concert ok)`);
		amend(
			w,
			"UPDATE instances SET status = 'failed' WHERE concert = ? AND expansion != '[ghost][a]'",
			[id],
		);
		const none = await w.call(["ls", id, "--json"]);
		expect(none.code).toBe(0);
		expect(json(none)).not.toHaveProperty("changeset");
		expect((await w.cs("show", id)).code).toBe(1);
	});

	// Seam: ls <concert> --json's changeset pointer, compared with art ls and cs show.
	test("ls names the result node's changeset even when another settles later", async () => {
		const w = await edited("pick.ts");
		const shown = await w.cs("show", w.id);
		expect(shown.code).toBe(0);
		expect(shown.out).toContain("+kept");
		expect((await w.cs("show", w.id, "--node", "keptSet")).out).toBe(shown.out);
		const { path } = await artifactPath(w, w.id, "keptSet");
		const listed = await w.call(["ls", w.id, "--json"]);
		expect(listed.code).toBe(0);
		expect(json(listed).changeset).toEqual({ name: "keptSet", path });
	});

	test("ls names the last ok changeset when the result has none", async () => {
		const w = await edited();
		const id = await twoSets(w, "fallback");
		recordInOrder(w, id, ["laterSet", "firstSet"]);
		settle(w, id, "firstSet", 1000);
		settle(w, id, "laterSet", 2000);
		const shown = await w.cs("show", id);
		expect(shown.code).toBe(0);
		expect((await w.cs("show", id, "--node", "laterSet")).out).toBe(shown.out);
		const { path } = await artifactPath(w, id, "laterSet");
		const listed = await w.call(["ls", id, "--json"]);
		expect(listed.code).toBe(0);
		expect(json(listed).changeset).toEqual({ name: "laterSet", path });
	});

	test("ls names the changeset that settled last, not the one recorded last", async () => {
		const w = await edited();
		const id = await twoSets(w, "settleorder");
		recordInOrder(w, id, ["firstSet", "laterSet"]);
		settle(w, id, "firstSet", 3000);
		settle(w, id, "laterSet", 1000);
		const shown = await w.cs("show", id);
		expect(shown.out).toContain("+first");
		const { path } = await artifactPath(w, id, "firstSet");
		const listed = await w.call(["ls", id, "--json"]);
		expect(json(listed).changeset).toEqual({ name: "firstSet", path });
	});

	test("ls skips a changeset step that did not settle ok, and omits the field when none did", async () => {
		const w = await edited();
		const id = await twoSets(w, "failedlater");
		const { path } = await artifactPath(w, id, "firstSet");
		settle(w, id, "firstSet", 1000);
		settle(w, id, "laterSet", 2000, "failed");
		const earlier = json(await w.call(["ls", id, "--json"]));
		expect(earlier.changeset).toEqual({ name: "firstSet", path });
		settle(w, id, "firstSet", 1000, "failed");
		const none = json(await w.call(["ls", id, "--json"]));
		expect(none).not.toHaveProperty("changeset");
	});

	test("ls names an expanded changeset step as cs show reports it", async () => {
		const w = await edited();
		const fan = idOf(await w.call(["perform", join(REPO, "fan.ts")]));
		const listed = json(await w.call(["ls", fan, "--json"]));
		const name: string = listed.changeset.name;
		expect(name).toMatch(/^rounds\[0\]\/fan\[(lens|risk)\]\/nestedSet$/);
		const other = swapItem(name);
		await markDiff(w, fan, name);
		await markDiff(w, fan, other);
		const shown = await w.cs("show", fan);
		expect(shown.code).toBe(0);
		const own = await w.cs("show", fan, "--node", name);
		expect(own.out).toBe(shown.out);
		expect((await w.cs("show", fan, "--node", other)).out).not.toBe(shown.out);
		const { path } = await artifactPath(w, fan, name);
		expect(listed.changeset.path).toBe(path);
	});

	test("ls keeps the changeset pointer when its snapshot, checkout and artifact are unavailable", async () => {
		const w = await edited("pick.ts");
		const { absolute, path } = await artifactPath(w, w.id, "keptSet");
		amend(w, "UPDATE concerts SET snapshot = ? WHERE id = ?", ["[", w.id]);
		rmSync(w.target, { recursive: true });
		rmSync(absolute, { recursive: true });
		const listed = await w.call(["ls", w.id, "--json"], {
			cwd: await scratch(),
			env: { PATH: "" },
		});
		expect(listed.code).toBe(0);
		expect(json(listed).changeset).toEqual({ name: "keptSet", path });
	});

	test("changeset show and apply use the snapshot checkout from any folder, without config files or the preset performed with", async () => {
		const w = await edited();
		const preset = join(w.cwd, ".maestro/presets/free.yaml");
		await Bun.write(preset, "{}\n");
		writeFileSync(
			join(w.cwd, ".maestro/config.yaml"),
			`target: { repo: ${relative(w.cwd, w.target)}, base: main }\n`,
		);
		const id = idOf(
			await w.call(["perform", join(REPO, "edit.ts"), "--preset", "free"]),
		);
		const expected = (await w.cs("show", id)).out;
		const clone = join(await scratch(), "clone");
		git(w.target, "clone", "-q", w.target, clone);
		writeFileSync(
			join(w.cwd, ".maestro/config.yaml"),
			`target: { repo: ${clone} }\n`,
		);
		await Bun.write(
			join(w.env.XDG_CONFIG_HOME, "maestro/config.yaml"),
			"[broken YAML",
		);
		rmSync(preset);
		const outside = { cwd: await scratch(), env: GIT_ENV };
		expect(
			configValues(await w.call(["config", id, "--json"], outside))[
				"target.repo"
			],
		).toBe(w.target);
		const show = (...args: string[]) =>
			w.call(["cs", "show", id, ...args], outside);
		expect(await show()).toMatchObject({ code: 0, out: expected });
		expect(await show("-C", w.target)).toMatchObject({
			code: 0,
			out: expected,
		});
		expect(await w.cs("show", id)).toMatchObject({ code: 0, out: expected });
		expect(a(w.target)).toBe("one\n");
		expect((await w.call(["cs", "apply", id], outside)).code).toBe(0);
		expect(a(w.target)).toBe("edited\n");
		expect(git(w.target, "diff", "--cached", "--name-only")).toBe("a.txt");
		expect(a(clone)).toBe("one\n");
	});

	// Seam: changeset refusals name the uncomposable key and the supported checkout recovery.
	test("changeset show and apply suggest -C when the recorded config no longer composes", async () => {
		const w = await edited();
		const host = repoHost({ harnesses: [] });
		const former: Host = {
			...host,
			config: { ...host.config, retired: { type: "object" } },
			deferred: [...(host.deferred ?? []), ["retired"]],
		};
		writeFileSync(
			join(w.cwd, ".maestro/config.yaml"),
			`target: { repo: ${w.target}, base: main }\nretired:\n  missing: !delete\n`,
		);
		const performed = await w.call(["perform", join(REPO, "edit.ts")], {
			hosts: [former],
		});
		expect(performed.code).toBe(0);
		const id = idOf(performed);
		const outside = { cwd: await scratch(), env: GIT_ENV };
		for (const action of ["show", "apply"]) {
			const refused = await w.call(["cs", action, id], outside);
			expect(refused.code).not.toBe(0);
			expect(refused.out).toBe("");
			const words = refused.err.split(/[\s'"`,:;()]+/);
			expect(words).toEqual(
				expect.arrayContaining(["retired.missing", "-C", "<repo>"]),
			);
			expect(words).not.toContain("-c");
		}
		expect(a(w.target)).toBe("one\n");
		const recovered = await w.call(["cs", "show", id, "-C", w.target], outside);
		expect(recovered.code).toBe(0);
		expect(recovered.out).toBe((await w.cs("show", w.id)).out);
		expect(
			(await w.call(["cs", "apply", id, "-C", w.target], outside)).code,
		).toBe(0);
		expect(a(w.target)).toBe("edited\n");
	});

	// Seam: recorded changeset commands work even when the installed-pack directory cannot be scanned.
	test("changeset show and apply read the recorded checkout without scanning installed packs", async () => {
		const w = await edited();
		const expected = (await w.cs("show", w.id)).out;
		writeFileSync(
			join(w.env.XDG_DATA_HOME, "maestro/packs"),
			"not a directory\n",
		);
		const outside = { cwd: await scratch(), env: GIT_ENV };
		const shown = await w.call(["cs", "show", w.id], outside);
		expect(shown.code).toBe(0);
		expect(shown.out).toBe(expected);
		expect((await w.call(["cs", "apply", w.id], outside)).code).toBe(0);
		expect(a(w.target)).toBe("edited\n");
	});

	test("a gone snapshot checkout is named with the -C recovery for show and apply", async () => {
		const w = await edited();
		rmSync(w.target, { recursive: true });
		const outside = { cwd: await scratch(), env: GIT_ENV };
		for (const action of ["show", "apply"]) {
			const refused = await w.call(["cs", action, w.id], outside);
			expect(refused.code).not.toBe(0);
			const words = refused.err.split(/[\s'"`,:;.()]+/);
			expect(words).toEqual(expect.arrayContaining([w.target, "-C", "<repo>"]));
		}
	});

	test("older concerts stay listed and refuse snapshot commands but show and apply accept -C", async () => {
		const w = await edited();
		const expected = (await w.cs("show", w.id)).out;
		const legacy = Bun.randomUUIDv7();
		const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
		// Copy only columns an older store knew, leaving the snapshot absent after its upgrade.
		db.run(
			`INSERT INTO concerts (id, composition, pack, ir, pid, status, started_at, settled_at, reason, workspace, module_dir, file)
			SELECT ?, composition, pack, ir, pid, 'failed', 1, 3, 'stopped', workspace, module_dir, file FROM concerts WHERE id = ?`,
			[legacy, w.id],
		);
		db.run(
			`INSERT INTO instances (concert, node, expansion, status, outputs, stale)
			SELECT ?, node, expansion, status, outputs, 0 FROM instances WHERE concert = ?`,
			[legacy, w.id],
		);
		db.close();
		const area = join(w.env.XDG_DATA_HOME, "maestro/concerts");
		await cp(join(area, w.id), join(area, legacy), {
			recursive: true,
			verbatimSymlinks: true,
		});
		const listed = await w.call(["ls", "--json"]);
		expect(listed.code).toBe(0);
		expect(json(listed).map((row: { id: string }) => row.id)).toContain(legacy);
		for (const args of [
			["compose", "--concert", legacy],
			["resume", legacy],
			["encore", legacy],
		]) {
			const refused = await w.call(args, { env: GIT_ENV });
			expect(refused.code).not.toBe(0);
			const words = refused.err.split(/[\s'"`,:;.()]+/);
			expect(words).toContain("perform");
		}
		for (const verb of ["show", "apply"]) {
			const refused = await w.call(["cs", verb, legacy], { env: GIT_ENV });
			expect(refused.code).not.toBe(0);
			expect(refused.err.split(/[\s'"`,:;.()]+/)).toContain("-C");
		}
		const clone = join(await scratch(), "clone");
		git(w.target, "clone", "-q", w.target, clone);
		rmSync(w.target, { recursive: true });
		await Bun.write(
			join(w.env.XDG_CONFIG_HOME, "maestro/config.yaml"),
			"[broken YAML",
		);
		const outside = { cwd: await scratch(), env: GIT_ENV };
		const shown = await w.call(["cs", "show", legacy, "-C", clone], outside);
		expect(shown.code).toBe(0);
		expect(shown.out).toBe(expected);
		expect(
			(await w.call(["cs", "apply", legacy, "-C", clone], outside)).code,
		).toBe(0);
		expect(a(clone)).toBe("edited\n");
		expect(git(clone, "diff", "--cached", "--name-only")).toBe("a.txt");
	});

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
		const details = await Promise.all(
			instances.map(async ({ name }: { name: string }) =>
				json(await w.call(["ls", w.id, name, "--json"])),
			),
		);
		const made = details.find(
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
		const nested = json(await w.call(["ls", fan, "--json"])).instances.find(
			(i: { node: string; expansion: string }) =>
				i.node === "rounds/fan/nestedSet" && i.expansion === "[0][lens]",
		);
		expect(nested.name).toBe("rounds[0]/fan[lens]/nestedSet");
		const artifacts: { instance: string; port: string }[] = json(
			await w.call(["art", "ls", fan, "--json"]),
		);
		expect(artifacts).toContainEqual(
			expect.objectContaining({ instance: nested.name, port: "changeset" }),
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
			code: 2,
		});
	});

	test("changeset show highlights its concert and base on terminal stderr", async () => {
		const w = await edited();
		const stderrTerminal = () => ({ columns: 120, rows: 24 });
		const args = ["cs", "show", w.id];
		const piped = await w.call(args, { env: GIT_ENV });
		const shown = await w.call(args, { env: GIT_ENV, stderrTerminal });
		const short = shortOf(w.id);
		const base = git(w.target, "rev-parse", "--short", "HEAD");
		expect(piped.code).toBe(0);
		expect(shown.code).toBe(0);
		expect(shown.err).toStartWith(
			`\u001b[1m${short[0]}\u001b[22m\u001b[2m${short.slice(1)}\u001b[22m`,
		);
		expect(shown.err).toContain("concert \u001b[32mok\u001b[39m");
		expect(shown.err).toContain(`on base \u001b[33m${base}\u001b[39m two`);
		expect(stripVTControlCharacters(shown.err)).toBe(piped.err);
		expect(shown.out).toBe(piped.out);
	});

	test("changeset show lengthens the bold id prefix when another concert's short id collides", async () => {
		const w = await edited();
		// Change the fifth of the 15 digits the short id spells: the two ids share four letters.
		const at = 25;
		const digit = (Number.parseInt(w.id[at] ?? "0", 16) + 1) % 16;
		const twin = `${w.id.slice(0, at)}${digit.toString(16)}${w.id.slice(at + 1)}`;
		const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
		db.run("CREATE TEMP TABLE twin AS SELECT * FROM concerts WHERE id = ?", [
			w.id,
		]);
		db.run("UPDATE twin SET id = ?", [twin]);
		db.run("INSERT INTO concerts SELECT * FROM twin");
		db.close();
		const shown = await w.call(["cs", "show", w.id], {
			env: GIT_ENV,
			stderrTerminal: () => ({ columns: 120, rows: 24 }),
		});
		expect(shown.code).toBe(0);
		const short = shortOf(w.id);
		expect(shown.err).toStartWith(
			`\u001b[1m${short.slice(0, 5)}\u001b[22m\u001b[2m${short.slice(5)}\u001b[22m `,
		);
	});

	test("changeset show summary dims its labels on a terminal and leaves piped output plain", async () => {
		const w = await edited();
		const terminal = () => ({ columns: 120, rows: 24 });
		const args = ["cs", "show", w.id, "--summary"];
		const piped = await w.call(args, { env: GIT_ENV });
		const shown = await w.call(args, { env: GIT_ENV, terminal });
		expect(piped.code).toBe(0);
		expect(shown.code).toBe(0);
		expect(piped.out).toBe("tour   -\ntitle  -\nM\ta.txt");
		const [tour = "", title = ""] = shown.out.split("\n");
		for (const [line, label] of [
			[tour, "tour"] as const,
			[title, "title"] as const,
		]) {
			expect(line.startsWith(`\u001b[2m${label}`)).toBe(true);
			const [dimmed, value] = line.split("\u001b[22m");
			expect(dimmed?.trimEnd()).toBe(`\u001b[2m${label}`);
			expect(value?.trimStart()).toBe("\u001b[2m-");
		}
		expect(stripVTControlCharacters(shown.out)).toBe(piped.out);
	});

	test("the closing block shows what the changeset touches on a terminal stdout only", async () => {
		const w = await edited();
		const terminal = () => ({ columns: 80, rows: 24 });
		const env = { ...GIT_ENV, NO_COLOR: "1" };
		expect((await w.call(["wait", w.id], { terminal, env })).out).toMatch(
			/\nchanges {4}1 file {2}\+1 \u22121\nDetails: maestro ls \S+ --json$/,
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

	test("partial show resolves a live instance beside a dropped group", async () => {
		const w = await failed();
		seedDroppedInstance(w.env.XDG_DATA_HOME, w.id);
		const shown = await w.cs("show", w.id, "--node", "build", "--partial");
		expect(shown.code).toBe(0);
		expect(shown.out).toContain("+lost");
	});

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
		const { w, done, instances } = await perform(dir, ROUNDS);
		expect(done).toMatchObject({ code: 0 });
		expect(instances.map((i) => [i.id, i.status])).toEqual([
			["review", "rejected"],
			["rounds[0]/review", "ok"],
		]);
		const listed = json(await w.call(["ls", idOf(done), "--json"]));
		expect(listed.instances).toContainEqual(
			expect.objectContaining({
				name: "review",
				status: "rejected",
				reason: "missing a test",
			}),
		);
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

	/** A loop of two verdict agents `a`, each replying a `tag` field a code node reads and refuses with. */
	async function tagged() {
		const file = join(await scratch(), "tagged.ts");
		writeFileSync(
			file,
			`import { fresh, seat } from "@maestro/host-repo-sdk";
import { code, composition, loop, not, Text } from "@maestro/sdk";

const smoke = seat("smoke", { verdict: true });
const a = () => smoke({ label: "a", task: "nothing", lane: fresh(), reply: { tag: Text() } });

export const tagOf = ({ tag }: { tag: string }) => {
	throw new Error(\`read \${tag}\`);
};

export const tagged = composition("tagged", { examples: [{}] }, () => {
	const rounds = loop.while((s) => not(s.ok), {
		init: a(),
		step: () => a(),
		max: 2,
		tolerate: "rejected",
		label: "rounds",
	});
	return code(tagOf, { in: { tag: rounds.out.tag }, out: { tag: Text() } });
});
`,
		);
		return file;
	}

	test("a scripted reply field reaches its port, an instance id's file wins over its node id's, and a file that is not JSON fails the agent naming it", async () => {
		const file = await tagged();
		const refused = async (files: Record<string, string>) => {
			const { done } = await perform(await fixtures(files), file);
			return done.out + done.err;
		};
		expect(
			await refused({
				"a/verdict": "rejected go on",
				"rounds/a/tag.json": '"node"',
			}),
		).toContain("read node");
		expect(
			await refused({
				"a/verdict": "rejected go on",
				"rounds/a/tag.json": '"node"',
				"rounds[0]/a/tag.json": '"instance"',
			}),
		).toContain("read instance");
		expect(
			await refused({
				"a/verdict": "rejected go on",
				"rounds/a/tag.json": "node",
			}),
		).toContain(join("rounds", "a", "tag.json"));
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
				'{"type":"environment","tools":[],"skills":["deploy"]}',
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
		const detail = json(await w.call(["ls", id, "review", "--json"]));
		expect(Object.keys(detail.environment)).toEqual(["faults"]);
		expect(Object.keys(detail.environment.faults)).toEqual(["skills"]);
		expect(detail.environment.faults.skills).toHaveLength(1);
		expect(detail.environment.faults.skills[0]).toContain("deploy");
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
			err: "a · seat smoke/smoke/smoke · smoke",
		});
		const rebound = await w.call([
			"agent",
			"prompt",
			file,
			"a",
			"-c",
			"seats.smoke/smoke/smoke=flag",
		]);
		expect(rebound.err).toBe("a · seat smoke/smoke/smoke · flag [-c]");
		expect(
			json(await w.call(["agent", "prompt", file, "a", "--json"])),
		).toEqual({
			node: "a",
			seat: { key: "smoke/smoke/smoke", profile: "smoke" },
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
			err: "a · seat smoke/smoke/smoke · smoke",
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
	test("lists the faults of an agent's environment report, one line each, and none for a clean one; --json carries the faults", async () => {
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
		const detail = json(await faulty.call(["ls", id, "review", "--json"]));
		expect(Object.keys(detail.environment.faults)).toEqual(["mcp"]);
		expect(detail.environment.faults.mcp).toHaveLength(1);
		expect(detail.environment.faults.mcp[0]).toContain("github");

		const clean = await repoWorld(SMOKE_RUNTIME("stub"));
		const ok = idOf(await clean.call(["perform", file]));
		expect((await clean.call(["ls", ok])).out).not.toContain("Environment");
		const cleanDetail = json(await clean.call(["ls", ok, "review", "--json"]));
		expect(cleanDetail.report).toBeDefined();
		expect(cleanDetail.environment).toEqual({ faults: {} });
	});

	test("a cut Environment note points to the instance's notes holding the full fault", async () => {
		const name =
			"repository-environment-service-with-a-name-too-long-for-the-terminal";
		const w = await repoWorld(SMOKE_RUNTIME("stub"), {
			MAESTRO_STUB_ENVIRONMENT: JSON.stringify({ mcp: [name] }),
		});
		const done = await w.call(["perform", join(REPO, "rounds.ts")]);
		expect(done.code).toBe(0);
		const id = idOf(done);
		const listed = await w.call(["ls", id], {
			terminal: () => ({ columns: 40, rows: 24 }),
			env: { NO_COLOR: "1" },
		});
		expect(listed.code).toBe(0);
		const lines = listed.out.split("\n");
		expect(lines).toContain("Environment");
		const note = lines[lines.indexOf("Environment") + 1] ?? "";
		expect(note.endsWith("…")).toBe(true);
		expect(Bun.stringWidth(note)).toBeLessThanOrEqual(40);
		expect(lines.at(-1)?.trim()).toBe(
			`Full notes: maestro ls ${shortOf(id)} <instance> --json | jq .notes`,
		);
		const full = await w.call(["ls", shortOf(id), "review", "--json"]);
		expect(full.code).toBe(0);
		const [entry, ...more] = json(full).notes.Environment;
		expect(more).toEqual([]);
		expect(entry).toContain(name);
	});
});
