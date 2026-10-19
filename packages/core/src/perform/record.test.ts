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
const IR_FIXTURE = join(
	import.meta.dir,
	"../../../ir/fixtures/fanout-fanin-loop.json",
);
const A = { node: "a", expansion: "" };

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

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
	for (const version of [1, 7]) {
		const db = new Database(path);
		db.exec(`PRAGMA user_version = ${version}`);
		db.close();
		expect(() => openRecord(path)).toThrow(
			`record store '${path}' has schema version ${version}, and this maestro reads version 4. Use a record store this maestro made, or move '${path}' aside`,
		);
	}
});

test("several processes open one new record store at once", async () => {
	dir = await mkdtemp(join(tmpdir(), "maestro-record-"));
	const path = join(dir, "record.db");
	const at = Date.now() + OPEN_AT_MS;
	const failures = await Promise.all(
		Array.from({ length: OPENERS }, () =>
			inProcess(path, "record.close();", at),
		),
	);
	expect(failures).toEqual(Array(OPENERS).fill(""));
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

test("a concert keeps its origin, tour, title, profile and config, NULL when not given, and concerts filter by them, newest first, up to a limit", async () => {
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
		profile: "stub",
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
