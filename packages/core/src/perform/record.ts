import { Database } from "bun:sqlite";
import type {
	ArtifactRef,
	ConcertEvent,
	Enrichment,
	EventBody,
	Ir,
	NodeInstance,
	Outcome,
} from "@maestro/ir";
import type { ConcertLimits } from "../config";
import type { HostNodeResult, Metrics } from "../host";
import type { Inputs, Outputs } from "../node";
import { instanceKey, isRecord } from "../shared";

/** The `user_version` of a file SQLite just created. */
const NEW_STORE_VERSION = 0;
/** The oldest schema version an upgrade starts from. */
const OLDEST_UPGRADABLE_VERSION = 4;
/**
 * `UPGRADE_STEPS[i]` upgrades a record store from version `OLDEST_UPGRADABLE_VERSION + i` to the next. A step only adds.
 */
const UPGRADE_STEPS = [
	"ALTER TABLE instances ADD COLUMN inputs TEXT",
	`ALTER TABLE concerts ADD COLUMN params TEXT; ALTER TABLE concerts ADD COLUMN encore_of TEXT;
	ALTER TABLE concerts ADD COLUMN fingerprint TEXT`,
	"ALTER TABLE concerts ADD COLUMN limits TEXT",
	"ALTER TABLE concerts ADD COLUMN disk_use INTEGER",
];
/** The version of the schema below, kept in SQLite's `user_version`. */
const SCHEMA_VERSION = OLDEST_UPGRADABLE_VERSION + UPGRADE_STEPS.length;
/** How long a write waits for another connection's lock before it fails, in milliseconds. */
const BUSY_TIMEOUT_MS = 5000;
/** How long opening retries switching a new file to WAL mode while another connection holds it, in milliseconds. */
const WAL_RETRY_MS = 5000;
/** The pause between those retries, in milliseconds. */
const WAL_RETRY_PAUSE_MS = 10;
/** SQLite's `LIMIT` for no limit. */
const NO_LIMIT = -1;
/** The tables with a row per concert, keyed by `concert`. */
const CONCERT_TABLES = [
	"instances",
	"metrics",
	"earlier_metrics",
	"artifacts",
	"events",
];
/** How often `wait` reads a concert's status, in milliseconds. */
const WAIT_POLL_MS = 50;
/** The reason a reader settles a concert, and its running instances, with when the process performing it is gone. */
export const PROCESS_EXITED = "process exited";
/** The reason `finish` settles an instance still running with. */
export const CONCERT_FINISHED = "the concert finished before it settled";

