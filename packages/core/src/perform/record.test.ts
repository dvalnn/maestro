import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ir, parseIr } from "@maestro/ir";
import { coreDefaults, layered, parseLayer } from "../config";
import type { Host } from "../host";
import { isTourSlug, TOUR_MAX_LENGTH, TOUR_SEGMENT } from "../index";
import { stagedRef } from "./artifacts";
import { perform } from "./perform";
import {
	CONCERT_FINISHED,
	openRecord,
	openWriter,
	PROCESS_EXITED,
	Unencorable,
	Unrulable,
} from "./record";

const OPENERS = 6;
/** How long after spawning the openers they all open at once, in milliseconds: longer than a process takes to start. */
const OPEN_AT_MS = 1000;
/** How long another process holds the write lock, in milliseconds: well inside the record's busy timeout. */
const HOLD_MS = 200;
const IR_FIXTURE = join(
	import.meta.dir,
	"../../../ir/fixtures/fanout-fanin-loop.json",
);
const A = { node: "a", expansion: "" };
const V4 = 4;
const CURRENT_VERSION = 11;
/** The record store schema at version 4, the oldest one an upgrade starts from. */
const V4_SCHEMA = `
CREATE TABLE concerts (
	id TEXT PRIMARY KEY,
	composition TEXT NOT NULL,
	pack TEXT NOT NULL,
	ir TEXT NOT NULL,
	pid INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'rejected', 'failed')),
	started_at INTEGER NOT NULL,
	settled_at INTEGER,
	result_node TEXT,
	result_expansion TEXT,
	reason TEXT,
	workspace TEXT NOT NULL,
	tour TEXT,
	title TEXT,
	module_dir TEXT NOT NULL,
	file TEXT,
	profile TEXT,
	config TEXT
) STRICT;
CREATE TABLE instances (
	concert TEXT NOT NULL,
	node TEXT NOT NULL,
	expansion TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'skipped', 'rejected', 'failed')),
	reason TEXT,
	outputs TEXT,
	enrichment TEXT,
	started_at INTEGER,
	settled_at INTEGER,
	key TEXT,
	stale INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (concert, node, expansion)
) STRICT;
CREATE TABLE metrics (
	concert TEXT NOT NULL,
	node TEXT NOT NULL,
	expansion TEXT NOT NULL,
	name TEXT NOT NULL,
	value REAL NOT NULL,
	PRIMARY KEY (concert, node, expansion, name)
) STRICT;
CREATE TABLE earlier_metrics (
	concert TEXT NOT NULL,
	name TEXT NOT NULL,
	value REAL NOT NULL
) STRICT;
CREATE TABLE artifacts (
	concert TEXT NOT NULL,
	path TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	node TEXT NOT NULL,
	expansion TEXT NOT NULL,
	PRIMARY KEY (concert, path)
) STRICT;
CREATE TABLE events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	concert TEXT NOT NULL,
	node TEXT NOT NULL,
	expansion TEXT NOT NULL,
	at INTEGER NOT NULL,
	body TEXT NOT NULL
) STRICT;
CREATE INDEX events_by_concert ON events (concert, seq);
`;

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

/** Creates a version-4 record store at `path`, holding the settled concert `c`. */
async function v4Store(path: string): Promise<void> {
	const db = new Database(path);
	db.exec(V4_SCHEMA);
	db.exec(
		`INSERT INTO concerts (id, composition, pack, ir, pid, status, started_at, settled_at, workspace, module_dir)
		VALUES ('c', 'fanout', 'pack', ?, 1, 'ok', 1, 2, '', '')`,
		[JSON.stringify(await fixtureIr())],
	);
	db.exec(`PRAGMA user_version = ${V4}`);
	db.close();
}

/** Each table's columns, by table name. */
function columns(path: string): Record<string, unknown[]> {
	const db = new Database(path, { readonly: true });
	const tables = db
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
		)
		.all();
	const result = Object.fromEntries(
		tables.map(({ name }) => [
			name,
			db.query(`PRAGMA table_info(${name})`).all(),
		]),
	);
	db.close();
	return result;
}

const userVersion = (path: string) => {
	const db = new Database(path, { readonly: true });
	const version = db
		.query<{ user_version: number }, []>("PRAGMA user_version")
		.get()?.user_version;
	db.close();
	return version;
};

async function fixtureIr(file = IR_FIXTURE): Promise<Ir> {
	const parsed = parseIr(await Bun.file(file).json());
	if (!parsed.ok) throw new Error("the IR fixture does not parse");
	return parsed.ir;
}

