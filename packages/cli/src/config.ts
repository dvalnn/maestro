import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { closest } from "@maestro/core";
import {
	type Composed,
	ConfigError,
	type CoreConfig,
	configDiagnostic,
	coreConfig,
	coreDefaults,
	type KeyPath,
	type Layer,
	type LayerName,
	layered,
	parseLayer,
	type Source,
	schemaErrors,
	sourceOf,
	valueAt,
	valuesLayer,
} from "@maestro/core/config";
import type { Host, Roots } from "@maestro/core/host";
import type { ConfigSnapshot } from "@maestro/core/perform";
import { type JsonSchema, messageOf, validator } from "@maestro/ir";
import { packIdOf } from "./loader";
import { CliError } from "./output";

const APP = "maestro";
/** The directory that makes its parent a workspace. */
const WORKSPACE_DIR = ".maestro";
const CONFIG_FILE = "config.yaml";
/** The directory of presets in `.maestro/` and in the user config directory. */
const PRESETS_DIR = "presets";
/** The directory of profiles in `.maestro/`, where a preset file is refused and named for moving. */
const PROFILES_DIR = "profiles";
const PRESET_EXTENSION = ".yaml";
/** The prefix of a name `ls -a` alone shows. */
const HIDDEN = ".";
/** The file of variables the CLI loads beside the user config file. */
const DOTENV_FILE = ".env";

/** The top-level key that lists the installed packs, each by the path of its directory. */
const PACKS = "packs";
/** The directory under `$XDG_DATA_HOME/maestro` whose every subdirectory is an installed pack. */
const PACKS_DIR = "packs";

/** The config schemas the CLI owns beside core's, by top-level key. */
export const CLI_CONFIG: Readonly<Record<string, JsonSchema>> = {
	[PACKS]: { type: "array", items: { type: "string", minLength: 1 } },
};

/** The key paths whose relative values are anchored to their config file, or to the workspace root: each host's and the CLI's. */
const pathKeys = (hosts: readonly Host[]) => [
	...hosts.flatMap((h) => h.paths ?? []),
	[PACKS],
];

/** The key paths each host gives the base of later. */
export const deferredKeys = (hosts: readonly Host[]) =>
	hosts.flatMap((h) => h.deferred ?? []);

export type Environment = Readonly<Record<string, string | undefined>>;

/** A command's `--preset` names and each `-c` as given, in order. */
export type Overrides = {
	presets?: readonly string[];
	config?: readonly string[];
};

export type ConfigRequest = {
	cwd: string;
	env: Environment;
	hosts: readonly Host[];
	/** Layered above the config files: its presets, then each of its `-c`, in order. */
	overrides?: Overrides;
};

/**
 * An installed pack's directory, and the config file or `-c` that lists it, as diagnostics name them; without one, it
 * was found in the packs directory.
 */
export type PackDir = { dir: string; listedBy?: string };

export type LoadedConfig = {
	/** Every layer, lowest first: the default, then each config file found, preset and `-c`. */
	layers: readonly Layer[];
	composed: Composed;
	core: CoreConfig;
	/** Each installed pack once: those `packs` lists, then each directory under `packsDir`. */
	packs: readonly PackDir[];
	/** `$XDG_DATA_HOME/maestro/packs`, the directory of packs installed without config. */
	packsDir: string;
	/** The directory that holds `.maestro/`, when the cwd is inside one. */
	workspace?: string;
	/** The directories presets are looked up in. */
	presets: readonly PresetDir[];
	/** The host roots: `.maestro` in the workspace, `$XDG_CONFIG_HOME/maestro`, and each pack's directory. */
	roots: Roots;
};

const isDirectory = async (path: string) =>
	(await stat(path).catch(() => undefined))?.isDirectory() ?? false;

/** The nearest directory from `cwd` up that holds `.maestro/`. */
async function workspaceOf(cwd: string): Promise<string | undefined> {
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		if (await isDirectory(join(dir, WORKSPACE_DIR))) return dir;
		if (dirname(dir) === dir) return undefined;
	}
}