// Timestamps are epoch milliseconds, and `expansion` is '' outside groups. `ir`, `outputs`, `inputs`, `enrichment`,
// `body` and a concert's `config` hold JSON. `inputs` is a leaf instance's wired input ports: each port the node does
// not hold in `literals`, with its resolved value (a fan-out item, a loop round's carried value, a collected input), an
// artifact as its reference and never its content. A leaf with no wired ports keeps `{}`; NULL means not recorded: an
// instance recorded before the upgrade, and every group, loop and scope row. A resume that reuses an instance keeps its
// row. Literals stay readable through the IR and `art`.
// `workspace` is '' outside any workspace, and `module_dir` is '' when the concert has none. `reason` is set on every
// non-ok outcome. `result_node` is NULL while a concert is running, and after one that failed before any node ran.
// `key` is the resume key of an `ok` instance. `stale` marks an instance row left by an earlier attempt, which a resume
// reuses or replaces. `earlier_metrics` holds the metrics of the attempts a resume replaced, which still count as
// spend. A concert's `profile` holds the names of the presets it was performed with (a JSON list, or one bare name in a
// row written before presets repeated), `params` its root params as given (JSON), `encore_of` the concert it is an
// encore of, `fingerprint` the digest `begin` was given, and `limits` the ceiling of its latest attempt (JSON), NULL
// when it had none. `disk_use` is the bytes the concert holds on disk, measured when it settles, NULL until then.
const SCHEMA = `
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
	config TEXT,
	params TEXT,
	encore_of TEXT,
	fingerprint TEXT,
	limits TEXT,
	disk_use INTEGER
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
	inputs TEXT,
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

/** A concert is `running` until it settles with its result's outcome. */
export type ConcertStatus = "running" | Exclude<Outcome, "skipped">;

/**
 * What a concert row keeps beside its IR. `moduleDir` is the directory its worker references' modules are found in,
 * and `file` the composition file in it that the IR was built from, when it was built from a bare file. `presets` and
 * `config` are each preset name and each config override, as given and in order, it was performed with, and `params`
 * its root composition's params as given, by name.
 */
export type ConcertOrigin = {
	workspace: string;
	moduleDir: string;
	file?: string;
	tour?: string;
	title?: string;
	presets?: readonly string[];
	config?: readonly string[];
	params?: Readonly<Record<string, unknown>>;
};

/** Timestamps are milliseconds since the Unix epoch. `pid` is the process performing the concert. */
export type ConcertRecord = ConcertOrigin & {
	id: string;
	/** The concert this one is an encore of. */
	encoreOf?: string;
	/** The ceiling of its latest attempt, left out when it had none. */
	limits?: ConcertLimits;
	composition: string;
	pack: string;
	ir: Ir;
	pid: number;
	status: ConcertStatus;
	startedAt: number;
	settledAt?: number;
	/** The bytes it holds on disk, as last measured, left out when it was never measured. */
	diskUse?: number;
};

/**
 * `limit` is a positive integer. `tour` matches that tour and every tour under it on a dot boundary: `epic` matches
 * `epic` and `epic.story`, not `epic-x`.
 */
export type ConcertFilter = {
	status?: ConcertStatus;
	pack?: string;
	composition?: string;
	tour?: string;
	workspace?: string;
	limit?: number;
};

/** Decides whether the process `pid`, which a concert's row names, is still performing it. */
export type Alive = (pid: number) => boolean;

/**
 * A concert's result (architecture 7): the returned node when it is `ok`, else the root cause of its outcome, where
 * a cause skipped by its own guard counts as rejected. A concert that failed before any node ran, was cancelled, or
 * whose process exited has no node. A rejected result carries its root cause's rejection outputs, when it has any.
 */
export type ConcertResult =
	| (NodeInstance & { outcome: "ok"; outputs: Outputs })
	| (Partial<NodeInstance> & {
			outcome: "rejected" | "failed";
			reason: string;
			outputs?: Outputs;
	  });

/**
 * An instance without `startedAt` never started. `key` is the resume key of an `ok` instance. `stale` marks a record
 * left by an earlier attempt, which the current one has neither reused nor replaced. `artifacts` are the files it
 * wrote, as moved into the area.
 */
export type InstanceRecord = NodeInstance & {
	status: "running" | Outcome;
	reason?: string;
	outputs?: Outputs;
	/** The values a leaf was fed on its wired ports, left out when not recorded. */
	inputs?: Inputs;
	enrichment?: Enrichment;
	key?: string;
	stale: boolean;
	startedAt?: number;
	settledAt?: number;
	metrics: Metrics;
	artifacts: ArtifactRef[];
};

/** How an instance settled, with what the record keeps beside its outcome. */
export type Settling = (
	| HostNodeResult
	| (Omit<HostNodeResult, "outcome" | "reason"> & {
			outcome: "skipped";
			reason: string;
	  })
) & {
	artifacts?: readonly ArtifactRef[];
	/** The resume key, kept for an `ok` instance. */
	key?: string;
};

/** An instance's node and enrichment, by concert. */
export type EnrichedInstance = {
	concert: string;
	node: string;
	enrichment: Enrichment;
};

/** The record outside a concert's attempt: its reads, and the operator's bookkeeping (tour, remove). */
export interface Records {
	/** The concert, or `undefined` for an id the record does not hold. */
	find(concert: string): ConcertRecord | undefined;
	/** The id of every concert in the record, oldest first. */
	ids(): string[];
	/** Concerts matching every field of `filter`, newest first. */
	concerts(filter?: ConcertFilter): ConcertRecord[];
	/** Puts the concert on `tour`, or takes it off with `undefined`. */
	setTour(concert: string, tour: string | undefined): void;
	/** Keeps `bytes` as the disk the concert holds. */
	setDiskUse(concert: string, bytes: number): void;
	/**
	 * Deletes the concert's rows: the concert, its instances, metrics, artifact references and events.
	 * @throws Error when the concert is running.
	 */
	remove(concert: string): void;
	/** A concert's node instances, in the order they started or settled without starting, read as one snapshot. */
	instances(concert: string): InstanceRecord[];
	/** The node and enrichment of each current instance of `concerts` that has an enrichment, read in one query. */
	enrichments(concerts: readonly string[]): EnrichedInstance[];
	/** The concert's result, `undefined` while it is running. */
	result(concert: string): ConcertResult | undefined;
	/** The concert's events after the cursor `after`, oldest first. */
	events(concert: string, after?: number): ConcertEvent[];
	/** The concert's metrics, each name summed over its instances and over the attempts a resume replaced (CORE-19). */
	metrics(concert: string): Metrics;
	/** The concert once it settles, or `undefined` when `timeoutMs` passes first. Another process may be performing it. */
	wait(concert: string, timeoutMs?: number): Promise<ConcertRecord | undefined>;
	close(): void;
}

/** The writes of the process performing a concert. Every write throws on an unknown concert id. */
export interface RecordWriter {
	/**
	 * Records a new concert as `running`, performed by this process. `workspace` and `moduleDir` default to ''.
	 * `fingerprint` is a digest of what it is performed from, which an encore of it must not repeat.
	 * @throws Unencorable when a concert in the encore chain of `encoreOf` is running, the chain being the root reached
	 * by following `encoreOf` and every concert that reaches it, or when `encoreOf` was recorded with `fingerprint`.
	 * @throws Error when `encoreOf` names no concert.
	 */
	begin(
		concert: { id: string; ir: Ir; startedAt: number } & Partial<
			ConcertOrigin & {
				encoreOf: string;
				fingerprint: string;
				limits: ConcertLimits;
			}
		>,
	): void;
	/**
	 * Restarts a concert that failed or was rejected as `running`, performed by this process, with `ir` as its stored IR
	 * and `limits` as its ceiling. Its instance records and events stay. `reuse`, `start` and `settle` take over each
	 * instance record from before.
	 * @returns the concert, and its instance records from before.
	 * @throws Unresumable when the concert is running, as its process is alive, or settled `ok`.
	 */
	resume(concert: { id: string; ir: Ir; limits?: ConcertLimits }): {
		concert: ConcertRecord;
		instances: InstanceRecord[];
	};
	/**
	 * Records that `instance` started, with its `running` event. A record from before a resume is replaced, its events
	 * kept. `inputs` are a leaf's wired inputs, kept as given.
	 * @throws Error when the concert has settled or the instance has a record.
	 */
	start(
		concert: string,
		instance: NodeInstance,
		at: number,
		inputs?: Inputs,
	): void;
	/**
	 * Keeps `instance`'s `ok` record from before a resume, with a `reused` event.
	 * @throws Error when the concert has settled or the instance has no `ok` record from before.
	 */
	reuse(concert: string, instance: NodeInstance, at: number): void;
	/**
	 * Records how `instance` settled, with its `settled` event. A record from before a resume is replaced, its events
	 * kept.
	 * @throws Error when the concert or the instance has settled.
	 */
	settle(
		concert: string,
		instance: NodeInstance,
		settling: Settling,
		at: number,
	): void;
	/**
	 * Appends a progress or log event of `instance`.
	 * @throws Error when the instance is not running.
	 */
	note(
		concert: string,
		instance: NodeInstance,
		body: Extract<EventBody, { type: "progress" | "log" }>,
		at: number,
	): void;
	/**
	 * Records the concert's result, which settles it with the result's outcome. An instance still running settles
	 * `failed` with `CONCERT_FINISHED`.
	 */
	finish(concert: string, result: ConcertResult, at: number): void;
	/** Keeps `bytes` as the disk the concert holds, as `Records.setDiskUse` does. */
	setDiskUse(concert: string, bytes: number): void;
	/** The concert's metrics, as `Records.metrics` sums them. */
	metrics(concert: string): Metrics;
	close(): void;
}

type ConcertRow = {
	id: string;
	composition: string;
	pack: string;
	ir: string;
	pid: number;
	status: ConcertStatus;
	started_at: number;
	settled_at: number | null;
	result_node: string | null;
	result_expansion: string | null;
	reason: string | null;
	workspace: string;
	tour: string | null;
	title: string | null;
	module_dir: string;
	file: string | null;
	profile: string | null;
	config: string | null;
	params: string | null;
	encore_of: string | null;
	fingerprint: string | null;
	limits: string | null;
	disk_use: number | null;
};

type InstanceStatus = InstanceRecord["status"];

type InstanceRow = {
	node: string;
	expansion: string;
	status: InstanceStatus;
	reason: string | null;
	outputs: string | null;
	inputs: string | null;
	enrichment: string | null;
	started_at: number | null;
	settled_at: number | null;
	key: string | null;
	stale: number;
};

type EventRow = {
	seq: number;
	node: string;
	expansion: string;
	at: number;
	body: string;
};

const json = (value: unknown) =>
	value === undefined ? null : JSON.stringify(value);

// The record is maestro's own data, under the schema version checked on open.
const parsed = <T>(text: string | null): T | undefined =>
	text === null ? undefined : JSON.parse(text);

const unknownConcert = (id: string) =>
	new Error(`no concert '${id}' in the record. Check the concert id`);

type Options = { alive?: Alive };

function openDatabase(path: string): Database {
	const db = new Database(path, { create: true, strict: true });
	try {
		db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		walMode(db);
		migrate(db, path);
	} catch (error) {
		db.close();
		throw error;
	}
	return db;
}

/**
 * Opens the record at `path` for reading, creating it with the current schema when it is new. WAL mode lets several
 * concerts, in this process or others, share the file (D-26). `alive` decides whether a running concert's process is
 * still performing it, by default whether the process exists. An older record store is upgraded first.
 * @throws Error when the file holds a schema version this maestro neither reads nor upgrades.
 */
export function openRecord(
	path: string,
	{ alive = processExists }: Options = {},
): Records {
	const db = openDatabase(path);
	return readerOf(db, lookupOf(db, alive));
}

/**
 * Opens the record at `path` for the writes of the process performing a concert, as `openRecord` opens it for reading.
 * @throws Error when the file holds a schema version this maestro neither reads nor upgrades.
 */
export function openWriter(path: string): RecordWriter {
	const db = openDatabase(path);
	return writerOf(db, lookupOf(db, processExists));
}

/** Switches to WAL mode, retrying while another connection holds the file, which `busy_timeout` does not cover. */
function walMode(db: Database): void {
	const deadline = Date.now() + WAL_RETRY_MS;
	for (;;) {
		try {
			db.exec("PRAGMA journal_mode = WAL");
			return;
		} catch (error) {
			const busy = isRecord(error) && error.code === "SQLITE_BUSY";
			if (!busy || Date.now() >= deadline) throw error;
			Bun.sleepSync(WAL_RETRY_PAUSE_MS);
		}
	}
}

/**
 * Wraps `fn` in a transaction that takes the write lock at its start, where `busy_timeout` waits for another writer.
 * A deferred one that reads before it writes fails at once when another writer commits between the two.
 */
const writing = <A extends unknown[], T>(
	db: Database,
	fn: (...args: A) => T,
): ((...args: A) => T) => db.transaction(fn).immediate;

/**
 * The SQL that brings a store at `version` to `SCHEMA_VERSION`: a new store's schema, else each step from `version`.
 * @throws Error when `version` is newer than `SCHEMA_VERSION`, or older than the first step.
 */
function upgradeFrom(version: number, path: string): string[] {
	if (version === NEW_STORE_VERSION) return [SCHEMA];
	if (version < OLDEST_UPGRADABLE_VERSION || version > SCHEMA_VERSION)
		throw new Error(
			`record store '${path}' has schema version ${version}, and this maestro reads version ${SCHEMA_VERSION}. Use a record store this maestro made, or move '${path}' aside`,
		);
	return UPGRADE_STEPS.slice(version - OLDEST_UPGRADABLE_VERSION);
}

/** Brings the store to `SCHEMA_VERSION` in one transaction, so a failing step leaves it at its version. */
function migrate(db: Database, path: string): void {
	writing(db, () => {
		const version =
			db.query<{ user_version: number }, []>("PRAGMA user_version").get()
				?.user_version ?? NEW_STORE_VERSION;
		if (version === SCHEMA_VERSION) return;
		for (const sql of upgradeFrom(version, path)) db.exec(sql);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	})();
}

/** Whether the process `pid` exists. One owned by another user exists too. */
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
}

function insertEvent(
	db: Database,
	concert: string,
	{ node, expansion }: NodeInstance,
	body: EventBody,
	at: number,
) {
	db.exec(
		"INSERT INTO events (concert, node, expansion, at, body) VALUES (?, ?, ?, ?, ?)",
		[concert, node, expansion, at, JSON.stringify(body)],
	);
}

function settleRow(
	db: Database,
	id: string,
	instance: NodeInstance,
	s: Settling,
	at: number,
) {
	db.exec(
		`INSERT INTO instances (concert, node, expansion, status, reason, outputs, enrichment, settled_at, key)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (concert, node, expansion) DO UPDATE SET status = excluded.status, reason = excluded.reason,
		outputs = excluded.outputs, enrichment = excluded.enrichment, settled_at = excluded.settled_at,
		key = excluded.key`,
		[
			id,
			instance.node,
			instance.expansion,
			s.outcome,
			s.outcome === "ok" ? null : s.reason,
			json(s.outputs),
			json(s.enrichment),
			at,
			s.outcome === "ok" ? (s.key ?? null) : null,
		],
	);
	const reason = s.outcome === "ok" ? undefined : s.reason;
	const { outcome, enrichment } = s;
	insertEvent(
		db,
		id,
		instance,
		{ type: "settled", outcome, reason, enrichment },
		at,
	);
}

/** Settles a `running` concert whose process is gone, with its running instances. A second call does nothing. */
/**
 * Keeps `bytes` as the disk concert `id` holds.
 * @throws Error when the record holds no concert `id`.
 */
function setDiskUse(db: Database, id: string, bytes: number) {
	const updated = db
		.query<{ id: string }, [number, string]>(
			"UPDATE concerts SET disk_use = ? WHERE id = ? RETURNING id",
		)
		.get(bytes, id);
	if (!updated) throw unknownConcert(id);
}

function settleRunning(db: Database, id: string, reason: string, at: number) {
	const running = db
		.query<NodeInstance, [string]>(
			"SELECT node, expansion FROM instances WHERE concert = ? AND status = 'running'",
		)
		.all(id);
	for (const instance of running)
		settleRow(db, id, instance, { outcome: "failed", reason }, at);
}

/** Finds a concert's row, settling a `running` one whose process is gone. */
type Lookup = {
	rowIf(id: string): ConcertRow | undefined;
	rowOf(id: string): ConcertRow;
	/** Whether `row` was `running` with its process gone, so it is now settled. */
	reaped(row: ConcertRow): boolean;
};

function lookupOf(db: Database, alive: Alive): Lookup {
	const reap = writing(db, (id: string) => {
		const at = Date.now();
		settleRunning(db, id, PROCESS_EXITED, at);
		db.exec(
			"UPDATE concerts SET status = 'failed', settled_at = ?, reason = ? WHERE id = ? AND status = 'running'",
			[at, PROCESS_EXITED, id],
		);
	});

	const reaped = (row: ConcertRow) => {
		if (row.status !== "running" || alive(row.pid)) return false;
		reap(row.id);
		return true;
	};

	const rowIf = (id: string): ConcertRow | undefined => {
		const query = db.query<ConcertRow, [string]>(
			"SELECT * FROM concerts WHERE id = ?",
		);
		const row = query.get(id);
		return row && reaped(row) ? (query.get(id) ?? row) : (row ?? undefined);
	};

	const rowOf = (id: string): ConcertRow => {
		const row = rowIf(id);
		if (!row) throw unknownConcert(id);
		return row;
	};

	return { rowIf, rowOf, reaped };
}

function readerOf(db: Database, look: Lookup): Records {
	const { rowIf, rowOf, reaped } = look;
	const concert = (id: string) => concertOf(rowOf(id));

	return {
		find: (id) => {
			const row = rowIf(id);
			return row && concertOf(row);
		},
		ids: () =>
			db
				.query<{ id: string }, []>(
					"SELECT id FROM concerts ORDER BY started_at, id",
				)
				.all()
				.map((row) => row.id),
		concerts(filter = {}) {
			for (const row of db
				.query<ConcertRow, []>(
					"SELECT * FROM concerts WHERE status = 'running'",
				)
				.all())
				reaped(row);
			return db
				.query<ConcertRow, (string | number | null)[]>(
					`SELECT * FROM concerts WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR composition = ?2)
					AND (?3 IS NULL OR tour = ?3 OR substr(tour, 1, length(?3) + 1) = ?3 || '.') AND (?4 IS NULL OR workspace = ?4) AND (?5 IS NULL OR pack = ?5)
					ORDER BY started_at DESC, id DESC LIMIT ?6`,
				)
				.all(
					filter.status ?? null,
					filter.composition ?? null,
					filter.tour ?? null,
					filter.workspace ?? null,
					filter.pack ?? null,
					filter.limit ?? NO_LIMIT,
				)
				.map(concertOf);
		},
		setTour(id, tour) {
			rowOf(id);
			db.exec("UPDATE concerts SET tour = ? WHERE id = ?", [tour ?? null, id]);
		},
		setDiskUse: (id, bytes) => setDiskUse(db, id, bytes),
		remove: writing(db, (id: string) => {
			const row = rowOf(id);
			if (row.status === "running")
				throw new Error(
					`concert '${id}' is still running in process ${row.pid}, so it cannot be removed. Wait for it to settle, or kill it, then remove it`,
				);
			for (const table of CONCERT_TABLES)
				db.exec(`DELETE FROM ${table} WHERE concert = ?`, [id]);
			db.exec("DELETE FROM concerts WHERE id = ?", [id]);
		}),
		instances(id) {
			rowOf(id);
			return db.transaction(() => instancesOf(db, id))();
		},
		enrichments: (ids) =>
			db
				.query<{ concert: string; node: string; enrichment: string }, [string]>(
					`SELECT concert, node, enrichment FROM instances
					WHERE stale = 0 AND enrichment IS NOT NULL AND concert IN (SELECT value FROM json_each(?))`,
				)
				.all(JSON.stringify(ids))
				.map((row) => ({ ...row, enrichment: JSON.parse(row.enrichment) })),
		result(id) {
			const row = rowOf(id);
			if (row.status === "running") return undefined;
			const instance = {
				node: row.result_node ?? "",
				expansion: row.result_expansion ?? "",
			};
			const stored = db
				.query<{ outputs: string | null }, [string, string, string]>(
					"SELECT outputs FROM instances WHERE concert = ? AND node = ? AND expansion = ?",
				)
				.get(id, instance.node, instance.expansion)?.outputs;
			const outputs = parsed<Outputs>(stored ?? null);
			if (row.status === "ok")
				return { ...instance, outcome: "ok", outputs: outputs ?? {} };
			return failure(row, row.status, outputs);
		},
		events(id, after = 0) {
			rowOf(id);
			return db
				.query<EventRow, [string, number]>(
					"SELECT seq, node, expansion, at, body FROM events WHERE concert = ? AND seq > ? ORDER BY seq",
				)
				.all(id, after)
				.map(({ body, ...row }) => {
					const said: EventBody = JSON.parse(body);
					return { ...row, ...said };
				});
		},
		metrics(id) {
			rowOf(id);
			return metricsOf(db, id);
		},
		async wait(id, timeoutMs = Number.POSITIVE_INFINITY) {
			const deadline = Date.now() + timeoutMs;
			let found = concert(id);
			while (found.status === "running" && Date.now() < deadline) {
				await Bun.sleep(Math.min(WAIT_POLL_MS, deadline - Date.now()));
				found = concert(id);
			}
			return found.status === "running" ? undefined : found;
		},
		close: () => db.close(),
	};
}

function writerOf(db: Database, look: Lookup): RecordWriter {
	/** Refuses a write unless the concert is running and `instance`'s status is one of `allowed`, `null` for no record. */
	const writable = (
		id: string,
		{ node, expansion }: NodeInstance,
		allowed: readonly (InstanceStatus | null)[],
	) => {
		const row = db
			.query<
				{ concert: ConcertStatus; instance: InstanceStatus | null },
				[string, string, string]
			>(
				`SELECT c.status AS concert, i.status AS instance FROM concerts c
				LEFT JOIN instances i ON i.concert = c.id AND i.node = ?1 AND i.expansion = ?2 WHERE c.id = ?3`,
			)
			.get(node, expansion, id);
		if (!row) throw unknownConcert(id);
		if (row.concert !== "running")
			throw new Error(
				`concert '${id}' has settled, so it takes no more writes`,
			);
		if (!allowed.includes(row.instance))
			throw new Error(
				`'${node}${expansion}' of concert '${id}' is ${row.instance ?? "not recorded"}, so it takes no such write`,
			);
	};

	/** Drops what a resume left of `instance` from before, so the write that follows replaces it. */
	const replaceStale = (id: string, { node, expansion }: NodeInstance) => {
		const where = "WHERE concert = ? AND node = ? AND expansion = ?";
		const { changes } = db.exec(
			`DELETE FROM instances ${where} AND stale = 1`,
			[id, node, expansion],
		);
		if (changes === 0) return;
		db.exec(
			`INSERT INTO earlier_metrics (concert, name, value) SELECT concert, name, value FROM metrics ${where}`,
			[id, node, expansion],
		);
		db.exec(`DELETE FROM metrics ${where}`, [id, node, expansion]);
		db.exec(`DELETE FROM artifacts ${where}`, [id, node, expansion]);
	};

	const restart = writing(db, (id: string, ir: Ir, limits?: ConcertLimits) => {
		const refused = unresumable(concertOf(look.rowOf(id)));
		if (refused) throw refused;
		db.exec(
			`UPDATE concerts SET ir = ?, pid = ?, status = 'running', settled_at = NULL, result_node = NULL,
			result_expansion = NULL, reason = NULL, limits = ? WHERE id = ?`,
			[JSON.stringify(ir), process.pid, limitsColumn(limits), id],
		);
		db.exec("UPDATE instances SET stale = 1 WHERE concert = ?", [id]);
		return {
			concert: concertOf(look.rowOf(id)),
			instances: instancesOf(db, id),
		};
	});

	/** The refusal for the first concert in the encore chain of `id` that is running with its process alive. */
	const chainRunning = (id: string): Unencorable | undefined => {
		const running = db
			.query<ConcertRow, [string]>(
				`WITH RECURSIVE up(id, parent) AS (
					SELECT id, encore_of FROM concerts WHERE id = ?
					UNION ALL SELECT c.id, c.encore_of FROM concerts c JOIN up ON c.id = up.parent
				), chain(id) AS (
					SELECT id FROM up WHERE parent IS NULL OR parent NOT IN (SELECT id FROM concerts)
					UNION SELECT c.id FROM concerts c JOIN chain ON c.encore_of = chain.id
				) SELECT * FROM concerts WHERE id IN (SELECT id FROM chain) AND status = 'running' ORDER BY started_at`,
			)
			.all(id)
			.find((row) => !look.reaped(row));
		return (
			running &&
			new Unencorable(
				{ id: running.id, status: running.status, pid: running.pid },
				id,
			)
		);
	};

	const begin: RecordWriter["begin"] = (concert) => {
		const { encoreOf, fingerprint } = concert;
		const refused =
			encoreOf === undefined
				? undefined
				: (chainRunning(encoreOf) ??
					unencorable(look.rowOf(encoreOf), fingerprint));
		if (refused) throw refused;
		db.exec(
			`INSERT INTO concerts (id, composition, pack, ir, pid, status, started_at, workspace, tour, title, module_dir,
			file, profile, config, params, encore_of, fingerprint, limits)
			VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			beginRow(concert),
		);
	};

	return {
		begin: writing(db, begin),
		resume: ({ id, ir, limits }) => restart(id, ir, limits),
		metrics: (id) => metricsOf(db, id),
		start: writing(
			db,
			(id: string, instance: NodeInstance, at: number, inputs?: Inputs) => {
				replaceStale(id, instance);
				writable(id, instance, [null]);
				db.exec(
					"INSERT INTO instances (concert, node, expansion, status, inputs, started_at) VALUES (?, ?, ?, 'running', ?, ?)",
					[id, instance.node, instance.expansion, json(inputs), at],
				);
				insertEvent(db, id, instance, { type: "running" }, at);
			},
		),
		reuse: writing(db, (id: string, instance: NodeInstance, at: number) => {
			writable(id, instance, ["ok"]);
			const { changes } = db.exec(
				"UPDATE instances SET stale = 0 WHERE concert = ? AND node = ? AND expansion = ? AND stale = 1",
				[id, instance.node, instance.expansion],
			);
			if (changes === 0)
				throw new Error(
					`'${instance.node}${instance.expansion}' of concert '${id}' has no ok record from before the resume, so it cannot be reused`,
				);
			insertEvent(db, id, instance, { type: "reused" }, at);
		}),
		settle: writing(
			db,
			(id: string, instance: NodeInstance, s: Settling, at: number) => {
				replaceStale(id, instance);
				writable(id, instance, [null, "running"]);
				settleRow(db, id, instance, s, at);
				for (const [name, value] of Object.entries(s.metrics ?? {}))
					db.exec(
						"INSERT INTO metrics (concert, node, expansion, name, value) VALUES (?, ?, ?, ?, ?)",
						[id, instance.node, instance.expansion, name, value],
					);
				for (const ref of s.artifacts ?? [])
					db.exec(
						"INSERT INTO artifacts (concert, path, content_hash, node, expansion) VALUES (?, ?, ?, ?, ?)",
						[id, ref.path, ref.contentHash, instance.node, instance.expansion],
					);
			},
		),
		note: writing(
			db,
			(id: string, instance: NodeInstance, body: EventBody, at: number) => {
				writable(id, instance, ["running"]);
				insertEvent(db, id, instance, body, at);
			},
		),
		finish: writing(db, (id: string, result: ConcertResult, at: number) => {
			settleRunning(db, id, CONCERT_FINISHED, at);
			db.exec(
				"UPDATE concerts SET status = ?, settled_at = ?, result_node = ?, result_expansion = ?, reason = ? WHERE id = ?",
				[
					result.outcome,
					at,
					result.node ?? null,
					result.expansion ?? null,
					result.outcome === "ok" ? null : result.reason,
					id,
				],
			);
		}),
		setDiskUse: (id, bytes) => setDiskUse(db, id, bytes),
		close: () => db.close(),
	};
}