/**
 * Executes `body` in a new process, after a prelude that opens the record store at `path` as `record` once the clock
 * reaches `at`.
 * @returns The process's stderr when it fails, else ''.
 */
async function inProcess(path: string, body: string, at = 0): Promise<string> {
	const script = join(dir, `${Bun.randomUUIDv7()}.ts`);
	const module = JSON.stringify(join(import.meta.dir, "record.ts"));
	await writeFile(
		script,
		`import { openWriter } from ${module};
		while (Date.now() < ${at});
		const record = openWriter(${JSON.stringify(path)});
		${body}`,
	);
	const child = Bun.spawn([process.execPath, script], { stderr: "pipe" });
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	return code === 0 ? "" : stderr;
}

test("a record store of another schema version is refused, and one of this version reopens", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	openRecord(path).close();
	openRecord(path).close();
	for (const version of [1, CURRENT_VERSION + 1]) {
		const db = new Database(path);
		db.exec(`PRAGMA user_version = ${version}`);
		db.close();
		expect(() => openRecord(path)).toThrow(
			`record store '${path}' has schema version ${version}, and this maestro reads version ${CURRENT_VERSION}. Use a record store this maestro made, or move '${path}' aside`,
		);
	}
});

test("a version-4 record store opens upgraded, with its rows kept, and reopens unchanged", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const fresh = join(dir, "fresh.db");
	const path = join(dir, "record.db");
	openRecord(fresh).close();
	await v4Store(path);
	const record = openRecord(path);
	const found = record.find("c");
	expect(found).toMatchObject({ id: "c", status: "ok" });
	expect(found).not.toHaveProperty("limits");
	expect(found).not.toHaveProperty("diskUse");
	expect(found).not.toHaveProperty("snapshot");
	expect(found).not.toHaveProperty("facts");
	record.close();
	expect(userVersion(path)).toBe(CURRENT_VERSION);
	expect(columns(path)).toEqual(columns(fresh));
	expect(columns(path).concerts).toContainEqual(
		expect.objectContaining({ name: "facts", notnull: 0 }),
	);
	const upgraded = await Bun.file(path).bytes();
	openRecord(path).close();
	expect(await Bun.file(path).bytes()).toEqual(upgraded);
});

test("a version-4 instance reads with no inputs, and a new one keeps the inputs it started with", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	await v4Store(path);
	const old = new Database(path);
	old.exec("UPDATE concerts SET status = 'running', settled_at = NULL");
	old.exec(
		"INSERT INTO instances (concert, node, expansion, status, started_at) VALUES ('c', 'a', '', 'running', 1)",
	);
	old.close();
	const writer = openWriter(path);
	writer.start("c", { node: "b", expansion: "" }, 2, { x: { path: "p" } });
	writer.start("c", { node: "d", expansion: "" }, 3);
	const [a, b, d] = openRecord(path).instances("c");
	expect(a).not.toHaveProperty("inputs");
	expect(b?.inputs).toEqual({ x: { path: "p" } });
	expect(d).not.toHaveProperty("inputs");
	writer.close();
});

test("a failing upgrade step rolls back and leaves the store as it was", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	await v4Store(path);
	const db = new Database(path);
	db.exec("ALTER TABLE instances ADD COLUMN inputs TEXT");
	db.exec("PRAGMA user_version = 4");
	db.close();
	const before = columns(path);
	expect(() => openRecord(path)).toThrow();
	expect(userVersion(path)).toBe(V4);
	expect(columns(path)).toEqual(before);
});

test("a newer record store is refused", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	openRecord(path).close();
	const db = new Database(path);
	db.exec(`PRAGMA user_version = ${CURRENT_VERSION + 1}`);
	db.close();
	expect(() => openRecord(path)).toThrow(
		`this maestro reads version ${CURRENT_VERSION}`,
	);
});

test("several processes open one new, or one version-4, record store at once", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	for (const store of ["new.db", "v4.db"]) {
		const path = join(dir, store);
		if (store === "v4.db") await v4Store(path);
		const at = Date.now() + OPEN_AT_MS;
		const failures = await Promise.all(
			Array.from({ length: OPENERS }, () =>
				inProcess(path, "record.close();", at),
			),
		);
		expect(failures).toEqual(Array(OPENERS).fill(""));
		expect(userVersion(path)).toBe(CURRENT_VERSION);
	}
});

