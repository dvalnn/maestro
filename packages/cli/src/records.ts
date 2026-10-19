import { styleText } from "node:util";
import type { Metrics } from "@maestro/core/host";
import {
	type ConcertRecord,
	type ConcertStatus,
	openRecord,
	type Records,
} from "@maestro/core/perform";
import { DURATION_EXAMPLE, MS_PER_UNIT } from "@maestro/ir";
import {
	agentText,
	arranged,
	compact,
	idSegs,
	tokensOf,
	uniqueLength,
} from "@maestro/render-text/live";
import {
	COMMON,
	type Command,
	colorOn,
	isSet,
	type Options,
	only,
	textOf,
	type Values,
} from "./command";
import {
	CliError,
	closingLine,
	EXIT,
	exitOf,
	formatBytes,
	instanceName,
	jsonOf,
	outputsText,
	parseCount,
	parseDuration,
	parseTour,
	resultDoc,
	table,
	usageError,
} from "./output";
import {
	artifactsOf,
	concertOf,
	concertsOf,
	diskOf,
	isMaestro,
	type Session,
	type Stored,
	withStore,
} from "./session";

const STATUSES: readonly ConcertStatus[] = [
	"running",
	"ok",
	"failed",
	"rejected",
];
const LIST_LIMIT = 20;
/** How long `kill` waits for a concert to settle after it signals its process. */
const KILL_GRACE_S = 10;
const KILL_GRACE_MS = KILL_GRACE_S * MS_PER_UNIT.s;

const LS_OPTIONS = {
	...COMMON,
	status: {
		type: "string",
		arg: "status",
		desc: `Only concerts that are ${STATUSES.join(", ")}`,
	},
	composition: {
		type: "string",
		arg: "pack.name",
		desc: "Only this composition, as <pack>.<composition>",
	},
	tour: { type: "string", arg: "slug", desc: "Only this tour" },
	workspace: { type: "string", arg: "name", desc: "Only this workspace" },
	limit: {
		type: "string",
		arg: "count",
		desc: `Show at most this many, newest first (default ${LIST_LIMIT})`,
	},
} as const satisfies Options;

const concertColumns = ({ ir: _ir, ...row }: ConcertRecord) => row;

const tokenCell = (metrics: Metrics) => {
	const tokens = tokensOf(metrics);
	return tokens > 0 ? compact(tokens) : "-";
};

const dash = (text: string | undefined) => text || "-";

function statusOf(text: string | undefined): ConcertStatus | undefined {
	if (text === undefined) return undefined;
	const status = STATUSES.find((s) => s === text);
	if (!status)
		throw usageError(
			`--status takes one of ${STATUSES.join(", ")}, not '${text}'`,
			"Pick one of those",
		);
	return status;
}

/**
 * The pack and composition filters of `--composition <pack>.<composition>`.
 * @throws CliError, a usage error, for any other form.
 */
function compositionOf(text: string | undefined) {
	if (text === undefined) return {};
	const dot = text.indexOf(".");
	if (dot < 1 || dot === text.length - 1)
		throw usageError(
			`--composition takes <pack>.<composition>, not '${text}'`,
			"Write it as greet.hello",
		);
	return { pack: text.slice(0, dot), composition: text.slice(dot + 1) };
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
			async (stored) => {
				const [id, ...rest] = stored.positionals;
				if (rest.length > 0)
					throw usageError(
						`expected at most one concert, got ${stored.positionals.length}`,
						"Name one concert, or none to list them all",
					);
				return id === undefined ? listed(stored) : instancesOf(stored, id);
			},
		),
};

/** `text`, the table of `rows`, with each id's first characters that no other id shares in bold and the rest dim. */
function highlighted(
	{ deps }: Session,
	store: Records,
	rows: readonly { id: string }[],
	text: string,
): string {
	if (!deps.terminal || !colorOn(deps)) return text;
	const all = store.ids();
	return text
		.split("\n")
		.map((line, i) => {
			const id = rows[i - 1]?.id;
			if (id === undefined) return line;
			const styled = idSegs(id, uniqueLength(id, all)).map(([part, style]) =>
				style && part
					? styleText(style, part, { validateStream: false })
					: part,
			);
			return styled.join("") + line.slice(id.length);
		})
		.join("\n");
}

async function listed({ session, store, values, json }: Stored) {
	const limit = textOf(values, "limit");
	const concerts = store.concerts({
		status: statusOf(textOf(values, "status")),
		...compositionOf(textOf(values, "composition")),
		tour: textOf(values, "tour"),
		workspace: textOf(values, "workspace"),
		limit: limit === undefined ? LIST_LIMIT : parseCount("--limit", limit),
	});
	const rows = await Promise.all(
		concerts.map(async (c) => ({
			...concertColumns(c),
			metrics: store.metrics(c.id),
			diskUse: await diskOf(session, c.id),
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
			r.id,
			dash(r.title),
			dash(r.tour),
			dash(r.workspace),
			`${r.pack}.${r.composition}`,
			r.status,
			tokenCell(r.metrics),
			formatBytes(r.diskUse),
		]),
	]);
	session.deps.stdout(
		json ? jsonOf(rows) : highlighted(session, store, rows, text),
	);
	return EXIT.ok;
}

async function instancesOf({ session, store, json }: Stored, prefix: string) {
	const row = concertOf(store, prefix);
	const instances = arranged(row.ir, store.instances(row.id));
	session.deps.stdout(
		json
			? jsonOf({ ...concertColumns(row), instances })
			: table([
					["instance", "status", "stale", "agent", "reason"],
					...instances.map((i) => [
						instanceName(row.ir, i),
						i.status,
						i.stale ? "stale" : "",
						agentText(i.enrichment, i.metrics),
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

async function waited({ session, store, values, positionals, json }: Stored) {
	const { deps } = session;
	const prefix = only(positionals, "concert", "Name the concert to wait for");
	const timeout = textOf(values, "timeout");
	const limit =
		timeout === undefined ? undefined : parseDuration("--timeout", timeout);
	const { ir, id } = concertOf(store, prefix);
	const result = (await store.wait(id, limit)) && store.result(id);
	const { status } = resultDoc(id, result);
	if (json)
		deps.stdout(
			jsonOf({ ...resultDoc(id, result), metrics: store.metrics(id) }),
		);
	else if (result) {
		const outputs = outputsText(ir, artifactsOf(session, id), result);
		if (outputs !== undefined) deps.stdout(outputs);
		deps.stderr(closingLine(ir, id, result));
	} else
		deps.stderr(
			`concert ${id} is still running after ${timeout}\nWait again, or stop it with 'maestro kill ${id}'`,
		);
	return exitOf(status);
}

export const wait: Command = {
	usage: "wait <concert> [flags]  (alias: w)",
	options: WAIT_OPTIONS,
	execute: (args, deps) =>
		withStore(
			WAIT_OPTIONS,
			args,
			deps,
			"Flags are listed in 'maestro wait --help'",
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

async function killed({ session, store, positionals, json }: Stored) {
	const { deps } = session;
	const prefix = only(positionals, "concert", "Name the concert to stop");
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

async function toured({
	session: { deps },
	store,
	values,
	positionals,
	json,
}: Stored) {
	const { slug, ids: prefixes } = tourAndConcerts(values, positionals);
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
			toured,
		),
};
