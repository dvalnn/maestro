import { Database } from "bun:sqlite";
import type { ArtifactRef, Ir, Outcome } from "@maestro/ir";
import type { Enrichment, HostEvent, Metrics } from "../host";
import { instanceKey, isRecord } from "../shared";
import type { NodeInstance, Outputs } from "../worker";

/** The version of the schema below, kept in SQLite's `user_version`. */
const SCHEMA_VERSION = 2;
/** How long a write waits for another connection's lock before it fails, in milliseconds. */
const BUSY_TIMEOUT_MS = 5000;
/** How long opening retries switching a new file to WAL mode while another connection holds it, in milliseconds. */
const WAL_RETRY_MS = 5000;
/** The pause between those retries, in milliseconds. */
const WAL_RETRY_PAUSE_MS = 10;
/** How often `wait` reads a concert's status, in milliseconds. */
const WAIT_POLL_MS = 50;
/** The reason a reader settles a concert, and its running instances, with when the process performing it is gone. */
export const PROCESS_EXITED = "process exited";
/** The reason `finish` settles an instance still running with. */
export const CONCERT_FINISHED = "the concert finished before it settled";

// Timestamps are epoch milliseconds, and `expansion` is '' outside groups. `ir`, `outputs`, `enrichment` and `body`
// hold JSON. `reason` is set on every non-ok outcome. `result_node` is NULL while a concert is running, and after one
// that failed before any node ran. `key` is the resume key of an `ok` instance. `stale` marks an instance row left by
// an earlier attempt, which a resume reuses or replaces. `earlier_metrics` holds the metrics of the attempts a resume
// replaced, which still count as spend.
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
	reason TEXT
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

/** A concert is `running` until it settles with its result's outcome. */
export type ConcertStatus = "running" | Exclude<Outcome, "skipped">;

/** Timestamps are milliseconds since the Unix epoch. `pid` is the process performing the concert. */
export type ConcertRecord = {
	id: string;
	composition: string;
	pack: string;
	ir: Ir;
	pid: number;
	status: ConcertStatus;
	startedAt: number;
	settledAt?: number;
};

export type ConcertFilter = { status?: ConcertStatus; composition?: string };

/**
 * A concert's result (architecture 7): the returned node when it is `ok`, else the root cause of its outcome, where
 * a cause skipped by its own guard counts as rejected. A concert that failed before any node ran, was cancelled, or
 * whose process exited has no node.
 */