test("a write waits for another process's write to commit, though that write changes what it read", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const record = openWriter(path);
	record.begin({ id: "c", ir: await fixtureIr(), startedAt: 1 });
	record.start("c", A, 2);
	const script = join(dir, "hold.ts");
	await writeFile(
		script,
		`import { Database } from "bun:sqlite";
		const db = new Database(${JSON.stringify(path)});
		db.exec("BEGIN IMMEDIATE");
		db.exec("UPDATE concerts SET title = 'held' WHERE id = 'c'");
		console.log("held");
		Bun.sleepSync(${HOLD_MS});
		db.exec("COMMIT");`,
	);
	const holder = Bun.spawn([process.execPath, script], { stdout: "pipe" });
	await holder.stdout.getReader().read();
	record.note("c", A, { type: "log", line: "x" }, 3);
	expect(await holder.exited).toBe(0);
	expect(
		openRecord(path)
			.events("c")
			.map((e) => e.type),
	).toEqual(["running", "log"]);
	record.close();
});

test("a reader settles a concert whose process exited failed, with its running instances, once", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const ir = await fixtureIr();
	const failure = await inProcess(
		path,
		`record.begin({ id: "gone", ir: ${JSON.stringify(ir)}, startedAt: 1 });
		record.start("gone", ${JSON.stringify(A)}, 2);`,
	);
	expect(failure).toBe("");
	const reader = openRecord(path);
	const events = () => reader.events("gone").map((e) => e.type);
	expect(reader.concerts({ status: "running" })).toEqual([]);
	expect(reader.find("gone")).toMatchObject({ status: "failed", ir });
	expect(reader.result("gone")).toEqual({
		outcome: "failed",
		reason: PROCESS_EXITED,
	});
	expect(reader.instances("gone")).toMatchObject([
		{ ...A, status: "failed", reason: PROCESS_EXITED },
	]);
	expect(events()).toEqual(["running", "settled"]);
	const other = openRecord(path);
	expect(await other.wait("gone")).toMatchObject({ status: "failed" });
	expect(events()).toEqual(["running", "settled"]);
	other.close();
	reader.close();
});

test("a resumed concert holds no disk use until it settles again", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const record = openWriter(path);
	const reader = openRecord(path);
	const ir = await fixtureIr();
	record.begin({ id: "c", ir, startedAt: 1 });
	record.finish("c", { outcome: "failed", reason: "x" }, 2);
	record.setDiskUse("c", 100);
	expect(reader.find("c")).toMatchObject({ diskUse: 100 });
	record.resume({ id: "c", ir });
	expect(reader.find("c")).not.toHaveProperty("diskUse");
	record.close();
	reader.close();
});

test("finishing a concert settles its running instances, and a settled instance or concert takes no more writes", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const record = openWriter(path);
	const reader = openRecord(path);
	record.begin({ id: "c", ir: await fixtureIr(), startedAt: 1 });
	record.start("c", A, 2);
	record.settle("c", A, { outcome: "ok", outputs: {} }, 3);
	const b = { node: "b", expansion: "" };
	record.start("c", b, 3);
	const late = "'a' of concert 'c' is ok, so it takes no such write";
	expect(() =>
		record.settle("c", A, { outcome: "failed", reason: "late" }, 4),
	).toThrow(late);
	expect(() => record.note("c", A, { type: "log", line: "late" }, 4)).toThrow(
		late,
	);
	record.finish("c", { outcome: "failed", reason: "broke" }, 5);
	expect(reader.instances("c")).toMatchObject([
		{ ...A, status: "ok" },
		{ ...b, status: "failed", reason: CONCERT_FINISHED, settledAt: 5 },
	]);
	expect(() => record.start("c", { node: "z", expansion: "" }, 6)).toThrow(
		"concert 'c' has settled, so it takes no more writes",
	);
	expect(reader.events("c").map((e) => e.type)).toEqual([
		"running",
		"settled",
		"running",
		"settled",
	]);
	record.close();
	reader.close();
});

