import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type ConcertFilter,
	type ConcertRecord,
	diskUseOf,
} from "@maestro/core/perform";
import { DURATION_EXAMPLE, messageOf } from "@maestro/ir";
import { duration } from "@maestro/render-text/live";
import {
	type Command,
	FILTER_OPTIONS,
	filterOf,
	isSet,
	type Options,
	RECORDED,
	textOf,
	type Values,
	warn,
} from "./command";
import {
	EXIT,
	elapsedOf,
	formatBytes,
	jsonOf,
	parseDuration,
	STATUSES,
	stillRunning,
	table,
	usageError,
} from "./output";
import {
	concertsOf,
	type Located,
	openRecorded,
	type Stored,
	setupsOf,
	withStore,
} from "./session";

const SETTLED = STATUSES.filter((s) => s !== "running");

const PRUNE_OPTIONS = {
	...RECORDED,
	before: {
		type: "string",
		arg: "duration",
		desc: `Prune concerts that settled longer ago than this, such as ${DURATION_EXAMPLE}`,
	},
	all: {
		type: "boolean",
		desc: "Prune every settled concert, leaving running ones out",
	},
	...FILTER_OPTIONS,
	status: {
		...FILTER_OPTIONS.status,
		desc: `Only concerts that are ${SETTLED.join(", ")}`,
	},
	yes: { type: "boolean", desc: "Do not ask before deleting" },
	"dry-run": {
		type: "boolean",
		short: "n",
		desc: "List the concerts it would prune, and prune nothing; one per line, full id first, no header",
	},
} as const satisfies Options;

/** A concert that stays, and why. */
type Failure = { id: string; reason: string };

const FILTER_FLAGS = [
	"before",
	"tour",
	"workspace",
	"status",
	"composition",
] as const;

/**
 * The filter of the prune flags.
 * @throws CliError, a usage error, for a bad filter value or `--status running`.
 */
function prunable(values: Values): ConcertFilter {
	const filter = filterOf(values);
	if (filter.status === "running")
		throw usageError(
			"--status running cannot be pruned, a running concert has not settled",
			"Pick another status, or stop the concert with 'maestro kill <concert>' first",
		);
	return filter;
}

/** The time before which a concert must have settled to be pruned, or infinity when `--before` is absent. */
function cutoffOf(values: Values): number {
	const before = textOf(values, "before");
	return before === undefined
		? Number.POSITIVE_INFINITY
		: Date.now() - parseDuration("--before", before);
}

/** The concerts to prune: those named, or those matching `filter` that settled before `cutoff`; `--all` is the empty filter at any age. */
type Selection =
	| { named: readonly string[] }
	| { filter: ConcertFilter; cutoff: number };

/**
 * The selection the flags and positionals make.
 * @throws CliError, a usage error, for a selection that is none or more than one, or a bad filter value.
 */
function selectionChecked(
	values: Values,
	positionals: readonly string[],
): Selection {
	const filtered = FILTER_FLAGS.some((f) => textOf(values, f) !== undefined);
	if (isSet(values, "all")) return everyChecked(positionals, filtered);
	if (positionals.length > 0 && filtered)
		throw usageError(
			"prune takes concert ids or filters, not both",
			"Drop the ids, or drop --before, --tour, --workspace, --status and --composition",
		);
	if (positionals.length > 0) return { named: positionals };
	if (!filtered)
		throw usageError(
			"prune needs concert ids, --all, --before, --tour, --workspace, --status or --composition",
			"Name concerts, pass --all, or pick them with a filter from 'maestro prune --help'",
		);
	return { cutoff: cutoffOf(values), filter: prunable(values) };
}

/**
 * The selection of `--all`: every settled concert.
 * @throws CliError, a usage error, when ids or a filter come with it.
 */
function everyChecked(
	positionals: readonly string[],
	filtered: boolean,
): Selection {
	if (positionals.length > 0 || filtered)
		throw usageError(
			"prune takes --all alone, without concert ids or filters",
			"Drop --all, or drop the ids and --before, --tour, --workspace, --status and --composition",
		);
	return { filter: {}, cutoff: Number.POSITIVE_INFINITY };
}

/**
 * The settled concerts to prune: those named, or those matching the filters, at any age when `--before` is absent.
 * @throws CliError for a named concert that is running.
 */
function selected({ store }: Stored, selection: Selection): ConcertRecord[] {
	if ("named" in selection) {
		const named = concertsOf(store, selection.named);
		const running = named.find((c) => c.status === "running");
		if (running) throw stillRunning(running.id, running.pid);
		return named;
	}
	const { filter, cutoff } = selection;
	return store
		.concerts(filter)
		.filter((c) => c.settledAt !== undefined && c.settledAt < cutoff);
}

/**
 * The bytes `concert` holds: its directory under the data root, and what each host reports holding for it under its
 * config as `openRecorded` opens it. The record's size, else measured once and kept there. A host that cannot measure
 * its share counts none, why goes to stderr, and nothing is kept.
 */
async function diskOf(
	{ session, store, values }: Stored,
	concert: ConcertRecord,
): Promise<number> {
	const { id, diskUse } = concert;
	if (diskUse !== undefined) return diskUse;
	const { bytes, failures } = await diskUseOf(
		session.files.concerts,
		id,
		session.deps.hosts,
		await setupsOf(session, openRecorded(session, store, concert)),
	);
	for (const { host, error } of failures)
		warn(
			session.deps,
			values,
			`host '${host}' cannot measure concert ${id}: ${messageOf(error)}`,
		);
	if (failures.length === 0) store.setDiskUse(id, bytes);
	return bytes;
}

