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

export type ConfigRequest = {
	cwd: string;
	env: Environment;
	hosts: readonly Host[];
	/** The name given to `--profile`. */
	profile?: string;
};

/** An installed pack's directory, and the config file that lists it; without one, it was found in the packs directory. */
export type PackDir = { dir: string; file?: string };

export type LoadedConfig = {
	/** Every layer, lowest first: the default, then each config file found. */
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

/** The packs `composed` lists, each with the file that lists it, then those in `root`, each real directory once. */
async function packDirs(composed: Composed, root: string): Promise<PackDir[]> {
	const listed = (composed.values[PACKS] as string[]).map((dir, i) => ({
		dir,
		file: sourceOf(composed, [PACKS, String(i)])?.file,
	}));
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

const refused = (message: string, hint: string) =>
	new ConfigError([configDiagnostic("CFG.profile", undefined, message, hint)]);

async function profileLayer(
	name: string,
	workspace: string | undefined,
	paths: readonly KeyPath[],
): Promise<Layer> {
	if (basename(name) !== name)
		throw refused(
			`--profile takes a name, not a path: '${name}'`,
			`Name a profile in ${WORKSPACE_DIR}/${PROFILES_DIR}/, without its ${PROFILE_EXTENSION}`,
		);
	if (!workspace)
		throw refused(
			`--profile ${name} needs a workspace, and no directory from here up holds ${WORKSPACE_DIR}/`,
			`Change to a directory inside a workspace, or drop --profile`,
		);
	const dir = join(workspace, WORKSPACE_DIR, PROFILES_DIR);
	const file = join(dir, `${name}${PROFILE_EXTENSION}`);
	const found = await fileLayer(file, "profile", paths, workspace);
	if (!found)
		throw refused(
			`--profile ${name} names no file: ${file} does not exist`,
			`Create ${file}, or name a profile in ${dir}`,
		);
	return found;
}

/**
 * Finds and layers the config files for `request`, lowest first:
 * - core's defaults, and no packs listed;
 * - the user file, `$XDG_CONFIG_HOME/maestro/config.yaml`, when it exists;
 * - the workspace file, `.maestro/config.yaml` in the nearest directory from the cwd up holding `.maestro/`, when it
 *   exists;
 * - the profile `--profile` names, `.maestro/profiles/<name>.yaml` in that workspace.
 *
 * Relative paths in the user file resolve against its directory, those in the workspace file and the profile against
 * the workspace root. The installed packs are those `packs` lists, then each directory under
 * `$XDG_DATA_HOME/maestro/packs`, each once.
 *
 * @throws ConfigError for a file that cannot be parsed or layered, a missing profile, or core or CLI keys off their
 * schemas.
 */
export async function loadConfig({
	cwd,
	env,
	hosts,
	profile,
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
		profile === undefined
			? undefined
			: await profileLayer(profile, workspace, paths),
	];
	const layers = [
		coreDefaults(dataRoot, workspace ? basename(workspace) : ""),
		valuesLayer({ [PACKS]: [] }, { layer: "default" }),
		...files.filter((l): l is Layer => Boolean(l)),
	];
	const composed = layered(layers);
	const core = coreConfig(composed);
	const errors = schemaErrors(validator(), CLI_CONFIG, composed);
	if (errors.length) throw new ConfigError(errors);
	const packs = await packDirs(composed, packsDir);
	return { layers, composed, core, packs, packsDir, workspace };
}