test("a concert keeps its origin, tour, title, presets and config, NULL when not given, and concerts filter by them, newest first, up to a limit", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const record = openWriter(path);
	const reader = openRecord(path);
	const ir = await fixtureIr();
	const origin = {
		workspace: "w",
		moduleDir: "/m",
		file: "f.ts",
		tour: "t1",
		title: "T",
		presets: ["stub", "risky"],
		config: ["a=1", "b=!delete"],
	};
	record.begin({ id: "a", ir, startedAt: 1, ...origin });
	record.begin({ id: "b", ir, startedAt: 2 });
	record.begin({ id: "c", ir, startedAt: 3, workspace: "w", moduleDir: "/m" });
	expect(reader.find("a")).toMatchObject(origin);
	expect(reader.find("b")).toMatchObject({ workspace: "", moduleDir: "" });
	expect(reader.find("b")).not.toHaveProperty("tour");
	expect(reader.find("b")).not.toHaveProperty("file");
	const db = new Database(path, { readonly: true });
	expect(
		db.query("SELECT profile, config FROM concerts WHERE id = 'b'").get(),
	).toEqual({ profile: null, config: null });
	db.close();
	expect(reader.find("z")).toBeUndefined();
	const legacy = new Database(path);
	legacy.exec("UPDATE concerts SET profile = 'stub' WHERE id = 'c'");
	legacy.close();
	expect(reader.find("c")?.presets).toEqual(["stub"]);
	const ids = (filter?: Parameters<typeof reader.concerts>[0]) =>
		reader.concerts(filter).map((c) => c.id);
	expect(ids()).toEqual(["c", "b", "a"]);
	expect(ids({ workspace: "w" })).toEqual(["c", "a"]);
	expect(ids({ limit: 2 })).toEqual(["c", "b"]);
	reader.setTour("c", "t1");
	expect(ids({ tour: "t1" })).toEqual(["c", "a"]);
	reader.setTour("a", undefined);
	expect(ids({ tour: "t1", workspace: "w" })).toEqual(["c"]);
	expect(reader.find("a")).not.toHaveProperty("tour");
	reader.setTour("a", "epic");
	reader.setTour("b", "epic.story.task");
	reader.setTour("c", "epic-x");
	expect(ids({ tour: "epic" })).toEqual(["b", "a"]);
	expect(ids({ tour: "epic.story" })).toEqual(["b"]);
	expect(ids({ tour: "epic-x" })).toEqual(["c"]);
	expect(ids({ tour: "epi" })).toEqual([]);
	expect(() => reader.setTour("z", "t1")).toThrow("no concert 'z'");
	record.close();
	reader.close();
});

test("removing a concert deletes its rows, and a running concert is refused", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const record = openWriter(path);
	const reader = openRecord(path);
	const ir = await fixtureIr();
	record.begin({ id: "gone", ir, startedAt: 1 });
	record.begin({ id: "kept", ir, startedAt: 2 });
	for (const id of ["gone", "kept"]) {
		record.start(id, A, 3);
		record.ask(id, A, { key: "k", prompt: "Go?", inputs: {} }, 3);
		record.settle(
			id,
			A,
			{ outcome: "ok", outputs: {}, metrics: { tokens: 1 } },
			4,
		);
	}
	expect(() => reader.remove("gone")).toThrow(
		`concert 'gone' is still running in process ${process.pid}, so it cannot be removed`,
	);
	record.finish("gone", { outcome: "failed", reason: "x" }, 5);
	reader.remove("gone");
	expect(reader.find("gone")).toBeUndefined();
	const db = new Database(path);
	const rows = (table: string, concert: string) =>
		db.query(`SELECT 1 FROM ${table} WHERE concert = ?`).all(concert).length;
	for (const table of ["instances", "metrics", "events", "approvals"]) {
		expect([rows(table, "gone"), rows(table, "kept")]).toEqual([
			0,
			1 + (table === "events" ? 2 : 0),
		]);
	}
	db.close();
	record.close();
	reader.close();
});

test("a ruling is refused once its instance is no longer held, and a resume drops the request before the approval asks again", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const record = openWriter(path);
	const reader = openRecord(path);
	const ir = await fixtureIr();
	const hold = { node: "hold", expansion: "" };
	const asked = { key: "k", prompt: "Go?", inputs: { v: 1 } };
	const request = { concert: "c", ...hold, key: "k" };
	record.begin({ id: "c", ir, startedAt: 1 });
	record.start("c", hold, 2);
	record.ask("c", hold, asked, 3);
	record.settle("c", hold, { outcome: "failed", reason: "halted" }, 4);
	expect(() => reader.rule(request, { outcome: "ok" })).toThrow(
		new Unrulable(
			{ id: "c", status: "running" },
			"approval 'hold' of concert 'c' is no longer held, so it takes no ruling\nList its open approvals and rule on the current request",
		),
	);
	record.finish("c", { outcome: "failed", reason: "x" }, 5);
	record.resume({ id: "c", ir });
	record.start("c", hold, 6);
	expect(reader.openApprovals()).toEqual([]);
	expect(() => reader.rule(request, { outcome: "ok" })).toThrow(
		"concert 'c' holds at no approval 'hold'",
	);
	record.ask("c", hold, asked, 7);
	expect(reader.openApprovals()).toEqual([
		{ ...request, prompt: "Go?", inputs: { v: 1 }, askedAt: 7 },
	]);
	record.close();
	reader.close();
});