/** An XDG base directory: the variable when it holds an absolute path, else `fallback` under the home directory. */
function xdg(env: Environment, variable: string, fallback: string): string {
	const set = env[variable];
	if (set && isAbsolute(set)) return set;
	return join(env.HOME || homedir(), fallback);
}

/** Each directory under `root` whose name does not start with `.`, by name, none when `root` is missing. */
async function directoriesIn(root: string): Promise<PackDir[]> {
	const names = await readdir(root).catch((error: { code?: string }) => {
		if (error.code !== "ENOENT") throw error;
		return [];
	});
	const dirs = names
		.filter((name) => !name.startsWith(HIDDEN))
		.toSorted()
		.map((name) => join(root, name));
	const kept = await Promise.all(dirs.map(isDirectory));
	return dirs.filter((_, i) => kept[i]).map((dir) => ({ dir }));
}

/**
 * The packs `composed` lists, with the file or flag listing each, then those in `root`, each real directory once. A pack
 * in `root` whose id a listed pack has is dropped.
 */
async function packDirs(composed: Composed, root: string): Promise<PackDir[]> {
	const listed = (composed.values[PACKS] as string[]).map((dir, i) => {
		const source = sourceOf(composed, [PACKS, String(i)]);
		return { dir, listedBy: source?.file ?? source?.flag };
	});
	const all = [...listed, ...(await directoriesIn(root))];
	const keys = await Promise.all(
		all.map(({ dir }) => realpath(dir).catch(() => resolve(dir))),
	);
	const once = all.filter((_, i) => keys.indexOf(keys[i] ?? "") === i);
	const ids = await Promise.all(once.map(({ dir }) => packIdOf(dir)));
	const listedIds = new Set(
		once.flatMap((p, i) => (p.listedBy !== undefined ? [ids[i]] : [])),
	);
	return once.filter((p, i) => {
		const id = ids[i];
		return p.listedBy !== undefined || id === undefined || !listedIds.has(id);
	});
}

/** The real directory of each of `packs` by pack id, none for a pack whose manifest names no id. */
async function packRoots(
	packs: readonly PackDir[],
): Promise<Record<string, string>> {
	const reals = await Promise.all(
		packs.map(({ dir }) => realpath(dir).catch(() => undefined)),
	);
	const ids = await Promise.all(reals.map((real) => real && packIdOf(real)));
	return Object.fromEntries(
		reals.flatMap((real, i) => {
			const id = ids[i];
			return real && id ? [[id, real]] : [];
		}),
	);
}

/**
 * Loads `$XDG_CONFIG_HOME/maestro/.env` into `process.env`, each variable `process.env` already holds kept, when the
 * file exists.
 * @throws CliError naming the file when it exists and cannot be read.
 */
export function loadDotenv(env: Environment): void {
	const file = join(xdg(env, "XDG_CONFIG_HOME", ".config"), APP, DOTENV_FILE);
	try {
		process.loadEnvFile(file);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return;
		throw new CliError(
			`cannot read ${file}: ${messageOf(error)}\nMake it readable, or remove it`,
		);
	}
}

/** The layer in `file`, when it exists; its relative paths resolve against `base`, else its own directory. */
async function fileLayer(
	file: string,
	layer: LayerName,
	paths: readonly KeyPath[],
	base?: string,
): Promise<Layer | undefined> {
	const found = Bun.file(file);
	if (!(await found.exists())) return undefined;
	return parseLayer(await found.text(), { file, base, layer, paths });
}

/** The code of a refused `--preset`. */
const CFG_PRESET = "CFG.preset";
/** The code of a refused `-c`. */
const CFG_FLAG = "CFG.flag";
/** The key no config sets: the data root is `$XDG_DATA_HOME/maestro` (ADR 0019). */
const DATA_ROOT = "dataRoot";

