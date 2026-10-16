import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { messageOf } from "@maestro/core";
import { type ComposeInput, compose, type Plan } from "@maestro/core/compose";
import { CORE_CONFIG, type Composed, type Layer } from "@maestro/core/config";
import type { ConcertRecord } from "@maestro/core/perform";
import { type Ir, irSchema, mapWorkers, parseIr } from "@maestro/ir";
import { type Described, STDLIB_MODULE } from "@maestro/sdk";
import { COMMON, type Options, parse, type Values } from "./command";
import { CLI_CONFIG } from "./config";
import { flagValues, paramFlags } from "./flags";
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
import type { Session } from "./session";

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
} as const satisfies Options;

/** Flags a param may not take, whichever command reads the composition, so it is valid for all of them or none. */
const RESERVED: Options = { ...COMMON, ...COMPOSE_FLAGS, ...PERFORM_FLAGS };

/** How a command reads its target: its name, its flags, and whether a composition's example set stands in for flags. */
export type Reading = { verb: string; options: Options; examples: boolean };

const FILE = /\.(?:ts|js)$/;
const PACK_ID = new RegExp(irSchema.$defs.name.pattern);
const IR_FILE = /\.json$/;
const BUNDLE_SUFFIX = ".bundle.js";

const installed = (session: Session): Promise<Bundle[]> =>
	Promise.all(session.config.packs.map((dir) => openPack(dir)));

const namesOf = (compositions: readonly Described[]) =>
	compositions.map((c) => c.name).join(", ");

function chosen(
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
		throw usageError(
			`${what} has no composition '${name}'`,
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
 * `args`. Its config is `layers` with the example set and the flags on top.
 */
async function build(
	session: Session,
	reading: Reading,
	bundle: Bundle,
	composition: Described,
	args: readonly string[],
	layers: readonly Layer[],
): Promise<Omit<Prepared, "claims">> {
	const label = `${bundle.pack.id}.${composition.name}`;
	const flags = paramFlags(composition, RESERVED, label);
	const { values } = parse(
		{ ...reading.options, ...flags.options },
		args,
		`Flags are ${reading.verb}'s and the params of '${label}', in kebab-case`,
	);
	const params = paramValues({
		layers,
		pack: bundle.pack.id,
		compositions: bundle.compositions,
		root: composition.name,
		example: reading.examples ? composition.examples[0] : undefined,
		flags: flagValues(composition, flags, values),
		hosts: session.deps.hosts,
	});
	const built = bundle.build(composition.name, params.root, params.configured);
	if (!built.ok) throw new Diagnosed(built.diagnostics);
	return {
		ir: built.ir,
		loader: bundle,
		moduleDir: bundle.dir,
		config: params.composed,
		values,
	};
}

/**
 * Builds the composition of the bare file `target` from its example set and flags only: its stem claims no config.
 * @throws CliError, a usage error, when its stem is not a pack id or is an installed pack's.
 */
async function buildFile(
	session: Session,
	reading: Reading,
	packs: readonly Bundle[],
	target: string,
	args: readonly string[],
): Promise<Prepared> {
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
	const bundle = await openFile(file);
	const composition = chosen(bundle, target, undefined);
	const built = await build(session, reading, bundle, composition, args, []);
	return {
		...built,
		config: session.config.composed,
		claims: claimsOf(packs),
		file,
	};
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
	const isIr = IR_FILE.test(target);
	if (isIr || FILE.test(target)) await requireFile(session, target);
	if (isIr) return loadIr(session, reading, target, rest);
	const packs = await installed(session);
	if (FILE.test(target))
		return buildFile(session, reading, packs, target, rest);
	const [pack, name] = split(target);
	const bundle = packs.find((b) => b.pack.id === pack);
	if (!bundle)
		throw usageError(
			`no pack '${pack}' is installed`,
			`Add its directory to packs in the config${packs.length ? `, or use one of: ${packs.map((b) => b.pack.id).join(", ")}` : ""}`,
		);
	const composition = chosen(bundle, `pack '${pack}'`, name);
	const layers = session.config.layers;
	return {
		...(await build(session, reading, bundle, composition, rest, layers)),
		claims: claimsOf(packs),
	};
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

/**
 * The preparation of `concert`, a resumed one: its stored IR with the code hashes as the code stands now, loaded from
 * the directory its row holds, or re-bundled from the composition file there when it was built from one, and the
 * config as it stands.
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
	return {
		ir: await withCurrentHashes(concert.ir, loader.codeHash),
		loader,
		moduleDir,
		config: session.config.composed,
		claims: claimsOf(packs),
		values,
	};
}
