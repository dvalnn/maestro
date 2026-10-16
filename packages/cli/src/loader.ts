import { realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { messageOf, sha256Hex } from "@maestro/core";
import { validator, violations } from "@maestro/core/ports";
import type { CodeFunction, KeyFunction, LoadCode } from "@maestro/core/worker";
import {
	type Diagnostic,
	type Ir,
	irSchema,
	isPlainObject,
	type JsonSchema,
	mapWorkers,
	type ParseResult,
	parseIr,
	TS_RUNTIME,
	type WorkerRef,
} from "@maestro/ir";
import {
	type ConfiguredParams,
	type Described,
	glue,
	SDK_VERSION,
	STDLIB_HASH,
	STDLIB_MODULE,
} from "@maestro/sdk";
import * as stdlib from "@maestro/sdk/stdlib";

/** The `codeHash` of the code a worker reference names as it is now (ADR 0008). */
export type CodeHash = (ref: WorkerRef) => Promise<string>;

/** Resolves a worker reference to its function, and to its code's current `codeHash` (ADR 0008). */
export type Loader = { loadCode: LoadCode; codeHash: CodeHash };

/** A loaded pack bundle or bare composition file: its compositions, and how to build them. */
export type Bundle = Loader & {
	pack: { id: string; version: string };
	/** The directory each worker reference's `module` is relative to. */
	dir: string;
	/** The bundle's own `module`. */
	module: string;
	compositions: readonly Described[];
	/**
	 * Builds the composition `name` through the bundle's own SDK, with `params` for the root and `configured` for each
	 * subcomposition. A build diagnostic comes back as a failed parse.
	 */
	build(
		name: string,
		params: Readonly<Record<string, unknown>>,
		configured?: ConfiguredParams,
	): ParseResult;
};

const MANIFEST = "maestro-pack.json";

const MANIFEST_SCHEMA: JsonSchema = {
	type: "object",
	required: ["id", "version", "entry", "sdk"],
	additionalProperties: false,
	properties: {
		id: { type: "string", pattern: irSchema.$defs.name.pattern },
		version: { type: "string", minLength: 1 },
		entry: { type: "string", minLength: 1 },
		sdk: { type: "string", minLength: 1 },
	},
};

type Manifest = {
	id: string;
	version: string;
	/** The bundle file, relative to the pack's directory. */
	entry: string;
	/** A semver range on the SDK. */
	sdk: string;
};

/** What a bundle's `describe()` must return. */
const DESCRIBED_SCHEMA: JsonSchema = {
	type: "array",
	items: {
		type: "object",
		required: ["name", "params", "examples"],
		properties: {
			name: { type: "string" },
			doc: { type: "string" },
			params: {
				type: "object",
				required: ["properties", "required"],
				properties: {
					properties: { type: "object" },
					required: { type: "array", items: { type: "string" } },
				},
			},
			examples: { type: "array", items: { type: "object" } },
		},
	},
};

/** The source of a bare file's bundle entry, beside the file, so the file's relative imports resolve. */
const ENTRY = ".maestro-entry.js";
const HASH_PREFIX = "sha256:";
/** The `version` of a bare file's compositions, which have no manifest to declare one. */
const FILE_VERSION = "0.0.0";
const SDK = "@maestro/sdk";
const SDK_IMPORT = /^@maestro\/sdk$/;

type Namespace = Readonly<Record<string, unknown>>;

/** A module's current `codeHash`, and its namespace, imported on demand. */
type Opened = { hash: string; load: () => Promise<Namespace> };

/** The `codeHash` of a module's `bytes` (ADR 0008). */
export const codeHashOf = (bytes: Uint8Array | string) =>
	HASH_PREFIX + sha256Hex(bytes);

/** The function `ref.export` names in `namespace`: an export, or a function one object export down (`b.fn`). */
function exported(
	namespace: Namespace,
	ref: WorkerRef,
	what: string,
): CodeFunction | KeyFunction {
	const [head = "", tail, ...rest] = ref.export.split(".");
	const outer = Object.hasOwn(namespace, head) ? namespace[head] : undefined;
	const fn =
		tail === undefined
			? outer
			: isPlainObject(outer) && Object.hasOwn(outer, tail)
				? outer[tail]
				: undefined;
	if (rest.length > 0 || typeof fn !== "function")
		throw new Error(`${what} has no exported function '${ref.export}'`);
	return fn as CodeFunction | KeyFunction;
}

/**
 * A loader over `open`. A `maestro:stdlib` reference resolves to the stdlib of the SDK the engine embeds; any other
 * loads only when its module's current hash is the reference's `codeHash`.
 */
function loaderOver(open: (module: string) => Promise<Opened>): Loader {
	return {
		codeHash: async (ref) =>
			ref.module === STDLIB_MODULE
				? STDLIB_HASH
				: (await open(ref.module)).hash,
		loadCode: async (ref) => {
			if (ref.module === STDLIB_MODULE)
				return exported(stdlib, ref, "maestro's stdlib");
			const { hash, load } = await open(ref.module);
			if (hash !== ref.codeHash)
				throw new Error(
					`module '${ref.module}' has codeHash ${hash}, not the ${ref.codeHash} the IR names\nRebuild the pack, or recompute the IR's codeHash`,
				);
			return exported(await load(), ref, `module '${ref.module}'`);
		},
	};
}

/** `error`'s message, each of a bundler's messages led by its file, line and column. */
function bundlerMessage(error: unknown): string {
	if (!(error instanceof AggregateError)) return messageOf(error);
	return error.errors
		.map((e: { position?: { file: string; line: number; column: number } }) => {
			const at = e.position;
			return at
				? `${at.file}:${at.line}:${at.column}: ${messageOf(e)}`
				: messageOf(e);
		})
		.join("; ");
}

/**
 * `entry` bundled in memory, `files` standing over the disk, its SDK import the engine's own.
 * @throws Error when it does not bundle.
 */
async function bundle(
	entry: string,
	files: Record<string, string>,
): Promise<string> {
	const sdk = Bun.resolveSync(SDK, import.meta.dir);
	try {
		const out = await Bun.build({
			entrypoints: [entry],
			files,
			target: "bun",
			format: "esm",
			// Without whitespace, Bun writes each source path as a comment, and the hash would follow the cwd.
			minify: { whitespace: true },
			plugins: [
				{
					name: "maestro-sdk",
					setup: (b) => {
						b.onResolve({ filter: SDK_IMPORT }, () => ({ path: sdk }));
					},
				},
			],
		});
		const [output] = out.outputs;
		if (!output) throw new Error("the bundler wrote nothing");
		return await output.text();
	} catch (error) {
		throw new Error(bundlerMessage(error));
	}
}

const imported = (text: string): Promise<Namespace> =>
	import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);

