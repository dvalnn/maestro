import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { sha256Hex } from "@maestro/core";
import { isPlainObject } from "@maestro/ir";
import {
	bytesOnDisk,
	type Lanes,
	openLanes,
	type Sparse,
	type Version,
} from "../lane/index";

/** The hex digits of a target's realpath digest that name its directory in the store. */
const TARGET_ID_LENGTH = 16;
const TARGET_ID = new RegExp(`^[0-9a-f]{${TARGET_ID_LENGTH}}$`);

const SESSIONS = "sessions";
const SESSION_FILE = "session.json";
/** Under a session's home: the directory its harness keeps, bound at `SESSION_DIR`. */
const HARNESS_DIR = "harness";

/**
 * The store of one target, `<host store>/<target id>/`: its lanes and versions (ADR 0005), and its harness sessions
 * under `sessions/`.
 */
export type TargetStore = {
	/** The target's realpath. */
	target: string;
	root: string;
	lanes: Lanes;
};

/** A harness session, run only by `harness`. */
export type Session = {
	/** `<concert id>.<node instance id>` of the instance that started it: the value of an agent's `session` port. */
	id: string;
	/** The UUID its harness knows it by. */
	harnessId: string;
	harness: string;
	/** Its directory in the store. */
	home: string;
	/** The directory its harness keeps, under `home`. */
	dir: string;
};

/**
 * The store of target `repo`, resolved against the working directory, under the host store `store`, its checked-out
 * lanes narrowed to `sparse`, if any.
 * @throws Error when `repo` does not exist.
 */
export function openTarget(
	store: string,
	repo: string,
	sparse?: Sparse,
): TargetStore {
	const target = realpathSync(resolve(repo));
	const root = join(store, sha256Hex(target).slice(0, TARGET_ID_LENGTH));
	return { target, root, lanes: openLanes({ target, root, sparse }) };
}

/** The directory of every target under the host store `store`. */
const targetRoots = (store: string) =>
	existsSync(store)
		? readdirSync(store)
				.filter((name) => TARGET_ID.test(name))
				.map((name) => join(store, name))
		: [];

// The target is read only to cut a fresh lane, which neither usage nor release does.
const lanesAt = (root: string) => openLanes({ target: root, root });

const sessionsDir = (root: string) => join(root, SESSIONS);
const homeOf = (root: string, id: string) =>
	join(sessionsDir(root), encodeURIComponent(id));

const PARTIALS = "partials";
/** Under a target store, per concert: each agent instance's latest session, one file per instance id. */
const LATEST = "latest";

/** An agent instance's latest session: its node, the keys of its expansion and the session's id. */
export type Latest = { node: string; keys: string[]; session: string };

const latestDir = (root: string, concert: string) =>
	join(root, LATEST, encodeURIComponent(concert));

/** Keeps `latest` as the latest session of the agent instance `instance` of `concert`, over any kept before. */
export function keepLatest(
	root: string,
	concert: string,
	instance: string,
	latest: Latest,
) {
	const dir = latestDir(root, concert);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, encodeURIComponent(instance)),
		JSON.stringify(latest),
	);
}

const isLatest = (v: unknown): v is Latest =>
	isPlainObject(v) &&
	typeof v.node === "string" &&
	typeof v.session === "string" &&
	Array.isArray(v.keys) &&
	v.keys.every((k) => typeof k === "string");

/** The latest session of each agent instance of `concert` that has one kept, a malformed one left out. */
export function latestOf(root: string, concert: string): Latest[] {
	const dir = latestDir(root, concert);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		const value = recordAt(join(dir, name), "");
		return isLatest(value) ? [value] : [];
	});
}

/**
 * Where the partial work of failed instance `v` is kept: a changeset directory under the target store, outside the
 * lane chain.
 */
export const partialDir = (root: string, v: Version) =>
	join(root, PARTIALS, encodeURIComponent(v));

/** The partial directories of `concert` under `root`. */
function concertPartials(root: string, concert: string): string[] {
	const dir = join(root, PARTIALS);
	return existsSync(dir)
		? readdirSync(dir)
				.filter((f) => decodeURIComponent(f).startsWith(`${concert}.`))
				.map((f) => join(dir, f))
		: [];
}

