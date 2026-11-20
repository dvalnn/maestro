import { basename, dirname, extname, join, resolve } from "node:path";
import { recordedPlan } from "@maestro/core/compose";
import {
	type Composed,
	type ConcertLimits,
	layered,
	valueAt,
	valuesLayer,
} from "@maestro/core/config";
import type { Roots } from "@maestro/core/host";
import type { ConcertRecord } from "@maestro/core/perform";
import { canonicalJson, type Diagnostic, type Plan } from "@maestro/ir";
import { flow, listing, render, summary } from "@maestro/render-text";
import { shortIds } from "@maestro/render-text/live";
import {
	COMMON,
	type Command,
	colorOf,
	type Deps,
	isSet,
	parse,
	peek,
	RECORDED,
	splitFirst,
	textOf,
	type Values,
	without,
} from "./command";
import { deferredKeys, shownRoots } from "./config";
import { agentLines, agentsOf } from "./hosts";
import { bundled } from "./loader";
import {
	ArgumentError,
	CliError,
	Diagnosed,
	diagnosedExit,
	EXIT,
	jsonOf,
	NAME_CONCERT,
	renderDiagnostics,
	table,
} from "./output";
import {
	bundleName,
	COMPOSE_FLAGS,
	compared,
	compositionHelp,
	configured,
	persist,
	prepare,
	type Reading,
	type Saving,
} from "./prepare";
import {
	composeProblem,
	concertOf,
	openRecorded,
	openSession,
	overridesOf,
	unreadError,
	withLocated,
} from "./session";

const COMPOSE_OPTIONS = { ...COMMON, ...COMPOSE_FLAGS } as const;
/** `compose --concert` reads the concert's recorded config, so it takes no `--preset` or `-c` (ADR 0019). */
const CONCERT_OPTIONS = without(COMPOSE_OPTIONS, "preset", "config");

/** The flags of `args`, read before `compose` knows its form: a `--concert` among them picks the recorded plan's. */
const formFlags = (args: readonly string[]) => peek(COMPOSE_OPTIONS, args);

/** Prepares the target in `args`. @returns the session and the preparation. */
async function prepared(reading: Reading, args: readonly string[], deps: Deps) {
	const session = await openSession(deps, overridesOf(peek(COMMON, args)));
	return { session, prepared: await prepare(session, reading, args) };
}

const compositionRefused = (composition: string) =>
	new ArgumentError(
		`--concert takes no composition, got '${composition}'`,
		"Drop the composition, or drop --concert",
	);

/** What a concert's agents show under when its snapshot is not used, in a message to the user. */
const DEFAULTS = "maestro's built-in defaults";

/** What a plan is shown with: the command's flags, and the config and host roots its agents resolve under. */
type Shown = { deps: Deps; values: Values; config: Composed; roots: Roots };

/** What `--out` saves of concert `row`: its recorded IR, and the bundle of the composition file it was built from. */
async function savingOf(row: ConcertRecord): Promise<Saving> {
	const { ir, moduleDir, file } = row;
	if (file === undefined) return { ir, moduleDir };
	const path = join(moduleDir, file);
	return { ir, moduleDir, file: path, text: await bundled(path) };
}

/**
 * Shows the plan concert `prefix` was performed from: its recorded IR, expanded and bounded with no pre-flight, under
 * its config snapshot, else, saying why on stderr, under maestro's built-in defaults when the snapshot cannot be read
 * or does not compose. Reads no config file and loads no composition code (ADR 0019).
 * @throws CliError, a usage error, for a composition, no concert id, a param flag, `--preset`, `-c` or any other flag
 * `compose` does not take, or no such concert.
 * @throws CliError when the concert was recorded before snapshots.
 */
