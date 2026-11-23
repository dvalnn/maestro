import { spawn } from "node:child_process";
import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	type Concert,
	type ConcertResult,
	perform as conduct,
	type Records,
	Unencorable,
	unresumable,
} from "@maestro/core/perform";
import { MS_PER_UNIT, mapWorkers } from "@maestro/ir";
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
	textsOf,
	type Values,
	without,
} from "./command";
import type { Overrides } from "./config";
import {
	concertDoc,
	EXIT,
	encoreRefused,
	exitOf,
	failure,
	jsonOf,
	NAME_CONCERT,
	parseTour,
	printClosing,
	renderDiagnostics,
	resultDoc,
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
	type Located,
	openSession,
	overridesOf,
	recordedSession,
	type Session,
	withLocated,
	withRecord,
} from "./session";
import { drawLiveBlock } from "./watch";

/** The environment variable that puts a new concert on a tour when `--tour` is not given. */
const TOUR_VARIABLE = "MAESTRO_TOUR";

const PERFORM_OPTIONS = { ...COMMON, ...PERFORM_FLAGS } as const;
/** Resume and encore compose their concert's snapshot, so they take `-c`, layered over it, but no `--preset` (ADR 0019). */
const RECORDED_OPTIONS = without(COMMON, "preset");
const RESUME_OPTIONS = {
	...RECORDED_OPTIONS,
	detach: PERFORM_FLAGS.detach,
} as const;
const ENCORE_OPTIONS = { ...RECORDED_OPTIONS, ...PERFORM_FLAGS } as const;

const DETACH = "--detach";
/** The line a perform announces its concert with on stderr. */
const ANNOUNCED = /^concert (\S+)$/m;
/** How often a detaching perform looks for the concert its run announces. */
const DETACH_POLL_MS = 50;
/** How long a detaching perform waits for its run to announce a concert. */
const DETACH_TIMEOUT_MS = 2 * MS_PER_UNIT.m;

/** Starts `argv` as a process in its own session, its stdout written to `out` and its stderr to `err`. */
function spawnSession(
	deps: Deps,
	argv: readonly string[],
	out: string,
	err: string,
) {
	const fds = [openSync(out, "w"), openSync(err, "w")] as const;
	const [executable = "", ...rest] = argv;
	try {
		return spawn(executable, rest, {
			cwd: deps.cwd,
			env: deps.env,
			detached: true,
			stdio: ["ignore", ...fds],
		});
	} finally {
		for (const fd of fds) closeSync(fd);
	}
}

/**
 * Runs `command` with `args` again as a process in its own session, without `--detach`: the concert it announces, or
 * its exit code and output when it exits before announcing one.
 * @throws CliError, after stopping it, when it announces none within `DETACH_TIMEOUT_MS`.
 * @throws Error when the process does not start.
 */