/** The refusal to resume a concert that is still running, or that settled `ok` and so has nothing to resume. */
export class Unresumable extends Error {
	override readonly name = "Unresumable";
	readonly concert: { id: string; status: "running" | "ok"; pid: number };

	constructor(concert: Unresumable["concert"]) {
		const { id, status, pid } = concert;
		super(
			status === "running"
				? `concert '${id}' is still running in process ${pid}\nWait for it to settle, or kill it, then resume it`
				: `concert '${id}' finished ok, so it has nothing to resume\nPerform its composition as a new concert`,
		);
		this.concert = concert;
	}
}

/**
 * The refusal of an encore: a running concert in the encore chain of `of`, or the concert itself when `of` is omitted or
 * is that concert, or a concert whose fingerprint the encore repeats.
 */
export class Unencorable extends Error {
	override readonly name = "Unencorable";
	readonly concert: { id: string; pid: number; status: ConcertStatus };

	constructor(concert: Unencorable["concert"], of?: string) {
		const { id, status, pid } = concert;
		const fix = "Wait for it to settle, or kill it, then perform its encore";
		const running =
			of === undefined || of === id
				? `concert '${id}' is still running in process ${pid}`
				: `concert '${id}' in the encore chain of '${of}' is still running in process ${pid}`;
		super(
			status === "running"
				? `${running}\n${fix}`
				: `concert '${id}' was performed from the same IR, config and host facts\nChange one of them${status === "ok" ? "" : ", or resume it"}`,
		);
		this.concert = concert;
	}
}

