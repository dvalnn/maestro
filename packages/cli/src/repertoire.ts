import { basename, resolve } from "node:path";
import { ConfigError } from "@maestro/core/config";
import type { Host } from "@maestro/core/host";
import { type Ir, indexGraph, messageOf } from "@maestro/ir";
import type { Described } from "@maestro/sdk/loader";
import { COMMON, type Command, type Deps, isSet, parse } from "./command";
import type { PackDir } from "./config";
import { flagUsage, type ParamEntry, paramEntries, paramsBlock } from "./flags";
import { type Bundle, claimsOf, openPack } from "./loader";
import { ArgumentError, EXIT, jsonOf, table } from "./output";
import { paramValues } from "./params";
import { chosen, installedPack } from "./prepare";
import { openSession, overridesOf } from "./session";

type CompositionEntry = {
	/** `<pack>.<composition>`, as `perform` takes it. */
	id: string;
	name: string;
	doc?: string;
	params: ParamEntry[];
	/** The dotted config keys its host nodes read by name when built from its example set; absent when it does not build. */
	config?: string[];
	/** A `maestro perform` line with each required flag. */
	perform: string;
};

type PackEntry = {
	id: string;
	version: string;
	path: string;
	/** The config file or `-c` that lists the pack, when one does. */
	config?: string;
	compositions: CompositionEntry[];
};

type Loaded = { bundle: Bundle; entry: PackEntry };

const FIX = "Name an installed pack, or <pack>.<composition>";

/** The config entries `ir`'s host nodes read by name, as the loaded hosts name them: dotted, each once, sorted. */
function needsOf(ir: Ir, hosts: readonly Host[]): string[] {
	const graph = indexGraph(ir);
	const keys = hosts.flatMap((host) => host.needs?.(graph) ?? []);
	return [...new Set(keys.map((key) => key.join(".")))].toSorted();
}

/** The config entries `composition` reads when built from its example set and defaults, without the config. */
function builtNeeds(
	bundle: Bundle,
	composition: Described,
	{ hosts, cwd }: Deps,
): string[] | undefined {
	let params: ReturnType<typeof paramValues>;
	try {
		params = paramValues({
			layers: [],
			pack: bundle.pack.id,
			compositions: bundle.compositions,
			root: composition.name,
			example: composition.examples[0],
			hosts,
			base: () => resolve(cwd),
			exampleDir: bundle.dir,
		});
	} catch (error) {
		if (error instanceof ConfigError) return undefined;
		throw error;
	}
	const built = bundle.build(composition.name, params.root, params.configured);
	return built.ok ? needsOf(built.ir, hosts) : undefined;
}

function compositionEntry(
	bundle: Bundle,
	composition: Described,
	deps: Deps,
): CompositionEntry {
	const id = `${bundle.pack.id}.${composition.name}`;
	const params = paramEntries(composition);
	const flags = params.filter((p) => p.required).map((p) => ` ${flagUsage(p)}`);
	return {
		id,
		name: composition.name,
		doc: composition.doc,
		params,
		config: builtNeeds(bundle, composition, deps),
		perform: `maestro perform ${id}${flags.join("")}`,
	};
}

async function loaded(pack: PackDir, deps: Deps): Promise<Loaded> {
	const bundle = await openPack(pack);
	const compositions = bundle.compositions.map((c) =>
		compositionEntry(bundle, c, deps),
	);
	const { id, version } = bundle.pack;
	return {
		bundle,
		entry: {
			id,
			version,
			path: bundle.dir,
			config: pack.listedBy,
			compositions,
		},
	};
}

/** Why the pack in `dir` did not load, and the fix, naming `dir`. */
function failure(dir: string, error: unknown): string {
	const message = messageOf(error);
	return message.includes(dir) ? message : `${dir}: ${message}`;
}

/**
 * Loads each pack of `dirs`, printing on stderr why each one that does not load failed, and two that share an id.
 * @returns the packs that loaded, the directory names of those that did not, and whether all loaded with distinct ids.
 */
