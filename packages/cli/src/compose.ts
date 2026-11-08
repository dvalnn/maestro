import { basename, dirname, extname, resolve } from "node:path";
import { type Composed, valueAt } from "@maestro/core/config";
import { canonicalJson, type Diagnostic, type Plan } from "@maestro/ir";
import { flow, listing, render, summary } from "@maestro/render-text";
import {
	COMMON,
	type Command,
	colorOf,
	type Deps,
	isSet,
	parse,
	peek,
	textOf,
} from "./command";
import { agentLines, agentsOf } from "./hosts";
import {
	ArgumentError,
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
	type Prepared,
	persist,
	prepare,
	type Reading,
	resumable,
} from "./prepare";
import {
	concertOf,
	openSession,
	overridesOf,
	type Session,
	withLocated,
} from "./session";

const COMPOSE_OPTIONS = { ...COMMON, ...COMPOSE_FLAGS } as const;

/** Prepares the target in `args`. @returns the session, the preparation and whether `--json` is set. */
async function prepared(reading: Reading, args: readonly string[], deps: Deps) {
	const early = peek(COMMON, args);
	const session = await openSession(deps, overridesOf(early));
	return {
		json: isSet(early, "json"),
		session,
		prepared: await prepare(session, reading, args),
	};
}

const compositionRefused = (composition: string) =>
	new ArgumentError(
		`--concert takes no composition, got '${composition}'`,
		"Drop the composition, or drop --concert",
	);

/**
 * The concert `prefix` names, with its recorded IR, under the config files as they stand layered with its recorded
 * `--preset` and `-c`, then those of `args`.
 * @throws CliError, a usage error, for a composition, no concert id, a param flag or any other flag `compose` does not
 * take, or no such concert.
 * @throws CliError when the concert's code is gone.
 */
async function recorded(
	args: readonly string[],
	prefix: string | undefined,
	deps: Deps,
) {
	const [first] = args;
	if (first !== undefined && !first.startsWith("-"))
		throw compositionRefused(first);
	if (prefix === undefined || prefix.startsWith("-"))
		throw new ArgumentError("--concert needs a concert", NAME_CONCERT);
	const { values, positionals } = parse(
		COMPOSE_OPTIONS,
		args,
		"See 'maestro compose --help'; 'maestro encore <id>' performs a concert with new params",
	);
	if (positionals[0] !== undefined) throw compositionRefused(positionals[0]);
	return withLocated(deps, overridesOf(values), async (found, store) => ({
		json: isSet(values, "json"),
		...(await resumable(found, store, concertOf(store, prefix), values)),
	}));
}

async function save(prepared: Prepared, out: string) {
	const file = resolve(out);
	const saved = await persist(prepared, dirname(file), bundleName(file));
	await Bun.write(file, `${canonicalJson(saved.ir)}\n`);
}

/** The plan in full, then its `agents:` block when it has agent nodes. */
async function planText(
	session: Session,
	config: Composed,
	plan: Plan,
): Promise<string> {
	const agents = await agentsOf(session, config, plan);
	return agents.length
		? `${listing(plan)}\n${agentLines(agents)}`
		: listing(plan);
}

/**
 * Prints the summary, or the plan in full with `--plan`, and the graph with `--graph`, its authored flow with `--flow`,
 * which sets `--graph`.
 */
async function print(
	session: Session,
	prepared: Prepared,
	plan: Plan,
): Promise<void> {
	const { deps } = session;
	const { values } = prepared;
	const full = isSet(values, "plan");
	const graph = isSet(values, "graph") || isSet(values, "flow");
	if (full || !graph)
		deps.stdout(
			full ? await planText(session, prepared.config, plan) : summary(plan),
		);
	if (graph) deps.stdout(isSet(values, "flow") ? flow(plan) : render(plan));
}

/** Prints `diagnostics` on stderr. */
function printDiagnostics(
	session: Session,
	prepared: Prepared,
	diagnostics: readonly Diagnostic[],
): void {
	const { deps } = session;
	const { err } = colorOf(deps, prepared.values);
	for (const line of renderDiagnostics(diagnostics, err)) deps.stderr(line);
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
	help: compositionHelp,
	async execute(args, deps) {
		const early = peek(COMPOSE_OPTIONS, args);
		const {
			json,
			session,
			prepared: target,
		} = early.concert !== undefined
			? await recorded(args, textOf(early, "concert"), deps)
			: await prepared(
					{ verb: "compose", options: COMPOSE_OPTIONS, examples: true },
					args,
					deps,
				);
		const result = await compared(session, target);
		if (!result.ok) {
			if (json || !result.plan) throw new Diagnosed(result.diagnostics);
			await print(session, target, result.plan);
			printDiagnostics(session, target, result.diagnostics);
			return diagnosedExit(result.diagnostics);
		}
		const { plan } = result;
		const out = textOf(target.values, "out");
		if (out) await save(target, out);
		if (json) {
			deps.stdout(
				jsonOf({
					ok: true,
					plan,
					agents: await agentsOf(session, target.config, plan),
				}),
			);
			return EXIT.ok;
		}
		await print(session, target, plan);
		printDiagnostics(session, target, plan.diagnostics);
		if (out) deps.stderr(`wrote ${out}`);
		return EXIT.ok;
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

export const config: Command = {
	pages: true,
	usage: "config <composition> [flags]  (alias: cfg)",
	arguments: [
		[
			"<composition>",
			"A .ts, .js or .json file, or <pack>.<composition> as 'maestro repertoire' lists it",
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
	],
	options: COMMON,
	async execute(args, deps) {
		const early = peek(COMMON, args);
		const session = await openSession(deps, overridesOf(early));
		const { config: composed, unset } = await configured(
			session,
			{ verb: "config", options: COMMON, examples: false },
			args,
		);
		const json = isSet(early, "json");
		const rows: ConfigRow[] = [
			...rowsOf(composed),
			...unset.map((key) => ({ key, value: null, layer: "unset" })),
		];
		if (json) {
			deps.stdout(jsonOf({ values: rows }));
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
	},
};