/** The `concerts` row `begin` inserts, in its column order. */
function beginRow(concert: Parameters<RecordWriter["begin"]>[0]) {
	const { id, ir } = concert;
	return [
		id,
		ir.composition.id,
		ir.composition.pack,
		JSON.stringify(ir),
		process.pid,
		concert.startedAt,
		concert.workspace ?? "",
		concert.tour ?? null,
		concert.title ?? null,
		concert.moduleDir ?? "",
		concert.file ?? null,
		concert.presets?.length ? JSON.stringify(concert.presets) : null,
		concert.config?.length ? JSON.stringify(concert.config) : null,
		json(concert.params),
		concert.encoreOf ?? null,
		concert.fingerprint ?? null,
		limitsColumn(concert.limits),
	];
}

/** `limits` as the `limits` column holds them: JSON, or NULL when none is set. */
const limitsColumn = (limits: ConcertLimits | undefined) =>
	limits && Object.keys(limits).length > 0 ? JSON.stringify(limits) : null;

/** The refusal of an encore of `row` with `fingerprint`, when `row` was recorded with the same one. */
function unencorable(
	row: ConcertRow,
	fingerprint: string | undefined,
): Unencorable | undefined {
	const { id, status, pid } = row;
	return fingerprint !== undefined && row.fingerprint === fingerprint
		? new Unencorable({ id, status, pid })
		: undefined;
}