/** Starts the session of `harness` that node instance `instance` of `concert` runs, over any an earlier run left. */
export function mintSession(
	root: string,
	harness: string,
	concert: string,
	instance: string,
): Session {
	const id = `${concert}.${instance}`;
	const home = homeOf(root, id);
	rmSync(home, { recursive: true, force: true });
	const dir = join(home, HARNESS_DIR);
	mkdirSync(dir, { recursive: true });
	const harnessId = crypto.randomUUID();
	writeFileSync(
		join(home, SESSION_FILE),
		JSON.stringify({ harness, concert, harnessId }),
	);
	return { id, harnessId, harness, home, dir };
}

type Meta = { harness: string; concert: string; harnessId: string };

const isMeta = (v: unknown): v is Meta =>
	isPlainObject(v) &&
	typeof v.harness === "string" &&
	typeof v.concert === "string" &&
	typeof v.harnessId === "string";

/** The parsed JSON of `file` under `dir`, by default a session's record, or `undefined` when it is missing or not JSON. */
function recordAt(dir: string, file = SESSION_FILE): unknown {
	try {
		return JSON.parse(readFileSync(join(dir, file), "utf8"));
	} catch {
		return undefined;
	}
}

/** Session `id` of `root`, or `undefined` when it is not in the store or its record is malformed. */
export function findSession(root: string, id: string): Session | undefined {
	const home = homeOf(root, id);
	const meta = recordAt(home);
	if (!isMeta(meta)) return undefined;
	const { harness, harnessId } = meta;
	return { id, harnessId, harness, home, dir: join(home, HARNESS_DIR) };
}

/**
 * Session `id` of `root`.
 * @throws Error when it is not in the store, naming the node instance that started it, or its record is malformed.
 */
export function openSession(root: string, id: string): Session {
	const home = homeOf(root, id);
	if (!existsSync(home)) {
		const node = id.slice(id.indexOf(".") + 1);
		throw new Error(
			`session ${id} of node '${node}' is not in the store: its concert was pruned. Perform the composition anew`,
		);
	}
	const found = findSession(root, id);
	if (!found)
		throw new Error(
			`session record '${join(home, SESSION_FILE)}' is malformed. Perform the composition anew`,
		);
	return found;
}

/** Under `SESSIONS` in an older store: one file per version an agent wrote, named by the version, holding its session id. */
const LEGACY_WRITTEN = "written";

/** The older store's files of `concert` under `LEGACY_WRITTEN` in `dir`. */
function legacyPointers(dir: string, concert: string): string[] {
	const written = join(dir, LEGACY_WRITTEN);
	return existsSync(written)
		? readdirSync(written)
				.filter((f) => decodeURIComponent(f).startsWith(`${concert}.`))
				.map((f) => join(written, f))
		: [];
}

/**
 * The session homes of `concert` under `root`, and its older store's files under `LEGACY_WRITTEN`. A home is the
 * concert's by its id, by its record, or, for an older one whose record is unreadable, by a file naming it.
 */
function concertSessions(root: string, concert: string): string[] {
	const dir = sessionsDir(root);
	if (!existsSync(dir)) return [];
	const pointers = legacyPointers(dir, concert);
	const named = new Set(pointers.map((p) => readFileSync(p, "utf8")));
	const own = (name: string) => {
		if (decodeURIComponent(name).startsWith(`${concert}.`)) return true;
		const meta = recordAt(join(dir, name));
		return isPlainObject(meta) ? meta.concert === concert : named.has(name);
	};
	const homes = readdirSync(dir).filter(
		(name) => name !== LEGACY_WRITTEN && own(name),
	);
	return [...homes.map((name) => join(dir, name)), ...pointers];
}

/** What `concert` keeps under `root` outside its lanes: its sessions, partials and latest sessions. */
const concertFiles = (root: string, concert: string) => [
	...concertSessions(root, concert),
	...concertPartials(root, concert),
	...[latestDir(root, concert)].filter((dir) => existsSync(dir)),
];

/** The bytes the lanes and sessions of `concert` take, over every target in the host store `store`. */
export async function concertUsage(
	store: string,
	concert: string,
): Promise<number> {
	let bytes = 0;
	for (const root of targetRoots(store)) {
		bytes += await lanesAt(root).diskUse(concert);
		for (const p of concertFiles(root, concert)) bytes += bytesOnDisk(p);
	}
	return bytes;
}

/** Removes the lanes, versions and sessions of `concert` from every target in the host store `store`. */
export async function releaseConcert(store: string, concert: string) {
	for (const root of targetRoots(store)) {
		await lanesAt(root).prune(concert);
		for (const p of concertFiles(root, concert))
			rmSync(p, { recursive: true, force: true });
	}
}
