import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ConcertFilter, ConcertRecord } from "@maestro/core/perform";
import { DURATION_EXAMPLE, messageOf } from "@maestro/ir";
import {
	COMMON,
	type Command,
	FILTER_OPTIONS,
	filterOf,
	isSet,
	type Options,
	textOf,
	type Values,
} from "./command";
import {
	EXIT,
	formatBytes,
	jsonOf,
	parseDuration,
	STATUSES,
	stillRunning,
	usageError,
} from "./output";
import {
	concertsOf,
	diskOf,
	type Session,
	type Stored,
	setupOf,
	withStore,
} from "./session";

const SETTLED = STATUSES.filter((s) => s !== "running");

const PRUNE_OPTIONS = {
	...COMMON,
	before: {
		type: "string",
		arg: "duration",
		desc: `Prune concerts that settled longer ago than this, such as ${DURATION_EXAMPLE}`,
	},
	...FILTER_OPTIONS,
	status: {
		...FILTER_OPTIONS.status,
		desc: `Only concerts that are ${SETTLED.join(", ")}`,
	},
	yes: { type: "boolean", desc: "Do not ask before deleting" },
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

/** The concerts to prune: those named, or those matching `filter` that settled before `cutoff`. */
type Selection =
	| { named: readonly string[] }
	| { filter: ConcertFilter; cutoff: number };

/**
 * The selection the flags and positionals make.
 * @throws CliError, a usage error, for a selection that is none or both, or a bad filter value.
 */
function selectionChecked(
	values: Values,
	positionals: readonly string[],
): Selection {
	const filtered = FILTER_FLAGS.some((f) => textOf(values, f) !== undefined);
	if (positionals.length > 0 && filtered)
		throw usageError(
			"prune takes concert ids or filters, not both",
			"Drop the ids, or drop --before, --tour, --workspace, --status and --composition",
		);
	if (positionals.length > 0) return { named: positionals };
	if (!filtered)
		throw usageError(
			"prune needs concert ids, --before, --tour, --workspace, --status or --composition",
			"Name concerts, or pick them with a filter from 'maestro prune --help'",
		);
	return { cutoff: cutoffOf(values), filter: prunable(values) };
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
 * Releases what each host holds for `concert`, then drops its rows and directory. The concert stays when it is running
 * by now, or a host cannot release it.
 * @returns why it stays, if it does.
 */
async function pruneOne(
	{ session, store }: Stored,
	concert: string,
): Promise<Failure | undefined> {
	const row = store.find(concert);
	if (row?.status === "running")
		return { id: concert, reason: `it is running in process ${row.pid}` };
	for (const host of session.deps.hosts) {
		try {
			await host.resources?.release(concert, setupOf(session, host));
		} catch (error) {
			return {
				id: concert,
				reason: `host '${host.name}' could not release it: ${messageOf(error)}`,
			};
		}
	}
	if (row) store.remove(concert);
	await rm(join(session.files.concerts, concert), {
		recursive: true,
		force: true,
	});
	return undefined;
}

async function confirmed(
	session: Session,
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
		`Prune ${count} concert${count === 1 ? "" : "s"}, freeing ${formatBytes(bytes)}?`,
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

async function pruned(stored: Stored, selection: Selection) {
	const { session, values, json } = stored;
	const targets = selected(stored, selection);
	const sizes = await Promise.all(targets.map((c) => diskOf(session, c.id)));
	const total = sizes.reduce((sum, size) => sum + size, 0);
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
	usage: "prune <concert>... | <filter>... [flags]",
	options: PRUNE_OPTIONS,
	execute: (args, deps) =>
		withStore(
			PRUNE_OPTIONS,
			args,
			deps,
			"Flags are listed in 'maestro prune --help'",
			selectionChecked,
			pruned,
		),
};
