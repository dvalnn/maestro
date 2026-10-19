import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	CORE_PATHS,
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
	schemaErrors,
	sourceOf,
	valuesLayer,
} from "@maestro/core/config";
import type { Host } from "@maestro/core/host";
import type { JsonSchema } from "@maestro/ir";
import { messageOf, validator } from "@maestro/ir";
import { CliError } from "./output";

const APP = "maestro";
/** The directory that makes its parent a workspace. */
const WORKSPACE_DIR = ".maestro";
const CONFIG_FILE = "config.yaml";
const PROFILES_DIR = "profiles";
const PROFILE_EXTENSION = ".yaml";
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

/** The key paths whose relative values are anchored to their config file, or to the workspace root: core's, the CLI's and each host's. */
const pathKeys = (hosts: readonly Host[]) => [
	...CORE_PATHS,
	...hosts.flatMap((h) => h.paths ?? []),
	[PACKS],
];

export type Environment = Readonly<Record<string, string | undefined>>;

/** A command's `--profile` name and each `-c` as given, in order. */
export type Overrides = {
	profile?: string;
	config?: readonly string[];
	/** The short id of the concert they were recorded with, when a resume reapplies them. */
	recorded?: string;
};

export type ConfigRequest = {
	cwd: string;
	env: Environment;
	hosts: readonly Host[];
	/** Layered above the config files in order, each as its profile, then each of its `-c` in order. */
	overrides?: readonly Overrides[];
};

/**
 * An installed pack's directory, and the config file or `-c` that lists it, as diagnostics name them; without one, it
 * was found in the packs directory.
 */
export type PackDir = { dir: string; listedBy?: string };