/** Each module's namespace by `codeHash`, so the same bytes bundle once. */
const namespaces = new Map<string, Promise<Namespace>>();

/** What the module source `text` imports beyond the builtins and the SDK. */
const outsideOf = (text: string): string[] =>
	new Bun.Transpiler({ loader: "ts" })
		.scanImports(text)
		.map((i) => i.path)
		.filter((path) => !isBuiltin(path) && !SDK_IMPORT.test(path));

/**
 * The module file `module`, relative to `dir`: its `codeHash`, `sha256:` and the hex SHA-256 of its bytes, and a load
 * of those same bytes.
 * @throws Error when the file is missing.
 */
async function openModule(dir: string, module: string): Promise<Opened> {
	const file = resolve(dir, module);
	const bytes = await Bun.file(file)
		.bytes()
		.catch((error: { code?: string }) => {
			if (error.code !== "ENOENT") throw error;
			throw new Error(
				`module ${file} not found\nRestore it, or fix the module the IR names`,
			);
		});
	const hash = codeHashOf(bytes);
	const load = async () => {
		const text = new TextDecoder().decode(bytes);
		const outside = outsideOf(text);
		if (outside.length)
			throw new Error(
				`module '${module}' imports '${outside.join("', '")}', which its codeHash does not cover\nBundle it, e.g. through \`maestro compose --out\``,
			);
		const namespace =
			namespaces.get(hash) ?? bundle(file, { [file]: text }).then(imported);
		namespaces.set(hash, namespace);
		return namespace;
	};
	return { hash, load };
}

/** The loader of worker references whose `module` is a file relative to `dir`, as in an IR file or a pack. */
export const moduleLoader = (dir: string): Loader =>
	loaderOver((module) => openModule(dir, module));

/** Each export of `namespace` by name, and each property of a plain-object export by `<export>.<property>`. */
const entriesOf = (namespace: Namespace): [string, unknown][] =>
	Object.entries(namespace).flatMap(([name, value]) =>
		isPlainObject(value)
			? Object.entries(value).map(([key, inner]): [string, unknown] => [
					`${name}.${key}`,
					inner,
				])
			: [[name, value]],
	);

/** Every function among `namespace`'s exports and one level down, with each of its names. */
function namesOf(namespace: Namespace): Map<unknown, string[]> {
	const names = new Map<unknown, string[]>();
	for (const [name, value] of entriesOf(namespace))
		if (typeof value === "function")
			names.set(value, [...(names.get(value) ?? []), name]);
	return names;
}

