import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { closest } from "@maestro/core";
import { type ComposeInput, compose } from "@maestro/core/compose";
import { CORE_CONFIG, type Composed, type Layer } from "@maestro/core/config";
import type { ConcertRecord, Staged } from "@maestro/core/perform";
import {
	type Ir,
	irSchema,
	isPlainObject,
	mapWorkers,
	messageOf,
	type Plan,
	parseIr,
} from "@maestro/ir";
import { type Described, STDLIB_MODULE } from "@maestro/sdk/loader";
import {
	COMMON,
	colorOf,
	type Deps,
	type Options,
	parse,
	peek,
	type Values,
	warn,
} from "./command";
import { baseOf, CLI_CONFIG } from "./config";
import { flagValues, paramFlags, paramsBlock } from "./flags";
import {
	type Bundle,
	bundled,
	claimsOf,
	codeHashOf,
	type Loader,
	moduleLoader,
	openFile,
	openPack,
	rewriteModules,
	withCurrentHashes,
} from "./loader";
import { CliError, Diagnosed, usageError } from "./output";
import { paramValues } from "./params";
import { openSession, overridesOf, type Session } from "./session";

/** A composition's IR, with what loads its code, composes it, and keeps it with a concert. */
export type Prepared = {
	ir: Ir;
	loader: Loader;
	/** The directory the IR's worker references' `module` are relative to. */
	moduleDir: string;
	config: Composed;
	claims: ComposeInput["packs"];
	/** The path of the bare composition file the IR was built from, whose code is in memory. */
	file?: string;
	/** The flags the command was given. */
	values: Values;
	/** The root's params the flags gave, those recorded beneath them for an encore. */
	params?: Readonly<Record<string, unknown>>;
	/** The files the params name, to stage into a new concert; absent for a built IR, whose files are not known. */
	staged?: readonly Staged[];
};

/** The flags `compose` takes beyond the common ones. */
export const COMPOSE_FLAGS = {
	out: {
		type: "string",
		arg: "file",
		desc: "Save the IR to this file, with its code beside it",
	},
	plan: { type: "boolean", desc: "Print the plan in full" },
	graph: { type: "boolean", desc: "Print the graph as a Mermaid flowchart" },
} as const satisfies Options;

/** The flags `perform` takes beyond the common ones. */
export const PERFORM_FLAGS = {
	tour: {
		type: "string",
		arg: "slug",
		desc: "Put the concert on this tour (default: MAESTRO_TOUR)",
	},
	title: { type: "string", arg: "text", desc: "Give the concert a title" },
	resume: {
		type: "string",
		arg: "concert",
		desc: "Resume this failed or rejected concert instead of starting one",
	},
	encore: {
		type: "string",
		arg: "concert",
		desc: "Perform this concert's composition again, its agents continuing their sessions",
	},
} as const satisfies Options;

/** Flags a param may not take, whichever command reads the composition, so it is valid for all of them or none. */
const RESERVED: Options = { ...COMMON, ...COMPOSE_FLAGS, ...PERFORM_FLAGS };

/**
 * How a command reads its target: its name, its flags, whether a composition's example set stands in for flags, and,
 * for an encore, the root's params its concert recorded, which the flags override.
 */
export type Reading = {
	verb: string;
	options: Options;
	examples: boolean;
	recorded?: Readonly<Record<string, unknown>>;
};

const FILE = /\.(?:ts|js)$/;
const PACK_ID = new RegExp(irSchema.$defs.name.pattern);
const IR_FILE = /\.json$/;
const BUNDLE_SUFFIX = ".bundle.js";

const installed = (session: Session): Promise<Bundle[]> =>
	Promise.all(session.config.packs.map((pack) => openPack(pack)));

const namesOf = (compositions: readonly Described[]) =>
	compositions.map((c) => c.name).join(", ");

/** A usage error for `name`, which is none of `names`: `what`, then a did-you-mean when one is near, else `fix`. */
const unknownName = (
	what: string,
	name: string,
	names: readonly string[],
	fix: string,
) => {
	const near = closest(name, names);
	return usageError(what, near === undefined ? fix : `Did you mean '${near}'?`);
};

/**
 * The composition `name` of `bundle`, or its only one when `name` is undefined.
 * @throws CliError, a usage error naming `what`, when it has no such composition, or not exactly one.
 */