test("a running concert is settled when the alive check says its process is gone", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const record = openWriter(path);
	record.begin({ id: "c", ir: await fixtureIr(), startedAt: 1 });
	const reader = openRecord(path, { alive: () => false });
	expect(reader.find("c")).toMatchObject({ status: "failed" });
	expect(reader.result("c")).toEqual({
		outcome: "failed",
		reason: PROCESS_EXITED,
	});
	reader.close();
	record.close();
});

test("an encore is refused while any concert in its encore chain is live, and allowed once the chain settles", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const record = openWriter(path);
	const reader = openRecord(path);
	const ir = await fixtureIr();
	const done = { ...A, outcome: "ok" as const, outputs: {} };
	const fix = "Wait for it to settle, or kill it, then perform its encore";
	const refusal = (id: string, of: string) =>
		`concert '${id}' in the encore chain of '${of}' is still running in process ${process.pid}\n${fix}`;
	record.begin({ id: "x", ir, startedAt: 1 });
	record.finish("x", done, 2);
	record.begin({ id: "e1", ir, startedAt: 3, encoreOf: "x" });
	expect(() =>
		record.begin({ id: "e2", ir, startedAt: 4, encoreOf: "x" }),
	).toThrow(refusal("e1", "x"));
	record.finish("e1", done, 5);
	record.begin({ id: "e2", ir, startedAt: 6, encoreOf: "x" });
	expect(() =>
		record.begin({ id: "e3", ir, startedAt: 7, encoreOf: "e1" }),
	).toThrow(refusal("e2", "e1"));
	record.finish("e2", done, 8);
	record.begin({ id: "e3", ir, startedAt: 9, encoreOf: "e1" });
	record.finish("e3", done, 10);
	reader.remove("x");
	record.begin({ id: "e4", ir, startedAt: 11, encoreOf: "e1" });
	expect(() =>
		record.begin({ id: "e5", ir, startedAt: 12, encoreOf: "e1" }),
	).toThrow(refusal("e4", "e1"));
	reader.close();
	record.close();
});

test("enrichments reads the enriched current instances of the concerts named, none stale", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const record = openWriter(path);
	const ir = await fixtureIr();
	const b = { node: "b", expansion: "" };
	for (const id of ["c", "d", "e"]) {
		record.begin({ id, ir, startedAt: 1 });
		record.start(id, A, 2);
		record.settle(
			id,
			A,
			{ outcome: "ok", outputs: {}, enrichment: { n: id } },
			3,
		);
		record.start(id, b, 3);
		record.settle(id, b, { outcome: "failed", reason: "x" }, 4);
		record.finish(id, { outcome: "failed", reason: "x" }, 5);
	}
	record.resume({ id: "c", ir });
	record.start("c", b, 6);
	record.settle(
		"c",
		b,
		{ outcome: "ok", outputs: {}, enrichment: { n: "c2" } },
		7,
	);
	expect(openRecord(path).enrichments(["c", "d"])).toEqual([
		{ concert: "c", node: "b", enrichment: { n: "c2" } },
		{ concert: "d", node: "a", enrichment: { n: "d" } },
	]);
	record.close();
});

test("a tour slug is dot-separated lower-case hyphen-joined words of at most 64 characters", () => {
	expect(TOUR_MAX_LENGTH).toBe(64);
	expect(new RegExp(`^${TOUR_SEGMENT}$`).test("release-2")).toBe(true);
	const verdicts = Object.fromEntries(
		[
			"release-2.part-3",
			"spring-tour",
			"0",
			"a".repeat(64),
			"a".repeat(65),
			"",
			".release",
			"release.",
			"release..part",
			"Release",
			"release--part",
			"-release",
			"release_part",
		].map((slug) => [slug, isTourSlug(slug)]),
	);
	expect(verdicts).toEqual({
		"release-2.part-3": true,
		"spring-tour": true,
		"0": true,
		["a".repeat(64)]: true,
		["a".repeat(65)]: false,
		"": false,
		".release": false,
		"release.": false,
		"release..part": false,
		Release: false,
		"release--part": false,
		"-release": false,
		release_part: false,
	});
});

/** Perform options over one alpha host whose facts and code `behaviour` steers, in a fresh store under `dir`. */
async function factsFixture(behaviour: {
	environment: Host["environment"];
	code?: () => Promise<() => unknown>;
}) {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const host: Host = {
		name: "alpha",
		kinds: [],
		types: [],
		config: {},
		validate: () => [],
		bounds: () => ({}),
		environment: behaviour.environment,
	};
	const options = {
		ir: await fixtureIr(
			join(import.meta.dir, "../../../ir/fixtures/minimal.json"),
		),
		config: layered([coreDefaults(dir, "w")]),
		hosts: [host],
		roots: { user: dir, packs: {} },
		loadCode: behaviour.code ?? (async () => () => ({ text: "hello" })),
		recordPath: path,
		dir: join(dir, "concerts"),
		concurrency: 1,
	};
	return { path, host, options };
}

