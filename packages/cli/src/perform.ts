import { basename, join } from "node:path";
import {
	type Concert,
	type ConcertRecord,
	type ConcertResult,
	perform as conduct,
	type Records,
	Unencorable,
	unresumable,
} from "@maestro/core/perform";
import { mapWorkers } from "@maestro/ir";
import { shortIds } from "@maestro/render-text/live";
import { STDLIB_HASH, STDLIB_MODULE } from "@maestro/sdk/loader";
import { changesOf } from "./changeset";
import {
	COMMON,
	type Colors,
	type Command,
	colorOf,
	type Deps,
	isSet,
	only,
	parse,
	peek,
	splitFirst,
	textOf,
	type Values,
} from "./command";
import type { Overrides } from "./config";
import {
	concertDoc,
	EXIT,
	encoreRefused,
	exitOf,
	jsonOf,
	NAME_CONCERT,
	parseTour,
	printClosing,
	renderDiagnostic,
	resumeRefused,
} from "./output";
import {
	compositionHelp,
	PERFORM_FLAGS,
	type Prepared,
	preflight,
	prepare,
	requireNoParamFiles,
	resumable,
} from "./prepare";
import {
	artifactsOf,
	concertOf,
	locating,
	openSession,
	overridesOf,
	recordedOf,
	type Session,
	withRecord,
	withSession,
} from "./session";

/** The environment variable that puts a new concert on a tour when `--tour` is not given. */
const TOUR_VARIABLE = "MAESTRO_TOUR";

const PERFORM_OPTIONS = { ...COMMON, ...PERFORM_FLAGS } as const;

/** A prepared concert: the session it is performed in, what to perform, and how it is recorded. */
type Start = {
	session: Session;
	prepared: Prepared;
	/** The id of the concert to resume. */
	resume?: string;
	/** The id of the concert a new one is an encore of. */
	encore?: string;
	/** The `--preset` and `-c` a new concert records. */
	overrides?: Overrides;
	tour?: string;
	title?: string;
};

const tourOf = (values: Values, env: Deps["env"]) => {
	const flag = textOf(values, "tour");
	if (flag !== undefined) return parseTour("--tour", flag);
	const variable = env[TOUR_VARIABLE];
	return variable ? parseTour(TOUR_VARIABLE, variable) : undefined;
};

/**
 * A new concert from `args`, over the params `recorded` for an encore, each stdlib reference keyed on the stdlib this
 * engine embeds (ADR 0008).
 */
async function begin(
	session: Session,
	args: readonly string[],
	recorded?: Readonly<Record<string, unknown>>,
): Promise<Start> {
	const prepared = await prepare(
		session,
		{
			verb: recorded ? "encore" : "perform",
			options: PERFORM_OPTIONS,
			examples: false,
			recorded,
		},
		args,
	);
	if (prepared.staged === undefined)
		requireNoParamFiles(prepared.ir, args[0] ?? "");
	const ir = mapWorkers(prepared.ir, (ref) =>
		ref.module === STDLIB_MODULE ? { ...ref, codeHash: STDLIB_HASH } : ref,
	);
	return {
		session,
		prepared: { ...prepared, ir },
		overrides: overridesOf(prepared.values),
		tour: tourOf(prepared.values, session.deps.env),
		title: textOf(prepared.values, "title") || undefined,
	};
}

/**
 * The overrides an encore of `row` layers and records: its own `--preset` list in place of the concert's whole list when
 * it gives any, and its own `-c` after the concert's.
 */
function encoreOverrides(store: Records, row: ConcertRecord, own: Overrides) {
	const { recorded } = recordedOf(store, row);
	const replaced = own.presets !== undefined && own.presets.length > 0;
	return {
		layers: [
			replaced ? { presets: own.presets } : { presets: row.presets, recorded },
			{ config: row.config, recorded },
			{ config: own.config },
		],
		kept: {
			presets: replaced ? own.presets : row.presets,
			config: [...(row.config ?? []), ...(own.config ?? [])],
		},
	};
}

/**
 * An encore of the concert whose id starts with `prefix`: its composition performed anew with the flags of `args` over
 * its recorded params, under the config files as they stand layered with its `--preset` and `-c` and the encore's `own`.
 * @throws CliError, a usage error, when `args` hold a composition.
 * @throws ConfigError as `openSession` does.
 */