const refused = (
	code: string,
	message: string,
	hint: string,
	source?: Source,
) => new ConfigError([configDiagnostic(code, source, message, hint)]);

/**
 * A directory presets are looked up in, the base its presets' relative paths resolve against, and the directory whose
 * `<name>.yaml` a missing preset's fix says to move into it.
 */
type PresetDir = { dir: string; base: string; moveFrom?: string };

const lookedIn = (dirs: readonly PresetDir[]) =>
	dirs.map(({ dir }) => dir).join(" or ");

/** The names of the presets in `dirs`, a directory that cannot be read holding none. */
async function presetNames(dirs: readonly PresetDir[]): Promise<string[]> {
	const files = await Promise.all(
		dirs.map(({ dir }) => readdir(dir).catch(() => [])),
	);
	return files
		.flat()
		.filter((file) => file.endsWith(PRESET_EXTENSION))
		.map((file) => file.slice(0, -PRESET_EXTENSION.length));
}

/**
 * The layer of preset `name`, from the first of `dirs` that holds `<name>.yaml`.
 * @throws ConfigError when `name` is a path, or no directory of `dirs` holds it.
 */
async function presetLayer(
	name: string,
	dirs: readonly PresetDir[],
	paths: readonly KeyPath[],
): Promise<Layer> {
	const file = `${name}${PRESET_EXTENSION}`;
	const looked = lookedIn(dirs);
	if (basename(name) !== name)
		throw refused(
			CFG_PRESET,
			`--preset takes a name, not a path: '${name}'`,
			`Name a preset in ${looked}, without its ${PRESET_EXTENSION}`,
		);
	for (const { dir, base } of dirs) {
		const found = await fileLayer(join(dir, file), "preset", paths, base);
		if (found) return found;
	}
	const moved = await moveFix(file, dirs);
	throw refused(
		CFG_PRESET,
		`--preset ${name} names no file in ${looked}`,
		moved ?? (await unknownFix(name, dirs)),
	);
}

/** The fix that moves `file` into its preset directory, when one of `dirs` names a directory holding it. */
async function moveFix(
	file: string,
	dirs: readonly PresetDir[],
): Promise<string | undefined> {
	for (const { dir, moveFrom } of dirs) {
		const stale = moveFrom && join(moveFrom, file);
		if (stale && (await Bun.file(stale).exists()))
			return `Move ${stale} to ${dir}/`;
	}
	return undefined;
}

/** The fix for preset `name` that no directory of `dirs` holds: the nearest name there, else where to create it. */
async function unknownFix(
	name: string,
	dirs: readonly PresetDir[],
): Promise<string> {
	const near = closest(name, await presetNames(dirs));
	return near
		? `Did you mean --preset ${near}?`
		: `Create ${name}${PRESET_EXTENSION} in ${lookedIn(dirs)}`;
}

/**
 * The presets, by name, that set every entry of `unset`, each a list of key paths of which any one sets it; a value
 * of null counts as unset. A preset that cannot be read is no candidate.
 */
export async function presetsSetting(
	config: Pick<LoadedConfig, "presets">,
	hosts: readonly Host[],
	unset: readonly (readonly KeyPath[])[],
): Promise<string[]> {
	const names = [...new Set(await presetNames(config.presets))].toSorted();
	const paths = pathKeys(hosts);
	const found: string[] = [];
	for (const name of names) {
		const layer = await presetLayer(name, config.presets, paths).catch(
			() => undefined,
		);
		if (!layer) continue;
		const { values } = layered([layer]);
		const sets = (path: KeyPath) => valueAt(values, path) != null;
		if (unset.every((alternatives) => alternatives.some(sets)))
			found.push(name);
	}
	return found;
}

