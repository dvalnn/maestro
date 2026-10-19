import { basename } from "node:path";
import { ConfigError } from "@maestro/core/config";
import type { Host } from "@maestro/core/host";
import { type Ir, isPlainObject, messageOf } from "@maestro/ir";
import type { Described } from "@maestro/sdk/loader";
import {
	COMMON,
	type Command,
	type Deps,
	isSet,
	parse,
	textOf,
} from "./command";
import type { PackDir } from "./config";
import { flagUsage, type ParamEntry, paramEntries, paramsBlock } from "./flags";
import { type Bundle, claimsOf, openPack } from "./loader";
import { EXIT, jsonOf, table, usageError } from "./output";
import { paramValues } from "./params";
import { chosen, installedPack } from "./prepare";
import { openSession } from "./session";

type CompositionEntry = {
	/** `<pack>.<composition>`, as `perform` takes it. */
	id: string;
	name: string;
	doc?: string;
	params: ParamEntry[];
	/** The roles of the agents its example set builds; absent when it builds from no example set. */
	roles?: string[];
	/** A `maestro perform` line with each required flag. */
	perform: string;
};

type PackEntry = {
	id: string;
	version: string;
	path: string;
	/** The config file that lists the pack, when one does. */
	config?: string;
	compositions: CompositionEntry[];
};

type Loaded = { bundle: Bundle; entry: PackEntry };

const FIX = "Name an installed pack, or <pack>.<composition>";

/** The role name each host node's `config.role` gives, each once, sorted. */
function rolesOf(ir: Ir): string[] {
	const names = ir.nodes.flatMap((node) => {
		const role =
			"config" in node && isPlainObject(node.config)
				? node.config.role
				: undefined;
		return isPlainObject(role) && typeof role.name === "string"
			? [role.name]
			: [];
	});
	return [...new Set(names)].toSorted();
}

/** The roles `composition` uses when built from its example set and defaults, without the config. */
function builtRoles(
	bundle: Bundle,
	composition: Described,
	hosts: readonly Host[],
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
		});
	} catch (error) {
		if (error instanceof ConfigError) return undefined;
		throw error;
	}
	const built = bundle.build(composition.name, params.root, params.configured);
	return built.ok ? rolesOf(built.ir) : undefined;
}

function compositionEntry(
	bundle: Bundle,
	composition: Described,
	hosts: readonly Host[],
): CompositionEntry {
	const id = `${bundle.pack.id}.${composition.name}`;
	const params = paramEntries(composition);
	const flags = params.filter((p) => p.required).map((p) => ` ${flagUsage(p)}`);
	return {
		id,
		name: composition.name,
		doc: composition.doc,
		params,
		roles: builtRoles(bundle, composition, hosts),
		perform: `maestro perform ${id}${flags.join("")}`,
	};
}

async function loaded(pack: PackDir, hosts: readonly Host[]): Promise<Loaded> {
	const bundle = await openPack(pack);
	const compositions = bundle.compositions.map((c) =>
		compositionEntry(bundle, c, hosts),
	);
	const { id, version } = bundle.pack;
	return {
		bundle,
		entry: { id, version, path: bundle.dir, config: pack.file, compositions },
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
	const settled = await Promise.allSettled(
		dirs.map((p) => loaded(p, deps.hosts)),
	);
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
	if (c.roles?.length) lines.push(`Roles  ${c.roles.join(", ")}`);
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
	usage: "repertoire [<pack>[.<composition>]] [flags]  (alias: rep)",
	options: COMMON,
	async execute(args, deps) {
		const { values, positionals } = parse(COMMON, args, FIX);
		if (positionals.length > 1)
			throw usageError(
				`expected at most one pack or composition, got ${positionals.length}`,
				FIX,
			);
		const session = await openSession(deps, textOf(values, "profile"));
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