export function chosen(
	bundle: Bundle,
	what: string,
	name: string | undefined,
): Described {
	const { compositions } = bundle;
	const found =
		name === undefined
			? compositions.length === 1
				? compositions[0]
				: undefined
			: compositions.find((c) => c.name === name);
	if (found) return found;
	if (name !== undefined)
		throw unknownName(
			`${what} has no composition '${name}'`,
			name,
			compositions.map((c) => c.name),
			`Name one of: ${namesOf(compositions)}`,
		);
	throw usageError(
		`${what} exports ${compositions.length} compositions, not one`,
		compositions.length
			? `Move all but one of ${namesOf(compositions)} to another file`
			: "Export a composition from it",
	);
}

/** Splits `<pack>.<composition>` at its dot. */
function split(target: string): [string, string] {
	const dot = target.indexOf(".");
	if (dot < 1 || dot === target.length - 1)
		throw usageError(
			`'${target}' is neither a file nor <pack>.<composition>`,
			`Name a .ts, .js or .json file, or a composition of an installed pack as <pack>.<composition>`,
		);
	return [target.slice(0, dot), target.slice(dot + 1)];
}

/**
 * The installed pack `id` among `packs`, whose directories live in `packsDir` or are listed in the config.
 * @throws CliError, a usage error, when none is.
 */
export function installedPack(
	packs: readonly Bundle[],
	id: string,
	packsDir: string,
): Bundle {
	const found = packs.find((p) => p.pack.id === id);
	if (found) return found;
	const ids = packs.map((p) => p.pack.id);
	throw unknownName(
		`no pack '${id}' is installed`,
		id,
		ids,
		`Extract it into ${packsDir}, or list its directory under packs in the config${ids.length ? `; installed: ${ids.join(", ")}` : ""}`,
	);
}

/** @throws CliError, a usage error naming `target` as typed, when no file is there. */
async function requireFile(session: Session, target: string) {
	if (!(await Bun.file(resolve(session.deps.cwd, target)).exists()))
		throw usageError(`no such file: ${target}`, "Check the path");
}

async function loadIr(
	session: Session,
	reading: Reading,
	target: string,
	args: readonly string[],
): Promise<Prepared> {
	const file = resolve(session.deps.cwd, target);
	const value: unknown = await Bun.file(file)
		.json()
		.catch((error) => {
			throw usageError(
				`${target} is not JSON: ${messageOf(error)}`,
				"Fix the file, or compose it again from its composition",
			);
		});
	const parsed = parseIr(value);
	if (!parsed.ok) throw new Diagnosed(parsed.diagnostics);
	const { values } = parse(
		reading.options,
		args,
		"An IR file is already built and takes no param flags: drop them",
	);
	return {
		ir: parsed.ir,
		loader: moduleLoader(dirname(file)),
		moduleDir: dirname(file),
		config: session.config.composed,
		claims: claimsOf(await installed(session)),
		values,
	};
}

/**
 * Builds `composition` of `bundle` from the config `layers`, the example set when `reading` says so, and the flags in
 * `args` over the params `reading` recorded. The example set fills only the params no config file or flag gives, an
 * optional one only when none of the root's optional params is given.
 * @throws CliError, a usage error, for a composition in `args` when `reading` is an encore's.
 */
async function build(
	session: Session,
	reading: Reading,
	bundle: Bundle,
	composition: Described,
	args: readonly string[],
	layers: readonly Layer[],
	bare = false,
): Promise<Omit<Prepared, "claims">> {
	const label = `${bundle.pack.id}.${composition.name}`;
	const flags = paramFlags(composition, RESERVED, label);
	const { values, positionals } = parse(
		{ ...reading.options, ...flags.options },
		args,
		`Flags are ${reading.verb}'s and the params of '${label}', in kebab-case`,
	);
	if (reading.recorded && positionals.length)
		throw usageError(
			"--encore takes no composition: it performs its concert's own",
			"Drop the composition, or perform it without --encore",
		);
	const given = {
		...reading.recorded,
		...flagValues(composition, flags, values, session.deps.cwd),
	};
	const params = paramValues({
		layers,
		pack: bundle.pack.id,
		compositions: bundle.compositions,
		root: composition.name,
		example: reading.examples ? composition.examples[0] : undefined,
		flags: given,
		hosts: session.deps.hosts,
		base: (source) => baseOf(session.config, session.deps.cwd, source),
		bare,
	});
	const built = bundle.build(composition.name, params.root, params.configured);
	if (!built.ok) throw new Diagnosed(built.diagnostics);
	return {
		ir: built.ir,
		loader: bundle,
		moduleDir: bundle.dir,
		config: params.composed,
		values,
		params: given,
		staged: params.staged,
	};
}

