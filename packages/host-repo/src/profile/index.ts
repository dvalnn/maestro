import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
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
	canonicalJson,
	type Diagnostic,
	durationMs,
	durationText,
	irSchema,
	isPlainObject,
	type JsonSchema,
	timeoutProblem,
	validator,
} from "@maestro/ir";
import {
	type AgentEnvironment,
	type ContextAt,
	type ContextPolicy,
	type Runtime,
	STUB,
} from "../harness/index";

/** The config namespace that tunes profiles by name. */
export const PROFILES = "profiles";
/** The config namespace that rebinds seats to profiles. */
export const SEATS = "seats";
/** The directory under each root of `Roots` that holds its profiles. */
const PROFILES_DIR = "profiles";
/** The file that makes a directory a profile. */
const PROFILE_FILE = "profile.yaml";
const CODE = "HOST.profile";

const SEGMENT = irSchema.$defs.name.pattern.slice(1, -1);
/** A bare name, or `<pack id>/<name>`, each segment a pack id. */
export const PROFILE_NAME = new RegExp(`^${SEGMENT}(?:/${SEGMENT})?$`);
/** The `profiles` key whose entry applies to every profile its layer does not name, beneath the named entries. */
export const ANY_PROFILE = "*";
/** `<composition id>/<seat>`, the key `seats` rebinds a seat by (ADR 0013). */
const SEAT_KEY = new RegExp(`^${SEGMENT}/${SEGMENT}$`);
const OWNER_SEPARATOR = "/";
/** The directory where an agent's sandbox mounts its attachments. */
const ATTACHMENT_DIR = "/in";

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
const COUNT = { type: "integer", minimum: 1 } as const;
/** A context policy's `at` as a share of the window: a whole percentage from 1 to 99. */
const PERCENT = /^([1-9][0-9]?)%$/;

/**
 * A profile's fields, and `extra`. Once `resolved`, an attachment requires its path and hint, and a context block its
 * strategy and trigger.
 */
const fieldsSchema = (
	resolved: boolean,
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
				required: resolved ? ["path", "hint"] : [],
				additionalProperties: false,
				properties: { path: TEXT, hint: TEXT },
			},
		},
		context: {
			type: "object",
			required: resolved ? ["strategy", "at"] : [],
			additionalProperties: false,
			properties: {
				strategy: { enum: ["handoff", "compact"] },
				at: {
					type: ["integer", "string"],
					minimum: 1,
					pattern: PERCENT.source,
				},
				max: COUNT,
			},
		},
		readOnly: { type: "array", items: { type: "string", pattern: "^/" } },
		limits: {
			type: "object",
			additionalProperties: false,
			properties: { timeout: TEXT, tokens: COUNT },
		},
		...extra,
	},
});

/** The schema of the `profiles` config namespace: each profile's fields by name, none required. */
export const PROFILES_CONFIG: JsonSchema = {
	type: "object",
	propertyNames: {
		pattern: `^(?:\\${ANY_PROFILE}|${PROFILE_NAME.source.slice(1, -1)})$`,
	},
	additionalProperties: fieldsSchema(
		false,
		Object.fromEntries(RESERVED.map((k) => [k, {}])),
	),
};

const RESOLVED_SCHEMA = fieldsSchema(true);

/** The schema of the `seats` config namespace: a profile name by seat key. */
export const SEATS_CONFIG: JsonSchema = {
	type: "object",
	propertyNames: { pattern: SEAT_KEY.source },
	additionalProperties: { type: "string", pattern: PROFILE_NAME.source },
};

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
	context?: ContextPolicy<ContextAt>;
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

/** Where the sandbox sees attachment `name`. */
export const attachmentPath = (name: string) => `${ATTACHMENT_DIR}/${name}`;

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

export type ProfileRoot = "workspace" | "user" | "pack";

/** The root kind of `roots` that holds `dir`, a directory `findProfile` gave. */
export function profileRoot(dir: string, roots: Roots): ProfileRoot {
	const holds = (root: string) =>
		dir.startsWith(join(root, PROFILES_DIR) + sep);
	if (roots.workspace !== undefined && holds(roots.workspace))
		return "workspace";
	return holds(roots.user) ? "user" : "pack";
}

/** The entries of `dir`, none when it is missing or no directory. */
const entries = (dir: string) => readdir(dir).catch((): string[] => []);

/** Those of `names`, each a path under `root`, that are profiles. */
async function profilesAmong(root: string, names: string[]): Promise<string[]> {
	const held = await Promise.all(names.map((n) => isProfile(join(root, n))));
	return names.filter((_, i) => held[i]);
}