async function showConcert(
	args: readonly string[],
	prefix: string | undefined,
	deps: Deps,
): Promise<number> {
	const [first] = args;
	if (first !== undefined && !first.startsWith("-"))
		throw compositionRefused(first);
	if (prefix === undefined || prefix.startsWith("-"))
		throw new ArgumentError("--concert needs a concert", NAME_CONCERT);
	const { values, positionals } = parse(
		CONCERT_OPTIONS,
		args,
		"See 'maestro compose --help'; 'maestro encore <id>' performs a concert with new params",
	);
	if (positionals[0] !== undefined) throw compositionRefused(positionals[0]);
	return withLocated(deps, async (located, store) => {
		const row = concertOf(store, prefix);
		const opened = openRecorded(located, store, row);
		if (opened.kind === "predates") throw unreadError(opened);
		const { composed, workspace } = opened;
		const roots = await shownRoots(composed, deps.env, workspace);
		const shown = { deps, values, config: composed, roots };
		if (opened.kind === "unreadable")
			deps.stderr(`${opened.problem}, so its agents show under ${DEFAULTS}`);
		else if (opened.kind === "does-not-compose") {
			const label = shortIds(store.ids()).label(row.id, false);
			deps.stderr(
				`concert ${label}'s config snapshot does not compose under the installed hosts, so its agents show under ${DEFAULTS}:`,
			);
			printDiagnostics(shown, opened.error.diagnostics);
		}
		return planShown(shown, recordedPlan(row.ir, deps.hosts), () =>
			savingOf(row),
		);
	});
}

async function save(saving: Saving, out: string) {
	const file = resolve(out);
	const ir = await persist(saving, dirname(file), bundleName(file));
	await Bun.write(file, `${canonicalJson(ir)}\n`);
}

const agentsIn = ({ deps, roots, config }: Shown, plan: Plan) =>
	agentsOf(deps.hosts, roots, config, plan);

/** The plan in full, then its `agents:` block when it has agent nodes. */
async function planText(shown: Shown, plan: Plan): Promise<string> {
	const agents = await agentsIn(shown, plan);
	return agents.length
		? `${listing(plan)}\n${agentLines(agents)}`
		: listing(plan);
}

/**
 * Prints the summary, or the plan in full with `--plan`, and the graph with `--graph`, its authored flow with `--flow`,
 * which sets `--graph`.
 */
async function print(shown: Shown, plan: Plan): Promise<void> {
	const { deps, values } = shown;
	const full = isSet(values, "plan");
	const graph = isSet(values, "graph") || isSet(values, "flow");
	if (full || !graph)
		deps.stdout(full ? await planText(shown, plan) : summary(plan));
	if (graph) deps.stdout(isSet(values, "flow") ? flow(plan) : render(plan));
}

/** Prints `diagnostics` on stderr. */
function printDiagnostics(
	{ deps, values }: Shown,
	diagnostics: readonly Diagnostic[],
): void {
	const { err } = colorOf(deps, values);
	for (const line of renderDiagnostics(diagnostics, err)) deps.stderr(line);
}

/** Saves what `saving` gives with `--out`, and prints `plan` as the flags of `shown` say. */
async function planShown(
	shown: Shown,
	plan: Plan,
	saving: () => Promise<Saving>,
): Promise<number> {
	const { deps, values } = shown;
	const out = textOf(values, "out");
	if (out) await save(await saving(), out);
	if (isSet(values, "json")) {
		deps.stdout(
			jsonOf({ ok: true, plan, agents: await agentsIn(shown, plan) }),
		);
		return EXIT.ok;
	}
	await print(shown, plan);
	printDiagnostics(shown, plan.diagnostics);
	if (out) deps.stderr(`wrote ${out}`);
	return EXIT.ok;
}

/** Pre-flights the composition `args` name, and shows its plan. */
async function composeFile(
	args: readonly string[],
	deps: Deps,
): Promise<number> {
	const { session, prepared: target } = await prepared(
		{ verb: "compose", options: COMPOSE_OPTIONS, examples: true },
		args,
		deps,
	);
	const shown = {
		deps,
		values: target.values,
		config: target.config,
		roots: session.config.roots,
	};
	const result = await compared(session, target);
	if (result.ok) return planShown(shown, result.plan, async () => target);
	if (isSet(target.values, "json") || !result.plan)
		throw new Diagnosed(result.diagnostics);
	await print(shown, result.plan);
	printDiagnostics(shown, result.diagnostics);
	return diagnosedExit(result.diagnostics);
}