/**
 * The bundle of the bare composition file `target`.
 * @throws CliError, a usage error, when its stem is not a pack id or is an installed pack's.
 */
function fileBundle(
	session: Session,
	packs: readonly Bundle[],
	target: string,
): Promise<Bundle> {
	const file = resolve(session.deps.cwd, target);
	const id = basename(file, extname(file));
	if (!PACK_ID.test(id))
		throw usageError(
			`composition file ${target} is named '${id}', which is not a pack id`,
			"Rename it in lower case, starting with a letter, then letters, digits, '_' or '-'",
		);
	const taken = packs.find((p) => p.pack.id === id);
	if (taken)
		throw usageError(
			`composition file ${target} is named '${id}', the id of the pack at ${taken.dir}`,
			"Rename the file",
		);
	return openFile(file);
}

/** A composition a target names, its bundle, and the installed packs. */
type Located = {
	packs: Bundle[];
	bundle: Bundle;
	composition: Described;
	/** The path of the bare composition file, when the target is one. */
	file?: string;
};

/**
 * The composition `target` names: a `.ts` or `.js` composition file, or `<pack>.<composition>` of an installed pack.
 * @throws CliError, a usage error, for a target that names none.
 */
export async function located(
	session: Session,
	target: string,
): Promise<Located> {
	if (FILE.test(target)) {
		await requireFile(session, target);
		const packs = await installed(session);
		const bundle = await fileBundle(session, packs, target);
		const file = resolve(session.deps.cwd, target);
		return {
			packs,
			bundle,
			composition: chosen(bundle, target, undefined),
			file,
		};
	}
	const [id, name] = split(target);
	const packs = await installed(session);
	const bundle = installedPack(packs, id, session.config.packsDir);
	return { packs, bundle, composition: chosen(bundle, `pack '${id}'`, name) };
}

/**
 * The `Params` block of the composition `args` names first, a composition file or `<pack>.<composition>`; undefined
 * when they name none, or an IR file.
 * @throws as `located` does.
 */
export async function compositionHelp(
	args: readonly string[],
	deps: Deps,
): Promise<string | undefined> {
	const [target] = args;
	if (target === undefined || target.startsWith("-") || IR_FILE.test(target))
		return undefined;
	const session = await openSession(deps, overridesOf(peek(COMMON, args)));
	const { composition } = await located(session, target);
	return paramsBlock(composition, colorOf(deps, peek(COMMON, args)).out);
}

/**
 * The first of `args` is the target: a `.json` IR file, a `.ts` or `.js` composition file, or `<pack>.<composition>`
 * of an installed pack. The IR is read or built from it, with the rest of `args` as flags.
 * @throws CliError, a usage error, for a target or flag that cannot be used.
 * @throws Diagnosed for IR that does not parse, or a build that fails.
 * @throws ConfigError for config or params that are off their schemas.
 */
export async function prepare(
	session: Session,
	reading: Reading,
	args: readonly string[],
): Promise<Prepared> {
	const [target, ...rest] = args;
	if (target === undefined || target.startsWith("-"))
		throw usageError(
			`${reading.verb} takes a composition first`,
			`Name a file, or <pack>.<composition>, before its flags`,
		);
	if (IR_FILE.test(target)) {
		await requireFile(session, target);
		return loadIr(session, reading, target, rest);
	}
	const { packs, bundle, composition, file } = await located(session, target);
	const layers = file === undefined ? session.config.layers : [];
	const built = await build(
		session,
		reading,
		bundle,
		composition,
		rest,
		layers,
		file !== undefined,
	);
	const claims = claimsOf(packs);
	// A bare file's stem claims no config, so it composes under the config as loaded.
	return file === undefined
		? { ...built, claims }
		: { ...built, config: session.config.composed, claims, file };
}

/** The path of each artifact reference without a producer in `value`, at any depth. */
function outsidePaths(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(outsidePaths);
	if (!isPlainObject(value)) return [];
	const { path, contentHash, producer } = value;
	if (typeof path === "string" && typeof contentHash === "string")
		return producer === undefined ? [path] : [];
	return Object.values(value).flatMap(outsidePaths);
}