/** `<key>=<value>`, split at the first `=` outside double quotes. */
const OVERRIDE = /^((?:"[^"]*"|[^"=])*)=(.*)$/s;
/** One key of a key path: in double quotes, or up to the next `.`. */
const KEY = /"([^"]*)"|([^".]+)/y;
const KEY_SEPARATOR = ".";
const INDENT = "  ";
/** A flag value a shell reads as written, which is shown without quotes. */
const SHELL_SAFE = /^[\w.=/:,@+-]*$/;

/** `arg` as the `-c` that gives it, quoted for a shell when it needs quotes. */
const typed = (arg: string) =>
	`-c ${SHELL_SAFE.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`}`;

/** The keys of `key` from the top level down, or undefined when it is not keys joined by `.`. */
function keyPath(key: string): string[] | undefined {
	const path: string[] = [];
	for (let at = 0; ; at += KEY_SEPARATOR.length) {
		KEY.lastIndex = at;
		const match = KEY.exec(key);
		if (!match) return undefined;
		path.push(match[1] ?? match[2] ?? "");
		at = KEY.lastIndex;
		if (at === key.length) return path;
		if (!key.startsWith(KEY_SEPARATOR, at)) return undefined;
	}
}

/**
 * The layer of one `-c <key>=<value>`: the value, read as YAML with its merge tags, at the key, its relative paths
 * resolved against `base`.
 * @throws ConfigError naming the flag as typed when it is not `<key>=<value>`, its key is not keys joined by `.`, or
 * its value is not YAML.
 */
function overrideLayer(
	arg: string,
	base: string,
	paths: readonly KeyPath[],
): Layer {
	const flag = typed(arg);
	const match = OVERRIDE.exec(arg);
	if (!match)
		throw refused(
			CFG_FLAG,
			`${flag} takes <key>=<value>`,
			"Write it as -c <key>=<value>, as in -c concurrency=4",
			{ layer: "flag" },
		);
	const [, key = "", value = ""] = match;
	const path = keyPath(key);
	if (!path)
		throw refused(
			CFG_FLAG,
			`${flag}: '${key}' is not a key path`,
			`Join keys with '.', and quote a key holding '.', as in -c 'target.checks."a.b"=x'`,
			{ layer: "flag" },
		);
	const nested = path
		.map((k, depth) => `${INDENT.repeat(depth)}${JSON.stringify(k)}:`)
		.join("\n");
	const indented = value.replaceAll("\n", `\n${INDENT.repeat(path.length)}`);
	return parseLayer(`${nested} ${indented}\n`, {
		flag: typed(arg),
		key,
		base,
		layer: "flag",
		paths,
	});
}

/** The layers of `overrides`: its presets, then each of its `-c`, in order. */
async function overrideLayers(
	{ presets = [], config = [] }: Overrides,
	presetDirs: readonly PresetDir[],
	base: string,
	paths: readonly KeyPath[],
): Promise<Layer[]> {
	const layers: Layer[] = [];
	for (const preset of presets)
		layers.push(await presetLayer(preset, presetDirs, paths));
	return [...layers, ...config.map((arg) => overrideLayer(arg, base, paths))];
}

/** The directory a relative path from `source` resolves against: the base its layer was read with, else `cwd`. */
export const baseOf = (cwd: string, source: Source | undefined): string =>
	source?.base ?? resolve(cwd);

/**
 * Finds and layers the config files for `request`, lowest first:
 * - core's defaults, and no packs listed;
 * - the user file, `$XDG_CONFIG_HOME/maestro/config.yaml`, when it exists;
 * - the workspace file, `.maestro/config.yaml` in the nearest directory from the cwd up holding `.maestro/`, when it
 *   exists;
 * - the preset each `--preset` of `overrides` names, in order, `<name>.yaml` in the workspace's `.maestro/presets/`,
 *   else in `$XDG_CONFIG_HOME/maestro/presets/`, then a layer per `-c <key>=<value>` of it, in order.
 *
 * Relative paths in the user file and a user preset resolve against the user config directory, those in the workspace
 * file, a workspace preset and a `-c` against the workspace root, or the cwd outside a workspace. The installed packs
 * are those `packs` lists, then each directory under `$XDG_DATA_HOME/maestro/packs`, each once.
 *
 * @throws ConfigError for a file or `-c` that cannot be parsed or layered, a missing preset, or core or CLI keys off
 * their schemas.
 */
export async function loadConfig({
	cwd,
	env,
	hosts,
	overrides = {},
}: ConfigRequest): Promise<LoadedConfig> {
	const workspace = await workspaceOf(cwd);
	const { userDir } = placesOf(env);
	const paths = pathKeys(hosts);
	const presetDirs = [
		...(workspace
			? [
					{
						dir: join(workspace, WORKSPACE_DIR, PRESETS_DIR),
						base: workspace,
						moveFrom: join(workspace, WORKSPACE_DIR, PROFILES_DIR),
					},
				]
			: []),
		{ dir: join(userDir, PRESETS_DIR), base: userDir },
	];
	const files = [
		await fileLayer(join(userDir, CONFIG_FILE), "user", paths),
		workspace &&
			(await fileLayer(
				join(workspace, WORKSPACE_DIR, CONFIG_FILE),
				"workspace",
				paths,
				workspace,
			)),
	];
	const found = [
		...files.filter((l): l is Layer => Boolean(l)),
		...(await overrideLayers(
			overrides,
			presetDirs,
			workspace ?? resolve(cwd),
			paths,
		)),
	];
	const name = workspace ? basename(workspace) : "";
	return composedOf(found, name, {
		env,
		hosts,
		workspace,
		presets: presetDirs,
	});
}

/** Where maestro keeps its files, from the XDG base directories of `env`. */
export function placesOf(env: Environment) {
	const dataRoot = join(xdg(env, "XDG_DATA_HOME", ".local/share"), APP);
	return {
		/** The data root: the record store, concert areas and host stores. */
		dataRoot,
		packsDir: join(dataRoot, PACKS_DIR),
		userDir: join(xdg(env, "XDG_CONFIG_HOME", ".config"), APP),
	};
}

/** The code defaults: core's, with the data root of `env` and the workspace named `name`, and no packs listed. */
const defaultLayers = (env: Environment, name: string): Layer[] => [
	coreDefaults(placesOf(env).dataRoot, name),
	valuesLayer({ [PACKS]: [] }, { layer: "default" }),
];

/** A `CFG.unclaimed` error for each of `layers` that sets or deletes `dataRoot`. */
const dataRootErrors = (layers: readonly Layer[]) =>
	layers.flatMap((layer) => {
		const set = layer.entries.get(DATA_ROOT);
		return set
			? [
					configDiagnostic(
						"CFG.unclaimed",
						set.source,
						`config key '${DATA_ROOT}' is claimed by nothing: the data root is $XDG_DATA_HOME/${APP}`,
						`Remove '${DATA_ROOT}' from the config, and set $XDG_DATA_HOME to move the data root`,
					),
				]
			: [];
	});

/** The installed packs `composed` lists and those of `env`, and the host roots, with those of `workspace`. */
async function packsAndRoots(
	composed: Composed,
	env: Environment,
	workspace: string | undefined,
) {
	const { packsDir, userDir } = placesOf(env);
	const packs = await packDirs(composed, packsDir);
	const roots: Roots = {
		...(workspace && { workspace: join(workspace, WORKSPACE_DIR) }),
		user: userDir,
		packs: await packRoots(packs),
	};
	return { packs, packsDir, roots };
}

/**
 * The config of `layers` over the code defaults, with the workspace named `name`: merged, core's and the CLI's keys
 * checked, and the packs it lists found. The host roots hold `workspace`'s `.maestro/`.
 * @throws ConfigError for a layer that sets `dataRoot`, layers that do not merge, or core or CLI keys off their schemas.
 */
async function composedOf(
	layers: readonly Layer[],
	name: string,
	{
		env,
		hosts,
		workspace,
		presets,
	}: Pick<LoadedConfig, "workspace" | "presets"> & {
		env: Environment;
		hosts: readonly Host[];
	},
): Promise<LoadedConfig> {
	const refusedRoot = dataRootErrors(layers);
	if (refusedRoot.length) throw new ConfigError(refusedRoot);
	const all = [...defaultLayers(env, name), ...layers];
	const composed = layered(all, deferredKeys(hosts));
	const core = coreConfig(composed);
	const errors = schemaErrors(validator(), CLI_CONFIG, composed);
	if (errors.length) throw new ConfigError(errors);
	return {
		layers: all,
		composed,
		core,
		workspace,
		presets,
		...(await packsAndRoots(composed, env, workspace)),
	};
}

/** A performed concert's config, as the record keeps it. */
export type Recorded = {
	snapshot: ConfigSnapshot;
	/** The name of the workspace it was performed in, empty outside one. */
	workspaceName: string;
	/** Its short id, which a diagnostic on a value its snapshot set names. */
	label: string;
};

/**
 * The layers of `recorded`'s snapshot, each parsed again from its text as perform read it, its values credited to the
 * concert with a fix that names it.
 * @throws ConfigError when a text no longer parses.
 */
const snapshotLayers = ({ snapshot, label }: Recorded) =>
	snapshot.layers.map(({ text, from }) => ({
		...parseLayer(text, {
			...from,
			concert: label,
			fix: `Set that key, or !delete it, with -c on a resume or encore of concert ${label}, or perform its composition anew`,
		}),
		parsed: { text, from },
	}));

/** What `recordedConfig` loads: a concert's snapshot, then each `-c` of `config`. */
type RecordedRequest = Omit<ConfigRequest, "overrides"> & {
	recorded: Recorded;
	config?: readonly string[];
};

/**
 * The config of a recorded concert (ADR 0019): the code defaults, then its snapshot, then a layer per `-c` of `config`,
 * whose relative paths resolve against the recorded workspace root, else `cwd`, as a perform's `-c` does. No config
 * file is read and no preset found. The host roots hold the recorded workspace's `.maestro/`.
 * @throws ConfigError as `loadConfig` does.
 */
export async function recordedConfig({
	cwd,
	env,
	hosts,
	recorded,
	config = [],
}: RecordedRequest): Promise<LoadedConfig> {
	const paths = pathKeys(hosts);
	const base = recorded.snapshot.workspace ?? resolve(cwd);
	const layers = [
		...snapshotLayers(recorded),
		...config.map((arg) => overrideLayer(arg, base, paths)),
	];
	return composedOf(layers, recorded.workspaceName, {
		env,
		hosts,
		workspace: recorded.snapshot.workspace,
		presets: [],
	});
}

/**
 * The config a reader shows a concert of workspace `name` under (ADR 0019): the code defaults, then the snapshot of
 * `recorded` when given, merged under `hosts` and checked against nothing.
 * @throws ConfigError when its layers do not parse or merge.
 */
export const shownConfig = (
	{ env, hosts }: Pick<ConfigRequest, "env" | "hosts">,
	name: string,
	recorded?: Recorded,
) =>
	layered(
		[
			...defaultLayers(env, name),
			...(recorded ? snapshotLayers(recorded) : []),
		],
		deferredKeys(hosts),
	);

/** The host roots of `composed`, a config checked against nothing, with `workspace`'s `.maestro/`. */
export async function shownRoots(
	composed: Composed,
	env: Environment,
	workspace: string | undefined,
): Promise<Roots> {
	const listed = composed.values[PACKS];
	const lists =
		Array.isArray(listed) && listed.every((p) => typeof p === "string");
	const { roots } = await packsAndRoots(
		lists
			? composed
			: { ...composed, values: { ...composed.values, [PACKS]: [] } },
		env,
		workspace,
	);
	return roots;
}