export type ConcertResult =
	| (NodeInstance & { outcome: "ok"; outputs: Outputs })
	| (Partial<NodeInstance> & {
			outcome: "rejected" | "failed";
			reason: string;
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
	| { outcome: "ok"; outputs: Outputs }
	| { outcome: Exclude<Outcome, "ok">; reason: string; outputs?: Outputs }
) & {
	metrics?: Metrics;
	enrichment?: Enrichment;
	artifacts?: readonly ArtifactRef[];
	/** The resume key, kept for an `ok` instance. */
	key?: string;
};

/**
 * What an event says about its instance (CORE-10):
 * - `running`: it started.
 * - `settled`: it settled, with its outcome, reason and host enrichment.
 * - `reused`: a resume kept its `ok` record from before.
 * - `progress`: its host emitted `event`, stored as given.
 * - `log`: its worker wrote `line`, or its cancel hook failed.
 */
export type EventBody =
	| { type: "running" }
	| {
			type: "settled";
			outcome: Outcome;
			reason?: string;
			enrichment?: Enrichment;
	  }
	| { type: "reused" }
	| { type: "progress"; event: HostEvent }
	| { type: "log"; line: string };

/** `seq` orders all events of a store and is the cursor `events` reads after. `at` is epoch milliseconds. */
export type ConcertEvent = NodeInstance & {
	seq: number;
	at: number;
} & EventBody;

/**
 * The durable record of concerts, their node instances and events (CORE-11), in one SQLite file. Every query throws
 * on an unknown concert id. A reader that finds a `running` concert whose process is gone settles it, and its running
 * instances, `failed` with `PROCESS_EXITED`.
 */
export interface RecordStore {
	/** Records a new concert as `running`, performed by this process. */
	begin(concert: { id: string; ir: Ir; startedAt: number }): void;
	/**
	 * Restarts a concert that failed or was rejected as `running`, performed by this process, with `ir` as its stored IR.
	 * Its instance records and events stay. `reuse`, `start` and `settle` take over each instance record from before.
	 * @throws Error when the concert is running, as its process is alive, or settled `ok`.
	 */
	resume(concert: { id: string; ir: Ir }): void;
	/**
	 * Records that `instance` started, with its `running` event. A record from before a resume is replaced, its events
	 * kept.
	 * @throws Error when the concert has settled or the instance has a record.
	 */
	start(concert: string, instance: NodeInstance, at: number): void;
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
	concert(concert: string): ConcertRecord;
	/** Concerts matching every field of `filter`, newest first. */
	concerts(filter?: ConcertFilter): ConcertRecord[];
	/** A concert's node instances, in the order they started or settled without starting, read as one snapshot. */
	instances(concert: string): InstanceRecord[];
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
};

type InstanceStatus = InstanceRecord["status"];

type InstanceRow = {
	node: string;
	expansion: string;
	status: InstanceStatus;
	reason: string | null;
	outputs: string | null;
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

/**
 * Opens the record store at `path`, creating it with the current schema when it is new. WAL mode lets several
 * concerts, in this process or others, share the file (D-26).
 * @throws Error when the file holds another schema version.
 */
export function openRecord(path: string): RecordStore {
	const db = new Database(path, { create: true, strict: true });
	try {
		db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		walMode(db);
		migrate(db, path);
	} catch (error) {
		db.close();
		throw error;
	}
	return storeOf(db);
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

function migrate(db: Database, path: string): void {
	db.transaction(() => {
		const version =
			db.query<{ user_version: number }, []>("PRAGMA user_version").get()
				?.user_version ?? 0;
		if (version === SCHEMA_VERSION) return;
		if (version !== 0)
			throw new Error(
				`record store '${path}' has schema version ${version}, and this maestro reads version ${SCHEMA_VERSION}. Use a record store this maestro made, or move '${path}' aside`,
			);
		db.exec(SCHEMA);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	}).immediate();
}

/** Whether the process `pid` exists. One owned by another user exists too. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
}

function storeOf(db: Database): RecordStore {
	const event = (
		concert: string,
		{ node, expansion }: NodeInstance,
		body: EventBody,
		at: number,
	) =>
		db.exec(
			"INSERT INTO events (concert, node, expansion, at, body) VALUES (?, ?, ?, ?, ?)",
			[concert, node, expansion, at, JSON.stringify(body)],
		);

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

	const settleRow = (
		id: string,
		instance: NodeInstance,
		s: Settling,
		at: number,
	) => {
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
		event(id, instance, { type: "settled", outcome, reason, enrichment }, at);
	};

	const settle = db.transaction(
		(id: string, instance: NodeInstance, s: Settling, at: number) => {
			replaceStale(id, instance);
			writable(id, instance, [null, "running"]);
			settleRow(id, instance, s, at);
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
	);

	/** Settles a `running` concert whose process is gone, with its running instances. A second call does nothing. */
	const settleRunning = (id: string, reason: string, at: number) => {
		const running = db
			.query<NodeInstance, [string]>(
				"SELECT node, expansion FROM instances WHERE concert = ? AND status = 'running'",
			)
			.all(id);
		for (const instance of running)
			settleRow(id, instance, { outcome: "failed", reason }, at);
	};

	const reap = db.transaction((id: string) => {
		const at = Date.now();
		settleRunning(id, PROCESS_EXITED, at);
		db.exec(
			"UPDATE concerts SET status = 'failed', settled_at = ?, reason = ? WHERE id = ? AND status = 'running'",
			[at, PROCESS_EXITED, id],
		);
	});

	const reaped = (row: ConcertRow) => {
		if (row.status !== "running" || alive(row.pid)) return false;
		reap.immediate(row.id);
		return true;
	};

	const rowOf = (id: string): ConcertRow => {
		const query = db.query<ConcertRow, [string]>(
			"SELECT * FROM concerts WHERE id = ?",
		);
		const row = query.get(id);
		if (!row) throw unknownConcert(id);
		return reaped(row) ? (query.get(id) ?? row) : row;
	};

	const concert = (id: string) => concertOf(rowOf(id));

	const restart = db.transaction((id: string, ir: Ir) => {
		const { changes } = db.exec(
			`UPDATE concerts SET ir = ?, pid = ?, status = 'running', settled_at = NULL, result_node = NULL,
			result_expansion = NULL, reason = NULL WHERE id = ? AND status IN ('rejected', 'failed')`,
			[JSON.stringify(ir), process.pid, id],
		);
		if (changes === 0) throw unresumable(db, id);
		db.exec("UPDATE instances SET stale = 1 WHERE concert = ?", [id]);
	});

	return {
		begin({ id, ir, startedAt }) {
			db.exec(
				"INSERT INTO concerts (id, composition, pack, ir, pid, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
				[
					id,
					ir.composition.id,
					ir.composition.pack,
					JSON.stringify(ir),
					process.pid,
					startedAt,
				],
			);
		},
		resume: ({ id, ir }) => {
			rowOf(id);
			restart(id, ir);
		},
		start: db.transaction((id: string, instance: NodeInstance, at: number) => {
			replaceStale(id, instance);
			writable(id, instance, [null]);
			db.exec(
				"INSERT INTO instances (concert, node, expansion, status, started_at) VALUES (?, ?, ?, 'running', ?)",
				[id, instance.node, instance.expansion, at],
			);
			event(id, instance, { type: "running" }, at);
		}),
		reuse: db.transaction((id: string, instance: NodeInstance, at: number) => {
			writable(id, instance, ["ok"]);
			const { changes } = db.exec(
				"UPDATE instances SET stale = 0 WHERE concert = ? AND node = ? AND expansion = ? AND stale = 1",
				[id, instance.node, instance.expansion],
			);
			if (changes === 0)
				throw new Error(
					`'${instance.node}${instance.expansion}' of concert '${id}' has no ok record from before the resume, so it cannot be reused`,
				);
			event(id, instance, { type: "reused" }, at);
		}),
		settle,
		note: db.transaction(
			(id: string, instance: NodeInstance, body: EventBody, at: number) => {
				writable(id, instance, ["running"]);
				event(id, instance, body, at);
			},
		),
		finish: db.transaction((id: string, result: ConcertResult, at: number) => {
			settleRunning(id, CONCERT_FINISHED, at);
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
		concert,
		concerts(filter = {}) {
			for (const row of db
				.query<ConcertRow, []>(
					"SELECT * FROM concerts WHERE status = 'running'",
				)
				.all())
				reaped(row);
			return db
				.query<ConcertRow, [string | null, string | null]>(
					`SELECT * FROM concerts WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR composition = ?2)
					ORDER BY started_at DESC, id DESC`,
				)
				.all(filter.status ?? null, filter.composition ?? null)
				.map(concertOf);
		},
		instances(id) {
			rowOf(id);
			return db.transaction(() => instancesOf(db, id))();
		},
		result(id) {
			const row = rowOf(id);
			if (row.status === "running") return undefined;
			if (row.status !== "ok") return failure(row, row.status);
			const instance = {
				node: row.result_node ?? "",
				expansion: row.result_expansion ?? "",
			};
			const outputs = db
				.query<{ outputs: string | null }, [string, string, string]>(
					"SELECT outputs FROM instances WHERE concert = ? AND node = ? AND expansion = ?",
				)
				.get(id, instance.node, instance.expansion)?.outputs;
			return {
				...instance,
				outcome: "ok",
				outputs: parsed(outputs ?? null) ?? {},
			};
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
			const rows = db
				.query<{ name: string; total: number }, [string]>(
					`SELECT name, SUM(value) AS total FROM (
						SELECT name, value FROM metrics WHERE concert = ?1
						UNION ALL SELECT name, value FROM earlier_metrics WHERE concert = ?1
					) GROUP BY name ORDER BY name`,
				)
				.all(id);
			return Object.fromEntries(rows.map((r) => [r.name, r.total]));
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

/** Why `id`, which `restart` found neither failed nor rejected, cannot be resumed. */
function unresumable(db: Database, id: string): Error {
	const row = db
		.query<{ status: ConcertStatus; pid: number }, [string]>(
			"SELECT status, pid FROM concerts WHERE id = ?",
		)
		.get(id);
	if (row?.status === "running")
		return new Error(
			`concert '${id}' is still running in process ${row.pid}. Wait for it to settle, or kill it, then resume it`,
		);
	return new Error(
		`concert '${id}' finished ok, so it has nothing to resume. Perform its composition as a new concert`,
	);
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
		...(row.settled_at !== null && { settledAt: row.settled_at }),
	};
}

function failure(
	row: ConcertRow,
	outcome: "rejected" | "failed",
): ConcertResult {
	const node = row.result_node;
	const reason = row.reason ?? "";
	if (node === null) return { outcome, reason };
	const expansion = row.result_expansion ?? "";
	return { node, expansion, outcome, reason };
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
	const enrichment = parsed<Enrichment>(row.enrichment);
	return {
		node: row.node,
		expansion: row.expansion,
		status: row.status,
		...(row.reason !== null && { reason: row.reason }),
		...(outputs !== undefined && { outputs }),
		...(enrichment !== undefined && { enrichment }),
		...(row.key !== null && { key: row.key }),
		stale: row.stale === 1,
		...(row.started_at !== null && { startedAt: row.started_at }),
		...(row.settled_at !== null && { settledAt: row.settled_at }),
	};
}