/** The refusal to resume `concert`, unless it failed or was rejected. */
export function unresumable({
	id,
	status,
	pid,
}: ConcertRecord): Unresumable | undefined {
	return status === "running" || status === "ok"
		? new Unresumable({ id, status, pid })
		: undefined;
}

/** The preset names a `profile` column holds: its JSON list, or the one bare name a row written before it held. */
function presetsOf(profile: string): string[] {
	try {
		const names: unknown = JSON.parse(profile);
		if (Array.isArray(names) && names.every((n) => typeof n === "string"))
			return names;
	} catch {}
	return [profile];
}

function concertOf(row: ConcertRow): ConcertRecord {
	return {
		id: row.id,
		composition: row.composition,
		pack: row.pack,
		ir: JSON.parse(row.ir),
		pid: row.pid,
		status: row.status,
		startedAt: row.started_at,
		workspace: row.workspace,
		moduleDir: row.module_dir,
		...(row.file !== null && { file: row.file }),
		...(row.settled_at !== null && { settledAt: row.settled_at }),
		...(row.tour !== null && { tour: row.tour }),
		...(row.title !== null && { title: row.title }),
		...(row.profile !== null && { presets: presetsOf(row.profile) }),
		...(row.config !== null && { config: JSON.parse(row.config) }),
		...(row.params !== null && { params: JSON.parse(row.params) }),
		...(row.encore_of !== null && { encoreOf: row.encore_of }),
		...(row.limits !== null && { limits: JSON.parse(row.limits) }),
		...(row.disk_use !== null && { diskUse: row.disk_use }),
	};
}

