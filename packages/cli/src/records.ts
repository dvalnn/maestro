import type { Metrics } from "@maestro/core/host";
import {
	type ConcertFilter,
	type ConcertRecord,
	openRecord,
} from "@maestro/core/perform";
import { DURATION_EXAMPLE, MS_PER_UNIT } from "@maestro/ir";
import {
	agentText,
	compact,
	type ShortIds,
	shortIds,
	stateWord,
	tokensOf,
} from "@maestro/render-text/live";
import {
	COMMON,
	type Command,
	colorOf,
	FILTER_OPTIONS,
	filterOf,
	isSet,
	type Options,
	only,
	textOf,
	type Values,
} from "./command";
import { actorOf, hostTextOf } from "./host-text";
import {
	CliError,
	EXIT,
	exitOf,
	formatBytes,
	instanceName,
	jsonOf,
	parseCount,
	parseDuration,
	parseTour,
	printClosing,
	resultDoc,
	staleCell,
	table,
	usageError,
} from "./output";
import {
	artifactsOf,
	concertOf,
	concertsOf,
	diskOf,
	instancesInOrder,
	isMaestro,
	type Session,
	type Stored,
	withStore,
} from "./session";

const LIST_LIMIT = 20;
/** How long `kill` waits for a concert to settle after it signals its process. */
const KILL_GRACE_S = 10;
const KILL_GRACE_MS = KILL_GRACE_S * MS_PER_UNIT.s;

const LS_OPTIONS = {
	...COMMON,
	...FILTER_OPTIONS,
	limit: {
		type: "string",
		arg: "count",
		desc: `Show at most this many, newest first (default ${LIST_LIMIT})`,
	},
} as const satisfies Options;

/** The record's columns but its IR, and `elapsedMs`: the concert's run time, up to now while it runs. */
const concertColumns = ({ ir: _ir, ...row }: ConcertRecord) => ({
	...row,
	elapsedMs: (row.settledAt ?? Date.now()) - row.startedAt,
});

const tokenCell = (metrics: Metrics) => {
	const tokens = tokensOf(metrics);
	return tokens > 0 ? compact(tokens) : "-";
};

const dash = (text: string | undefined) => text || "-";

/**
 * The concert `ls` is to show, if any, and the filter and limit of the list.
 * @throws CliError, a usage error, for more than one concert, or a bad filter or limit.
 */
function lsChecked(values: Values, positionals: readonly string[]) {
	const [id, ...rest] = positionals;
	if (rest.length > 0)
		throw usageError(
			`expected at most one concert, got ${positionals.length}`,
			"Name one concert, or none to list them all",
		);
	const limit = textOf(values, "limit");
	const query = {
		...filterOf(values),
		limit: limit === undefined ? LIST_LIMIT : parseCount("--limit", limit),
	};
	return { id, query };
}

export const ls: Command = {
	usage: "ls [<concert>] [flags]",
	options: LS_OPTIONS,
	execute: (args, deps) =>
		withStore(
			LS_OPTIONS,
			args,
			deps,
			"Flags are listed in 'maestro ls --help'",
			lsChecked,
			async (stored, { id, query }) =>
				id === undefined ? listed(stored, query) : instancesOf(stored, id),
		),
};

/** `text`, the table of `rows` led by their short ids, each id's unique letters bold and the rest dim. */
function highlighted(
	short: ShortIds,
	rows: readonly { id: string }[],
	text: string,
): string {
	return text
		.split("\n")
		.map((line, i) => {
			const id = rows[i - 1]?.id;
			return id === undefined
				? line
				: short.label(id, true) + line.slice(short.label(id, false).length);
		})
		.join("\n");
}

async function listed(stored: Stored, query: ConcertFilter) {
	const { session, store, values, json } = stored;
	const color = colorOf(session.deps, values).out;
	const concerts = store.concerts(query);
	const short = shortIds(store.ids());
	const rows = await Promise.all(
		concerts.map(async (c) => ({
			...concertColumns(c),
			short: short.label(c.id, false),
			metrics: store.metrics(c.id),
			diskUse: await diskOf(stored, c.id),
		})),
	);
	const text = table([
		[
			"id",
			"title",
			"tour",
			"workspace",
			"composition",
			"status",
			"tokens",
			"disk",
		],
		...rows.map((r) => [
			r.short,
			dash(r.title),
			dash(r.tour),
			dash(r.workspace),
			`${r.pack}.${r.composition}`,
			stateWord(r.status, color),
			tokenCell(r.metrics),
			formatBytes(r.diskUse),
		]),
	]);
	session.deps.stdout(
		json ? jsonOf(rows) : color ? highlighted(short, rows, text) : text,
	);
	return EXIT.ok;
}

async function instancesOf(
	{ session, store, values, json }: Stored,
	prefix: string,
) {
	const color = colorOf(session.deps, values).out;
	const row = concertOf(store, prefix);
	const instances = instancesInOrder(store, row);
	const hostText = hostTextOf(session.deps.hosts, row.ir);
	session.deps.stdout(
		json
			? jsonOf({
					...concertColumns(row),
					short: shortIds(store.ids()).label(row.id, false),
					metrics: store.metrics(row.id),
					instances,
				})
			: table([
					["instance", "status", "stale", "agent", "reason"],
					...instances.map((i) => [
						instanceName(row.ir, i),
						stateWord(i.status, color),
						staleCell(i),
						agentText(actorOf(i.enrichment, i.node, hostText), i.metrics),
						i.reason ?? "",
					]),
				]),
	);
	return EXIT.ok;
}