async function encored(
	session: Session,
	store: Records,
	prefix: string,
	own: Overrides,
	args: readonly string[],
): Promise<Start> {
	const row = concertOf(store, prefix);
	const { layers, kept } = encoreOverrides(store, row, own);
	const { config } = await openSession(session.deps, ...layers);
	const target =
		row.file === undefined
			? `${row.pack}.${row.composition}`
			: join(row.moduleDir, row.file);
	const start = await begin(
		{ ...session, config },
		[target, ...args],
		row.params ?? {},
	);
	return { ...start, encore: row.id, overrides: kept };
}

/**
 * The concert whose id starts with `prefix`, to resume, with its code as it stands now, and the config files as they
 * stand layered with its recorded `--preset` and `-c`, then the resume's own. Its record store and concert files stay
 * those of `session`, where it was found, whatever `dataRoot` that config holds.
 * @throws CliError when core refuses to resume it or its code is gone.
 * @throws ConfigError as `openSession` does.
 */
async function restart(
	session: Session,
	store: Records,
	prefix: string,
	values: Values,
): Promise<Start> {
	const row = concertOf(store, prefix);
	const refused = unresumable(row);
	if (refused) throw resumeRefused(refused);
	const { config } = await openSession(
		session.deps,
		recordedOf(store, row),
		overridesOf(values),
	);
	const resumed = { ...session, config };
	return {
		session: resumed,
		prepared: await resumable(resumed, row, values),
		resume: row.id,
	};
}

const SIGNAL_EXITS = {
	SIGINT: EXIT.interrupted,
	SIGTERM: EXIT.terminated,
} as const;

/** Cancels `concert` on SIGINT or SIGTERM, until it settles; `stopped` is the exit code of the first signal. */
async function settled(
	concert: Concert,
): Promise<{ result: ConcertResult; stopped?: number }> {
	const signals = ["SIGINT", "SIGTERM"] as const;
	let stopped: number | undefined;
	const stops = signals.map((signal) => {
		const stop = () => {
			stopped ??= SIGNAL_EXITS[signal];
			void concert.cancel();
		};
		process.once(signal, stop);
		return [signal, stop] as const;
	});
	try {
		return { result: await concert.done, stopped };
	} finally {
		for (const [signal, stop] of stops) process.off(signal, stop);
	}
}

/** Prints how the concert ended and the outputs its result carries, and gives its exit code. */
async function report(
	session: Session,
	store: Records,
	json: boolean,
	{ color, values }: { color: Colors; values: Values },
	id: string,
	{ result, stopped }: { result: ConcertResult; stopped?: number },
): Promise<number> {
	const { deps } = session;
	if (json)
		deps.stdout(
			jsonOf(concertDoc(store, id, result, artifactsOf(session, id))),
		);
	else
		printClosing(deps, store, concertOf(store, id), result, {
			color,
			artifacts: artifactsOf(session, id),
			changes: await changesOf({ session, store, values }, id),
		});
	if (stopped === undefined) return exitOf(result.outcome);
	if (stopped === EXIT.interrupted && !json)
		deps.stderr(
			`Resume it: maestro resume ${shortIds(store.ids()).label(id, false)}`,
		);
	return stopped;
}

/** Pre-flights `start`, printing what it warns of. */
async function warned({ session, prepared }: Start): Promise<void> {
	const color = colorOf(session.deps, prepared.values);
	for (const d of (await preflight(session, prepared)).diagnostics)
		session.deps.stderr(renderDiagnostic(d, color.err));
}