/** What a concert that prune refuses is told to do instead. */
const CLEANUP =
	"Clean it up with scripts/prune-old-concerts.sh from the v0.3.0 maestro skill";

/**
 * Releases what each host holds for `row`, under its recorded config.
 * @returns why the concert stays, if it does: its snapshot does not read or compose, or a host cannot release it.
 */
async function released(
	{ session, store }: Stored,
	row: ConcertRecord,
): Promise<string | undefined> {
	const opened = openRecorded(session, store, row);
	if (opened.kind !== "composes")
		return `${"problem" in opened ? opened.problem : messageOf(opened.error)}\n${CLEANUP}`;
	const setup = await setupsOf(session, opened);
	for (const host of session.deps.hosts) {
		try {
			await host.resources?.release(row.id, setup(host));
		} catch (error) {
			return `host '${host.name}' could not release it: ${messageOf(error)}`;
		}
	}
	return undefined;
}

/**
 * Releases what each host holds for `concert`, then drops its rows and directory. The concert stays when it is running
 * by now, or `released` says why it stays.
 * @returns why it stays, if it does.
 */
async function pruneOne(
	stored: Stored,
	concert: string,
): Promise<Failure | undefined> {
	const { session, store } = stored;
	const row = store.find(concert);
	if (row?.status === "running")
		return { id: concert, reason: `it is running in process ${row.pid}` };
	if (row) {
		const reason = await released(stored, row);
		if (reason !== undefined) return { id: concert, reason };
		store.remove(concert);
	}
	await rm(join(session.files.concerts, concert), {
		recursive: true,
		force: true,
	});
	return undefined;
}

async function confirmed(
	session: Located,
	yes: boolean,
	count: number,
	bytes: number,
): Promise<boolean> {
	if (yes) return true;
	if (!session.deps.confirm)
		throw usageError(
			"prune asks before it deletes, and there is no terminal to ask on",
			"Pass --yes",
		);
	return session.deps.confirm(
		`Prune ${concertsWord(count)}, freeing ${formatBytes(bytes)}?`,
	);
}

type Outcome = { pruned: string[]; freed: number; failures: Failure[] };

/** Prunes each of `targets` in turn, `sizes` being what each holds. */
async function pruneAll(
	stored: Stored,
	targets: readonly ConcertRecord[],
	sizes: readonly number[],
): Promise<Outcome> {
	const outcome: Outcome = { pruned: [], freed: 0, failures: [] };
	for (const [i, { id }] of targets.entries()) {
		const failure = await pruneOne(stored, id);
		if (failure) outcome.failures.push(failure);
		else {
			outcome.pruned.push(id);
			outcome.freed += sizes[i] ?? 0;
		}
	}
	return outcome;
}

function report({ session: { deps }, json }: Stored, outcome: Outcome) {
	if (json) return deps.stdout(jsonOf(outcome));
	for (const id of outcome.pruned) deps.stdout(id);
	deps.stderr(
		`pruned ${outcome.pruned.length}, freed ${formatBytes(outcome.freed)}`,
	);
	for (const f of outcome.failures)
		deps.stderr(
			// A reason of several lines already ends in its own fix.
			f.reason.includes("\n")
				? `concert ${f.id} kept: ${f.reason}`
				: `concert ${f.id} kept: ${f.reason}\nFix that, then prune it again`,
		);
}

const concertsWord = (count: number) =>
	`${count} concert${count === 1 ? "" : "s"}`;

/** Lists `targets`, each with its status, time and size, and what pruning them would free, and prunes nothing. */
function rehearsed(
	{ session: { deps }, json }: Stored,
	targets: readonly ConcertRecord[],
	sizes: readonly number[],
	total: number,
) {
	if (json)
		deps.stdout(
			jsonOf({
				pruned: [],
				wouldPrune: targets.map((c, i) => ({ id: c.id, bytes: sizes[i] })),
				freed: 0,
				wouldFree: total,
				failures: [],
			}),
		);
	else {
		if (targets.length > 0)
			deps.stdout(
				table(
					targets.map((c, i) => [
						c.id,
						c.status,
						duration(elapsedOf(c)),
						formatBytes(sizes[i] ?? 0),
					]),
				),
			);
		deps.stderr(
			`would prune ${concertsWord(targets.length)}, freeing ${formatBytes(total)}`,
		);
	}
	return EXIT.ok;
}

async function pruned(stored: Stored, selection: Selection) {
	const { session, values, json } = stored;
	const targets = selected(stored, selection);
	const sizes = await Promise.all(targets.map((c) => diskOf(stored, c)));
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (isSet(values, "dry-run")) return rehearsed(stored, targets, sizes, total);
	if (
		targets.length > 0 &&
		!(await confirmed(session, isSet(values, "yes"), targets.length, total))
	) {
		if (json)
			session.deps.stdout(jsonOf({ pruned: [], freed: 0, failures: [] }));
		else session.deps.stderr("nothing pruned");
		return EXIT.ok;
	}
	const outcome = await pruneAll(stored, targets, sizes);
	report(stored, outcome);
	return outcome.failures.length > 0 ? EXIT.failed : EXIT.ok;
}

export const prune: Command = {
	usage: "prune <concert>... | <filter>... | --all [flags]",
	arguments: [["<concert>", "A settled concert, as 'maestro ls' lists it"]],
	options: PRUNE_OPTIONS,
	examples: [
		[
			"See what pruning week-old concerts would free",
			"maestro prune --before 7d -n",
		],
		["Prune them", "maestro prune --before 7d"],
	],
	execute: (args, deps) =>
		withStore(
			{
				options: PRUNE_OPTIONS,
				fix: "Flags are listed in 'maestro prune --help'",
				check: selectionChecked,
			},
			args,
			deps,
			pruned,
		),
};
