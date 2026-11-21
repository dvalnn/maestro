import { stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { tildeOf, walk } from "@maestro/core";
import type { ConcertRecord, InstanceRecord } from "@maestro/core/perform";
import type { Ir } from "@maestro/ir";
import { shellArg, shortIds } from "@maestro/render-text/live";
import {
	type Command,
	colorOf,
	columnsOf,
	type Deps,
	isSet,
	type Options,
	RECORDED,
	type Values,
	warn,
} from "./command";
import {
	ArgumentError,
	absent,
	artifactRefs,
	CliError,
	diffColored,
	EXIT,
	fittedTable,
	giving,
	jsonAgain,
	jsonOf,
	NAME_CONCERT,
	paint,
	resolveInstanceName,
	staleCell,
	usageError,
} from "./output";
import {
	artifactsOf,
	concertOf,
	instancesInOrder,
	type Stored,
	withStore,
} from "./session";

const FIX = "Flags are listed in 'maestro artifact --help'";
const FILE_RULE = "══";
/** The port of an artifact no output of its instance holds, such as one of a failed instance. */
const NO_PORT = "-";
const NEWLINE = 0x0a;

const ARTIFACT_OPTIONS = {
	...RECORDED,
	path: {
		type: "boolean",
		desc: "Print absolute paths, one per line, not content",
	},
} as const satisfies Options;

type Listed = {
	instance: string;
	port: string;
	path: string;
	contentHash: string;
	stale?: true;
};

type Named = ReturnType<typeof checked>;

type File = { name: string; path: string };

async function onDisk<T>(path: string, read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		throw new CliError(
			`the artifact is not at ${path}\nPerform the concert again, or pick another instance`,
		);
	}
}

/** Each artifact `instance` of a concert of `ir` recorded, with the output port that holds it, `-` for none. */
export function portedArtifacts(ir: Ir, instance: InstanceRecord) {
	const refs = artifactRefs(ir, instance.node, instance.outputs ?? {});
	return instance.artifacts.map((ref) => ({
		port: refs.find((r) => r.ref.path === ref.path)?.port ?? NO_PORT,
		ref,
	}));
}

function recorded({ session, store }: Stored, row: ConcertRecord) {
	const area = artifactsOf(session, row.id);
	const instances = instancesInOrder(store, row);
	const artifacts: Listed[] = instances.flatMap((i) =>
		portedArtifacts(row.ir, i).map(({ port, ref }) => ({
			instance: i.name,
			port,
			path: join(area, ref.path),
			contentHash: ref.contentHash,
			...(i.stale && { stale: true as const }),
		})),
	);
	return { names: instances.map((i) => i.name), artifacts };
}

/** Each file of the artifact at `path`: itself as its basename, or each file under it as `<dir>/<inner path>`. */
async function filesOf(path: string): Promise<File[]> {
	if (!(await onDisk(path, () => stat(path))).isDirectory())
		return [{ name: basename(path), path }];
	return (await walk(path))
		.filter((e) => e.isFile())
		.map((e) => join(e.parentPath, e.name))
		.sort()
		.map((inner) => ({
			name: join(basename(path), relative(path, inner)),
			path: inner,
		}));
}

/**
 * Checks that `args`, the arguments after the sub-verb `action`, number what it takes.
 * @throws ArgumentError unless `ls` has one concert, or `show` a concert, an instance and at most a file.
 */
function arity(action: "ls" | "show", args: readonly string[]) {
	if (args.length === 0)
		throw new ArgumentError(`${action} needs a concert`, NAME_CONCERT);
	if (action === "ls" && args.length > 1)
		throw new ArgumentError(
			`ls takes one concert, got ${args.length}`,
			NAME_CONCERT,
		);
	if (action === "show" && args.length === 1)
		throw new ArgumentError(
			"show needs an instance",
			"Name one as 'maestro artifact ls <concert>' lists it",
		);
	if (action === "show" && args.length > 3)
		throw new ArgumentError(
			`show takes a concert, an instance and at most a file, got ${args.length}`,
			"Name a file by its name, or leave it out to print every file",
		);
}

/**
 * The concert, and the instance and file within it, `positionals` name after `ls` or `show`.
 * @throws CliError, a usage error, for another sub-verb or a count of arguments it does not take, or `--json` with
 * `--path` or with `show`.
 */
function checked(values: Values, positionals: readonly string[]) {
	const [action, ...args] = positionals;
	if (action !== "ls" && action !== "show")
		throw usageError(
			`expected ls or show, got ${action === undefined ? "nothing" : `'${action}'`}`,
			"Run 'maestro artifact ls <concert>', or 'maestro artifact show <concert> <instance>'",
		);
	arity(action, args);
	if (isSet(values, "json") && isSet(values, "path"))
		throw usageError(
			"--path and --json do not go together",
			"Drop one of them",
		);
	if (isSet(values, "json") && action === "show")
		throw usageError(
			"--json lists a concert's artifacts, so only artifact ls takes it",
			"Drop --json to print the instance's files",
		);
	const [prefix = "", instance, file] = args;
	return { prefix, instance, file };
}

/** The narrowest an artifact's path is cut to on a terminal. */
const PATH_FLOOR = 12;

/**
 * The human listing of `artifacts`: the artifact area `area` once, whole, then a table whose path column is relative
 * to it. On a terminal the area starts `~` for home, and a path wider than the terminal leaves is cut, with a hint to
 * the full paths of `id`.
 */
