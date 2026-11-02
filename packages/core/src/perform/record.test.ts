import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ir, parseIr } from "@maestro/ir";
import {
	CONCERT_FINISHED,
	openRecord,
	openWriter,
	PROCESS_EXITED,
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
const CURRENT_VERSION = 7;
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

async function fixtureIr(): Promise<Ir> {
	const parsed = parseIr(await Bun.file(IR_FIXTURE).json());
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
	for (const version of [1, 8]) {
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
	record.close();
	expect(userVersion(path)).toBe(CURRENT_VERSION);
	expect(columns(path)).toEqual(columns(fresh));
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
	for (const table of ["instances", "metrics", "events"]) {
		expect([rows(table, "gone"), rows(table, "kept")]).toEqual([
			0,
			1 + (table === "events" ? 1 : 0),
		]);
	}
	db.close();
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
