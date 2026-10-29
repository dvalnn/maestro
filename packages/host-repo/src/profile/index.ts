import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { closest, sha256Hex } from "@maestro/core";
import {
	type Composed,
	ConfigError,
	configDiagnostic,
	type KeyPath,
	type Layer,
	layered,
	layeredOver,
	offSchema,
	parseLayer,
	type Source,
	sourceOf,
} from "@maestro/core/config";
import type { HostSetup, Roots } from "@maestro/core/host";
import {
	type Diagnostic,
	DURATION_EXAMPLE,
	durationMs,
	irSchema,
	isPlainObject,
	type JsonSchema,
	MAX_TIMEOUT,
	validator,
} from "@maestro/ir";
import type { Runtime } from "../harness/index";

/** The config namespace that tunes profiles by name. */
export const PROFILES = "profiles";
/** The directory under each root of `Roots` that holds its profiles. */
const PROFILES_DIR = "profiles";
/** The file that makes a directory a profile. */
const PROFILE_FILE = "profile.yaml";
const CODE = "HOST.profile";

const SEGMENT = irSchema.$defs.name.pattern.slice(1, -1);
/** A bare name, or `<pack id>/<name>`, each segment a pack id. */
export const PROFILE_NAME = new RegExp(`^${SEGMENT}(?:/${SEGMENT})?$`);
const OWNER_SEPARATOR = "/";

/** The keys of a profile that hold file paths, relative to its directory in its file. `*` matches any one key. */
export const PROFILE_PATHS: readonly KeyPath[] = [
	["instructions"],
	["attachments", "*", "path"],
];
/** Keys reserved for later: config passes them for resolution to refuse by name. */
const RESERVED = ["mcp", "skills"];
const READ_ONLY = "readOnly";
/** The runtime fields that must be set once config is layered over the file. */
const REQUIRED_RUNTIME = ["harness", "model"] as const;

const TEXT = { type: "string", minLength: 1 } as const;

/** A profile's fields, and `extra`; an attachment requires `required` of its own. */
const fieldsSchema = (
	required: string[],
	extra: Record<string, JsonSchema> = {},
): JsonSchema => ({
	type: "object",
	additionalProperties: false,
	properties: {
		runtime: {
			type: "object",
			additionalProperties: false,
			properties: { harness: TEXT, model: TEXT, thinking: TEXT },
		},
		instructions: TEXT,
		attachments: {
			type: "object",
			propertyNames: { pattern: irSchema.$defs.portName.pattern },
			additionalProperties: {
				type: "object",
				required,
				additionalProperties: false,
				properties: { path: TEXT, hint: TEXT },
			},
		},
		readOnly: { type: "array", items: { type: "string", pattern: "^/" } },
		limits: {
			type: "object",
			additionalProperties: false,
			properties: { timeout: TEXT, tokens: { type: "integer", minimum: 1 } },
		},
		...extra,
	},
});

/** The schema of the `profiles` config namespace: each profile's fields by name, none required. */
export const PROFILES_CONFIG: JsonSchema = {
	type: "object",
	propertyNames: { pattern: PROFILE_NAME.source },
	additionalProperties: fieldsSchema(
		[],
		Object.fromEntries(RESERVED.map((k) => [k, {}])),
	),
};

const RESOLVED_SCHEMA = fieldsSchema(["path", "hint"]);

/** A file or directory an agent reads, and the hint that says when it should. `path` is absolute. */
export type ProfileAttachment = { path: string; hint: string };

/** A profile's fields once config is layered over its file. Every path is absolute. */
export type ProfileFields = {
	runtime: Runtime;
	instructions?: string;
	attachments: Record<string, ProfileAttachment>;
	/** Host paths bound read-only, set in config only. */
	readOnly: string[];
	/** `timeout` in milliseconds. */
	limits: { timeout?: number; tokens?: number };
};

/** A profile as it resolved. */
export type Profile = {
	name: string;
	/** The directory that won the name. */
	dir: string;
	/** The directories under the name that `dir` shadows, highest root first. */
	shadows: string[];
	fields: ProfileFields;
	/** Where each field came from, at its key path from the profile down. */
	sources: Composed["sources"];
	/** `sha256:<hex>` of each regular file under `dir`, by its path relative to `dir`. */
	files: Record<string, string>;
};

/** Whether `name` is a bare name or `<pack id>/<name>`. */
export const isProfileName = (name: string) => PROFILE_NAME.test(name);

/** Whether `dir` is a profile: a directory holding a `profile.yaml` file. */
const isProfile = async (dir: string) =>
	(await stat(join(dir, PROFILE_FILE)).catch(() => undefined))?.isFile() ??
	false;