// Seam: perform's record and its refusal of an encore with the same loaded IR, config and host facts.
test("shared and inline IR give the same recorded IR and encore fingerprint", async () => {
	const { path, options } = await factsFixture({
		environment: () => ({ place: "/checkout" }),
	});
	const inline = { ...options.ir, irVersion: "1.3" };
	const shared = {
		...inline,
		schemas: { text: { type: "string" } },
		nodes: inline.nodes.map((n) => ({
			...n,
			in: { name: "text" },
			out: { text: "text" },
		})),
	};
	const loaded = parseIr(shared);
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) return;
	const first = await perform({ ...options, ir: inline });
	expect((await first.done).outcome).toBe("ok");
	await expect(
		perform({ ...options, ir: loaded.ir, encore: first.id }),
	).rejects.toBeInstanceOf(Unencorable);
	const second = await perform({ ...options, ir: loaded.ir });
	expect((await second.done).outcome).toBe("ok");
	const reader = openRecord(path);
	try {
		expect(reader.find(first.id)?.ir).toEqual(inline);
		expect(reader.find(second.id)?.ir).toEqual(inline);
	} finally {
		reader.close();
	}
});

// Seam: perform's attempts and the facts a reopened record reader returns.
test("a concert records each host's facts at perform start and replaces them on resume", async () => {
	let place = "/checkout/first";
	let fail = true;
	const { path, host, options } = await factsFixture({
		environment: () => ({ place, nested: { n: 2 }, absent: null }),
		code: async () => () => {
			if (fail) throw new Error("first attempt");
			return { text: "hello" };
		},
	});
	const other: Host = {
		...host,
		name: "beta",
		environment: () => ({ mode: "test" }),
	};
	const both = { ...options, hosts: [host, other] };
	const first = await perform(both);
	expect((await first.done).outcome).toBe("failed");
	place = "/checkout/second";
	const reader = openRecord(path);
	try {
		expect(reader.find(first.id)).toHaveProperty("facts", {
			alpha: { place: "/checkout/first", nested: { n: 2 }, absent: null },
			beta: { mode: "test" },
		});
		fail = false;
		const resumed = await perform({ ...both, resume: first.id });
		expect((await resumed.done).outcome).toBe("ok");
		expect(reader.find(first.id)).toHaveProperty("facts", {
			alpha: { place: "/checkout/second", nested: { n: 2 }, absent: null },
			beta: { mode: "test" },
		});
		place = "/checkout/third";
		const encore = await perform({ ...both, encore: first.id });
		expect((await encore.done).outcome).toBe("ok");
		expect(reader.find(encore.id)).toHaveProperty("facts", {
			alpha: { place: "/checkout/third", nested: { n: 2 }, absent: null },
			beta: { mode: "test" },
		});
		expect(reader.find(first.id)).toMatchObject({
			facts: { alpha: { place: "/checkout/second" } },
		});
	} finally {
		reader.close();
	}
});

// Seam: what a reader of the record sees while an attempt is in progress.
test("a reader sees a new concert's facts in its running row", async () => {
	const held = Promise.withResolvers<void>();
	let settled = false;
	const { path, options } = await factsFixture({
		environment: () => ({ place: "/checkout" }),
		code: async () => async () => {
			await held.promise;
			return { text: "hello" };
		},
	});
	const reader = openRecord(path);
	const seen: (Record<string, unknown> | undefined)[] = [];
	const polling = (async () => {
		while (!settled) {
			const [row] = reader.concerts();
			if (row?.status === "running") seen.push(row.facts);
			await Bun.sleep(0);
		}
	})();
	try {
		const concert = await perform(options);
		await Bun.sleep(50);
		held.resolve();
		await concert.done;
		settled = true;
		await polling;
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((facts) => facts?.alpha !== undefined)).toBe(true);
	} finally {
		settled = true;
		held.resolve();
		reader.close();
	}
});