/**
 * The `diagnostic` a build error from any SDK copy carries, read by shape, not class (ADR 0002). Its location is
 * dropped unless it names an absolute file path, as a bundle's frames name the bundle itself.
 */
function diagnosticOf(error: unknown): Diagnostic | undefined {
	const diagnostic = (error as { diagnostic?: unknown } | null)?.diagnostic;
	if (!isPlainObject(diagnostic) || typeof diagnostic.code !== "string")
		return undefined;
	const { source, ...rest } = diagnostic as Diagnostic;
	return source && isAbsolute(source.file) ? { ...rest, source } : rest;
}

type Entry = {
	describe: () => unknown;
	build: (name: string, params: unknown, context: unknown) => unknown;
};

const isEntry = (namespace: Namespace): boolean =>
	typeof namespace.describe === "function" &&
	typeof namespace.build === "function";

/**
 * A bundle over `namespace`, whose functions live in `module` and hash to `hash`.
 * @throws Error naming `what` when the bundle's entry lacks `describe()` and `build()`, or its `describe()` is off
 * shape.
 */
function bundleOf(
	what: string,
	from: { pack: Bundle["pack"]; dir: string; module: string; hash: string },
	namespace: Namespace,
	loader: Loader,
): Bundle {
	if (!isEntry(namespace))
		throw new Error(
			`${what}: its entry exports no describe() and build()\nRebuild it so its entry is the SDK's glue`,
		);
	const entry = namespace as unknown as Entry;
	const compositions = entry.describe();
	const off = violations(
		validator(),
		DESCRIBED_SCHEMA,
		compositions,
		(segments) => ["describe()", ...segments].join("."),
	);
	if (off.length)
		throw new Error(
			`${what}: ${off.join("; ")}\nRebuild it with a maestro SDK`,
		);
	const names = namesOf(namespace);
	const resolveCode = (fn: unknown): WorkerRef | undefined => {
		const found = (names.get(fn) ?? []).toSorted();
		if (found.length > 1)
			throw new Error(
				`function '${(fn as { name?: string }).name}' is exported under two names, '${found.join("' and '")}'`,
			);
		const [name] = found;
		return name === undefined
			? undefined
			: {
					runtime: TS_RUNTIME,
					module: from.module,
					export: name,
					codeHash: from.hash,
				};
	};
	return {
		...loader,
		pack: from.pack,
		dir: from.dir,
		module: from.module,
		compositions: compositions as Described[],
		build(name, params, configured = {}) {
			const context = { pack: from.pack, resolveCode, params: configured };
			let built: unknown;
			try {
				built = entry.build(name, params, context);
			} catch (error) {
				const diagnostic = diagnosticOf(error);
				if (diagnostic) return { ok: false, diagnostics: [diagnostic] };
				throw error;
			}
			return parseIr(JSON.parse(String(built)));
		},
	};
}

async function manifestOf(dir: string): Promise<Manifest> {
	const file = join(dir, MANIFEST);
	let value: unknown;
	try {
		value = await Bun.file(file).json();
	} catch (error) {
		throw new Error(
			`cannot read ${file}: ${messageOf(error)}\nGive the pack a JSON manifest, or remove '${dir}' from packs`,
		);
	}
	const off = violations(validator(), MANIFEST_SCHEMA, value, (segments) =>
		["manifest", ...segments].join("."),
	);
	if (off.length)
		throw new Error(`${file}: ${off.join("; ")}\nFix the manifest`);
	return value as Manifest;
}

function checkSdk(manifest: Manifest, sdk: string, dir: string) {
	if (!Bun.semver.satisfies(sdk, manifest.sdk))
		throw new Error(
			`pack '${manifest.id}' at ${dir} needs SDK ${manifest.sdk}, and this maestro has ${sdk}\nRebuild the pack against SDK ${sdk}, or remove it from packs`,
		);
}

/** The pack's entry file. @throws Error when it resolves outside the pack's directory. */
async function entryOf(manifest: Manifest, dir: string): Promise<string> {
	const entry = await realpath(resolve(dir, manifest.entry)).catch(() => {
		throw new Error(
			`pack '${manifest.id}' at ${dir} has no entry file '${manifest.entry}'\nBuild the pack, or fix 'entry' in its ${MANIFEST}`,
		);
	});
	if (!entry.startsWith(dir + sep))
		throw new Error(
			`pack '${manifest.id}' at ${dir} has entry '${manifest.entry}' outside its directory\nPoint 'entry' at its bundle inside the pack`,
		);
	return entry;
}

