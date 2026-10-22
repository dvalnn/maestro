import { readFileSync, readlinkSync } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { Host } from "@maestro/core/host";
import { hostSetup } from "@maestro/core/host";
import {
	type ConcertRecord,
	concertDirs,
	openRecord,
	type Records,
} from "@maestro/core/perform";
import { messageOf } from "@maestro/ir";
import {
	inGraphOrder,
	seen,
	shortId,
	shortIds,
} from "@maestro/render-text/live";
import {
	type Deps,
	isSet,
	type Options,
	parse,
	textOf,
	textsOf,
	type Values,
} from "./command";
import { type LoadedConfig, loadConfig, type Overrides } from "./config";
import { listedOf, usageError } from "./output";

/** The executable's name, which a process performing a concert shows in its command line. */
const COMMAND = "maestro";
/** The runtime that executes a script given as its first argument, so the script's name stands for the process. */
const RUNTIME = "bun";

const stem = (path: string) => basename(path, extname(path));

/**
 * Whether `pid` is a process of this program: its executable, or script when it is the runtime's, is named `maestro`,
 * or it runs `self`, the executable of this process, when that is no runtime (a compiled release binary).
 */
export function isMaestro(pid: number, self = process.execPath): boolean {
	try {
		const [executable = "", script = ""] = readFileSync(
			`/proc/${pid}/cmdline`,
			"utf8",
		).split("\0");
		const named =
			stem(stem(executable) === RUNTIME ? script : executable) === COMMAND;
		return (
			named ||
			(stem(self) !== RUNTIME && readlinkSync(`/proc/${pid}/exe`) === self)
		);
	} catch {
		return false;
	}
}

/** The config a command resolved, and where the data root keeps what a command reads and writes. */
export type Session = {
	deps: Deps;
	config: LoadedConfig;
	files: {
		/** The one record store. */
		record: string;
		/** Each concert's artifact area, in `<concert id>/`. */
		concerts: string;
	};
};

/** The absolute path of concert `id`'s artifact area. */
export const artifactsOf = (session: Session, id: string) =>
	concertDirs(resolve(session.files.concerts), id).artifacts;

/** The `--profile` and each `-c` of `values`. */
export const overridesOf = (values: Values): Overrides => ({
	profile: textOf(values, "profile"),
	config: textsOf(values, "config"),
});

/** The session for `deps`, its config layered for `overrides` in order. @throws ConfigError as `loadConfig` does. */
export async function openSession(
	deps: Deps,
	...overrides: Overrides[]
): Promise<Session> {
	const config = await loadConfig({
		cwd: deps.cwd,
		env: deps.env,
		hosts: deps.hosts,
		overrides,
	});
	const { dataRoot } = config.core;
	return {
		deps,
		config,
		files: {
			record: join(dataRoot, "record.db"),
			concerts: join(dataRoot, "concerts"),
		},
	};
}

/**
 * The concert of `store` whose id is `prefix`, or whose id or short id starts with it. A short id's letters are no hex
 * digit, so a prefix never starts both kinds.
 * @throws CliError, a usage error, when the store has no such concert, or `prefix` starts several.
 */
export function concertOf(store: Records, prefix: string): ConcertRecord {
	const ids = store.ids();
	const starts = (id: string) =>
		prefix !== "" && (id.startsWith(prefix) || shortId(id).startsWith(prefix));
	const matching = ids.includes(prefix) ? [prefix] : ids.filter(starts);
	if (matching.length > 1) {
		const short = shortIds(ids);
		const listed = listedOf(matching.map((id) => short.label(id, false)));
		throw usageError(
			`'${prefix}' starts ${matching.length} concerts: ${listed}`,
			"Give more characters of the id",
		);
	}
	const found = matching[0] === undefined ? undefined : store.find(matching[0]);
	if (!found)
		throw usageError(
			`no concert '${prefix}' in the record`,
			"Check the id with 'maestro ls'",
		);
	return found;
}

/** The instances of concert `row`, in graph order. */
export const instancesInOrder = (store: Records, row: ConcertRecord) =>
	inGraphOrder(
		row.ir,
		store.instances(row.id),
		seen(new Map(), store.events(row.id)),
	);

/** The concerts the prefixes `prefixes` start, each once, in the order first named. */
export const concertsOf = (store: Records, prefixes: readonly string[]) => [
	...new Map(
		prefixes.map((p) => concertOf(store, p)).map((c) => [c.id, c]),
	).values(),
];

/** What a command that works on the record is handed. */
export type Stored = {
	session: Session;
	store: Records;
	values: Values;
	positionals: string[];
	json: boolean;
};

/**
 * Opens the session for `overrides` and its record store, made when it is new, and gives `body` both until it settles.
 * @throws ConfigError as `openSession` does.
 */
export async function withSession<T>(
	deps: Deps,
	overrides: Overrides,
	body: (session: Session, store: Records) => Promise<T>,
): Promise<T> {
	const session = await openSession(deps, overrides);
	await mkdir(session.config.core.dataRoot, { recursive: true });
	const store = openRecord(session.files.record);
	try {
		return await body(session, store);
	} finally {
		store.close();
	}
}

/**
 * Reads `args` against `options`, then gives `body` the session, the record store and what it read.
 * @throws CliError, a usage error ending with `fix`, for flags `options` does not take.
 */
export async function withStore(
	options: Options,
	args: readonly string[],
	deps: Deps,
	fix: string,
	body: (stored: Stored) => Promise<number>,
): Promise<number> {
	const { values, positionals } = parse(options, args, fix);
	return withSession(deps, overridesOf(values), (session, store) =>
		body({ session, store, values, positionals, json: isSet(values, "json") }),
	);
}

/** The bytes held under `dir`, 0 when it is not there. */
async function sizeOf(dir: string): Promise<number> {
	const names = await readdir(dir, { recursive: true }).catch(() => []);
	const sizes = await Promise.all(
		names.map((name) =>
			lstat(join(dir, name)).then(
				(entry) => (entry.isFile() ? entry.size : 0),
				() => 0,
			),
		),
	);
	return sizes.reduce((sum, size) => sum + size, 0);
}

/** The setup core gives `host` under the session's config. */
export const setupOf = (session: Session, host: Host) =>
	hostSetup(host, session.config.composed);

/**
 * The bytes concert `id` holds: its directory under the data root, and what each host reports holding for it. A host
 * that cannot measure its share counts none, and why goes to stderr.
 */
export async function diskOf(session: Session, id: string): Promise<number> {
	const usage = async (host: Host) => {
		try {
			return (await host.resources?.usage(id, setupOf(session, host))) ?? 0;
		} catch (error) {
			session.deps.stderr(
				`host '${host.name}' cannot measure concert ${id}: ${messageOf(error)}`,
			);
			return 0;
		}
	};
	const held = await Promise.all([
		sizeOf(join(session.files.concerts, id)),
		...session.deps.hosts.map(usage),
	]);
	return held.reduce((sum, bytes) => sum + bytes, 0);
}