// Seam: what a reader of the record sees while a resume is in progress.
test("a resume shows no facts until its hosts give its own, then shows them during the attempt", async () => {
	const hosts = Promise.withResolvers<void>();
	const code = Promise.withResolvers<void>();
	let attempt = 0;
	const { path, options } = await factsFixture({
		environment: async () => {
			if (attempt > 0) await hosts.promise;
			return { place: attempt > 0 ? "/second" : "/first" };
		},
		code: async () => async () => {
			if (attempt === 0) throw new Error("first attempt");
			await code.promise;
			return { text: "hello" };
		},
	});
	const reader = openRecord(path);
	try {
		const first = await perform(options);
		await first.done;
		expect(reader.find(first.id)).toMatchObject({
			facts: { alpha: { place: "/first" } },
		});
		attempt = 1;
		const resumed = await perform({ ...options, resume: first.id });
		const pending = reader.find(first.id);
		expect(pending).toMatchObject({ status: "running" });
		expect(pending).not.toHaveProperty("facts");
		hosts.resolve();
		await Bun.sleep(50);
		expect(reader.find(first.id)).toMatchObject({
			status: "running",
			facts: { alpha: { place: "/second" } },
		});
		code.resolve();
		await resumed.done;
	} finally {
		hosts.resolve();
		code.resolve();
		reader.close();
	}
});

// Seam: a resume's limits and the record while its hosts give their facts.
test("a resume counts the time its hosts take to give their facts against its timeout", async () => {
	let slow = false;
	const { options } = await factsFixture({
		environment: async () => {
			if (slow) await Bun.sleep(150);
			return { place: "/checkout" };
		},
		code: async () => () => ({ text: "hello" }),
	});
	const missing = {
		source: join(dir, "gone.txt"),
		ref: { path: "ab/gone.txt", contentHash: "sha256:ab" },
		from: "--file",
	};
	const first = await perform({ ...options, stage: [missing] });
	await first.done;
	slow = true;
	const resumed = await perform({
		...options,
		resume: first.id,
		limits: { timeout: 30 },
	});
	expect((await resumed.done).outcome).toBe("failed");
});

// Seam: perform's attempts that fail before a node starts, and the facts a reopened record reader returns.
test("a concert whose staged file is gone still records its facts, and a resume whose host fails keeps none of the earlier attempt's", async () => {
	let broken = false;
	const { path, options } = await factsFixture({
		environment: () => {
			if (broken) throw new Error("no checkout");
			return { place: "/checkout" };
		},
	});
	const missing = {
		source: join(dir, "gone.txt"),
		ref: { path: "ab/gone.txt", contentHash: "sha256:ab" },
		from: "--file",
	};
	const first = await perform({ ...options, stage: [missing] });
	expect((await first.done).outcome).toBe("failed");
	const reader = openRecord(path);
	try {
		expect(reader.find(first.id)).toHaveProperty("facts", {
			alpha: { place: "/checkout" },
		});
		broken = true;
		const resumed = await perform({
			...options,
			resume: first.id,
			stage: [missing],
		});
		expect((await resumed.done).outcome).toBe("failed");
		expect(reader.find(first.id)).not.toHaveProperty("facts");
	} finally {
		reader.close();
	}
});

// Seam: a resume whose host fails, and the files it staged before.
test("a resume whose host fails stages nothing, keeps the earlier staged file and reports the host", async () => {
	let broken = false;
	const { options } = await factsFixture({
		environment: () => {
			if (broken) throw new Error("no checkout");
			return { place: "/checkout" };
		},
		code: async () => () => {
			throw new Error("first attempt");
		},
	});
	const source = join(dir, "a.txt");
	await writeFile(source, "one");
	const ref = stagedRef("a.txt", new TextEncoder().encode("one"));
	const staged = [{ source, ref, from: "--file" }];
	const first = await perform({ ...options, stage: staged });
	await first.done;
	const kept = join(dir, "concerts", first.id, "artifacts", ref.path);
	expect(await Bun.file(kept).text()).toBe("one");
	await writeFile(source, "two");
	broken = true;
	const resumed = await perform({
		...options,
		resume: first.id,
		stage: staged,
	});
	expect(await resumed.done).toMatchObject({
		outcome: "failed",
		reason: expect.stringContaining("no checkout"),
	});
	expect(await Bun.file(kept).text()).toBe("one");
});

// Seam: a reopened record reader over a column a later version wrote.
test("a facts column that is not JSON of an object of objects is read as no facts", async () => {
	const { path, options } = await factsFixture({
		environment: () => ({ place: "/checkout" }),
	});
	const concert = await perform(options);
	await concert.done;
	const reader = openRecord(path);
	try {
		for (const column of [
			"[1,2]",
			'{"alpha":1}',
			'{"alpha":[1]}',
			"{not json",
		]) {
			const db = new Database(path);
			db.exec(`UPDATE concerts SET facts = '${column}'`);
			db.close();
			expect(reader.find(concert.id)).not.toHaveProperty("facts");
		}
	} finally {
		reader.close();
	}
});