/** The profile directories of the workspace and user roots, highest first. */
const unowned = (roots: Roots) =>
	[roots.workspace, roots.user]
		.filter((r): r is string => r !== undefined)
		.map((r) => join(r, PROFILES_DIR));

/** The profile directory of pack `id`, undefined when no pack of that id is installed. */
function packDir(roots: Roots, id: string) {
	const bundle = Object.hasOwn(roots.packs, id) ? roots.packs[id] : undefined;
	return bundle === undefined ? undefined : join(bundle, PROFILES_DIR);
}

/** Where `name` may live, highest root first: a bare name in the workspace and user roots, a pack's in its pack's too. */
function candidates(name: string, roots: Roots): string[] {
	const [owner = "", own] = name.split(OWNER_SEPARATOR);
	if (own === undefined) return unowned(roots).map((r) => join(r, owner));
	const pack = packDir(roots, owner);
	return [
		...unowned(roots).map((r) => join(r, owner, own)),
		...(pack === undefined ? [] : [join(pack, own)]),
	];
}

/**
 * The directory that holds profile `name` in `roots`, the first found winning whole, and the lower ones it shadows.
 * Undefined when no root holds it, or `name` is no profile name.
 */
export async function findProfile(
	name: string,
	roots: Roots,
): Promise<{ dir: string; shadows: string[] } | undefined> {
	if (!isProfileName(name)) return undefined;
	const dirs = candidates(name, roots);
	const held = await Promise.all(dirs.map(isProfile));
	const [dir, ...shadows] = dirs.filter((_, i) => held[i]);
	return dir === undefined ? undefined : { dir, shadows };
}

/** The entries of `dir`, none when it is missing or no directory. */
const entries = (dir: string) => readdir(dir).catch((): string[] => []);

/** Those of `names`, each a path under `root`, that are profiles. */
async function profilesAmong(root: string, names: string[]): Promise<string[]> {
	const held = await Promise.all(names.map((n) => isProfile(join(root, n))));
	return names.filter((_, i) => held[i]);
}

/** The profile names `roots` hold, each once: bare and two-level in the unowned roots, and each pack's. */
async function heldNames(roots: Roots): Promise<string[]> {
	const inUnowned = async (root: string) => {
		const tops = await entries(root);
		const nested = await Promise.all(
			tops.map(async (t) =>
				(await entries(join(root, t))).map((n) => `${t}/${n}`),
			),
		);
		return profilesAmong(root, [...tops, ...nested.flat()]);
	};
	const inPacks = Object.entries(roots.packs).map(async ([id, bundle]) => {
		const root = join(bundle, PROFILES_DIR);
		return (await profilesAmong(root, await entries(root))).map(
			(n) => `${id}/${n}`,
		);
	});
	const all = await Promise.all([...unowned(roots).map(inUnowned), ...inPacks]);
	return [...new Set(all.flat())].filter(isProfileName).toSorted();
}

/**
 * The fix for profile `name`, which no root holds, then `otherwise`. The first that applies:
 * - a name of `held` near it;
 * - for a pack's name, the pack to install or update;
 * - where to create it.
 */
function missingFix(
	name: string,
	roots: Roots,
	held: readonly string[],
	otherwise: string,
) {
	const near = closest(name, held);
	if (near !== undefined) return `Did you mean '${near}'?`;
	const [pack = "", own] = name.split(OWNER_SEPARATOR);
	if (own !== undefined)
		return Object.hasOwn(roots.packs, pack)
			? `Update pack '${pack}' to a version with profile '${own}', or ${otherwise}`
			: `Install pack '${pack}', or ${otherwise}`;
	const [first] = candidates(name, roots);
	return first === undefined
		? otherwise
		: `Create ${join(first, PROFILE_FILE)}, or ${otherwise}`;
}

const refusal = (source: Source | undefined, message: string, fix: string) =>
	configDiagnostic(CODE, source, message, fix);

/**
 * An error for each profile `setup` tunes under `profiles` that no root of `setup` holds, located where config sets
 * it, with a did-you-mean among the names the roots hold.
 */
export async function untunable(setup: HostSetup): Promise<Diagnostic[]> {
	const tuned = setup.config[PROFILES];
	const names = isPlainObject(tuned) ? Object.keys(tuned) : [];
	const found = await Promise.all(
		names.map((n) => findProfile(n, setup.roots)),
	);
	const missing = names.filter((_, i) => !found[i]);
	if (!missing.length) return [];
	const held = await heldNames(setup.roots);
	return missing.map((n) =>
		refusal(
			sourceOf(setup, [PROFILES, n]),
			`config '${PROFILES}.${n}' tunes profile '${n}', which no profile root holds`,
			missingFix(n, setup.roots, held, `drop '${PROFILES}.${n}'`),
		),
	);
}