function listingOf(
	deps: Deps,
	values: Values,
	id: string,
	area: string,
	artifacts: readonly Listed[],
): string {
	const color = colorOf(deps, values).out;
	const where =
		deps.terminal === undefined ? area : tildeOf(area, deps.env.HOME);
	const rows = [
		["instance", "port", "stale", "path"],
		...artifacts.map((a) => [
			a.instance,
			a.port === NO_PORT ? absent(color) : a.port,
			staleCell(a),
			relative(area, a.path),
		]),
	];
	return [
		`${paint("dim", "artifacts", color)}  ${where}`,
		fittedTable(
			rows,
			color,
			giving(columnsOf(deps), [{ column: 3, floor: PATH_FLOOR }]),
			`Full paths: ${jsonAgain("artifact", ["ls", id])}`,
		),
	].join("\n");
}

function listed(
	{ session, store, values, json }: Stored,
	row: ConcertRecord,
	artifacts: Listed[],
) {
	const { deps } = session;
	if (json) deps.stdout(jsonOf(artifacts));
	else if (artifacts.length === 0) {
		const id = shortIds(store.ids()).label(row.id, false);
		deps.stderr(`no artifacts in concert ${id}`);
		deps.stderr(
			`Its instances wrote no files; 'maestro ls ${id}' shows what ran`,
		);
	} else if (isSet(values, "path"))
		for (const a of artifacts) deps.stdout(a.path);
	else
		deps.stdout(
			listingOf(
				deps,
				values,
				shortIds(store.ids()).label(row.id, false),
				artifactsOf(session, row.id),
				artifacts,
			),
		);
	return EXIT.ok;
}

/**
 * The files of instance `name`, or its one file `file` names.
 * @throws CliError, exit 1 when it has no artifacts, or a usage error when `file` names none.
 */
async function picked(
	row: ConcertRecord,
	name: string,
	artifacts: readonly Listed[],
	file: string | undefined,
): Promise<File[]> {
	const own = artifacts.filter((a) => a.instance === name);
	if (own.length === 0)
		throw new CliError(
			`instance '${name}' of concert ${row.id} has no artifacts yet\nSee where it stands with 'maestro ls ${row.id}'`,
		);
	const files = (await Promise.all(own.map((a) => filesOf(a.path)))).flat();
	if (file === undefined) return files;
	const named = files.find((f) => f.name === file);
	if (!named)
		throw usageError(
			`instance '${name}' of concert ${row.id} has no file '${file}'`,
			`List them with maestro art show ${row.id} ${shellArg(name)} --path`,
		);
	return [named];
}

const DIFF_FILE = /\.(patch|diff)$/;

/** The bytes of `file`: a diff colored over its bytes, whatever the encoding, when `color`, else as they are. */
function shownBytes(file: File, bytes: Uint8Array, color: boolean) {
	return color && DIFF_FILE.test(file.name)
		? Buffer.from(diffColored(Buffer.from(bytes).toString("latin1")), "latin1")
		: bytes;
}

/**
 * Prints each file's bytes as they are, after a `══ <file>` line of its own when there are several. A `.patch` or
 * `.diff` file is colored when `color`.
 */
async function printed(deps: Deps, files: readonly File[], color: boolean) {
	let open = false;
	for (const f of files) {
		if (files.length > 1) {
			if (open) deps.stdout("");
			deps.stdout(`${FILE_RULE} ${f.name}`);
		}
		const bytes = await onDisk(f.path, () => Bun.file(f.path).bytes());
		deps.stdoutBytes(shownBytes(f, bytes, color));
		open = bytes.length > 0 && bytes.at(-1) !== NEWLINE;
	}
	return EXIT.ok;
}

async function artifacted(stored: Stored, { prefix, instance, file }: Named) {
	const { values, store, session } = stored;
	const row = concertOf(store, prefix);
	const { names, artifacts } = recorded(stored, row);
	if (instance === undefined) return listed(stored, row, artifacts);
	const name = resolveInstanceName(instance, names, row.id);
	const files = await picked(row, name, artifacts, file);
	if (artifacts.some((a) => a.instance === name && a.stale))
		warn(
			session.deps,
			values,
			`instance '${name}' is stale, from an earlier attempt`,
		);
	if (!isSet(values, "path"))
		return printed(session.deps, files, colorOf(session.deps, values).out);
	for (const f of files) session.deps.stdout(f.path);
	return EXIT.ok;
}

export const artifact: Command = {
	pages: true,
	usage:
		"artifact ls <concert> [flags]  (alias: art)\n       maestro artifact show <concert> <instance> [<file>] [flags]",
	arguments: [
		["<concert>", "A concert, as 'maestro ls' lists it"],
		[
			"<instance>",
			"One of its node instances, as 'maestro ls <concert>' lists it, or a unique ending of its id",
		],
		[
			"<file>",
			"One file of that instance, by name; without it, every file prints in turn",
		],
	],
	options: ARTIFACT_OPTIONS,
	examples: [
		[
			"What did the concert leave, instance by instance?",
			"maestro artifact ls 7f3c2a",
		],
		[
			"Read the plan the planner wrote",
			"maestro artifact show 7f3c2a planner plan.md",
		],
		[
			"Open an instance's files in your editor",
			"$EDITOR $(maestro artifact show 7f3c2a panel/consolidator --path)",
		],
	],
	execute: (args, deps) =>
		withStore(
			{
				options: ARTIFACT_OPTIONS,
				fix: FIX,
				check: checked,
			},
			args,
			deps,
			artifacted,
		),
};