const WAIT_OPTIONS = {
	...COMMON,
	timeout: {
		type: "string",
		arg: "duration",
		desc: `Give up after this long, such as ${DURATION_EXAMPLE}, and exit ${EXIT.timeout}`,
	},
} as const satisfies Options;

const NAME_TO_WAIT = "Name the concert to wait for";

/**
 * The concert to wait for, and the limit to wait for it, if any.
 * @throws CliError, a usage error, for other than one concert, or a bad `--timeout`.
 */
function waitChecked(values: Values, positionals: readonly string[]) {
	const timeout = textOf(values, "timeout");
	return {
		prefix: only(positionals, "concert", NAME_TO_WAIT),
		limit:
			timeout === undefined ? undefined : parseDuration("--timeout", timeout),
	};
}

async function waited(
	{ session, store, values, json }: Stored,
	{ prefix, limit }: ReturnType<typeof waitChecked>,
) {
	const { deps } = session;
	const timeout = textOf(values, "timeout");
	const { id } = concertOf(store, prefix);
	const result = (await store.wait(id, limit)) && store.result(id);
	const { status } = resultDoc(id, result);
	if (json)
		deps.stdout(
			jsonOf({ ...resultDoc(id, result), metrics: store.metrics(id) }),
		);
	else if (result)
		printClosing(deps, store, concertOf(store, id), result, {
			color: colorOf(deps, values),
			artifacts: artifactsOf(session, id),
		});
	else
		deps.stderr(
			`concert ${id} is still running after ${timeout}\nWait again, or stop it with 'maestro kill ${id}'`,
		);
	return exitOf(status);
}

export const wait: Command = {
	usage: "wait <concert> [flags]  (alias: wt)",
	options: WAIT_OPTIONS,
	execute: (args, deps) =>
		withStore(
			WAIT_OPTIONS,
			args,
			deps,
			"Flags are listed in 'maestro wait --help'",
			waitChecked,
			waited,
		),
};

/**
 * Settles concert `id` failed, as a reader does for a concert whose process exited, taking only maestro's processes as
 * live.
 */
function reap(session: Session, id: string) {
	const reader = openRecord(session.files.record, { alive: isMaestro });
	try {
		reader.find(id);
	} finally {
		reader.close();
	}
}

/** Signals the process performing a concert, which cancels it on SIGTERM. */
function signal(pid: number) {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// The process is already gone, which the record shows on the next read.
	}
}

const NAME_TO_STOP = "Name the concert to stop";

async function killed({ session, store, json }: Stored, prefix: string) {
	const { deps } = session;
	const { id, status, pid } = concertOf(store, prefix);
	if (status !== "running")
		throw new CliError(
			`concert ${id} is not running, it settled ${status}\nSee 'maestro ls ${id}'`,
		);
	if (!isMaestro(pid)) {
		reap(session, id);
		throw new CliError(
			`the process ${pid} of concert ${id} is gone, and its pid now belongs to another program\nThe concert is marked failed: resume it with 'maestro perform --resume ${id}', or prune it`,
		);
	}
	signal(pid);
	if (!(await store.wait(id, KILL_GRACE_MS)))
		throw new CliError(
			`concert ${id} did not settle within ${KILL_GRACE_S}s of stopping process ${pid}\nCheck on it with 'maestro wait ${id} --timeout 1m'`,
		);
	if (json) deps.stdout(jsonOf(resultDoc(id, store.result(id))));
	else deps.stderr(`concert ${id} stopped`);
	return EXIT.ok;
}

export const kill: Command = {
	usage: "kill <concert> [flags]  (alias: k)",
	options: COMMON,
	execute: (args, deps) =>
		withStore(
			COMMON,
			args,
			deps,
			"Flags are listed in 'maestro kill --help'",
			(_values, positionals) => only(positionals, "concert", NAME_TO_STOP),
			killed,
		),
};

const TOUR_OPTIONS = {
	...COMMON,
	clear: { type: "boolean", desc: "Take the concerts off their tour" },
} as const satisfies Options;

/** The tour to set, or `undefined` to clear, and the concerts to set it on. */
function tourAndConcerts(values: Values, positionals: readonly string[]) {
	const [first, ...rest] = positionals;
	const clear = isSet(values, "clear");
	const ids = clear ? positionals : rest;
	if (ids.length === 0)
		throw usageError(
			"tour takes a slug and at least one concert",
			"Write maestro tour <slug> <concert>..., or maestro tour --clear <concert>...",
		);
	return {
		slug: clear ? undefined : parseTour("the tour slug", first ?? ""),
		ids,
	};
}

async function toured(
	{ session: { deps }, store, json }: Stored,
	{ slug, ids: prefixes }: ReturnType<typeof tourAndConcerts>,
) {
	const ids = concertsOf(store, prefixes).map((c) => c.id);
	for (const id of ids) store.setTour(id, slug);
	if (json) deps.stdout(jsonOf({ tour: slug ?? null, concerts: ids }));
	else deps.stderr(`${slug ?? "no tour"}: ${ids.join(" ")}`);
	return EXIT.ok;
}

export const tour: Command = {
	usage:
		"tour <slug> <concert>... [flags]  (alias: t)\n       maestro tour --clear <concert>... [flags]",
	options: TOUR_OPTIONS,
	execute: (args, deps) =>
		withStore(
			TOUR_OPTIONS,
			args,
			deps,
			"Flags are listed in 'maestro tour --help'",
			tourAndConcerts,
			toured,
		),
};