async function loadAll(
	dirs: readonly PackDir[],
	deps: Deps,
): Promise<{ packs: Loaded[]; failed: string[]; ok: boolean }> {
	const settled = await Promise.allSettled(dirs.map((p) => loaded(p, deps)));
	const packs: Loaded[] = [];
	const failed: string[] = [];
	settled.forEach((result, i) => {
		const dir = dirs[i]?.dir ?? "";
		if (result.status === "fulfilled") packs.push(result.value);
		else {
			failed.push(basename(dir));
			deps.stderr(failure(dir, result.reason));
		}
	});
	try {
		claimsOf(packs.map((p) => p.bundle));
	} catch (error) {
		deps.stderr(messageOf(error));
		return { packs, failed, ok: false };
	}
	return { packs, failed, ok: failed.length === 0 };
}

const firstLine = (text = "") => text.split("\n", 1)[0] ?? "";

function packText(p: PackEntry): string {
	const header = [`${p.id} ${p.version}`, p.path];
	if (p.config) header.push(`listed in ${p.config}`);
	const rows = table(
		p.compositions.map((c) => [`  ${c.name}`, firstLine(c.doc)]),
	);
	return rows ? `${header.join("  ")}\n${rows}` : header.join("  ");
}

function compositionText(c: CompositionEntry, composition: Described): string {
	const [first = "", ...rest] = (c.doc ?? "").split("\n");
	const lines = [table([[c.id, first]]), ...rest];
	const params = paramsBlock(composition);
	if (params) lines.push(params);
	if (c.config?.length) lines.push(`Config  ${c.config.join(", ")}`);
	lines.push("", `  ${c.perform}`);
	return lines.join("\n");
}

type Selection = { entries: PackEntry[]; composition?: Described };

/**
 * What `target` selects among `packs`: every pack, one pack, or one composition with its declaration. A pack whose
 * directory is among `failed`, already reported, selects nothing.
 */
function selected(
	{ packs, failed }: { packs: readonly Loaded[]; failed: readonly string[] },
	target: string | undefined,
	packsDir: string,
): Selection {
	if (target === undefined) return { entries: packs.map((p) => p.entry) };
	const dot = target.indexOf(".");
	const id = dot < 0 ? target : target.slice(0, dot);
	const bundles = packs.map((p) => p.bundle);
	if (failed.includes(id) && !bundles.some((b) => b.pack.id === id))
		return { entries: [] };
	const bundle = installedPack(bundles, id, packsDir);
	const entries = packs.filter((p) => p.bundle === bundle).map((p) => p.entry);
	if (dot < 0) return { entries };
	const composition = chosen(bundle, `pack '${id}'`, target.slice(dot + 1));
	const only = entries.map((e) => ({
		...e,
		compositions: e.compositions.filter((c) => c.name === composition.name),
	}));
	return { entries: only, composition };
}

function printed(deps: Deps, { entries, composition }: Selection): void {
	const [only] = entries[0]?.compositions ?? [];
	if (composition && only) deps.stdout(compositionText(only, composition));
	else if (entries.length) deps.stdout(entries.map(packText).join("\n"));
}

export const repertoire: Command = {
	pages: true,
	usage: "repertoire [<pack>[.<composition>]] [flags]  (alias: rep)",
	arguments: [
		[
			"<pack>",
			"An installed pack, or <pack>.<composition> for one of its compositions; without it, every pack is listed",
		],
	],
	options: COMMON,
	async execute(args, deps) {
		const { values, positionals } = parse(COMMON, args, FIX);
		if (positionals.length > 1)
			throw new ArgumentError(
				`takes at most one pack or composition, got ${positionals.length}`,
				"Name one pack, or none to list every pack",
			);
		const session = await openSession(deps, overridesOf(values));
		const { packs: dirs, packsDir } = session.config;
		const all = await loadAll(dirs, deps);
		const shown = selected(all, positionals[0], packsDir);
		if (isSet(values, "json")) deps.stdout(jsonOf({ packs: shown.entries }));
		else printed(deps, shown);
		if (!dirs.length)
			deps.stderr(
				`no packs are installed\nExtract one into ${packsDir}, or list its directory under packs in the config`,
			);
		return all.ok ? EXIT.ok : EXIT.failed;
	},
};
