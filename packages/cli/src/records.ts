import type { Metrics } from "@maestro/core/host";
import {
	type ConcertFilter,
	type ConcertRecord,
	openRecord,
} from "@maestro/core/perform";
import { compact, DURATION_EXAMPLE, MS_PER_UNIT, tokensOf } from "@maestro/ir";
import {
	agentText,
	flat,
	painted,
	type ShortIds,
	shortIds,
	stateWord,
} from "@maestro/render-text/live";
import {
	COMMON,
	type Command,
	colorOf,
	type Deps,
	FILTER_OPTIONS,
	filterOf,
	isSet,
	type Options,
	only,
	peek,
	textOf,
	type Values,
} from "./command";
import { actorOf, hostTextOf, notesOf, reportOf } from "./host-text";
import {
	CliError,
	EXIT,
	exitOf,
	formatBytes,
	instanceName,
	jsonOf,
	paint,
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

/** What ends a note line cut to the terminal's width. */
const CUT_MARK = "…";
const CUT_MARK_CELLS = Bun.stringWidth(CUT_MARK);
/** What follows a concert's status in `ls` when its instances have notes. */
const NOTED_MARK = "•";

/** An instance's name and its notes, by heading. */
type Noted = { name: string; notes: Record<string, string[]> };

/** The notes of `noted` under each heading, in the order first met, as `[instance, entry]` rows. */
function noteSections(noted: readonly Noted[]): Map<string, string[][]> {
	const sections = new Map<string, string[][]>();
	for (const { name, notes } of noted)
		for (const [heading, entries] of Object.entries(notes))
			sections.set(heading, [
				...(sections.get(heading) ?? []),
				...entries.map((entry) => [name, flat(entry)]),
			]);
	return sections;
}

/**
 * The lines of `noted`'s sections, each a blank line, its heading, then one `<instance>  <entry>` line each. A line
 * wider than `columns` cells is cut with `…`, followed by a dim line saying how to read the full reports.
 */
function notesLines(
	noted: readonly Noted[],
	id: string,
	color: boolean,
	columns?: number,
): string[] {
	const lines = [...noteSections(noted)].flatMap(([heading, rows]) => [
		"",
		paint("bold", heading, color),
		...table(rows).split("\n"),
	]);
	if (columns === undefined) return lines;
	const fits = (line: string) => Bun.stringWidth(line) <= columns;
	if (lines.every(fits)) return lines;
	return [
		...lines.map((line) =>
			fits(line)
				? line
				: `${painted([[line]], false, columns - CUT_MARK_CELLS)}${CUT_MARK}`,
		),
		paint("dim", `Full reports: maestro ls ${id} --json | jq .reports`, color),
	];
}

/** How many entries the notes of each of `concerts`' current instances hold, by concert id, then by heading. */
function noteCounts(
	{ store, session }: Stored,
	concerts: readonly ConcertRecord[],
): Map<string, Record<string, number>> {
	const texts = new Map(
		concerts.map((c) => [c.id, hostTextOf(session.deps.hosts, c.ir)]),
	);
	const counts = new Map(
		concerts.map((c): [string, Record<string, number>] => [c.id, {}]),
	);
	for (const { concert, node, enrichment } of store.enrichments([
		...texts.keys(),
	])) {
		const count = counts.get(concert) ?? {};
		const hostText = texts.get(concert);
		const notes = hostText ? notesOf(enrichment, node, hostText) : {};
		for (const [heading, entries] of Object.entries(notes))
			count[heading] = (count[heading] ?? 0) + entries.length;
	}
	return counts;
}

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

/** What `ls --help` adds: the fields of the reports `--json` gives, as the hosts word them. */
async function reportHelp(args: readonly string[], deps: Deps) {
	const fields = deps.hosts.flatMap((h) =>
		Object.entries(h.text?.reportFields ?? {}),
	);
	if (!fields.length) return undefined;
	const color = colorOf(deps, peek(COMMON, args)).out;
	const rows = fields.map(([field, what]) => [`  ${field}`, what]);
	return `${paint("bold", "Reports", color)}\n  --json | jq .reports\n${table(rows)}`;
}

export const ls: Command = {
	usage: "ls [<concert>] [flags]",
	options: LS_OPTIONS,
	help: reportHelp,
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
	const counts = noteCounts(stored, concerts);
	const rows = await Promise.all(
		concerts.map(async (c) => ({
			...concertColumns(c),
			short: short.label(c.id, false),
			metrics: store.metrics(c.id),
			diskUse: await diskOf(stored, c.id),
			notes: counts.get(c.id) ?? {},
		})),
	);
	const text = table(
		[
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
				Object.keys(r.notes).length
					? stateWord(r.status, color, `${r.status} ${NOTED_MARK}`)
					: stateWord(r.status, color),
				tokenCell(r.metrics),
				formatBytes(r.diskUse),
			]),
		],
		color,
	);
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
	const hostText = hostTextOf(session.deps.hosts, row.ir);
	const instances = instancesInOrder(store, row);
	const named = instances.map((i) => ({
		...i,
		name: instanceName(row.ir, i),
		notes: i.stale ? {} : notesOf(i.enrichment, i.node, hostText),
		report: i.stale ? undefined : reportOf(i.enrichment, i.node, hostText),
	}));
	const short = shortIds(store.ids()).label(row.id, false);
	if (json) {
		session.deps.stdout(
			jsonOf({
				...concertColumns(row),
				short,
				metrics: store.metrics(row.id),
				instances,
				reports: Object.fromEntries(
					named.flatMap((i) => (i.report ? [[i.name, i.report]] : [])),
				),
			}),
		);
		return EXIT.ok;
	}
	const text = table(
		[
			["instance", "status", "stale", "agent", "reason"],
			...named.map((i) => [
				i.name,
				stateWord(i.status, color),
				staleCell(i),
				agentText(actorOf(i.enrichment, i.node, hostText), i.metrics),
				i.reason ?? "",
			]),
		],
		color,
	);
	const notes = notesLines(
		named,
		short,
		color,
		session.deps.terminal?.().columns,
	);
	session.deps.stdout([text, ...notes].join("\n"));
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
