import { basename } from "node:path";
import {
	type ConcertRecord,
	type ConcertResult,
	perform as conduct,
	type Performance,
	type RecordStore,
} from "@maestro/core/perform";
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
	CliError,
	exitOf,
	instanceName,
	jsonOf,
	parseTour,
	reasonOf,
	renderDiagnostic,
	resultDoc,
	stillRunning,
	usageError,
} from "./output";
import {
	PERFORM_FLAGS,
	type Prepared,
	preflight,
	prepare,
	resumable,
} from "./prepare";
import { concertOf, type Session, withSession } from "./session";

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

async function begin(
	session: Session,
	args: readonly string[],
): Promise<Start> {
	const prepared = await prepare(
		session,
		{ verb: "perform", options: PERFORM_OPTIONS, examples: false },
		args,
	);
	return {
		prepared,
		tour: tourOf(prepared.values, session.deps.env),
		title: textOf(prepared.values, "title") || undefined,
	};
}

function refuseResume({ id, status, pid }: ConcertRecord) {
	if (status === "running") throw stillRunning(id, pid);
	if (status === "ok")
		throw new CliError(
			`concert ${id} finished ok, so there is nothing to resume\nPerform its composition as a new concert`,
		);
}

/**
 * The concert `id` to resume, with its code as it stands now.
 * @throws CliError when the concert is running or finished `ok`, or its code is gone.
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
	refuseResume(row);
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

/** Prints how the concert ended, and gives its exit code. */
function report(
	deps: Deps,
	json: boolean,
	id: string,
	{ ir }: Prepared,
	result: ConcertResult,
): number {
	if (json) deps.stdout(jsonOf(resultDoc(id, result)));
	else {
		const at =
			result.outcome === "ok" ||
			result.node === undefined ||
			result.expansion === undefined
				? ""
				: ` at ${instanceName(ir, { node: result.node, expansion: result.expansion })}`;
		const reason = reasonOf(result);
		deps.stderr(
			`concert ${id} ${result.outcome}${at}${reason === undefined ? "" : `: ${reason}`}`,
		);
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
		codeHash: prepared.loader.codeHash,
		record: store,
		dir: session.files.concerts,
		concurrency: session.config.core.concurrency,
		...(start.resume === undefined
			? {
					ir: prepared.ir,
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
	(json ? deps.stderr : deps.stdout)(
		json ? `concert ${performance.concert}` : performance.concert,
	);
	return report(
		deps,
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
