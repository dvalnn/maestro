import { basename } from "node:path";
import {
	type ConcertResult,
	perform as conduct,
	type Performance,
	type RecordStore,
	unresumable,
} from "@maestro/core/perform";
import { mapWorkers } from "@maestro/ir";
import { STDLIB_HASH, STDLIB_MODULE } from "@maestro/sdk";
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
import {
	closingLine,
	exitOf,
	jsonOf,
	outputsText,
	parseTour,
	renderDiagnostic,
	resultDoc,
	resumeRefused,
	usageError,
} from "./output";
import {
	PERFORM_FLAGS,
	type Prepared,
	preflight,
	prepare,
	resumable,
} from "./prepare";
import { artifactsOf, concertOf, type Session, withSession } from "./session";

/** The environment variable that puts a new concert on a tour when `--tour` is not given. */
const TOUR_VARIABLE = "MAESTRO_TOUR";
const FIX = "Flags are listed in 'maestro perform --help'";

const PERFORM_OPTIONS = { ...COMMON, ...PERFORM_FLAGS } as const;

/** A prepared concert: what to perform, and how it is recorded. */
type Start = {
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
		prepared: { ...prepared, ir },
		tour: tourOf(prepared.values, session.deps.env),
		title: textOf(prepared.values, "title") || undefined,
	};
}

/**
 * The concert `id` to resume, with its code as it stands now.
 * @throws CliError when core refuses to resume it, its code is gone, or the flags are not a resume's.
 */
async function restart(
	session: Session,
	store: RecordStore,
	id: string,
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
	const row = concertOf(store, id);
	const refused = unresumable(row);
	if (refused) throw resumeRefused(refused);
	return { prepared: await resumable(session, row, values), resume: id };
}

/** Cancels `performance` on SIGINT or SIGTERM, until it settles. */
async function settled(performance: Performance): Promise<ConcertResult> {
	const signals = ["SIGINT", "SIGTERM"] as const;
	const stop = () => void performance.cancel();
	for (const signal of signals) process.once(signal, stop);
	try {
		return await performance.done;
	} finally {
		for (const signal of signals) process.off(signal, stop);
	}
}

/** Prints the outputs the concert's result carries and how it ended, and gives its exit code. */
function report(
	session: Session,
	json: boolean,
	id: string,
	{ ir }: Prepared,
	result: ConcertResult,
): number {
	const { deps } = session;
	if (json) deps.stdout(jsonOf(resultDoc(id, result)));
	else {
		const outputs = outputsText(ir, artifactsOf(session, id), result);
		if (outputs !== undefined) deps.stdout(outputs);
		deps.stderr(closingLine(ir, id, result));
	}
	return exitOf(result.outcome);
}

async function performed(
	session: Session,
	store: RecordStore,
	args: readonly string[],
	json: boolean,
	resume: string | undefined,
): Promise<number> {
	const { deps } = session;
	const start =
		resume === undefined
			? await begin(session, args)
			: await restart(session, store, resume, args);
	const { prepared } = start;
	for (const d of (await preflight(session, prepared)).diagnostics)
		deps.stderr(renderDiagnostic(d));
	const performance = conduct({
		hosts: deps.hosts,
		loadCode: prepared.loader.loadCode,
		record: store,
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
					},
				}
			: { resume: start.resume }),
	});
	deps.stderr(`concert ${performance.concert}`);
	return report(
		session,
		json,
		performance.concert,
		prepared,
		await settled(performance),
	);
}

export const perform: Command = {
	usage:
		"perform <composition> [flags]  (alias: p)\n       maestro perform --resume <concert> [flags]",
	options: PERFORM_OPTIONS,
	execute(args, deps) {
		const early = peek(PERFORM_OPTIONS, args);
		return withSession(deps, textOf(early, "profile"), (session, store) =>
			performed(
				session,
				store,
				args,
				isSet(early, "json"),
				textOf(early, "resume"),
			),
		);
	},
};
