import { dirname, resolve } from "node:path";
import type { Composed } from "@maestro/core/config";
import { canonicalJson, isPlainObject, type Plan } from "@maestro/ir";
import { listing, render, summary } from "@maestro/render-text";
import {
	COMMON,
	type Command,
	colorOf,
	type Deps,
	isSet,
	peek,
	textOf,
	type Values,
} from "./command";
import { EXIT, jsonOf, renderDiagnostic, table } from "./output";
import {
	bundleName,
	COMPOSE_FLAGS,
	compositionHelp,
	type Prepared,
	persist,
	preflight,
	prepare,
	type Reading,
} from "./prepare";
import { openSession, overridesOf } from "./session";

const COMPOSE_OPTIONS = { ...COMMON, ...COMPOSE_FLAGS } as const;

/** Prepares and pre-flights the target in `args`. @returns the preparation and its plan. */
async function composed(reading: Reading, args: readonly string[], deps: Deps) {
	const early = peek(COMMON, args);
	const session = await openSession(deps, overridesOf(early));
	const prepared = await prepare(session, reading, args);
	const plan = await preflight(session, prepared);
	return { json: isSet(early, "json"), prepared, plan };
}

async function save(prepared: Prepared, out: string) {
	const file = resolve(out);
	const saved = await persist(prepared, dirname(file), bundleName(file));
	await Bun.write(file, `${canonicalJson(saved.ir)}\n`);
}

/** Prints the warnings on stderr, then the summary, or the plan in full with `--plan`, and the graph with `--graph`. */
function print(deps: Deps, plan: Plan, values: Values): void {
	const { err } = colorOf(deps, values);
	for (const d of plan.diagnostics) deps.stderr(renderDiagnostic(d, err));
	const full = isSet(values, "plan");
	const graph = isSet(values, "graph");
	if (full || !graph) deps.stdout(full ? listing(plan) : summary(plan));
	if (graph) deps.stdout(render(plan));
}

export const compose: Command = {
	usage: "compose <composition> [flags]  (alias: c)",
	options: COMPOSE_OPTIONS,
	help: compositionHelp,
	async execute(args, deps) {
		const { json, prepared, plan } = await composed(
			{ verb: "compose", options: COMPOSE_OPTIONS, examples: true },
			args,
			deps,
		);
		const out = textOf(prepared.values, "out");
		if (out) await save(prepared, out);
		if (json) {
			deps.stdout(jsonOf({ ok: true, plan }));
			return EXIT.ok;
		}
		print(deps, plan, prepared.values);
		if (out) deps.stderr(`wrote ${out}`);
		return EXIT.ok;
	},
};

/** The values of `config` with where each came from: one row per key, a list as one value. */
function rowsOf({ values, sources }: Composed) {
	const at = (path: readonly string[]) =>
		path.reduce<unknown>(
			(found, key) => (isPlainObject(found) ? found[key] : undefined),
			values,
		);
	return sources
		.filter(({ path }) => !Array.isArray(at(path.slice(0, -1))))
		.map(({ path, source }) => ({
			key: path.join("."),
			value: at(path),
			layer: source.layer,
			file: source.file,
			line: source.line,
			flag: source.flag,
		}));
}

export const config: Command = {
	usage: "config <composition> [flags]  (alias: cfg)",
	options: COMMON,
	async execute(args, deps) {
		const { json, prepared } = await composed(
			{ verb: "config", options: COMMON, examples: false },
			args,
			deps,
		);
		const rows = rowsOf(prepared.config);
		if (json) {
			deps.stdout(jsonOf({ values: rows }));
			return EXIT.ok;
		}
		deps.stdout(
			table(
				rows.map((r) => [
					r.key,
					r.layer,
					JSON.stringify(r.value),
					r.file ? `${r.file}:${r.line}` : (r.flag ?? ""),
				]),
			),
		);
		return EXIT.ok;
	},
};