/**
 * @throws CliError, a usage error, when `ir`, read from the IR file `target`, feeds a node a file a param staged when
 * it was composed, which only performing its composition stages again.
 */
export function requireNoParamFiles(ir: Ir, target: string): void {
	for (const node of ir.nodes)
		for (const [port, value] of Object.entries(node.literals ?? {})) {
			const [path] = outsidePaths(value);
			if (path !== undefined)
				throw usageError(
					`${target} feeds input '${port}' of node '${node.id}' the file param '${basename(path)}', which an IR file cannot stage`,
					"Perform the composition file instead, passing the file to its param",
				);
		}
}

/**
 * Pre-flight of `prepared` under the session's config and hosts.
 * @throws Diagnosed when composing fails.
 */
export async function preflight(
	session: Session,
	{ ir, loader, config, claims }: Prepared,
): Promise<Plan> {
	const result = await compose({
		ir,
		config,
		roots: session.config.roots,
		core: { ...CORE_CONFIG, ...CLI_CONFIG },
		packs: claims,
		hosts: session.deps.hosts,
		loadCode: loader.loadCode,
		caps: session.config.core.caps,
	});
	if (!result.ok) throw new Diagnosed(result.diagnostics);
	return result.plan;
}

/**
 * `prepared` with its code under `dir`, so it loads as an IR file from there: a bare file's bundle is written as
 * `name`, and a pack's or an IR file's modules are made relative to `dir`.
 */
export async function persist(
	prepared: Prepared,
	dir: string,
	name: string,
): Promise<Prepared> {
	const { file, ir, moduleDir, ...rest } = prepared;
	const where = resolve(dir);
	if (file === undefined)
		return {
			...rest,
			ir: rewriteModules(ir, moduleDir, where),
			loader: moduleLoader(where),
			moduleDir: where,
		};
	const text = await bundled(file);
	const codeHash = codeHashOf(text);
	await mkdir(where, { recursive: true });
	await Bun.write(join(where, name), text);
	return {
		...rest,
		ir: mapWorkers(ir, (ref) =>
			ref.module === STDLIB_MODULE ? ref : { ...ref, module: name, codeHash },
		),
		loader: moduleLoader(where),
		moduleDir: where,
	};
}

/** The name of the bundle written for a bare file beside the IR at `out`: `<out stem>.bundle.js`. */
export const bundleName = (out: string) =>
	`${basename(out, extname(out))}${BUNDLE_SUFFIX}`;

/** The code hashes of `ir`'s worker references, stdlib's left out, in graph order. */
function codeHashes(ir: Ir): string {
	const hashes: string[] = [];
	mapWorkers(ir, (ref) => {
		if (ref.module !== STDLIB_MODULE) hashes.push(ref.codeHash);
		return ref;
	});
	return hashes.join();
}

/**
 * The preparation of `concert`, a resumed one: its stored IR with the code hashes as the code stands now, loaded from
 * the directory its row holds, or re-bundled from the composition file there when it was built from one, and the
 * session's config. Warns on stderr, unless `--json` in `values`, when any of those hashes differs from the recorded one.
 * @throws CliError when that directory or file is gone.
 */
export async function resumable(
	session: Session,
	concert: ConcertRecord,
	values: Values,
): Promise<Prepared> {
	const { id, moduleDir, file } = concert;
	const path = file === undefined ? moduleDir : join(moduleDir, file);
	if (
		!(await stat(path).then(
			() => true,
			() => false,
		))
	)
		throw new CliError(
			`the code of concert ${id} was in ${path}, which is gone\nRestore it, or perform its composition as a new concert`,
		);
	const packs = await installed(session);
	const bundle = file === undefined ? undefined : await openFile(path);
	const loader = bundle ?? moduleLoader(moduleDir);
	const ir = await withCurrentHashes(concert.ir, loader.codeHash);
	if (codeHashes(ir) !== codeHashes(concert.ir))
		warn(
			session.deps,
			values,
			`composition changed since concert ${id}; resuming its recorded graph`,
		);
	return {
		ir,
		loader,
		moduleDir,
		config: session.config.composed,
		claims: claimsOf(packs),
		values,
	};
}