export type LoadedConfig = {
	/** Every layer, lowest first: the default, then each config file found, profile and `-c`. */
	layers: readonly Layer[];
	composed: Composed;
	core: CoreConfig;
	/** Each installed pack once: those `packs` lists, then each directory under `packsDir`. */
	packs: readonly PackDir[];
	/** `$XDG_DATA_HOME/maestro/packs`, the directory of packs installed without config. */
	packsDir: string;
	/** The directory that holds `.maestro/`, when the cwd is inside one. */
	workspace?: string;
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

/** The packs `composed` lists, with the file or flag listing each, then those in `root`, each real directory once. */
async function packDirs(composed: Composed, root: string): Promise<PackDir[]> {
	const listed = (composed.values[PACKS] as string[]).map((dir, i) => {
		const source = sourceOf(composed, [PACKS, String(i)]);
		return { dir, listedBy: source?.file ?? source?.flag };
	});
	const all = [...listed, ...(await directoriesIn(root))];
	const keys = await Promise.all(
		all.map(({ dir }) => realpath(dir).catch(() => resolve(dir))),
	);
	return all.filter((_, i) => keys.indexOf(keys[i] ?? "") === i);
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

/** The code of a refused `--profile`. */
const CFG_PROFILE = "CFG.profile";
/** The code of a refused `-c`. */
const CFG_FLAG = "CFG.flag";
const NEW_CONCERT = "perform the composition as a new concert";
const NO_WORKSPACE = `needs a workspace, and no directory from here up holds ${WORKSPACE_DIR}/`;

const refused = (code: string, message: string, hint: string) =>
	new ConfigError([configDiagnostic(code, undefined, message, hint)]);

/** The layer of profile `name`; `recorded` is the short id of the concert a resume reapplies it from. */
async function profileLayer(
	name: string,
	workspace: string | undefined,
	paths: readonly KeyPath[],
	recorded?: string,
): Promise<Layer> {
	const by =
		recorded && `concert ${recorded} was performed with --profile ${name}`;
	if (basename(name) !== name)
		throw refused(
			CFG_PROFILE,
			`--profile takes a name, not a path: '${name}'`,
			`Name a profile in ${WORKSPACE_DIR}/${PROFILES_DIR}/, without its ${PROFILE_EXTENSION}`,
		);
	if (!workspace)
		throw by
			? refused(
					CFG_PROFILE,
					`${by}, which ${NO_WORKSPACE}`,
					`Resume from inside its workspace, or ${NEW_CONCERT}`,
				)
			: refused(
					CFG_PROFILE,
					`--profile ${name} ${NO_WORKSPACE}`,
					"Change to a directory inside a workspace, or drop --profile",
				);
	const dir = join(workspace, WORKSPACE_DIR, PROFILES_DIR);
	const file = join(dir, `${name}${PROFILE_EXTENSION}`);
	const found = await fileLayer(file, "profile", paths, workspace);
	if (!found)
		throw by
			? refused(
					CFG_PROFILE,
					`${by}, and ${file} does not exist`,
					`Restore ${file}, or ${NEW_CONCERT}`,
				)
			: refused(
					CFG_PROFILE,
					`--profile ${name} names no file: ${file} does not exist`,
					`Create ${file}, or name a profile in ${dir}`,
				);
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

/** How a `-c` is named and fixed: as typed, or as recorded with concert `recorded`, which a resume reapplies. */
const flagOrigin = (arg: string, recorded: string | undefined) =>
	recorded === undefined
		? { flag: typed(arg) }
		: {
				flag: `concert ${recorded} was performed with ${typed(arg)}`,
				fix: `Set that key, or !delete it, with -c on the resume, or ${NEW_CONCERT}`,
			};

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
 * resolved against `base`; `recorded` is the short id of the concert a resume reapplies it from.
 * @throws ConfigError naming the flag as typed when it is not `<key>=<value>`, its key is not keys joined by `.`, or
 * its value is not YAML.
 */
function overrideLayer(
	arg: string,
	base: string,
	paths: readonly KeyPath[],
	recorded?: string,
): Layer {
	const flag = typed(arg);
	const match = OVERRIDE.exec(arg);
	if (!match)
		throw refused(
			CFG_FLAG,
			`${flag} takes <key>=<value>`,
			"Write it as -c <key>=<value>, as in -c concurrency=4",
		);
	const [, key = "", value = ""] = match;
	const path = keyPath(key);
	if (!path)
		throw refused(
			CFG_FLAG,
			`${flag}: '${key}' is not a key path`,
			`Join keys with '.', and quote a key holding '.', as in -c 'target.checks."a.b"=x'`,
		);
	const nested = path
		.map((k, depth) => `${INDENT.repeat(depth)}${JSON.stringify(k)}:`)
		.join("\n");
	const indented = value.replaceAll("\n", `\n${INDENT.repeat(path.length)}`);
	return parseLayer(`${nested} ${indented}\n`, {
		...flagOrigin(arg, recorded),
		base,
		layer: "flag",
		paths,
	});
}

/** The layers of `overrides` in order: each one's profile, then each of its `-c` in order. */
async function overrideLayers(
	overrides: readonly Overrides[],
	workspace: string | undefined,
	base: string,
	paths: readonly KeyPath[],
): Promise<Layer[]> {
	const layers: Layer[] = [];
	for (const { profile, config = [], recorded } of overrides) {
		if (profile !== undefined)
			layers.push(await profileLayer(profile, workspace, paths, recorded));
		layers.push(
			...config.map((arg) => overrideLayer(arg, base, paths, recorded)),
		);
	}
	return layers;
}

/**
 * Finds and layers the config files for `request`, lowest first:
 * - core's defaults, and no packs listed;
 * - the user file, `$XDG_CONFIG_HOME/maestro/config.yaml`, when it exists;
 * - the workspace file, `.maestro/config.yaml` in the nearest directory from the cwd up holding `.maestro/`, when it
 *   exists;
 * - for each of `overrides` in order, the profile its `--profile` names, `.maestro/profiles/<name>.yaml` in that
 *   workspace, then a layer per `-c <key>=<value>`, in order.
 *
 * Relative paths in the user file resolve against its directory, those in the workspace file, a profile and a `-c`
 * against the workspace root, or the cwd outside a workspace. The installed packs are those `packs` lists, then each
 * directory under `$XDG_DATA_HOME/maestro/packs`, each once.
 *
 * @throws ConfigError for a file or `-c` that cannot be parsed or layered, a missing profile, or core or CLI keys off
 * their schemas.
 */
export async function loadConfig({
	cwd,
	env,
	hosts,
	overrides = [],
}: ConfigRequest): Promise<LoadedConfig> {
	const workspace = await workspaceOf(cwd);
	const dataRoot = join(xdg(env, "XDG_DATA_HOME", ".local/share"), APP);
	const packsDir = join(dataRoot, PACKS_DIR);
	const paths = pathKeys(hosts);
	const files = [
		await fileLayer(
			join(xdg(env, "XDG_CONFIG_HOME", ".config"), APP, CONFIG_FILE),
			"user",
			paths,
		),
		workspace &&
			(await fileLayer(
				join(workspace, WORKSPACE_DIR, CONFIG_FILE),
				"workspace",
				paths,
				workspace,
			)),
	];
	const layers = [
		coreDefaults(dataRoot, workspace ? basename(workspace) : ""),
		valuesLayer({ [PACKS]: [] }, { layer: "default" }),
		...files.filter((l): l is Layer => Boolean(l)),
		...(await overrideLayers(
			overrides,
			workspace,
			workspace ?? resolve(cwd),
			paths,
		)),
	];
	const composed = layered(layers);
	const core = coreConfig(composed);
	const errors = schemaErrors(validator(), CLI_CONFIG, composed);
	if (errors.length) throw new ConfigError(errors);
	const packs = await packDirs(composed, packsDir);
	return { layers, composed, core, packs, packsDir, workspace };
}