/** The message and fix for `key` set in `file`, profile `name`'s file, when a profile file may not set it. */
function refusedKey(name: string, file: string, key: string) {
	if (RESERVED.includes(key))
		return [
			`profile ${name}: ${key} is reserved, not yet supported`,
			`Drop '${key}' from ${file}`,
		] as const;
	if (key === READ_ONLY)
		return [
			`profile ${name}: ${READ_ONLY} binds host paths, which a profile file holds none of`,
			`Drop '${READ_ONLY}' from ${file}, and set it in config under '${PROFILES}.${name}.${READ_ONLY}'`,
		] as const;
	return undefined;
}

/**
 * The profile file in `dir` as a `directory` layer, its paths anchored to `dir`.
 * @throws ConfigError when it cannot be read, is not YAML config, or sets a key a profile file may not.
 */
async function fileLayer(name: string, dir: string): Promise<Layer> {
	const file = join(dir, PROFILE_FILE);
	const text = await readFile(file, "utf8").catch((error: unknown) => {
		const why = error instanceof Error && "code" in error ? error.code : error;
		throw new ConfigError([
			refusal(
				undefined,
				`profile ${name}: ${file} cannot be read (${String(why)})`,
				`Make ${file} readable`,
			),
		]);
	});
	const layer = parseLayer(text, {
		file,
		layer: "directory",
		paths: PROFILE_PATHS,
	});
	const refused = [...layer.entries].flatMap(([key, tree]) => {
		const [message, fix] = refusedKey(name, file, key) ?? [];
		return message && fix ? [refusal(tree.source, message, fix)] : [];
	});
	if (refused.length) throw new ConfigError(refused);
	return layer;
}

/** The path values of `values`, a profile file's, by key path. */
function pathsIn(
	values: Readonly<Record<string, unknown>>,
): [KeyPath, string][] {
	const { instructions, attachments } = values;
	const found: [KeyPath, unknown][] = [[["instructions"], instructions]];
	if (isPlainObject(attachments))
		for (const [key, value] of Object.entries(attachments))
			if (isPlainObject(value))
				found.push([["attachments", key, "path"], value.path]);
	return found.filter((f): f is [KeyPath, string] => typeof f[1] === "string");
}

/**
 * What is wrong with the path at `key` in profile `name`'s file, given its real path, and the fix; undefined when it
 * is a file or directory inside the profile, and a file for `instructions`.
 */
async function pathProblem(
	name: string,
	dir: string,
	key: KeyPath,
	real: string | undefined,
): Promise<readonly [string, string] | undefined> {
	const root = await realpath(dir);
	if (real === undefined)
		return ["which does not exist", `Create it in ${dir}`];
	if (real === root)
		return [
			"which is the profile directory itself",
			`Point it at a file or directory inside ${dir}`,
		];
	if (!real.startsWith(root + sep))
		return [
			"which is outside the profile",
			`Keep it inside ${dir}, or set it in config under '${PROFILES}.${name}.${key.join(".")}'`,
		];
	if (key[0] === "instructions" && !(await stat(real)).isFile())
		return ["which is not a file", `Point it at a file inside ${dir}`];
	return undefined;
}

/** An error for each path in `layer`, profile `name`'s file, that `pathProblem` finds wrong. */
async function pathErrors(
	name: string,
	dir: string,
	layer: Layer,
): Promise<Diagnostic[]> {
	const file = layered([layer]);
	const checked = pathsIn(file.values).map(async ([key, path]) => {
		const real = await realpath(path).catch(() => undefined);
		const [problem, fix] = (await pathProblem(name, dir, key, real)) ?? [];
		if (problem === undefined || fix === undefined) return [];
		const at = `profile ${name}: '${key.join(".")}' is ${relative(dir, path) || "."}`;
		return [refusal(sourceOf(file, key), `${at}, ${problem}`, fix)];
	});
	return (await Promise.all(checked)).flat();
}

/** Profile `name` with config layered over its file. */
type Merged = Omit<Composed, "layers">;

/** The errors of a `limits.timeout` of `merged` that is no duration, or is longer than any timer holds. */
function timeoutErrors(name: string, merged: Merged): Diagnostic[] {
	const timeout = (merged.values.limits as { timeout?: unknown } | undefined)
		?.timeout;
	if (typeof timeout !== "string") return [];
	const ms = durationMs(timeout);
	const source = sourceOf(merged, ["limits", "timeout"]);
	if (ms === undefined)
		return [
			refusal(
				source,
				`profile ${name}: limits.timeout '${timeout}' is not a duration`,
				`Write it as ${DURATION_EXAMPLE}`,
			),
		];
	return ms > MAX_TIMEOUT
		? [
				refusal(
					source,
					`profile ${name}: limits.timeout '${timeout}' is longer than ${MAX_TIMEOUT}ms`,
					"Shorten it",
				),
			]
		: [];
}