/**
 * Loads the pack in directory `dir`: its manifest, its SDK range checked against `sdk`, and its entry. Worker references
 * name the entry relative to the pack's directory, and their `codeHash` is the entry's, as `moduleLoader` hashes it:
 * the whole bundle (ADR 0008).
 * @throws Error for a missing directory or manifest, a manifest off its schema, a version out of range, an entry
 * outside the pack, or one that does not import, each naming the pack.
 */
export async function openPack(
	dir: string,
	sdk = SDK_VERSION,
): Promise<Bundle> {
	const root = await realpath(dir).catch(() => {
		throw new Error(
			`pack directory '${dir}' does not exist\nFix its path in packs`,
		);
	});
	const manifest = await manifestOf(root);
	checkSdk(manifest, sdk, root);
	const entry = await entryOf(manifest, root);
	const module = relative(root, entry);
	const { hash, load } = await openModule(root, module);
	const what = `pack '${manifest.id}' at ${root}`;
	let namespace: Namespace;
	try {
		namespace = await load();
	} catch (error) {
		throw new Error(
			`${what}: cannot load its entry '${manifest.entry}': ${messageOf(error)}\nRebuild the pack, or remove it from packs`,
		);
	}
	const pack = { id: manifest.id, version: manifest.version };
	return bundleOf(
		what,
		{ pack, dir: root, module, hash },
		namespace,
		moduleLoader(root),
	);
}

/**
 * The bundle of the composition file `file`, made in memory behind the SDK's glue, its SDK import the engine's own.
 * @throws Error when it does not bundle.
 */
export async function bundled(file: string): Promise<string> {
	const entry = join(dirname(file), ENTRY);
	try {
		return await bundle(entry, { [entry]: glue(`./${basename(file)}`) });
	} catch (error) {
		throw new Error(
			`cannot bundle ${file}: ${messageOf(error)}\nFix the file or its imports`,
		);
	}
}

/**
 * Loads a bare composition file: its own entry, bundled in memory so `codeHash` covers it, its imports and its SDK.
 * Worker references name the file relative to its directory, and their `codeHash` is `sha256:` and the hex SHA-256 of
 * the bundle. Its compositions take the file's name, less its extension, as their pack id.
 * @throws Error when the file does not bundle or import.
 */
export async function openFile(file: string): Promise<Bundle> {
	const path = resolve(file);
	const module = basename(path);
	const id = basename(path, extname(path));
	const text = await bundled(path);
	const hash = codeHashOf(text);
	const what = `composition file ${path}`;
	let namespace: Namespace;
	try {
		namespace = await imported(text);
	} catch (error) {
		throw new Error(
			`${what}: cannot load it: ${messageOf(error)}\nFix the file`,
		);
	}
	const loader = loaderOver(async (m) => {
		if (m !== module)
			throw new Error(
				`module '${m}' is not ${module}, the file this loader bundles`,
			);
		return { hash, load: async () => namespace };
	});
	const pack = { id, version: FILE_VERSION };
	return bundleOf(
		what,
		{ pack, dir: dirname(path), module, hash },
		namespace,
		loader,
	);
}

/** `ir` with the `codeHash` of each code node and each `map` key function replaced by its current one. */
export async function withCurrentHashes(
	ir: Ir,
	codeHash: CodeHash,
): Promise<Ir> {
	const refs: WorkerRef[] = [];
	mapWorkers(ir, (ref) => {
		refs.push(ref);
		return ref;
	});
	const hashes = new Map<WorkerRef, string>();
	for (const ref of refs) hashes.set(ref, await codeHash(ref));
	return mapWorkers(ir, (ref) => ({
		...ref,
		codeHash: hashes.get(ref) ?? ref.codeHash,
	}));
}

/** `ir` with each worker reference's `module` moved from relative to `from` to relative to `to`. */
export const rewriteModules = (ir: Ir, from: string, to: string): Ir =>
	mapWorkers(ir, (ref) =>
		ref.module === STDLIB_MODULE
			? ref
			: { ...ref, module: relative(to, resolve(from, ref.module)) },
	);

/**
 * The config each bundle claims: its pack id, then its compositions' names, then each one's param names.
 * @throws Error when two bundles share a pack id.
 */
export function claimsOf(
	bundles: readonly Bundle[],
): Record<string, Record<string, string[]>> {
	const claims: Record<string, Record<string, string[]>> = {};
	const dirs = new Map<string, string>();
	for (const { pack, dir, compositions } of bundles) {
		const other = dirs.get(pack.id);
		if (other !== undefined)
			throw new Error(
				`pack id '${pack.id}' is taken twice, by ${other} and by ${dir}\nRemove one of them from packs`,
			);
		dirs.set(pack.id, dir);
		claims[pack.id] = Object.fromEntries(
			compositions.map((c) => [c.name, Object.keys(c.params.properties)]),
		);
	}
	return claims;
}
