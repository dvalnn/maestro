import { readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { ConcertRecord } from "@maestro/core/perform";
import { shellArg } from "@maestro/render-text/live";
import {
	COMMON,
	type Command,
	colorOf,
	type Deps,
	isSet,
	type Options,
	type Values,
	warn,
} from "./command";
import {
	artifactRefs,
	CliError,
	EXIT,
	instanceName,
	jsonOf,
	nameOf,
	staleCell,
	table,
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
	...COMMON,
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

function recorded({ session, store }: Stored, row: ConcertRecord) {
	const area = artifactsOf(session, row.id);
	const instances = instancesInOrder(store, row);
	const artifacts: Listed[] = instances.flatMap((i) => {
		const refs = artifactRefs(row.ir, i.node, i.outputs ?? {});
		return i.artifacts.map((ref) => ({
			instance: instanceName(row.ir, i),
			port: refs.find((r) => r.ref.path === ref.path)?.port ?? NO_PORT,
			path: join(area, ref.path),
			contentHash: ref.contentHash,
			...(i.stale && { stale: true as const }),
		}));
	});
	return { names: instances.map((i) => instanceName(row.ir, i)), artifacts };
}

/** Each file of the artifact at `path`: itself as its basename, or each file under it as `<dir>/<inner path>`. */
async function filesOf(path: string): Promise<File[]> {
	if (!(await onDisk(path, () => stat(path))).isDirectory())
		return [{ name: basename(path), path }];
	const entries = await readdir(path, { recursive: true, withFileTypes: true });
	return entries
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
 * @throws CliError, a usage error, unless `ls` has one concert, or `show` a concert, an instance and at most a file.
 */
function arity(action: "ls" | "show", args: readonly string[]) {
	if (action === "ls" && args.length !== 1)
		throw usageError(
			`artifact ls takes one concert, got ${args.length} arguments`,
			"Write maestro artifact ls <concert>",
		);
	if (action === "show" && (args.length < 2 || args.length > 3))
		throw usageError(
			`artifact show takes a concert, an instance and at most a file, got ${args.length} arguments`,
			"Write maestro artifact show <concert> <instance> [<file>]",
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

function listed({ session, values, json }: Stored, artifacts: Listed[]) {
	const { deps } = session;
	if (json) deps.stdout(jsonOf(artifacts));
	else if (isSet(values, "path"))
		for (const a of artifacts) deps.stdout(a.path);
	else
		deps.stdout(
			table(
				[
					["instance", "port", "stale", "path"],
					...artifacts.map((a) => [a.instance, a.port, staleCell(a), a.path]),
				],
				colorOf(deps, values).out,
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

/** Prints each file's bytes as they are, after a `══ <file>` line of its own when there are several. */
async function printed(deps: Deps, files: readonly File[]) {
	let open = false;
	for (const f of files) {
		if (files.length > 1) {
			if (open) deps.stdout("");
			deps.stdout(`${FILE_RULE} ${f.name}`);
		}
		const bytes = await onDisk(f.path, () => Bun.file(f.path).bytes());
		deps.stdoutBytes(bytes);
		open = bytes.length > 0 && bytes.at(-1) !== NEWLINE;
	}
	return EXIT.ok;
}

async function artifacted(stored: Stored, { prefix, instance, file }: Named) {
	const { values, store, session } = stored;
	const row = concertOf(store, prefix);
	const { names, artifacts } = recorded(stored, row);
	if (instance === undefined) return listed(stored, artifacts);
	const name = nameOf(instance, names, row.id);
	const files = await picked(row, name, artifacts, file);
	if (artifacts.some((a) => a.instance === name && a.stale))
		warn(
			session.deps,
			values,
			`instance '${name}' is stale, from an earlier attempt`,
		);
	if (!isSet(values, "path")) return printed(session.deps, files);
	for (const f of files) session.deps.stdout(f.path);
	return EXIT.ok;
}

export const artifact: Command = {
	usage:
		"artifact ls <concert> [flags]  (alias: art)\n       maestro artifact show <concert> <instance> [<file>] [flags]",
	options: ARTIFACT_OPTIONS,
	execute: (args, deps) =>
		withStore(ARTIFACT_OPTIONS, args, deps, FIX, checked, artifacted),
};
