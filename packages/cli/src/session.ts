import { readFileSync, readlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { type Composed, ConfigError } from "@maestro/core/config";
import type { Host } from "@maestro/core/host";
import { hostSetup } from "@maestro/core/host";
import {
	type ConcertRecord,
	concertDirs,
	openRecord,
	type Records,
} from "@maestro/core/perform";
import { indexGraph } from "@maestro/ir";
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
	textsOf,
	type Values,
} from "./command";
import {
	type LoadedConfig,
	loadConfig,
	type Overrides,
	placesOf,
	type Recorded,
	recordedConfig,
	shownConfig,
	shownRoots,
} from "./config";
import { CliError, listedOf, usageError } from "./output";

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

/** The command that runs this program: the executable, then the script when the executable is the runtime. */
export const selfOf = (
	executable = process.execPath,
	script = process.argv[1],
): string[] =>
	stem(executable) === RUNTIME && script ? [executable, script] : [executable];

/** A command's deps, and where the data root, `$XDG_DATA_HOME/maestro`, keeps what a command reads and writes. */
export type Located = {
	deps: Deps;
	files: {
		/** The data root. */
		root: string;
		/** The one record store. */
		record: string;
		/** Each concert's artifact area, in `<concert id>/`. */
		concerts: string;
	};
};

/** The config a command resolved, beside where the data root keeps its files. */
export type Session = Located & { config: LoadedConfig };

/** Where the data root of `deps`' environment keeps what a command reads and writes. Reads no config. */
export function locate(deps: Deps): Located {
	const root = placesOf(deps.env).dataRoot;
	return {
		deps,
		files: {
			root,
			record: join(root, "record.db"),
			concerts: join(root, "concerts"),
		},
	};
}

/** The absolute path of concert `id`'s artifact area. */
export const artifactsOf = (located: Located, id: string) =>
	concertDirs(resolve(located.files.concerts), id).artifacts;

/** Each `--preset` and each `-c` of `values`. */
export const overridesOf = (values: Values): Overrides => ({
	presets: textsOf(values, "preset"),
	config: textsOf(values, "config"),
});

/** The session for `deps`, its config layered for `overrides`. @throws ConfigError as `loadConfig` does. */
export async function openSession(
	deps: Deps,
	overrides?: Overrides,
): Promise<Session> {
	const config = await loadConfig({
		cwd: deps.cwd,
		env: deps.env,
		hosts: deps.hosts,
		overrides,
	});
	return { ...locate(deps), config };
}

/** Why a concert's snapshot cannot be read: a row recorded before snapshots, or one this version cannot parse. */
type Unread = {
	kind: "predates" | "unreadable";
	/** What went wrong. */
	problem: string;
	/** What to do next. */
	fix: string;
};

/** The error for a snapshot that cannot be read, `problem` then `fix` on a line each. */
export const unreadError = ({ problem, fix }: Unread) =>
	new CliError(`${problem}\n${fix}`);

/** The problem line of concert `label`'s snapshot failing to compose, naming each diagnostic. */
export const composeProblem = (label: string, error: ConfigError) =>
	`concert ${label}'s config snapshot no longer composes: ${error.diagnostics.map((d) => d.message).join("; ")}`;

/** Concert `row` of `store` as its config snapshot records it, or why the snapshot cannot be read. */
function recordedOf(store: Records, row: ConcertRecord): Recorded | Unread {
	const label = shortIds(store.ids()).label(row.id, false);
	const { snapshot } = row;
	if (snapshot === "unreadable")
		return {
			kind: "unreadable",
			problem: `concert ${label}'s config snapshot is not one this maestro reads`,
			fix: "Upgrade maestro, or perform its composition anew with 'maestro perform'",
		};
	if (!snapshot)
		return {
			kind: "predates",
			problem: `concert ${label} predates config snapshots, so its config is not known`,
			fix: "Perform its composition anew with 'maestro perform'",
		};
	return { snapshot, workspaceName: row.workspace, label };
}

/**
 * The session of concert `row` of `store`, which `located` opened: the code defaults, its snapshot, then each `-c` of
 * `config`, checked as `recordedConfig` does. Reads no config file.
 * @throws CliError when the row was recorded before config snapshots, or holds one this version cannot read.
 * @throws ConfigError as `recordedConfig` does.
 */
export async function recordedSession(
	located: Located,
	store: Records,
	row: ConcertRecord,
	config: readonly string[] = [],
): Promise<Session> {
	const { deps } = located;
	const snapshot = recordedOf(store, row);
	if ("problem" in snapshot) throw unreadError(snapshot);
	const recorded = await recordedConfig({
		cwd: deps.cwd,
		env: deps.env,
		hosts: deps.hosts,
		recorded: snapshot,
		config,
	});
	return { ...located, config: recorded };
}