// Seam: perform writes the snapshot, and a reopened record reader returns it.
test("a performed concert records the text of each parsed config layer, lowest first, which parses again to the same config", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const layer = (text: string, file: string) =>
		parseLayer(text, { file, layer: "workspace", paths: [["mode", "path"]] });
	const lower = layer(
		"mode: { path: rel, keep: a, n: .inf }\n",
		"/w/.maestro/config.yaml",
	);
	const upper = layer("mode: !replace { keep: b }\n", "/w/.maestro/more.yaml");
	const config = layered([coreDefaults(dir, "w"), lower, upper]);
	const concert = await perform({
		ir: await fixtureIr(
			join(import.meta.dir, "../../../ir/fixtures/minimal.json"),
		),
		config,
		hosts: [],
		roots: { user: dir, packs: {} },
		loadCode: async () => (inputs: Readonly<Record<string, unknown>>) => ({
			text: `Hello, ${String(inputs.name)}`,
		}),
		recordPath: path,
		dir: join(dir, "concerts"),
		concurrency: 1,
		workspaceDir: "/w",
	});
	expect(await concert.done).toMatchObject({ outcome: "ok" });
	const reader = openRecord(path);
	try {
		const snapshot = reader.find(concert.id)?.snapshot;
		if (snapshot === undefined || snapshot === "unreadable")
			throw new Error("no snapshot was recorded");
		expect(snapshot.workspace).toBe("/w");
		expect(snapshot.layers.map((l) => l.from)).toEqual([
			{
				file: "/w/.maestro/config.yaml",
				layer: "workspace",
				paths: [["mode", "path"]],
			},
			{
				file: "/w/.maestro/more.yaml",
				layer: "workspace",
				paths: [["mode", "path"]],
			},
		]);
		expect(
			snapshot.layers.map((l) => layered([parseLayer(l.text, l.from)]).values),
		).toEqual([
			{
				mode: {
					path: "/w/.maestro/rel",
					keep: "a",
					n: Number.POSITIVE_INFINITY,
				},
			},
			{ mode: { keep: "b" } },
		]);
	} finally {
		reader.close();
	}
});

test.each([
	["malformed JSON", "["],
	["a later format", '{"format":"future"}'],
	["a workspace that is no path", '{"workspace":5,"layers":[]}'],
	[
		"layers in the entries form",
		'{"layers":[{"source":{"layer":"user"},"entries":{"a":{"value":1}}}]}',
	],
	[
		"a file layer whose base is no path",
		'{"layers":[{"text":"packs: [rel]\\n","from":{"layer":"user","file":"/u/config.yaml","base":5}}]}',
	],
	[
		"a flag layer with no base",
		'{"layers":[{"text":"a: 1\\n","from":{"layer":"flag","flag":"-c a=1","key":"a"}}]}',
	],
	[
		"a layer with no text",
		'{"layers":[{"from":{"layer":"user","file":"/u/config.yaml"}}]}',
	],
	[
		"a layer whose text is no string",
		'{"layers":[{"text":5,"from":{"layer":"user","file":"/u/config.yaml"}}]}',
	],
	[
		"a layer read with no layer name",
		'{"layers":[{"text":"a: 1\\n","from":{"file":"/u/config.yaml"}}]}',
	],
	[
		"a layer named for none of the layers",
		'{"layers":[{"text":"a: 1\\n","from":{"layer":"elsewhere","file":"/u/config.yaml"}}]}',
	],
	[
		"a layer whose concert is no string",
		'{"layers":[{"text":"a: 1\\n","from":{"layer":"user","file":"/u/config.yaml","concert":5}}]}',
	],
	[
		"path keys that are not key paths",
		'{"layers":[{"text":"a: 1\\n","from":{"layer":"user","file":"/u/c.yaml","paths":["a"]}}]}',
	],
])(
	"a concert whose snapshot is %s reads as unreadable, beside its other columns",
	async (_kind, column) => {
		dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
		const path = join(dir, "record.db");
		const writer = openRecord(path);
		writer.close();
		const db = new Database(path);
		db.exec(
			`INSERT INTO concerts (id, composition, pack, ir, pid, status, started_at, workspace, module_dir, snapshot)
		VALUES ('c', 'greet', 'demo', ?, 1, 'ok', 1, 'w', '/m', ?)`,
			[JSON.stringify(await fixtureIr()), column],
		);
		db.close();
		const reader = openRecord(path);
		try {
			expect(reader.find("c")).toMatchObject({
				id: "c",
				snapshot: "unreadable",
			});
		} finally {
			reader.close();
		}
	},
);
