import type { Metrics } from "@maestro/core/host";
import {
	type ConcertFilter,
	type ConcertRecord,
	openRecord,
} from "@maestro/core/perform";
import { compact, DURATION_EXAMPLE, MS_PER_UNIT, tokensOf } from "@maestro/ir";
import {
	agentText,
	cutTo,
	duration,
	flat,
	hintLine,
	type ShortIds,
	shortIds,
	stateWord,
} from "@maestro/render-text/live";
import { changesOf } from "./changeset";
import {
	COMMON,
	type Command,
	colorOf,
	type Deps,
	FILTER_OPTIONS,
	filterOf,
	type Options,
	only,
	peek,
	textOf,
	type Values,
} from "./command";
import { actorOf, hostTextOf, notesOf, reportOf } from "./host-text";
import {
	ArgumentError,
	CliError,
	concertDoc,
	EXIT,
	exitOf,
	formatBytes,
	instanceName,
	jsonOf,
	NAME_CONCERT,
	nameOf,
	paint,
	parseCount,
	parseDuration,
	parseTour,
	printClosing,
	resultDoc,
	spendOf,
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

/** What follows a concert's status in `ls` when its instances have notes. */
const NOTED_MARK = "•";

/** What `ls --help` says of the mark. */
const NOTED_HELP = `${NOTED_MARK} after a status: its instances left notes ('maestro ls <concert>' shows them)`;

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
 * wider than `columns` cells is cut with `…`, followed by a dim hint line saying how to read the full reports.
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
	const cut = lines.map((line) => cutTo(line, columns));
	if (cut.every((line, i) => line === lines[i])) return lines;
	return [
		...cut,
		hintLine(`Full reports: maestro ls ${id} --json | jq .reports`, color),
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
 * @throws ArgumentError for more than one concert, and CliError, a usage error, for a bad filter or limit.
 */
function lsChecked(values: Values, positionals: readonly string[]) {
	const [id, instance, ...rest] = positionals;
	if (rest.length > 0)
		throw new ArgumentError(
			`takes at most a concert and an instance, got ${positionals.length}`,
			"Name one concert, and one of its instances, or none to list the concerts",
		);
	if (id === undefined && instance !== undefined)
		throw new ArgumentError("takes an instance after a concert", NAME_CONCERT);
	const limit = textOf(values, "limit");
	const query = {
		...filterOf(values),
		limit: limit === undefined ? LIST_LIMIT : parseCount("--limit", limit),
	};
	return { id, instance, query };
}

/** What `ls --help` adds: the mark, and the fields of the reports `--json` gives, as the hosts word them. */
async function reportHelp(args: readonly string[], deps: Deps) {
	const fields = deps.hosts.flatMap((h) =>
		Object.entries(h.text?.reportFields ?? {}),
	);
	if (!fields.length) return NOTED_HELP;
	const color = colorOf(deps, peek(COMMON, args)).out;
	const rows = fields.map(([field, what]) => [`  ${field}`, what]);
	return `${NOTED_HELP}\n\n${paint("bold", "Reports", color)}\n  --json | jq .reports\n${table(rows)}`;
}

export const ls: Command = {
	pages: true,
	usage: "ls [<concert> [<instance>]] [flags]",
	arguments: [
		[
			"<concert>",
			"A concert, as 'maestro ls' lists it; without it, the concerts are listed",
		],
		[
			"<instance>",
			"One of the concert's instances, as 'maestro ls <concert>' lists it, or a unique ending of its name; its row and notes alone",
		],
	],
	options: LS_OPTIONS,
	examples: [
		["Which concerts failed?", "maestro ls --status failed"],
		[
			"Every concert on the epic tour and the tours under it, such as epic.story",
			"maestro ls --tour epic",
		],
		["One concert's node instances", "maestro ls 7f3c2a"],
		["One instance's row and notes", "maestro ls 7f3c2a build"],
	],
	help: reportHelp,
	execute: (args, deps) =>
		withStore(
			LS_OPTIONS,
			args,
			deps,
			"Flags are listed in 'maestro ls --help'",
			lsChecked,
			async (stored, { id, instance, query }) =>
				id === undefined
					? listed(stored, query)
					: instancesOf(stored, id, instance),
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

/** The empty list: `[]` under `--json`, else what matched nothing and what to do about it on stderr. */
function none({ session: { deps }, json }: Stored, filtered: boolean) {
	if (json) deps.stdout(jsonOf([]));
	else if (filtered) {
		deps.stderr("no concerts match");
		deps.stderr("Drop a filter, or run 'maestro ls' for all");
	} else {
		deps.stderr("no concerts");
		deps.stderr("Perform one with 'maestro perform <pack>.<composition>'");
	}
	return EXIT.ok;
}

async function listed(stored: Stored, query: ConcertFilter) {
	const { session, store, values, json } = stored;
	const color = colorOf(session.deps, values).out;
	const limit = query.limit ?? LIST_LIMIT;
	const fetched = store.concerts({ ...query, limit: limit + 1 });
	const concerts = fetched.slice(0, limit);
	const marked = session.deps.terminal !== undefined;
	if (concerts.length === 0) {
		const { limit: _, ...filter } = query;
		return none(
			stored,
			Object.values(filter).some((v) => v !== undefined),
		);
	}
	const short = shortIds(store.ids());
	const counts = noteCounts(stored, concerts);
	const rows = await Promise.all(
		concerts.map(async (c) => ({
			...concertColumns(c),
			short: short.label(c.id, false),
			...spendOf(store, c.id),
			diskUse: await diskOf(stored, c),
			notes: counts.get(c.id) ?? {},
		})),
	);
	const text = table(
		[
			[
				"id",
				"status",
				"time",
				"title",
				"tour",
				"workspace",
				"composition",
				"tokens",
				"disk",
			],
			...rows.map((r) => [
				r.short,
				marked && Object.keys(r.notes).length
					? stateWord(r.status, color, `${r.status} ${NOTED_MARK}`)
					: stateWord(r.status, color),
				duration(r.elapsedMs),
				dash(r.title),
				dash(r.tour),
				dash(r.workspace),
				`${r.pack}.${r.composition}`,
				tokenCell(r.metrics),
				formatBytes(r.diskUse),
			]),
		],
		color,
	);
	const shown = color ? highlighted(short, rows, text) : text;
	const more =
		!json && session.deps.terminal && fetched.length > limit
			? `\n${olderHint(values, limit, color)}`
			: "";
	session.deps.stdout(json ? jsonOf(rows) : shown + more);
	return EXIT.ok;
}

/** `value` as one shell word: as it is when plain, otherwise in single quotes. */
const shellWord = (value: string) =>
	/^[A-Za-z0-9._/:@-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", "'\\''")}'`;

/** The hint after a list the limit cut: `ls` with the filters given and twice the limit. */
export function olderHint(values: Values, limit: number, color: boolean) {
	const filters = ["status", "composition", "tour", "workspace"].flatMap(
		(name) => {
			const value = textOf(values, name);
			return value === undefined ? [] : [` --${name} ${shellWord(value)}`];
		},
	);
	return hintLine(
		`Older concerts: maestro ls${filters.join("")} --limit ${limit * 2}`,
		color,
	);
}

async function instancesOf(
	{ session, store, values, json }: Stored,
	prefix: string,
	which?: string,
) {
	const color = colorOf(session.deps, values).out;
	const row = concertOf(store, prefix);
	const hostText = hostTextOf(session.deps.hosts, row.ir);
	const every = instancesInOrder(store, row);
	const chosen =
		which === undefined
			? undefined
			: nameOf(
					which,
					every.map((i) => instanceName(row.ir, i)),
					row.id,
				);
	const instances = every.filter(
		(i) => chosen === undefined || instanceName(row.ir, i) === chosen,
	);
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
				...spendOf(store, row.id),
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

/**
 * The concert to wait for, and the limit to wait for it, if any.
 * @throws CliError, a usage error, for other than one concert, or a bad `--timeout`.
 */
function waitChecked(values: Values, positionals: readonly string[]) {
	const timeout = textOf(values, "timeout");
	return {
		prefix: only(positionals, "concert", NAME_CONCERT),
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
			jsonOf(concertDoc(store, id, result, artifactsOf(session, id))),
		);
	else if (result)
		printClosing(deps, store, concertOf(store, id), result, {
			color: colorOf(deps, values),
			artifacts: artifactsOf(session, id),
			changes: await changesOf({ session, store, values }, id),
		});
	else
		deps.stderr(
			`concert ${id} is still running after ${timeout}\nWait again, or stop it with 'maestro kill ${id}'`,
		);
	return exitOf(status);
}

export const wait: Command = {
	usage: "wait <concert> [flags]  (alias: wt)",
	arguments: [["<concert>", "A concert, as 'maestro ls' lists it"]],
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

async function killed({ session, store, json }: Stored, prefix: string) {
	const { deps } = session;
	const { id, status, pid } = concertOf(store, prefix);
	if (status !== "running") {
		deps.stderr(`concert ${id} already settled ${status}`);
		if (json) deps.stdout(jsonOf(resultDoc(id, store.result(id))));
		return EXIT.ok;
	}
	if (!isMaestro(pid)) {
		reap(session, id);
		throw new CliError(
			`the process ${pid} of concert ${id} is gone, and its pid now belongs to another program\nThe concert is marked failed: resume it with 'maestro resume ${id}', or prune it`,
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
	arguments: [
		[
			"<concert>",
			"A running concert, as 'maestro ls' lists it; a settled one exits 0 and says so",
		],
	],
	options: COMMON,
	execute: (args, deps) =>
		withStore(
			COMMON,
			args,
			deps,
			"Flags are listed in 'maestro kill --help'",
			(_values, positionals) => only(positionals, "concert", NAME_CONCERT),
			killed,
		),
};

const TOUR_FIX =
	"Write maestro tour set <slug> <concert>..., or maestro tour clear <concert>...";

/** The tour to set, or `undefined` to clear, and the concerts to set it on. */
function tourAndConcerts(_values: Values, positionals: readonly string[]) {
	const [action, ...rest] = positionals;
	if (action !== "set" && action !== "clear")
		throw usageError(
			`expected set or clear, got ${action === undefined ? "nothing" : `'${action}'`}`,
			TOUR_FIX,
		);
	const [first, ...named] = rest;
	const ids = action === "clear" ? rest : named;
	if (ids.length === 0)
		throw new ArgumentError(
			`${action} needs ${action === "set" ? "a slug and " : ""}at least one concert`,
			TOUR_FIX,
		);
	return {
		slug:
			action === "clear" ? undefined : parseTour("the tour slug", first ?? ""),
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
		"tour set <slug> <concert>... [flags]  (alias: t)\n       maestro tour clear <concert>... [flags]",
	arguments: [
		["<slug>", "The tour, such as epic or epic.story"],
		["<concert>", "A concert, as 'maestro ls' lists it"],
	],
	options: COMMON,
	examples: [
		["Put two concerts on a tour", "maestro tour set epic.story 7f3c2a 9b1d04"],
		["Take a concert off its tour", "maestro tour clear 7f3c2a"],
	],
	execute: (args, deps) =>
		withStore(
			COMMON,
			args,
			deps,
			"Flags are listed in 'maestro tour --help'",
			tourAndConcerts,
			toured,
		),
};