/**
 * A recorded concert's config as a reader opens it. `composed` is the snapshot's config, or the code defaults alone
 * when the snapshot is not read or does not compose; `workspace` is the directory it was performed in, when its
 * snapshot records one.
 */
export type Opened = { composed: Composed } & (
	| (Unread & { workspace?: undefined })
	| { kind: "composes"; workspace: string | undefined }
	| {
			kind: "does-not-compose";
			workspace: string | undefined;
			error: ConfigError;
	  }
);

/**
 * Concert `row`'s config, as every reader of the record opens it (ADR 0019): the code defaults, then its snapshot,
 * merged under the running hosts and checked against nothing. Never throws for a row it cannot read or compose.
 */
export function openRecorded(
	{ deps }: Located,
	store: Records,
	row: ConcertRecord,
): Opened {
	const recorded = recordedOf(store, row);
	const defaults = () => shownConfig(deps, row.workspace);
	if ("problem" in recorded) return { ...recorded, composed: defaults() };
	const { workspace } = recorded.snapshot;
	try {
		const composed = shownConfig(deps, row.workspace, recorded);
		return { kind: "composes", composed, workspace };
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		return { kind: "does-not-compose", composed: defaults(), workspace, error };
	}
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

/**
 * The instances of concert `row` its graph places, each with its `name`, in graph order. A stale instance the graph no
 * longer places, after a resume with an IR that dropped its node, is left out and never named.
 */
export function instancesInOrder(store: Records, row: ConcertRecord) {
	const graph = indexGraph(row.ir);
	return inGraphOrder(
		row.ir,
		store.instances(row.id),
		seen(new Map(), store.events(row.id)),
	).map((i) => ({ ...i, name: graph.instanceName(i) }));
}

/** The concerts the prefixes `prefixes` start, each once, in the order first named. */
export const concertsOf = (store: Records, prefixes: readonly string[]) => [
	...new Map(
		prefixes.map((p) => concertOf(store, p)).map((c) => [c.id, c]),
	).values(),
];

/** What a command that works on the record is handed. */
export type Stored = {
	session: Located;
	store: Records;
	values: Values;
	json: boolean;
};

/** Opens the record store of `located`, made with its data root when it is new, and gives `body` it until it settles. */
export async function withRecord<T>(
	located: Located,
	body: (store: Records) => Promise<T>,
): Promise<T> {
	await mkdir(located.files.root, { recursive: true });
	const store = openRecord(located.files.record);
	try {
		return await body(store);
	} finally {
		store.close();
	}
}

/** Opens the record store of `deps`' data root, reading no config, and gives `body` it until it settles. */
export async function withLocated<T>(
	deps: Deps,
	body: (located: Located, store: Records) => Promise<T>,
): Promise<T> {
	const located = locate(deps);
	return withRecord(located, (store) => body(located, store));
}

/** What `withStore` reads a command's arguments with. */
export type StoreRead<T> = {
	options: Options;
	/** Ends the usage error for a flag `options` does not take. */
	fix: string;
	/** Validates and parses the flags and positionals alone, before anything is opened. */
	check: (values: Values, positionals: readonly string[]) => T;
};

/**
 * Reads `args` as `read` says, has its pure `check` validate them, then gives `body` the located data root, which reads
 * no config (ADR 0019), its record store, what it read and what `check` returned. Nothing is opened when `check` throws.
 * @throws CliError, a usage error, for flags `read.options` does not take, or whatever `check` throws.
 */
export async function withStore<T>(
	{ options, fix, check }: StoreRead<T>,
	args: readonly string[],
	deps: Deps,
	body: (stored: Stored, parsed: T) => Promise<number>,
): Promise<number> {
	const { values, positionals } = parse(options, args, fix);
	const parsed = check(values, positionals);
	const session = locate(deps);
	return withRecord(session, (store) =>
		body({ session, store, values, json: isSet(values, "json") }, parsed),
	);
}

/** The setup core gives `host` under the session's config. */
export const setupOf = (session: Session, host: Host) =>
	hostSetup(host, session.config.composed, session.config.roots);

/** The setup core gives each host under `opened`, a recorded concert's config (ADR 0019). */
export async function setupsOf(
	session: Located,
	{ composed, workspace }: Opened,
): Promise<(host: Host) => ReturnType<typeof hostSetup>> {
	const roots = await shownRoots(composed, session.deps.env, workspace);
	return (host) => hostSetup(host, composed, roots);
}
