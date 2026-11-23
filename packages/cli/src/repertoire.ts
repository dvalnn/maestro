import { basename, resolve } from "node:path";
import { tildeOf } from "@maestro/core";
import { ConfigError } from "@maestro/core/config";
import type { Host } from "@maestro/core/host";
import { type Ir, indexGraph, messageOf } from "@maestro/ir";
import { hintLine } from "@maestro/render-text/live";
import type { Described } from "@maestro/sdk/loader";
import {
	COMMON,
	type Command,
	colorOf,
	columnsOf,
	type Deps,
	isSet,
	parse,
} from "./command";
import type { PackDir } from "./config";
import { flagUsage, type ParamEntry, paramEntries, paramsBlock } from "./flags";
import { type Bundle, claimsOf, openPack } from "./loader";
import {
	ArgumentError,
	EXIT,
	giving,
	jsonAgain,
	jsonOf,
	laidOut,
	paint,
	table,
	wrapping,
} from "./output";
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

/** The cells a description gives up before the row outgrows `columns`. */
const DESCRIPTION_FLOOR = 12;

/** What a pack listing prints, and whether it cut anything. */
type Shown = { text: string; cut: boolean };

/**
 * A pack's header: its id and version, which stay whole, then its path, then where it is listed. Past `columns` the
 * place it is listed gives way first, then the path, each down to a lone `…`.
 */
function headerText(p: PackEntry, { color, home, columns }: Look): Shown {
	const cells = [
		`${paint("bold", p.id, color)} ${paint("dim", p.version, color)}`,
		paint("dim", tildeOf(p.path, home), color),
		...(p.config ? [`listed in ${tildeOf(p.config, home)}`] : []),
	];
	return laidOut(
		[cells],
		false,
		giving(columns, [
			{ column: 2, floor: 1 },
			{ column: 1, floor: 1 },
		]),
	);
}

function packText(p: PackEntry, look: Look): Shown {
	const { color, columns } = look;
	const head = headerText(p, look);
	const rows = laidOut(
		p.compositions.map((c) => [
			`  ${paint("cyan", c.name, color)}`,
			firstLine(c.doc),
		]),
		false,
		giving(columns, [{ column: 1, floor: DESCRIPTION_FLOOR }]),
	);
	return {
		text: rows.text ? `${head.text}\n${rows.text}` : head.text,
		cut: head.cut || rows.cut,
	};
}

function compositionText(
	c: CompositionEntry,
	composition: Described,
	color: boolean,
	columns: number,
): string {
	const lines = [
		table(
			[[paint("bold", c.id, color), c.doc ?? ""]],
			false,
			wrapping(columns),
		),
	];
	const params = paramsBlock(composition, color, columns);
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

/** How a pack listing shows: colored, and with the directory `home` as `~` and descriptions cut to `columns` on a terminal. */
type Look = {
	color: boolean;
	home: string | undefined;
	columns: number;
};

function printed(
	deps: Deps,
	{ entries, composition }: Selection,
	color: boolean,
	again: string,
): void {
	const [only] = entries[0]?.compositions ?? [];
	const columns = columnsOf(deps);
	const look = {
		color,
		home: deps.terminal ? deps.env.HOME : undefined,
		columns,
	};
	if (composition && only)
		deps.stdout(compositionText(only, composition, color, columns));
	else if (entries.length) {
		const shown = entries.map((e) => packText(e, look));
		const hint = shown.some((s) => s.cut)
			? [hintLine(`Full listing: ${again}`, color)]
			: [];
		deps.stdout([...shown.map((s) => s.text), ...hint].join("\n"));
	}
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
		if (isSet(values, "json"))
			deps.stdout(jsonOf({ packs: shown.entries }, deps));
		else
			printed(
				deps,
				shown,
				colorOf(deps, values).out,
				jsonAgain("repertoire", args),
			);
		if (!dirs.length)
			deps.stderr(
				`no packs are installed\nExtract one into ${packsDir}, or list its directory under packs in the config`,
			);
		return all.ok ? EXIT.ok : EXIT.failed;
	},
};