/** The profile names `roots` hold, each once and sorted: bare and two-level in the unowned roots, and each pack's. */
export async function heldNames(roots: Roots): Promise<string[]> {
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

/** The profile a seat runs, and where config rebound it, when it did. */
export type Binding = { profile: string; source?: ValueSource };

/**
 * The profile seat `seat.seat` of composition `composition` runs: the one `seats` in `setup` rebinds it to, keyed
 * `<composition>/<seat>`, else `seat.profile`, the one it declares.
 */
export function seatBinding(
	setup: Pick<HostSetup, "config" | "sources">,
	composition: string,
	seat: { seat: string; profile: string },
): Binding {
	const key = `${composition}/${seat.seat}`;
	const seats = setup.config[SEATS];
	const bound =
		isPlainObject(seats) && Object.hasOwn(seats, key) ? seats[key] : undefined;
	if (typeof bound !== "string") return { profile: seat.profile };
	const source = sourceOf(setup, [SEATS, key]);
	return { profile: bound, ...(source && { source: valueSource(source) }) };
}

/**
 * An error for each profile `setup` tunes under `profiles` that no root of `setup` holds, located where config sets
 * it, with a did-you-mean among the names the roots hold.
 */
export async function untunable(setup: HostSetup): Promise<Diagnostic[]> {
	const tuned = setup.config[PROFILES];
	const names = isPlainObject(tuned)
		? Object.keys(tuned).filter((n) => n !== ANY_PROFILE)
		: [];
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
	const found = timeoutProblem(timeout);
	if (!found) return [];
	return [
		refusal(
			sourceOf(merged, ["limits", "timeout"]),
			`profile ${name}: limits.timeout '${timeout}' ${found.problem}`,
			found.fix,
		),
	];
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

/** The refusal message of profile `name` leaving required runtime field `field` unset. */
export const unsetMessage = (name: string, field: "harness" | "model") =>
	`profile ${name}: no ${field}`;

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
	const unset = REQUIRED_RUNTIME.filter(
		(f) =>
			runtime[f] === undefined && !(f === "model" && runtime.harness === STUB),
	).map((f) =>
		refusal(
			undefined,
			unsetMessage(name, f),
			`Set ${PROFILES}.${name}.runtime.${f}`,
		),
	);
	return [
		...unset,
		...timeoutErrors(name, merged),
		...contextErrors(name, merged),
	];
}

/** A context block as config writes it. */
type WrittenContext = Omit<ContextPolicy, "at" | "max"> & {
	at: number | string;
	max?: number;
};

/** A profile's values as config writes them, once they passed the schema. */
type Written = Omit<ProfileFields, "runtime" | "limits" | "context"> & {
	runtime: Omit<Runtime, "model"> & { model?: string };
	limits?: { timeout?: string; tokens?: number };
	context?: WrittenContext;
};

const writtenOf = (values: Readonly<Record<string, unknown>>) =>
	values as Written;

/** The error of a `handoff` context block of `merged` with no `max`. */
function contextErrors(name: string, merged: Merged): Diagnostic[] {
	const { context } = writtenOf(merged.values);
	if (context?.strategy !== "handoff" || context.max !== undefined) return [];
	return [
		refusal(
			sourceOf(merged, ["context", "strategy"]),
			`profile ${name}: context.max is required for strategy handoff`,
			`Set ${PROFILES}.${name}.context.max, the most handoffs the agent may make`,
		),
	];
}

/** `at` as config writes it: tokens as a whole number, or a percentage such as `"25%"`. */
const contextAt = (at: number | string): ContextAt =>
	typeof at === "number"
		? { tokens: at }
		: { percent: Number(PERCENT.exec(at)?.[1]) };

/** `context`, which passed `contextErrors`. */
function contextOf({
	strategy,
	at,
	max,
}: WrittenContext): ContextPolicy<ContextAt> {
	if (strategy === "compact")
		return { strategy, at: contextAt(at), ...(max !== undefined && { max }) };
	if (max === undefined)
		throw new Error("context.max is required for strategy handoff");
	return { strategy, at: contextAt(at), max };
}

/** The fields of `values`, which passed `fieldErrors`. */
function fieldsOf(values: Readonly<Record<string, unknown>>): ProfileFields {
	const { runtime, instructions, attachments, readOnly, limits, context } =
		writtenOf(values);
	const { timeout, tokens } = limits ?? {};
	return {
		// The stub runs no model, so one left unset reads as the stub's own.
		runtime: { ...runtime, model: runtime.model ?? STUB },
		...(instructions !== undefined && { instructions }),
		attachments: attachments ?? {},
		readOnly: readOnly ?? [],
		limits: {
			...(timeout !== undefined && { timeout: durationMs(timeout) }),
			...(tokens !== undefined && { tokens }),
		},
		...(context && { context: contextOf(context) }),
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

/** `sha256:<hex>` over the files of every profile `roots` hold, each name's that wins: any edit to one changes it. */
export async function profilesDigest(roots: Roots): Promise<string> {
	const names = await heldNames(roots);
	const held = await Promise.all(
		names.map(async (name) => {
			const found = await findProfile(name, roots);
			return [name, found ? await fileHashes(found.dir) : null];
		}),
	);
	return `sha256:${sha256Hex(canonicalJson(Object.fromEntries(held)))}`;
}

/**
 * `layer` as profile `name` sees it: its `profiles."*"` entry set as `name`'s in a layer of its own just beneath it, so
 * the entry `layer` names `name` by merges over it. A `!replace` on `profiles` moves to that layer beneath.
 */
function anyProfileFor(name: string, layer: Layer): Layer[] {
	const profiles = layer.entries.get(PROFILES);
	if (profiles?.kind !== "map") return [layer];
	const any = profiles.entries.get(ANY_PROFILE);
	if (any === undefined) return [layer];
	const at = (entries: typeof profiles.entries, replace: boolean): Layer => ({
		...layer,
		entries: new Map([
			...layer.entries,
			[PROFILES, { ...profiles, entries, replace }],
		]),
	});
	return [
		at(new Map([[name, any]]), profiles.replace),
		at(profiles.entries, false),
	];
}

/**
 * Resolves profile `name`: finds its directory in the roots of `setup`, reads its `profile.yaml` as the `directory`
 * layer, and layers the config layers of `setup` over it at `profiles.<name>` with every merge tag applying (ADR 0013), each
 * layer's `profiles."*"` beneath its `profiles.<name>`.
 * @throws ConfigError when the name is no profile name, no root holds it, its file cannot be read or sets a refused
 * key, a path in its file is wrong by `pathProblem`, or the fields set a reserved key, are off their schema or leave the
 * harness unset, or the model unset on any harness but the stub.
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
	const merged = layeredOver(
		{ layers: setup.layers.flatMap((l) => anyProfileFor(name, l)) },
		[PROFILES, name],
		layer,
	);
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

export type ValueSource = Pick<Source, "layer" | "file" | "line" | "flag">;

export type Inspection = {
	name: string;
	root: ProfileRoot;
	dir: string;
	shadows: string[];
	runtime: Runtime;
	instructions?: string;
	attachments: Record<string, ProfileAttachment & { agent: string }>;
	readOnly: string[];
	limits: { timeout?: string; tokens?: number };
	/** As config writes it, `at` in tokens or as a percentage such as `"25%"`. */
	context?: {
		strategy: ContextPolicy["strategy"];
		at: number | string;
		max?: number;
	};
	sources: Record<string, ValueSource>;
	environment: { declared: AgentEnvironment | null };
};

/** How each layer above the profile's own file reads in a source's words; a preset names itself. */
const LAYER_WORDS: Partial<Record<Source["layer"], string>> = {
	user: "user config",
	workspace: "workspace config",
	flag: "-c",
};

/** `source` in words, such as `preset risky`; undefined for the profile's own file. */
export function sourceWords(source: ValueSource): string | undefined {
	const { layer, file } = source;
	if (layer === "preset" && file !== undefined)
		return `preset ${basename(file, extname(file))}`;
	return LAYER_WORDS[layer];
}

const valueSource = ({ layer, file, line, flag }: Source): ValueSource => ({
	layer,
	...(file !== undefined && { file }),
	...(line !== undefined && { line }),
	...(flag !== undefined && { flag }),
});

const inside = (root: string | undefined, path: string) =>
	root !== undefined && path.startsWith(root + sep);

/** `path` relative to `base` when inside it, else to the workspace root of `roots` when inside that, else unchanged. */
export function readablePath(
	path: string,
	base: string | undefined,
	roots: Roots,
): string {
	const workspace = roots.workspace && dirname(roots.workspace);
	const root = [base, workspace].find((r) => inside(r, path));
	return root === undefined ? path : relative(root, path);
}

/**
 * `profile`, found in `roots`, with each value's source by dotted key, its attachments' sandbox paths and the
 * baseline `declared` gives its harness, null when none is declared. Paths are absolute.
 */
export function inspectProfile(
	profile: Profile,
	roots: Roots,
	declared: ReadonlyMap<string, AgentEnvironment>,
): Inspection {
	const { runtime, instructions, attachments, readOnly, limits, context } =
		profile.fields;
	const { timeout, tokens } = limits;
	return {
		name: profile.name,
		root: profileRoot(profile.dir, roots),
		dir: profile.dir,
		shadows: profile.shadows,
		runtime,
		...(instructions !== undefined && { instructions }),
		attachments: Object.fromEntries(
			Object.entries(attachments).map(([name, a]) => [
				name,
				{ ...a, agent: attachmentPath(name) },
			]),
		),
		readOnly,
		limits: {
			...(timeout !== undefined && { timeout: durationText(timeout) }),
			...(tokens !== undefined && { tokens }),
		},
		...(context !== undefined && {
			context: {
				...context,
				at:
					"tokens" in context.at ? context.at.tokens : `${context.at.percent}%`,
			},
		}),
		sources: Object.fromEntries(
			profile.sources.map(({ path, source }) => [
				path.join("."),
				valueSource(source),
			]),
		),
		environment: { declared: declared.get(runtime.harness) ?? null },
	};
}