async function detached(
	deps: Deps,
	command: string,
	args: readonly string[],
): Promise<{ id: string } | { exit: number; out: string; err: string }> {
	const dir = mkdtempSync(join(tmpdir(), "maestro-detach-"));
	const out = join(dir, "out");
	const err = join(dir, "err");
	try {
		const argv = [...deps.self, command, ...args.filter((a) => a !== DETACH)];
		const run = spawnSession(deps, argv, out, err);
		let exit: number | undefined;
		let failed: Error | undefined;
		run.once("exit", (code) => {
			exit = code ?? EXIT.failed;
		});
		run.once("error", (error) => {
			failed = error;
		});
		for (let waited = 0; waited < DETACH_TIMEOUT_MS; waited += DETACH_POLL_MS) {
			// Taken before reading, so a run that announced and exited is never taken for one that refused.
			const ended = exit;
			if (failed) throw failed;
			const id = ANNOUNCED.exec(readFileSync(err, "utf8"))?.[1];
			if (id) {
				run.unref();
				return { id };
			}
			if (ended !== undefined)
				return {
					exit: ended,
					out: readFileSync(out, "utf8"),
					err: readFileSync(err, "utf8"),
				};
			await Bun.sleep(DETACH_POLL_MS);
		}
		run.kill();
		throw failure(
			`${command} started no concert within ${DETACH_TIMEOUT_MS / MS_PER_UNIT.m}m, so it was stopped`,
			"Run it without --detach to see where it stops",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Starts `command` with `args` in the background: prints the concert's id, or its running document under `json`, and
 * gives 0; passes through the output and exit code of a run that refuses.
 */
async function detach(
	deps: Deps,
	command: string,
	args: readonly string[],
	json: boolean,
): Promise<number> {
	const started = await detached(deps, command, args);
	if ("exit" in started) {
		if (started.out) deps.stdoutBytes(Buffer.from(started.out));
		if (started.err) deps.stderr(started.err.trimEnd());
		return started.exit;
	}
	deps.stdout(
		json ? jsonOf(resultDoc(started.id, undefined), deps) : started.id,
	);
	if (deps.stderrTerminal && !json) await followHint(deps, started.id);
	return EXIT.ok;
}

/** Prints how to follow the concert `id`, by the short id the foreground path hints. */
async function followHint(deps: Deps, id: string) {
	await withLocated(deps, async (_located, store) => {
		deps.stderr(
			`Follow it: maestro watch ${shortIds(store.ids()).label(id, false)}`,
		);
	});
}

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
		recorded
			? { verb: "encore", options: ENCORE_OPTIONS, examples: false, recorded }
			: { verb: "perform", options: PERFORM_OPTIONS, examples: false },
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
 * An encore of the concert whose id starts with `prefix`: its composition performed anew with the flags of `args` over
 * its recorded params, under its snapshot and then each `-c` of `own`, which its own snapshot records (ADR 0019).
 * @throws CliError, a usage error, when `args` hold a composition.
 * @throws CliError when the concert has no snapshot.
 * @throws ConfigError as `recordedConfig` does.
 */
async function encored(
	located: Located,
	store: Records,
	prefix: string,
	own: readonly string[],
	args: readonly string[],
): Promise<Start> {
	const row = concertOf(store, prefix);
	const session = await recordedSession(located, store, row, own);
	const target =
		row.file === undefined
			? `${row.pack}.${row.composition}`
			: join(row.moduleDir, row.file);
	const start = await begin(session, [target, ...args], row.params ?? {});
	return {
		...start,
		encore: row.id,
		overrides: {
			presets: row.presets,
			config: [...(row.config ?? []), ...own],
		},
	};
}

/**
 * The concert whose id starts with `prefix`, to resume under its snapshot and then the `-c` of `values`, which hold for
 * this attempt only, prepared as `resumable` does.
 * @throws CliError when core refuses to resume it, when it has no snapshot, or as `resumable` does.
 * @throws ConfigError as `recordedConfig` does.
 */
async function restart(
	located: Located,
	store: Records,
	prefix: string,
	values: Values,
): Promise<Start> {
	const row = concertOf(store, prefix);
	const refused = unresumable(row);
	if (refused) throw resumeRefused(refused);
	const own = textsOf(values, "config");
	const session = await recordedSession(located, store, row, own);
	const prepared = await resumable(session, row, values);
	return { session, prepared, resume: row.id };
}

const SIGNAL_EXITS = {
	SIGINT: EXIT.interrupted,
	SIGTERM: EXIT.terminated,
} as const;

/**
 * Cancels `concert` on the first SIGINT or SIGTERM, until it settles and `after` has run; `stopped` is that signal's exit
 * code. A second one finds no handler and kills the process, which is the way out of a cancel that hangs.
 */
async function settled(
	concert: Concert,
	after: () => Promise<void>,
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
	let result: ConcertResult;
	try {
		result = await concert.done;
	} finally {
		// The handlers stay until `after` is done: a first signal while it waits still counts.
		await after();
		for (const [signal, stop] of stops) process.off(signal, stop);
	}
	return { result, stopped };
}

/** Prints how the concert ended and the outputs its result carries, and gives its exit code. */
async function report(
	session: Session,
	store: Records,
	json: boolean,
	color: Colors,
	id: string,
	{ result, stopped }: { result: ConcertResult; stopped?: number },
): Promise<number> {
	const { deps } = session;
	if (json)
		deps.stdout(
			jsonOf(concertDoc(store, id, result, artifactsOf(session, id)), deps),
		);
	else
		printClosing(deps, store, concertOf(store, id), result, {
			color,
			artifacts: artifactsOf(session, id),
			changes: await changesOf({ session, store }, id),
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
	for (const line of renderDiagnostics(
		(await preflight(session, prepared)).diagnostics,
		color.err,
	))
		session.deps.stderr(line);
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
					workspaceDir: session.config.workspace,
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
	const stopBlock = liveBlock(deps, store, concert.id, color, json);
	const settledConcert = await settled(concert, stopBlock);
	return report(session, store, json, color, concert.id, settledConcert);
}

/** Draws the live block while a concert runs on a terminal stderr that moves its cursor, and gives what stops it. */
function liveBlock(
	deps: Deps,
	store: Records,
	id: string,
	color: Colors,
	json: boolean,
): () => Promise<void> {
	const row = store.find(id);
	const terminal = deps.stderrTerminal;
	if (!terminal || json || row === undefined || deps.env.TERM === "dumb")
		return async () => {};
	return drawLiveBlock(deps, store, row, {
		terminal,
		color: color.err,
	});
}

/** Pre-flights and performs what `started` makes in the record store of the data root, and gives the exit code. */
async function inStore(
	deps: Deps,
	json: boolean,
	started: (located: Located, store: Records) => Promise<Start>,
) {
	return withLocated(deps, async (located, store) => {
		const start = await started(located, store);
		await warned(start);
		return conducted(start, store, json);
	});
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
			'maestro perform .maestro/slice.ts --preset stub --request "Add a --verbose flag"',
		],
		[
			"Put the concert on a tour, with a title",
			'maestro perform classics.build_then_repair --request "Add a --verbose flag" --tour epic.story --title "Verbose flag"',
		],
		[
			"Start it in the background, then wait for it",
			'id=$(maestro perform classics.build_then_repair --request "Add a --verbose flag" --detach) && maestro wait "$id"',
		],
	],
	options: PERFORM_OPTIONS,
	help: compositionHelp,
	async execute(args, deps) {
		const early = peek(PERFORM_OPTIONS, args);
		if (isSet(early, "detach"))
			return detach(deps, "perform", args, isSet(early, "json"));
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
			"Resume with -c over the concert's recorded config, for this attempt",
			"maestro resume 7f3c2a -c concurrency=2",
		],
	],
	options: RESUME_OPTIONS,
	async execute(args, deps) {
		const { values, positionals } = parse(
			RESUME_OPTIONS,
			args,
			"Flags are listed in 'maestro resume --help'",
		);
		const prefix = only(positionals, "concert", NAME_CONCERT);
		if (isSet(values, "detach"))
			return detach(deps, "resume", args, isSet(values, "json"));
		return inStore(deps, isSet(values, "json"), (located, store) =>
			restart(located, store, prefix, values),
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
		[
			"Set a config value with -c over the concert's recorded config",
			"maestro encore 7f3c2a -c concurrency=2",
		],
	],
	options: ENCORE_OPTIONS,
	async execute(args, deps) {
		const { first, rest } = splitFirst(ENCORE_OPTIONS, args);
		const prefix = only(
			first === undefined ? [] : [first],
			"concert",
			NAME_CONCERT,
		);
		const early = peek(ENCORE_OPTIONS, rest);
		if (isSet(early, "detach"))
			return detach(deps, "encore", args, isSet(early, "json"));
		return inStore(deps, isSet(early, "json"), (located, store) =>
			encored(located, store, prefix, textsOf(early, "config"), rest),
		);
	},
};