export const compose: Command = {
	pages: (args) => !textOf(peek(COMPOSE_OPTIONS, args), "out"),
	usage:
		"compose <composition> [flags]  (alias: c)\n       maestro compose --concert <id> [flags]",
	arguments: [
		[
			"<composition>",
			"A .ts, .js or .json file, or <pack>.<composition> as 'maestro repertoire' lists it",
		],
	],
	examples: [
		[
			"Pre-flight a pack's composition",
			'maestro compose classics.build_then_repair --request "Add a --verbose flag"',
		],
		[
			"Show the plan a concert was performed from",
			"maestro compose --concert 7f3c2a --plan",
		],
	],
	options: COMPOSE_OPTIONS,
	formOptions: (args) =>
		formFlags(args).concert === undefined ? COMPOSE_OPTIONS : CONCERT_OPTIONS,
	help: compositionHelp,
	async execute(args, deps) {
		const flags = formFlags(args);
		return flags.concert === undefined
			? composeFile(args, deps)
			: showConcert(args, textOf(flags, "concert"), deps);
	},
};

type ConfigRow = {
	key: string;
	value: unknown;
	layer: string;
	file?: string;
	line?: number;
	flag?: string;
};

/** The values of `config` with where each came from: one row per key, a list as one value. */
function rowsOf({ values, sources }: Composed): ConfigRow[] {
	return sources
		.filter(({ path }) => !Array.isArray(valueAt(values, path.slice(0, -1))))
		.map(({ path, source }) => ({
			key: path.join("."),
			value: valueAt(values, path),
			layer: source.layer,
			...(source.file !== undefined && { file: source.file }),
			...(source.line !== undefined && { line: source.line }),
			...(source.flag !== undefined && { flag: source.flag }),
		}));
}

/** A row's layer as the table names it: a preset by its own name, such as `preset risky`. */
const layerOf = ({ layer, file }: { layer: string; file?: string }) =>
	layer === "preset" && file
		? `preset ${basename(file, extname(file))}`
		: layer;

/** Whether `target` names a concert, not a composition: a composition is a file or `<pack>.<composition>`. */
const isConcertName = (target: string | undefined): target is string =>
	target !== undefined && /^[\w-]+$/.test(target);

/** The first argument of `config`, which picks its form. */
const configTarget = (args: readonly string[]) =>
	splitFirst(COMMON, args).first;

/**
 * What `config <concert> --json` adds to its `values`: the invocation the concert was performed with, and where its
 * composition came from: `moduleDir`, the directory its modules load from, and `file`, a bare file's name in it.
 */
type Invocation = {
	presets: readonly string[];
	flags: readonly string[];
	limits?: ConcertLimits;
	params: Readonly<Record<string, unknown>>;
	moduleDir?: string;
	file?: string;
};

/** Prints `rows` as a table, or with `--json` as `values` beside `invocation`'s fields. */
function printConfig(
	deps: Deps,
	json: boolean,
	rows: readonly ConfigRow[],
	invocation: Invocation | undefined,
): number {
	if (json) {
		deps.stdout(jsonOf({ values: rows, ...invocation }));
		return EXIT.ok;
	}
	deps.stdout(
		table(
			rows.map((r) => [
				r.key,
				layerOf(r),
				r.layer === "unset" ? "unset" : JSON.stringify(r.value),
				r.file ? `${r.file}:${r.line}` : (r.flag ?? ""),
			]),
		),
	);
	return EXIT.ok;
}

