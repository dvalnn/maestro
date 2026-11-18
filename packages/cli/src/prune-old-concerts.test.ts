import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanup } from "./fixtures/packs";
import { idOf, json, world } from "./fixtures/world";

afterEach(cleanup);

const SCRIPT = join(
	import.meta.dir,
	"../../../skills/maestro/scripts/prune-old-concerts.sh",
);
const MAESTRO = join(import.meta.dir, "maestro.ts");
const ESSAY = join(import.meta.dir, "fixtures/essay.ts");

async function setup() {
	const w = await world();
	const bin = join(w.root, "bin");
	await mkdir(bin);
	const executable = join(bin, "maestro");
	await Bun.write(
		executable,
		`#!/bin/sh\nexec '${process.execPath}' '${MAESTRO}' "$@"\n`,
	);
	await chmod(executable, 0o755);
	const env = { ...process.env, ...w.env, PATH: `${bin}:${process.env.PATH}` };
	const run = async (
		command: string[],
		overrides: Record<string, string | undefined> = {},
		input?: string,
	) => {
		const child = Bun.spawn(command, {
			cwd: w.cwd,
			env: { ...env, ...overrides },
			stdin: input === undefined ? "ignore" : new Blob([input]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { out: out.trim(), err: err.trim(), code };
	};
	const maestro = (
		args: string[],
		overrides: Record<string, string | undefined> = {},
	) => run([executable, ...args], overrides);
	const script = (
		args: string[],
		overrides: Record<string, string | undefined> = {},
	) => run(["bash", SCRIPT, ...args], overrides);
	// The script on a pseudo-terminal, answering its prompt with `input`.
	const asked = (
		args: string[],
		input: string,
		overrides: Record<string, string | undefined> = {},
	) =>
		run(
			["script", "-qec", `bash '${SCRIPT}' ${args.join(" ")}`, "/dev/null"],
			overrides,
			input,
		);
	// A `maestro` that logs each concert's snapshot before every prune, and runs `onSecond` before the second one.
	const spied = async (onSecond = "true") => {
		const dir = join(w.root, "spy");
		const log = join(w.root, "snapshots.log");
		await mkdir(dir);
		const db = join(w.env.XDG_DATA_HOME, "maestro/record.db");
		await Bun.write(
			join(dir, "maestro"),
			`#!/bin/sh\nif [ "$1" = prune ]; then\n sqlite3 '${db}' "SELECT id || ' ' || quote(snapshot) FROM concerts" >> '${log}'\n echo --- >> '${log}'\n if [ "$(grep -c -- --- '${log}')" -ge 2 ]; then ${onSecond}; fi\nfi\nexec '${process.execPath}' '${MAESTRO}' "$@"\n`,
		);
		await chmod(join(dir, "maestro"), 0o755);
		const prunes = async (id: string) =>
			((await Bun.file(log).exists()) ? await Bun.file(log).text() : "")
				.split("---\n")
				.filter(Boolean)
				.map((block) =>
					block.split("\n").filter((line) => line.startsWith(id)),
				);
		return { PATH: `${dir}:${process.env.PATH}`, prunes };
	};
	const perform = async (
		overrides: Record<string, string | undefined> = {},
	) => {
		const result = await maestro(["perform", ESSAY], overrides);
		expect(result.code).toBe(0);
		const id = idOf(result);
		expect(id).not.toBe("");
		return id;
	};
	return { ...w, maestro, script, asked, spied, perform };
}

function snapshot(data: string, id: string, value: string | null) {
	const db = new Database(join(data, "maestro/record.db"));
	db.run("UPDATE concerts SET snapshot = ? WHERE id = ?", [value, id]);
	db.close();
}

function snapshotOf(data: string, id: string) {
	const db = new Database(join(data, "maestro/record.db"));
	const row = db.query("SELECT snapshot FROM concerts WHERE id = ?").get(id);
	db.close();
	return (row as { snapshot: string | null } | null)?.snapshot;
}

const DEFAULTS = `'{"layers":[]}'`;

// Seam: the script's exit status and the real CLI's listing and concert directory.
test("the old-concert script prunes an old concert and restores a snapshot when release fails", async () => {
	const w = await setup();
	const old = await w.perform();
	const untouched = await w.perform();
	snapshot(w.env.XDG_DATA_HOME, old, null);
	const directory = join(w.env.XDG_DATA_HOME, "maestro/concerts", old);
	await Bun.write(join(directory, "artifacts/old.txt"), "old");

	const result = await w.script([old, "--yes"]);
	expect(result.code).toBe(0);
	const listed = await w.maestro(["ls", "--json"]);
	expect(listed.code).toBe(0);
	expect(json(listed).map((row: { id: string }) => row.id)).toEqual([
		untouched,
	]);
	expect(await Bun.file(directory).exists()).toBe(false);

	const kept = await w.perform();
	const sessions = join(
		w.env.XDG_DATA_HOME,
		"maestro/hosts/repo/0123456789abcdef/sessions",
	);
	await mkdir(sessions, { recursive: true });
	await Bun.write(join(sessions, "%"), "bad session name");
	const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
	db.run("UPDATE concerts SET disk_use = 0 WHERE id = ?", [kept]);
	db.close();
	const cannotRelease = await w.maestro(["prune", kept, "--yes"]);
	expect(cannotRelease.code).not.toBe(0);
	snapshot(w.env.XDG_DATA_HOME, kept, "[");
	const spy = await w.spied();
	const retry = await w.script([kept, "--yes"], { PATH: spy.PATH });
	expect(retry.code).not.toBe(0);
	// The first prune saw the earlier snapshot, the retry the defaults, and the earlier one is back.
	expect(await spy.prunes(kept)).toEqual([
		[`${kept} '['`],
		[`${kept} ${DEFAULTS}`],
	]);
	expect(snapshotOf(w.env.XDG_DATA_HOME, kept)).toBe("[");
}, 30_000);

test("an interrupted old-concert script restores the earlier snapshot", async () => {
	const w = await setup();
	const id = await w.perform();
	snapshot(w.env.XDG_DATA_HOME, id, "[");
	// The second prune interrupts the script, once the defaults snapshot is written.
	const spy = await w.spied("kill -TERM $PPID; sleep 5; exit 0");
	const result = await w.script([id, "--yes"], { PATH: spy.PATH });
	expect(result.code).not.toBe(0);
	expect(await spy.prunes(id)).toEqual([[`${id} '['`], [`${id} ${DEFAULTS}`]]);
	expect(snapshotOf(w.env.XDG_DATA_HOME, id)).toBe("[");
}, 30_000);

test("the old-concert script keeps the earlier snapshot in a file when it cannot restore it", async () => {
	const w = await setup();
	const id = await w.perform();
	snapshot(w.env.XDG_DATA_HOME, id, "[");
	const db = join(w.env.XDG_DATA_HOME, "maestro/record.db");
	// The second prune leaves the concert in the record, and a trigger refuses the restore.
	const spy = await w.spied(
		`sqlite3 '${db}' "CREATE TRIGGER refuse BEFORE UPDATE OF snapshot ON concerts BEGIN SELECT RAISE(ABORT, 'refused'); END"; exit 1`,
	);
	const result = await w.script([id, "--yes"], { PATH: spy.PATH });
	expect(result.code).not.toBe(0);
	expect(result.err).toContain(
		`could not restore the snapshot of concert ${id}`,
	);
	expect(snapshotOf(w.env.XDG_DATA_HOME, id)).toBe('{"layers":[]}');
	const saved = result.err.match(/is in (\S+)\/<concert>/)?.[1];
	expect(saved).toBeDefined();
	expect((await Bun.file(join(saved ?? "", id)).text()).trim()).toBe("'['");
}, 30_000);

test("the old-concert script waits for another writer's lock to restore a snapshot", async () => {
	const w = await setup();
	const id = await w.perform();
	snapshot(w.env.XDG_DATA_HOME, id, "[");
	const db = join(w.env.XDG_DATA_HOME, "maestro/record.db");
	// Another writer takes the record's lock before the restore and holds it for a second.
	const spy = await w.spied(
		`(sqlite3 '${db}' '.timeout 0' 'BEGIN EXCLUSIVE;' '.shell sleep 1' 'COMMIT;' >/dev/null 2>&1 &); sleep 0.3; exit 0`,
	);
	const result = await w.script([id, "--yes"], { PATH: spy.PATH });
	expect(result.code).toBe(0);
	expect(snapshotOf(w.env.XDG_DATA_HOME, id)).toBe("[");
}, 30_000);

test("the old-concert script refuses piped input without --yes and changes nothing", async () => {
	const w = await setup();
	const id = await w.perform();
	snapshot(w.env.XDG_DATA_HOME, id, null);
	const result = await w.script([id]);
	expect(result.code).not.toBe(0);
	expect(result.err).toContain("--yes");
	expect(snapshotOf(w.env.XDG_DATA_HOME, id)).toBeNull();
	const listed = await w.maestro(["ls", id, "--json"]);
	expect(listed.code).toBe(0);
	expect(json(listed)).toMatchObject({ id });
}, 30_000);

test("the old-concert script prunes after a yes at the terminal and keeps the concert after a no", async () => {
	const w = await setup();
	const id = await w.perform();
	snapshot(w.env.XDG_DATA_HOME, id, null);
	const declined = await w.asked([id], "n\n");
	expect(declined.code).toBe(0);
	expect(snapshotOf(w.env.XDG_DATA_HOME, id)).toBeNull();
	expect(json(await w.maestro(["ls", id, "--json"]))).toMatchObject({ id });
	const accepted = await w.asked([id], "y\n");
	expect(accepted.code).toBe(0);
	expect(json(await w.maestro(["ls", "--json"]))).toEqual([]);
}, 30_000);

test("an unknown concert stops the old-concert script before it changes a snapshot", async () => {
	const w = await setup();
	const id = await w.perform();
	snapshot(w.env.XDG_DATA_HOME, id, null);
	const missing = "00000000-0000-4000-8000-000000000000";
	const first = await w.maestro(["prune", id, missing, "--yes"]);
	expect(first.code).not.toBe(0);
	const result = await w.script([id, missing, "--yes"]);
	expect(result.code).toBe(first.code);
	expect(snapshotOf(w.env.XDG_DATA_HOME, id)).toBeNull();
}, 30_000);

test("a running concert stops the old-concert script before it changes a snapshot", async () => {
	const w = await setup();
	const id = await w.perform();
	snapshot(w.env.XDG_DATA_HOME, id, null);
	const db = new Database(join(w.env.XDG_DATA_HOME, "maestro/record.db"));
	db.run("UPDATE concerts SET status = 'running', pid = ? WHERE id = ?", [
		process.pid,
		id,
	]);
	db.close();
	const first = await w.maestro(["prune", id, "--yes"]);
	expect(first.code).not.toBe(0);
	const result = await w.script([id, "--yes"]);
	expect(result.code).toBe(first.code);
	expect(snapshotOf(w.env.XDG_DATA_HOME, id)).toBeNull();
}, 30_000);

test("the old-concert script prunes a concert prune removes and one it keeps in the same run", async () => {
	const w = await setup();
	const fine = await w.perform();
	const old = await w.perform();
	const untouched = await w.perform();
	snapshot(w.env.XDG_DATA_HOME, old, null);
	const result = await w.script([fine, old, "--yes"]);
	expect(result.code).toBe(0);
	expect(
		json(await w.maestro(["ls", "--json"])).map(
			(row: { id: string }) => row.id,
		),
	).toEqual([untouched]);
}, 30_000);

// Seam: the data root the script and maestro both open, from the shell and maestro's .env.
async function dotenv(w: Awaited<ReturnType<typeof setup>>, line: string) {
	await mkdir(join(w.env.XDG_CONFIG_HOME, "maestro"), { recursive: true });
	await Bun.write(join(w.env.XDG_CONFIG_HOME, "maestro/.env"), `${line}\n`);
}

test("the old-concert script uses the data home from maestro's .env for both prunes and the snapshot", async () => {
	const w = await setup();
	const data = join(w.root, "dotenv-data");
	await dotenv(w, `XDG_DATA_HOME=${data}`);
	const env = { XDG_DATA_HOME: undefined };
	const id = await w.perform(env);
	snapshot(data, id, null);
	const result = await w.script([id, "--yes"], env);
	expect(result.code).toBe(0);
	const listed = await w.maestro(["ls", "--json"], env);
	expect(listed.code).toBe(0);
	expect(json(listed)).toEqual([]);
}, 30_000);

for (const [name, line] of [
	["spaces and a comment", (d: string) => `XDG_DATA_HOME = ${d} # data`],
	["double quotes", (d: string) => `export XDG_DATA_HOME="${d}" # data`],
	["single quotes", (d: string) => `XDG_DATA_HOME='${d}'`],
] as const) {
	test(`the old-concert script reads a .env data home written with ${name}`, async () => {
		const w = await setup();
		const data = join(w.root, "dotenv data");
		await dotenv(w, line(data));
		const env = { XDG_DATA_HOME: undefined };
		const id = await w.perform(env);
		snapshot(data, id, null);
		const result = await w.script([id, "--yes"], env);
		expect(result.code).toBe(0);
		expect(json(await w.maestro(["ls", "--json"], env))).toEqual([]);
	}, 30_000);
}

test("the old-concert script keeps the shell's data home over the .env", async () => {
	const w = await setup();
	await dotenv(w, `XDG_DATA_HOME=${join(w.root, "elsewhere")}`);
	const id = await w.perform();
	snapshot(w.env.XDG_DATA_HOME, id, null);
	const result = await w.script([id, "--yes"]);
	expect(result.code).toBe(0);
	expect(json(await w.maestro(["ls", "--json"]))).toEqual([]);
}, 30_000);

test("the old-concert script falls back to the home directory for a relative shell data home, whatever the .env says", async () => {
	const w = await setup();
	await dotenv(w, `XDG_DATA_HOME=${join(w.root, "elsewhere")}`);
	const home = join(w.root, "home");
	await mkdir(home);
	const env = { XDG_DATA_HOME: "relative", HOME: home };
	const id = await w.perform(env);
	snapshot(join(home, ".local/share"), id, null);
	const result = await w.script([id, "--yes"], env);
	expect(result.code).toBe(0);
	expect(json(await w.maestro(["ls", "--json"], env))).toEqual([]);
}, 30_000);