/** The result of a concert that settled other than `ok`, with `outputs` when it was rejected. */
function failure(
	row: ConcertRow,
	outcome: "rejected" | "failed",
	outputs: Outputs | undefined,
): ConcertResult {
	const node = row.result_node;
	const reason = row.reason ?? "";
	if (node === null) return { outcome, reason };
	const expansion = row.result_expansion ?? "";
	const carried = outcome === "rejected" && outputs !== undefined;
	return { node, expansion, outcome, reason, ...(carried && { outputs }) };
}

/** Each metric of `concert` summed over its instances and over the attempts a resume replaced. */
function metricsOf(db: Database, concert: string): Metrics {
	const rows = db
		.query<{ name: string; total: number }, [string]>(
			`SELECT name, SUM(value) AS total FROM (
				SELECT name, value FROM metrics WHERE concert = ?1
				UNION ALL SELECT name, value FROM earlier_metrics WHERE concert = ?1
			) GROUP BY name ORDER BY name`,
		)
		.all(concert);
	return Object.fromEntries(rows.map((r) => [r.name, r.total]));
}

function instancesOf(db: Database, concert: string): InstanceRecord[] {
	const metrics = new Map<string, Record<string, number>>();
	for (const m of db
		.query<
			{ node: string; expansion: string; name: string; value: number },
			[string]
		>("SELECT node, expansion, name, value FROM metrics WHERE concert = ?")
		.all(concert)) {
		const key = instanceKey(m);
		metrics.set(key, { ...metrics.get(key), [m.name]: m.value });
	}
	const artifacts = Map.groupBy(
		db
			.query<
				{ node: string; expansion: string; path: string; content_hash: string },
				[string]
			>(
				"SELECT node, expansion, path, content_hash FROM artifacts WHERE concert = ? ORDER BY rowid",
			)
			.all(concert),
		instanceKey,
	);
	return db
		.query<InstanceRow, [string]>(
			"SELECT * FROM instances WHERE concert = ? ORDER BY rowid",
		)
		.all(concert)
		.map((row) => {
			const key = instanceKey(row);
			return {
				...instanceOf(row),
				metrics: metrics.get(key) ?? {},
				artifacts: (artifacts.get(key) ?? []).map((a) => ({
					path: a.path,
					contentHash: a.content_hash,
					producer: { node: a.node, expansion: a.expansion },
				})),
			};
		});
}

function instanceOf(
	row: InstanceRow,
): Omit<InstanceRecord, "metrics" | "artifacts"> {
	const outputs = parsed<Outputs>(row.outputs);
	const inputs = parsed<Inputs>(row.inputs);
	const enrichment = parsed<Enrichment>(row.enrichment);
	return {
		node: row.node,
		expansion: row.expansion,
		status: row.status,
		...(row.reason !== null && { reason: row.reason }),
		...(outputs !== undefined && { outputs }),
		...(inputs !== undefined && { inputs }),
		...(enrichment !== undefined && { enrichment }),
		...(row.key !== null && { key: row.key }),
		stale: row.stale === 1,
		...(row.started_at !== null && { startedAt: row.started_at }),
		...(row.settled_at !== null && { settledAt: row.settled_at }),
	};
}
