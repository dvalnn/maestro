import {
	copyFileSync,
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
/** Under `SESSIONS`: one file per version an agent wrote, holding its session id. */
const WRITTEN = "written";
const SESSION_FILE = "session.json";
/** The directory of a session that its harness keeps, bound at `SESSION_DIR`. */
const SESSION_HOME = "home";

/**
 * The store of one target, `<host store>/<target id>/`: its lanes and versions (ADR 0005), and the harness sessions
 * that wrote them under `sessions/`.
 */
export type TargetStore = {
	/** The target's realpath. */
	target: string;
	root: string;
	lanes: Lanes;
};

/** A harness session, and what it may continue: versions of `concert` only, by `harness` only. */
export type Session = {
	id: string;
	/** Host directory the harness keeps the session in. */
	dir: string;
	harness: string;
	concert: string;
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
const writtenFile = (root: string, v: Version) =>
	join(sessionsDir(root), WRITTEN, encodeURIComponent(v));

/** Starts a session of `harness` in `concert`. */
export function mintSession(
	root: string,
	harness: string,
	concert: string,
): Session {
	const id = crypto.randomUUID();
	const home = join(sessionsDir(root), id);
	const dir = join(home, SESSION_HOME);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(home, SESSION_FILE), JSON.stringify({ harness, concert }));
	return { id, dir, harness, concert };
}

/** Records that session `session` wrote version `v`. */
export function recordWriter(root: string, v: Version, session: Session) {
	const file = writtenFile(root, v);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, session.id);
}

/** Records that the session that wrote version `from`, if any agent did, is the writer of version `to` too. */
export function carryWriter(root: string, from: Version, to: Version) {
	const source = writtenFile(root, from);
	if (existsSync(source)) copyFileSync(source, writtenFile(root, to));
}

const isMeta = (v: unknown): v is { harness: string; concert: string } =>
	typeof v === "object" &&
	v !== null &&
	"harness" in v &&
	typeof v.harness === "string" &&
	"concert" in v &&
	typeof v.concert === "string";

type Meta = { harness: string; concert: string };

/** The harness and concert the session at `home` belongs to, or `undefined` when its record is not readable. */
function sessionMeta(home: string): Meta | undefined {
	try {
		const meta: unknown = JSON.parse(
			readFileSync(join(home, SESSION_FILE), "utf8"),
		);
		return isMeta(meta) ? meta : undefined;
	} catch {
		return undefined;
	}
}

const malformed = (home: string) =>
	`session record '${join(home, SESSION_FILE)}' is malformed`;

/**
 * The session that wrote version `v`, or `undefined` when no agent did.
 * @throws Error when the session's record is not readable.
 */
export function writerOf(root: string, v: Version): Session | undefined {
	const file = writtenFile(root, v);
	if (!existsSync(file)) return undefined;
	const id = readFileSync(file, "utf8");
	const home = join(sessionsDir(root), id);
	const meta = sessionMeta(home);
	if (!meta)
		throw new Error(
			`${malformed(home)}. Delete '${home}', and drop resume from the node that continues it`,
		);
	return { id, dir: join(home, SESSION_HOME), ...meta };
}

/**
 * The session directories of `concert` under `root` and its records of what they wrote, and the homes among them
 * whose record is malformed. A malformed session belongs to the concert whose record says it wrote a version.
 */
function concertSessions(root: string, concert: string) {
	const dir = sessionsDir(root);
	const writtenDir = join(dir, WRITTEN);
	const written = existsSync(writtenDir)
		? readdirSync(writtenDir)
				.filter((f) => decodeURIComponent(f).startsWith(`${concert}.`))
				.map((f) => join(writtenDir, f))
		: [];
	const writers = new Set(written.map((f) => readFileSync(f, "utf8")));
	const homes = existsSync(dir)
		? readdirSync(dir).filter((id) => id !== WRITTEN)
		: [];
	const own: string[] = [];
	const bad: string[] = [];
	for (const id of homes) {
		const home = join(dir, id);
		const meta = sessionMeta(home);
		if (meta?.concert === concert) own.push(home);
		else if (!meta && writers.has(id)) bad.push(home);
	}
	return { paths: [...own, ...bad, ...written], malformed: bad };
}

/**
 * The bytes the lanes and sessions of `concert` take, over every target in the host store `store`.
 * @throws Error naming each of its session records that is malformed, which `releaseConcert` still removes.
 */
export async function concertUsage(
	store: string,
	concert: string,
): Promise<number> {
	let bytes = 0;
	const bad: string[] = [];
	for (const root of targetRoots(store)) {
		bytes += await lanesAt(root).diskUse(concert);
		const sessions = concertSessions(root, concert);
		for (const p of sessions.paths) bytes += bytesOnDisk(p);
		bad.push(...sessions.malformed);
	}
	if (bad.length)
		throw new Error(
			`${bad.map(malformed).join("; ")}. Prune concert ${concert} to remove it`,
		);
	return bytes;
}

/** Removes the lanes, versions and sessions of `concert` from every target in the host store `store`. */
export async function releaseConcert(store: string, concert: string) {
	for (const root of targetRoots(store)) {
		await lanesAt(root).prune(concert);
		for (const p of concertSessions(root, concert).paths)
			rmSync(p, { recursive: true, force: true });
	}
}