/** `composed` with the params of concert `row`, as given, over it as a flag layer under its composition's key; a bare file's are left out. */
function withParams(
	composed: Composed,
	{ pack, composition, params = {}, file }: ConcertRecord,
	deps: Deps,
): Composed {
	// A bare file's params are not shown by `config <file>` either, and its pack key could shadow a config key.
	if (file !== undefined || !Object.keys(params).length) return composed;
	const given = valuesLayer(
		{ [pack]: { [composition]: params } },
		{ layer: "flag" },
	);
	return layered([...composed.layers, given], deferredKeys(deps.hosts));
}

/**
 * Shows the config concert `prefix` was performed under, from its recorded snapshot alone (ADR 0019).
 * @throws CliError, a usage error, for a flag `config <concert>` does not take, or no such concert.
 * @throws CliError when its snapshot is missing, cannot be read or no longer composes.
 */
async function configOfConcert(
	args: readonly string[],
	prefix: string,
	deps: Deps,
): Promise<number> {
	const { values, positionals } = parse(
		RECORDED,
		args,
		"See 'maestro config --help'; a concert's config is the one it was performed under",
	);
	if (positionals.length > 1)
		throw new ArgumentError(
			`config takes one concert, got '${positionals.slice(1).join(" ")}'`,
			"See 'maestro config --help'",
		);
	return withLocated(deps, async (located, store) => {
		const row = concertOf(store, prefix);
		const opened = openRecorded(located, store, row);
		if (opened.kind === "predates" || opened.kind === "unreadable")
			throw unreadError(opened);
		if (opened.kind === "does-not-compose")
			throw new CliError(
				`${composeProblem(shortIds(store.ids()).label(row.id, false), opened.error)}\nPerform its composition anew with 'maestro perform'`,
			);
		const composed = withParams(opened.composed, row, deps);
		return printConfig(deps, isSet(values, "json"), rowsOf(composed), {
			presets: row.presets ?? [],
			flags: row.config ?? [],
			limits: row.limits,
			params: row.params ?? {},
			moduleDir: row.moduleDir || undefined,
			file: row.file,
		});
	});
}

export const config: Command = {
	pages: true,
	usage: "config <composition|concert> [flags]  (alias: cfg)",
	arguments: [
		[
			"<composition>",
			"A .ts, .js or .json file, or <pack>.<composition> as 'maestro repertoire' lists it",
		],
		[
			"<concert>",
			"A concert id or unique prefix, as 'maestro ls' lists it: the config it was performed under, read from its record alone, so no --preset or -c. Each value shows its layer, and its file and line or its -c flag, as for a composition. The params it was given for a pack's composition show as values too, with the layer that set them; a bare file's are left out. --json is {values}, plus presets and flags, each as typed in order, limits with timeout in milliseconds, left out when the concert had none, params as given, and moduleDir and file, where its composition loads from. A snapshot that is missing, unreadable or no longer composes exits 1",
		],
	],
	examples: [
		[
			"Where does each key of the config come from?",
			'maestro config classics.build_then_repair --request "Add a --verbose flag"',
		],
		[
			"See a -c override take the top layer",
			'maestro config classics.build_then_repair --request "Add a --verbose flag" -c target.repo=../app',
		],
		[
			"The config a concert was performed under, with its presets, flags and limits",
			"maestro config 7f3c2a --json",
		],
	],
	options: COMMON,
	formOptions: (args) =>
		isConcertName(configTarget(args)) ? RECORDED : COMMON,
	async execute(args, deps) {
		const target = configTarget(args);
		if (isConcertName(target)) return configOfConcert(args, target, deps);
		const early = peek(COMMON, args);
		const session = await openSession(deps, overridesOf(early));
		const { config: composed, unset } = await configured(
			session,
			{ verb: "config", options: COMMON, examples: false },
			args,
		);
		const rows: ConfigRow[] = [
			...rowsOf(composed),
			...unset.map((key) => ({ key, value: null, layer: "unset" })),
		];
		return printConfig(deps, isSet(early, "json"), rows, undefined);
	},
};
