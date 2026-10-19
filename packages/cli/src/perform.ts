import { basename } from "node:path";
import { ConfigError } from "@maestro/core/config";
import {
	type Concert,
	type ConcertResult,
	perform as conduct,
	type Records,
	unresumable,
} from "@maestro/core/perform";
import { mapWorkers } from "@maestro/ir";
import { shortIds } from "@maestro/render-text/live";
import { STDLIB_HASH, STDLIB_MODULE } from "@maestro/sdk/loader";
import {
	COMMON,
	type Command,
	type Deps,
	isSet,
	parse,
	peek,
	textOf,
	type Values,
} from "./command";
import type { Overrides } from "./config";
import {
	exitOf,
	jsonOf,
	parseTour,
	printClosing,
	renderDiagnostic,
	resultDoc,
	resumeRefused,
	usageError,
} from "./output";
import {
	compositionHelp,
	PERFORM_FLAGS,
	type Prepared,
	preflight,
	prepare,
	resumable,
} from "./prepare";
import {
	artifactsOf,
	concertOf,
	openSession,
	overridesOf,
	type Session,
	withSession,
} from "./session";

/** The environment variable that puts a new concert on a tour when `--tour` is not given. */
const TOUR_VARIABLE = "MAESTRO_TOUR";
const FIX = "Flags are listed in 'maestro perform --help'";

const PERFORM_OPTIONS = { ...COMMON, ...PERFORM_FLAGS } as const;

/** A prepared concert: the session it is performed in, what to perform, and how it is recorded. */
type Start = {
	session: Session;
	prepared: Prepared;
	/** The id of the concert to resume. */
	resume?: string;
	tour?: string;
	title?: string;
};

const tourOf = (values: Values, env: Deps["env"]) => {
	const flag = textOf(values, "tour");
	if (flag !== undefined) return parseTour("--tour", flag);
	const variable = env[TOUR_VARIABLE];
	return variable ? parseTour(TOUR_VARIABLE, variable) : undefined;
};

/** A new concert from `args`, each stdlib reference keyed on the stdlib this engine embeds (ADR 0008). */
async function begin(
	session: Session,
	args: readonly string[],
): Promise<Start> {
	const prepared = await prepare(
		session,
		{ verb: "perform", options: PERFORM_OPTIONS, examples: false },
		args,
	);
	const ir = mapWorkers(prepared.ir, (ref) =>
		ref.module === STDLIB_MODULE ? { ...ref, codeHash: STDLIB_HASH } : ref,
	);
	return {
		session,
		prepared: { ...prepared, ir },
		tour: tourOf(prepared.values, session.deps.env),
		title: textOf(prepared.values, "title") || undefined,
	};
}

/**
 * The concert whose id starts with `prefix`, to resume, with its code as it stands now, and the config files as they
 * stand layered with its recorded `--profile` and `-c`, then the resume's own. Its record store and concert files stay
 * those of `session`, where it was found, whatever `dataRoot` that config holds.
 * @throws CliError when core refuses to resume it, its code is gone, or the flags are not a resume's.
 * @throws ConfigError as `openSession` does.
 */
async function restart(
	session: Session,
	store: Records,
	prefix: string,
	args: readonly string[],
): Promise<Start> {
	const { values, positionals } = parse(PERFORM_OPTIONS, args, FIX);
	if (
		positionals.length > 0 ||
		textOf(values, "tour") ||
		textOf(values, "title")
	)
		throw usageError(
			"--resume takes no composition, --tour or --title: the concert keeps its own",
			"Drop them, or start a new concert without --resume",
		);
	const row = concertOf(store, prefix);
	const refused = unresumable(row);
	if (refused) throw resumeRefused(refused);
	const recorded = {
		profile: row.profile,
		config: row.config,
		recorded: shortIds(store.ids()).label(row.id, false),
	};
	const { config } = await openSession(
		session.deps,
		recorded,
		overridesOf(values),
	);
	const resumed = { ...session, config };
	return {
		session: resumed,
		prepared: await resumable(resumed, row, values),
		resume: row.id,
	};
}

/** Cancels `concert` on SIGINT or SIGTERM, until it settles. */
async function settled(concert: Concert): Promise<ConcertResult> {
	const signals = ["SIGINT", "SIGTERM"] as const;
	const stop = () => void concert.cancel();
	for (const signal of signals) process.once(signal, stop);
	try {
		return await concert.done;
	} finally {
		for (const signal of signals) process.off(signal, stop);
	}
}

/** Prints how the concert ended and the outputs its result carries, and gives its exit code. */
function report(
	session: Session,
	store: Records,
	json: boolean,
	id: string,
	result: ConcertResult,
): number {
	const { deps } = session;
	if (json)
		deps.stdout(
			jsonOf({ ...resultDoc(id, result), metrics: store.metrics(id) }),
		);
	else
		printClosing(deps, store, concertOf(store, id), result, {
			artifacts: artifactsOf(session, id),
		});
	return exitOf(result.outcome);
}

/** Pre-flights and performs `start` in its session, and reports how it ended. */
async function conducted(
	{ session, prepared, ...start }: Start,
	store: Records,
	json: boolean,
): Promise<number> {
	const { deps } = session;
	for (const d of (await preflight(session, prepared)).diagnostics)
		deps.stderr(renderDiagnostic(d));
	const concert = await conduct({
		hosts: deps.hosts,
		config: prepared.config,
		loadCode: prepared.loader.loadCode,
		recordPath: session.files.record,
		dir: session.files.concerts,
		concurrency: session.config.core.concurrency,
		ir: prepared.ir,
		...(start.resume === undefined
			? {
					origin: {
						workspace: session.config.core.workspace,
						moduleDir: prepared.moduleDir,
						file: prepared.file && basename(prepared.file),
						tour: start.tour,
						title: start.title,
						...overridesOf(prepared.values),
					},
				}
			: { resume: start.resume }),
	});
	deps.stderr(`concert ${concert.id}`);
	const result = await settled(concert);
	return report(session, store, json, concert.id, result);
}

async function performed(
	session: Session,
	store: Records,
	args: readonly string[],
	json: boolean,
	resume: string | undefined,
): Promise<number> {
	const start =
		resume === undefined
			? await begin(session, args)
			: await restart(session, store, resume, args);
	return conducted(start, store, json);
}

/**
 * The overrides a resume finds its record store under: its own, or none when they do not layer without the concert's
 * recorded ones beneath, as a `!delete` of a key only those set does not.
 * @throws as `openSession` does, for an error other than a ConfigError.
 */
async function locating(deps: Deps, own: Overrides): Promise<Overrides> {
	try {
		await openSession(deps, own);
		return own;
	} catch (error) {
		if (error instanceof ConfigError) return {};
		throw error;
	}
}

export const perform: Command = {
	usage:
		"perform <composition> [flags]  (alias: p)\n       maestro perform --resume <concert> [flags]",
	options: PERFORM_OPTIONS,
	help: compositionHelp,
	async execute(args, deps) {
		const early = peek(PERFORM_OPTIONS, args);
		const resume = textOf(early, "resume");
		const own = overridesOf(early);
		const overrides = resume === undefined ? own : await locating(deps, own);
		return withSession(deps, overrides, (session, store) =>
			performed(session, store, args, isSet(early, "json"), resume),
		);
	},
};