/** Performs `start`, once pre-flown, in its session, and reports how it ended. */
async function conducted(
	{ session, prepared, ...start }: Start,
	store: Records,
	json: boolean,
): Promise<number> {
	const { deps } = session;
	const color = colorOf(deps, prepared.values);
	const concert = await conduct({
		hosts: deps.hosts,
		config: prepared.config,
		roots: session.config.roots,
		loadCode: prepared.loader.loadCode,
		recordPath: session.files.record,
		dir: session.files.concerts,
		concurrency: session.config.core.concurrency,
		limits: session.config.core.limits,
		ir: prepared.ir,
		...(start.resume === undefined
			? {
					encore: start.encore,
					stage: prepared.staged,
					origin: {
						workspace: session.config.core.workspace,
						moduleDir: prepared.moduleDir,
						file: prepared.file && basename(prepared.file),
						tour: start.tour,
						title: start.title,
						params: prepared.params,
						...start.overrides,
					},
				}
			: { resume: start.resume }),
	}).catch((error) => {
		throw error instanceof Unencorable ? encoreRefused(error) : error;
	});
	deps.stderr(`concert ${concert.id}`);
	if (deps.stderrTerminal && !json)
		deps.stderr(
			`Follow it: maestro watch ${shortIds(store.ids()).label(concert.id, false)}`,
		);
	const settledConcert = await settled(concert);
	return report(
		session,
		store,
		json,
		{
			color,
			values: {
				preset: prepared.values.preset,
				config: prepared.values.config,
			},
		},
		concert.id,
		settledConcert,
	);
}

/** Pre-flights and performs what `started` makes in the session `locating` finds, and gives the exit code. */
async function inStore(
	deps: Deps,
	own: Overrides,
	json: boolean,
	started: (session: Session, store: Records) => Promise<Start>,
) {
	return withSession(
		deps,
		await locating(deps, own),
		async (session, store) => {
			const start = await started(session, store);
			await warned(start);
			return conducted(start, store, json);
		},
	);
}

export const perform: Command = {
	usage: "perform <composition> [flags]  (alias: p)",
	arguments: [
		[
			"<composition>",
			"A .ts, .js or .json file, or <pack>.<composition> as 'maestro repertoire' lists it",
		],
	],
	examples: [
		[
			"Perform a pack's composition with one of its params",
			'maestro perform classics.build_then_repair --request "Add a --verbose flag"',
		],
		[
			"Rehearse with the stub preset, which spends nothing",
			'maestro perform .maestro/slice.ts --preset stub --request "Add a --verbose flag" --tier small',
		],
		[
			"Put the concert on a tour, with a title",
			'maestro perform classics.build_then_repair --request "Add a --verbose flag" --tour epic.story --title "Verbose flag"',
		],
	],
	options: PERFORM_OPTIONS,
	help: compositionHelp,
	async execute(args, deps) {
		const early = peek(PERFORM_OPTIONS, args);
		const session = await openSession(deps, overridesOf(early));
		const start = await begin(session, args);
		await warned(start);
		return withRecord(session, (store) =>
			conducted(start, store, isSet(early, "json")),
		);
	},
};

export const resume: Command = {
	usage: "resume <concert> [flags]  (alias: r)",
	arguments: [["<concert>", "A concert, as 'maestro ls' lists it"]],
	examples: [
		[
			"Resume a failed concert after fixing what failed",
			"maestro resume 7f3c2a",
		],
		[
			"Resume with a config value changed",
			"maestro resume 7f3c2a -c concurrency=2",
		],
	],
	options: COMMON,
	async execute(args, deps) {
		const { values, positionals } = parse(
			COMMON,
			args,
			"Flags are listed in 'maestro resume --help'",
		);
		const prefix = only(positionals, "concert", NAME_CONCERT);
		return inStore(
			deps,
			overridesOf(values),
			isSet(values, "json"),
			(s, store) => restart(s, store, prefix, values),
		);
	},
};

export const encore: Command = {
	usage: "encore <concert> [flags]  (alias: e)",
	arguments: [["<concert>", "A concert, as 'maestro ls' lists it"]],
	examples: [
		[
			"Perform a concert's composition again as a new concert",
			"maestro encore 7f3c2a",
		],
		[
			"Change one of its params",
			'maestro encore 7f3c2a --request "Add a --quiet flag"',
		],
	],
	options: PERFORM_OPTIONS,
	async execute(args, deps) {
		const { first, rest } = splitFirst(PERFORM_OPTIONS, args);
		const prefix = only(
			first === undefined ? [] : [first],
			"concert",
			NAME_CONCERT,
		);
		const early = peek(PERFORM_OPTIONS, rest);
		const own = overridesOf(early);
		return inStore(deps, own, isSet(early, "json"), (s, store) =>
			encored(s, store, prefix, own, rest),
		);
	},
};