/** An error for each reserved key config sets for profile `name`, naming where. */
function reservedErrors(name: string, merged: Merged): Diagnostic[] {
	return RESERVED.filter((k) => Object.hasOwn(merged.values, k)).map((k) => {
		const source = sourceOf(merged, [k]);
		const from = source?.file === undefined ? "" : ` from ${source.file}`;
		return refusal(
			source,
			`profile ${name}: ${k} is reserved, not yet supported`,
			`Drop '${PROFILES}.${name}.${k}'${from}`,
		);
	});
}

/** The errors of `merged`, profile `name` with config layered over its file, as fields. */
function fieldErrors(name: string, merged: Merged): Diagnostic[] {
	const reserved = reservedErrors(name, merged);
	if (reserved.length) return reserved;
	const off = offSchema(validator(), RESOLVED_SCHEMA, merged.values, {
		config: merged,
		path: [],
		hint: "Fix it where it is set",
		subject: (p) => `profile ${name}${p.length ? `: '${p.join(".")}'` : ""}`,
	});
	if (off.length) return off;
	const runtime = (merged.values.runtime ?? {}) as Partial<Runtime>;
	const unset = REQUIRED_RUNTIME.filter((f) => runtime[f] === undefined).map(
		(f) =>
			refusal(
				undefined,
				`profile ${name}: no ${f}`,
				`Set ${PROFILES}.${name}.runtime.${f}`,
			),
	);
	return [...unset, ...timeoutErrors(name, merged)];
}

/** The fields of `values`, which passed `fieldErrors`. */
function fieldsOf(values: Readonly<Record<string, unknown>>): ProfileFields {
	const { runtime, instructions, attachments, readOnly, limits } =
		values as Omit<ProfileFields, "limits"> & {
			limits?: { timeout?: string; tokens?: number };
		};
	const { timeout, tokens } = limits ?? {};
	return {
		runtime,
		...(instructions !== undefined && { instructions }),
		attachments: attachments ?? {},
		readOnly: readOnly ?? [],
		limits: {
			...(timeout !== undefined && { timeout: durationMs(timeout) }),
			...(tokens !== undefined && { tokens }),
		},
	};
}

/** `sha256:<hex>` of each regular file under `dir`, by its path relative to `dir`, in path order. */
async function fileHashes(dir: string): Promise<Record<string, string>> {
	const names = (await readdir(dir, { recursive: true })).toSorted();
	const hashed = await Promise.all(
		names.map(async (n): Promise<[string, string][]> => {
			const path = join(dir, n);
			if (!(await lstat(path)).isFile()) return [];
			return [[n, `sha256:${sha256Hex(await readFile(path))}`]];
		}),
	);
	return Object.fromEntries(hashed.flat());
}

/**
 * Resolves profile `name`: finds its directory in the roots of `setup`, reads its `profile.yaml` as the `directory`
 * layer, and layers the config layers of `setup` over it at `profiles.<name>` with every merge tag applying (ADR 0013).
 * @throws ConfigError when the name is no profile name, no root holds it, its file cannot be read or sets a refused
 * key, a path in its file is wrong by `pathProblem`, or the fields set a reserved key, are off their schema or leave the
 * harness or model unset.
 */
export async function resolveProfile(
	name: string,
	setup: Pick<HostSetup, "layers" | "roots">,
): Promise<Profile> {
	const { roots } = setup;
	if (!isProfileName(name))
		throw new ConfigError([
			refusal(
				undefined,
				`'${name}' is not a profile name`,
				"Name a profile bare or as <pack id>/<name>, in lowercase letters, digits, '-' and '_'",
			),
		]);
	const found = await findProfile(name, roots);
	if (!found)
		throw new ConfigError([
			refusal(
				undefined,
				`profile ${name} is in no profile root`,
				missingFix(name, roots, await heldNames(roots), "name another profile"),
			),
		]);
	const layer = await fileLayer(name, found.dir);
	const wrong = await pathErrors(name, found.dir, layer);
	if (wrong.length) throw new ConfigError(wrong);
	const merged = layeredOver(setup, [PROFILES, name], layer);
	const errors = fieldErrors(name, merged);
	if (errors.length) throw new ConfigError(errors);
	return {
		name,
		...found,
		fields: fieldsOf(merged.values),
		sources: merged.sources,
		files: await fileHashes(found.dir),
	};
}
