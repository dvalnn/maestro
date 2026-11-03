import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ConfigError } from "@maestro/core/config";
import type {
	ConcertRecord,
	InstanceRecord,
	Records,
} from "@maestro/core/perform";
import {
	BASE_FILE,
	CHANGESET_PORT,
	MESSAGE_FILE,
	patchFiles,
} from "@maestro/host-repo";
import { type Ir, isPlainObject } from "@maestro/ir";
import { type Changes, shortIds } from "@maestro/render-text/live";
import {
	type Command,
	colorOf,
	type Deps,
	isSet,
	type Options,
	only,
	parse,
	SHARED,
	textOf,
	type Values,
	warn,
} from "./command";
import type { Environment, Overrides } from "./config";
import {
	artifactRefs,
	CliError,
	EXIT,
	instanceName,
	NAME_CONCERT,
	nameOf,
	table,
	usageError,
} from "./output";
import {
	artifactsOf,
	concertOf,
	locating,
	openSession,
	overridesOf,
	recordedOf,
	type Session,
	type Stored,
	withSession,
} from "./session";

const FIX = "Flags are listed in 'maestro changeset --help'";

// Its output is the diff itself, so it takes no --json.
const CHANGESET_OPTIONS = {
	...SHARED,
	repo: {
		type: "string",
		short: "C",
		arg: "repo",
		desc: "The checkout to work in, as -c target.repo=<repo>, a relative path from the current directory",
	},
	node: {
		type: "string",
		arg: "id",
		desc: "show, apply: take this instance's changeset, as 'maestro ls <concert>' prints it, or a unique ending of its id",
	},
	partial: {
		type: "boolean",
		desc: "show, apply: with --node, take the work a failed agent left, not a changeset it made",
	},
	stat: { type: "boolean", desc: "show: print a diffstat, not the diff" },
	summary: {
		type: "boolean",
		desc: "show: print the concert's tour and title, and the files changed",
	},
	commit: {
		type: "boolean",
		desc: "apply: commit the staged change with the changeset's message",
	},
	yes: { type: "boolean", desc: "drop: do not ask before resetting" },
} as const satisfies Options;

type Action = "show" | "apply" | "drop";

/** The flags of this command each action takes; it refuses the others named here. */
const ACTION_FLAGS: Readonly<Record<Action, readonly string[]>> = {
	show: ["node", "partial", "stat", "summary"],
	apply: ["node", "partial", "commit"],
	drop: ["yes"],
};
const OWN_FLAGS = [...new Set(Object.values(ACTION_FLAGS).flat())];

const isAction = (word: string | undefined): word is Action =>
	word !== undefined && Object.hasOwn(ACTION_FLAGS, word);

/**
 * The action `word` names, after checking `values` takes only flags it takes.
 * @throws CliError, a usage error naming an unknown action, a flag the action does not take, or
 * `--stat` with `--summary`.
 */
function actionOf(word: string | undefined, values: Values): Action {
	if (!isAction(word))
		throw usageError(
			`expected show, apply or drop, got ${word === undefined ? "nothing" : `'${word}'`}`,
			"Run 'maestro changeset --help'",
		);
	const refused = OWN_FLAGS.find(
		(f) => values[f] !== undefined && !ACTION_FLAGS[word].includes(f),
	);
	if (refused !== undefined)
		throw usageError(
			`changeset ${word} takes no --${refused}`,
			`Drop --${refused}`,
		);
	if (isSet(values, "partial") && textOf(values, "node") === undefined)
		throw usageError(
			"--partial needs --node",
			"Pass --node <instance>, a failed agent from 'maestro ls <concert>'",
		);
	if (isSet(values, "stat") && isSet(values, "summary"))
		throw usageError(
			"--stat and --summary do not go together",
			"Drop one of them",
		);
	return word;
}

/** A checkout and the environment git runs in there: the user's own, so their git config applies. */
type Checkout = { repo: string; env: Environment };

type Ran = { code: number; out: Uint8Array; err: string };

function run({ repo, env }: Checkout, args: readonly string[]): Ran {
	const p = Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...env } });
	return {
		code: p.exitCode,
		out: p.stdout,
		err: p.stderr.toString().trim(),
	};
}

/** The stdout of git `args` in `checkout`, as git wrote it. @throws CliError naming the git command and its error when it fails. */
function output(checkout: Checkout, args: readonly string[]): Uint8Array {
	const ran = run(checkout, args);
	if (ran.code !== 0)
		throw new CliError(
			`git ${args[0]} failed in ${checkout.repo}: ${ran.err}\nFix what git reports, then run it again`,
		);
	return ran.out;
}

/** The stdout of git `args` in `checkout`, trimmed. @throws CliError naming the git command and its error when it fails. */
function git(checkout: Checkout, args: readonly string[]): string {
	return new TextDecoder().decode(output(checkout, args)).trimEnd();
}

/** The changeset an instance made, and where it stands. */
type Picked = {
	checkout: Checkout;
	row: ConcertRecord;
	short: string;
	instance: string;
	base: string;
	/** The changeset's commit message, when it has one. */
	message?: string;
	/** Each patch file's path, in order. */
	patches: string[];
};

/** The changeset artifact `instance` of `ir` holds on its changeset port, if any. */
const changesetOf = (ir: Ir, instance: InstanceRecord) =>
	artifactRefs(ir, instance.node, instance.outputs ?? {}).find(
		(r) => r.port === CHANGESET_PORT && r.pointer === "",
	)?.ref;

/** The directory of the partial work `instance` kept when it failed, if it did. */
const partialOf = (instance: InstanceRecord) => {
	const partial = instance.enrichment?.partial;
	return typeof partial === "string" ? partial : undefined;
};

/**
 * The instance of `row` that `node` names, with the directory of what to take from it: its kept partial work when
 * `partial`, else its changeset artifact under `artifacts`.
 * @throws CliError, a usage error for a `node` the concert has no instance of, else when the instance has none.
 */
function named(
	store: Records,
	row: ConcertRecord,
	artifacts: string,
	node: string,
	partial: boolean,
) {
	const names = new Map(
		store.instances(row.id).map((i) => [instanceName(row.ir, i), i]),
	);
	const name = nameOf(node, names.keys(), row.id);
	const instance = names.get(name);
	const kept = instance && partialOf(instance);
	if (partial) {
		if (!instance || !kept)
			throw new CliError(
				`instance '${name}' of concert ${row.id} kept no partial work\nPick a failed agent from 'maestro ls ${row.id}'`,
			);
		return { instance, dir: kept };
	}
	const ref = instance && changesetOf(row.ir, instance);
	if (!instance || !ref)
		throw new CliError(
			`instance '${name}' of concert ${row.id} made no changeset\nName a changeset node from 'maestro ls ${row.id}'`,
		);
	return { instance, dir: join(artifacts, ref.path) };
}

/**
 * The instance whose changeset to take: `node` when given, else the result's instance when it made one, else the last
 * `ok` one that did. With `partial`, `node`'s kept partial work is taken in place of its changeset artifact.
 * @throws CliError, a usage error for a `node` the concert has no instance of, else when the instance made none.
 */
function chosen(
	store: Records,
	row: ConcertRecord,
	artifacts: string,
	node?: string,
	partial = false,
) {
	const instances = store.instances(row.id);
	const made = (i: InstanceRecord) => changesetOf(row.ir, i);
	if (node !== undefined) return named(store, row, artifacts, node, partial);
	const result = store.result(row.id);
	const ok = instances
		.filter((i) => i.status === "ok" && made(i))
		.sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
	const instance =
		ok.find(
			(i) => i.node === result?.node && i.expansion === result?.expansion,
		) ?? ok.at(-1);
	const ref = instance && made(instance);
	if (!instance || !ref)
		throw new CliError(
			`concert ${row.id} made no changeset\nPick a concert that ends in a changeset node, from 'maestro ls'`,
		);
	return { instance, dir: join(artifacts, ref.path) };
}

const repoOf = ({ config }: Session) => {
	const target = config.composed.values.target;
	const repo = isPlainObject(target) ? target.repo : undefined;
	return typeof repo === "string" ? repo : undefined;
};

const NAMES_REPO = "target.repo=";

/**
 * The session for `layered` over `recorded`, a concert's `--preset` and `-c`, or over nothing when `recorded` does not
 * load outside any workspace and `layered` names the checkout.
 * @throws ConfigError, as `recorded` raised it, when the current directory is inside a workspace.
 * @throws CliError when `recorded` does not load outside a workspace and `layered` names no checkout, naming the
 * concert's `workspace`.
 */
async function sessionOf(
	deps: Deps,
	layered: Overrides,
	recorded: Overrides,
	workspace: string,
): Promise<Session> {
	try {
		return await openSession(deps, recorded, layered);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		const own = await openSession(deps, layered);
		if (own.config.workspace) throw error;
		if (layered.config?.some((c) => c.startsWith(NAMES_REPO))) return own;
		throw new CliError(
			`concert ${recorded.recorded}'s preset needs its workspace\nPass -C <repo>${workspace && `, or run from inside workspace '${workspace}'`}`,
		);
	}
}

/**
 * The checkout `target.repo` names in the config files layered with `recorded`, a concert's `--preset` and `-c` when
 * given, then this command's own, `-C` last.
 * @throws CliError, a usage error, when `target.repo` is not set; else as `sessionOf` does.
 */
async function checkoutOf(
	deps: Deps,
	values: Values,
	recorded?: Overrides,
	workspace = "",
): Promise<Checkout> {
	const own = overridesOf(values);
	const repo = textOf(values, "repo");
	const sugar =
		repo === undefined
			? []
			: [`${NAMES_REPO}${JSON.stringify(resolve(deps.cwd, repo))}`];
	const layered = { ...own, config: [...(own.config ?? []), ...sugar] };
	const session = recorded
		? await sessionOf(deps, layered, recorded, workspace)
		: await openSession(deps, layered);
	const found = repoOf(session);
	if (found === undefined)
		throw usageError("config 'target.repo' is not set", "Pass -C <repo>");
	return { repo: found, env: deps.env };
}

/**
 * The base, commit message when there is one, and patch files of the changeset in `dir`, concert `short`'s.
 * @throws CliError when `dir` or its `base` file is gone, or it holds no patch.
 */
async function readChangeset(dir: string, short: string) {
	let base: string;
	let patches: string[];
	let message: string | undefined;
	try {
		base = (await readFile(join(dir, BASE_FILE), "utf8")).trim();
		message = await readFile(join(dir, MESSAGE_FILE), "utf8").catch(
			() => undefined,
		);
		patches = patchFiles(dir).map((f) => join(dir, f));
	} catch {
		throw new CliError(
			`the changeset of ${short} is not at ${dir}\nPerform the concert again, or pick another node with --node`,
		);
	}
	if (patches.length === 0)
		throw new CliError(
			`the changeset of ${short} is empty\nPick another node with --node`,
		);
	return { base, message, patches };
}

async function picked(stored: Stored, prefix: string): Promise<Picked> {
	const { session, store, values } = stored;
	const row = concertOf(store, prefix);
	const { instance, dir } = chosen(
		store,
		row,
		artifactsOf(session, row.id),
		textOf(values, "node"),
		isSet(values, "partial"),
	);
	const short = shortIds(store.ids()).label(row.id, false);
	return {
		...(await readChangeset(dir, short)),
		checkout: await checkoutOf(
			session.deps,
			values,
			recordedOf(store, row),
			row.workspace,
		),
		row,
		short,
		instance: instanceName(row.ir, instance),
	};
}

/**
 * Warns on stderr when the concert is not `ok`.
 * @throws CliError when the checkout lacks the changeset's base.
 */
function checked(
	{ checkout, row, short, instance, base }: Picked,
	{ session, values }: Stored,
) {
	if (run(checkout, ["cat-file", "-e", `${base}^{commit}`]).code !== 0)
		throw new CliError(
			`base ${base} is not in ${checkout.repo}\nFetch it first`,
		);
	if (row.status !== "ok")
		warn(
			session.deps,
			values,
			`concert ${short} is ${row.status}; this is ${instance}'s changeset, not a delivered result`,
		);
}

const colorFlag = (deps: Deps, values: Values) =>
	colorOf(deps, values).out ? "--color=always" : "--color=never";

const print = (deps: Deps, bytes: Uint8Array) => {
	if (bytes.length > 0) deps.stdoutBytes(bytes);
};

/** The tree of the changeset's patches applied to its base, built in a private index so the checkout stays as it is. */
async function treeOf({ checkout, base, patches }: Picked): Promise<string> {
	const scratch = await mkdtemp(join(tmpdir(), "maestro-changeset-"));
	const indexed = {
		...checkout,
		env: { ...checkout.env, GIT_INDEX_FILE: join(scratch, "index") },
	};
	try {
		git(indexed, ["read-tree", base]);
		for (const patch of patches) git(indexed, ["apply", "--cached", patch]);
		return git(indexed, ["write-tree"]);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

const diffOf = (p: Picked, tree: string, flags: readonly string[]) =>
	output(p.checkout, ["diff", ...flags, p.base, tree]);

/**
 * What the changeset `cs show` would show for concert `id` touches, as its diff counts it; `undefined` off a terminal
 * stdout, or when the concert has no changeset or its diff cannot be read.
 */
export async function changesOf(
	{ session, store, values }: Pick<Stored, "session" | "store" | "values">,
	id: string,
): Promise<Changes | undefined> {
	if (!session.deps.terminal) return undefined;
	try {
		const p = await picked({ session, store, values, json: false }, id);
		const rows = new TextDecoder()
			.decode(diffOf(p, await treeOf(p), ["--numstat"]))
			.split("\n")
			.filter(Boolean)
			.map((row) => row.split("\t"));
		const count = (n: string | undefined) => Number(n) || 0;
		return {
			files: rows.length,
			added: rows.reduce((sum, [added]) => sum + count(added), 0),
			removed: rows.reduce((sum, [, removed]) => sum + count(removed), 0),
		};
	} catch (error) {
		if (error instanceof CliError || error instanceof ConfigError)
			return undefined;
		throw error;
	}
}

async function shown(stored: Stored, prefix: string) {
	const { session, values } = stored;
	const { deps } = session;
	const p = await picked(stored, prefix);
	checked(p, stored);
	const tree = await treeOf(p);
	const subject = git(p.checkout, ["log", "-1", "--format=%h %s", p.base]);
	deps.stderr(
		`${p.short} (node ${p.instance}, concert ${p.row.status}) on base ${subject}`,
	);
	if (p.message !== undefined) deps.stdout(p.message.trimEnd());
	const color = colorFlag(deps, values);
	if (isSet(values, "summary")) {
		deps.stdout(
			table([
				["tour", p.row.tour || "-"],
				["title", p.row.title || "-"],
			]),
		);
		print(deps, diffOf(p, tree, [color, "--name-status"]));
	} else {
		const stat = isSet(values, "stat") ? ["--stat"] : [];
		print(deps, diffOf(p, tree, [color, ...stat]));
	}
	return EXIT.ok;
}

const dirty = (checkout: Checkout) =>
	git(checkout, ["status", "--porcelain", "--untracked-files=no"]) !== "";

/** @throws CliError, exit 3 when `patch` leaves conflicts in the checkout, else exit 1 with git's error. */
function refused(p: Picked, patch: string, ran: Ran, deps: Deps): never {
	const name = basename(patch);
	const conflicts = git(p.checkout, ["diff", "--name-only", "--diff-filter=U"]);
	if (conflicts === "")
		throw new CliError(
			`${name} of ${p.short} does not apply in ${p.checkout.repo}: ${ran.err}\nUndo what applied with 'maestro cs drop'`,
		);
	deps.stderr(ran.err);
	throw new CliError(
		`${name} of ${p.short} conflicts in ${p.checkout.repo}\nResolve the conflicts and commit, or 'maestro cs drop'`,
		EXIT.rejected,
	);
}

async function applied(stored: Stored, prefix: string) {
	const { session, values } = stored;
	const { deps } = session;
	const p = await picked(stored, prefix);
	checked(p, stored);
	const commit = isSet(values, "commit");
	if (commit && !p.message?.trim())
		throw new CliError(
			`${p.short} has no commit message, so --commit has nothing to commit with\nDrop --commit, or give the changeset a message in the composition`,
		);
	if (dirty(p.checkout))
		throw new CliError(
			`${p.checkout.repo} has uncommitted changes\nCommit or stash them first`,
		);
	for (const patch of p.patches) {
		const ran = run(p.checkout, ["apply", "--index", "--3way", patch]);
		if (ran.code !== 0) refused(p, patch, ran, deps);
	}
	const color = colorFlag(deps, values);
	print(deps, output(p.checkout, ["diff", color, "--cached", "--stat"]));
	if (commit) {
		git(p.checkout, ["commit", "-q", "-m", p.message ?? ""]);
		const made = git(p.checkout, ["rev-parse", "--short", "HEAD"]);
		deps.stderr(
			`applied ${p.short} (node ${p.instance}, concert ${p.row.status}) and committed it as ${made}`,
		);
		return EXIT.ok;
	}
	const head = git(p.checkout, ["rev-parse", "--short", "HEAD"]);
	deps.stderr(
		`applied ${p.short} (node ${p.instance}, concert ${p.row.status}) on ${head}, staged. Next: commit it, or 'maestro cs drop'`,
	);
	return EXIT.ok;
}

async function confirmed(deps: Deps, yes: boolean, repo: string) {
	if (yes) return true;
	if (!deps.confirm)
		throw usageError(
			"drop asks before it resets, and there is no terminal to ask on",
			"Pass --yes",
		);
	return deps.confirm(`Drop the uncommitted changes in ${repo}?`);
}

async function dropped(deps: Deps, values: Values) {
	const checkout = await checkoutOf(deps, values);
	if (!dirty(checkout)) {
		deps.stderr(`nothing to drop: ${checkout.repo} has no uncommitted changes`);
		return EXIT.ok;
	}
	deps.stderr(git(checkout, ["diff", "HEAD", "--stat"]));
	if (!(await confirmed(deps, isSet(values, "yes"), checkout.repo))) {
		deps.stderr("nothing dropped");
		return EXIT.ok;
	}
	git(checkout, ["reset", "-q", "--hard"]);
	deps.stderr(`dropped the uncommitted changes in ${checkout.repo}`);
	return EXIT.ok;
}

async function changesetRun(args: readonly string[], deps: Deps) {
	const { values, positionals } = parse(CHANGESET_OPTIONS, args, FIX);
	const [word, ...rest] = positionals;
	const action = actionOf(word, values);
	if (action === "drop") {
		if (rest.length > 0)
			throw usageError(
				`changeset drop takes no concert, got ${rest.length}`,
				"Drop the concert, and pass -C <repo> for another checkout",
			);
		return dropped(deps, values);
	}
	const prefix = only(rest, "concert", NAME_CONCERT, action);
	const own = overridesOf(values);
	return withSession(deps, await locating(deps, own), (session, store) => {
		const stored = { session, store, values, json: false };
		return action === "show" ? shown(stored, prefix) : applied(stored, prefix);
	});
}

export const changeset: Command = {
	usage:
		"changeset show|apply <concert> [flags]  (alias: cs)\n       maestro changeset drop [flags]",
	arguments: [["<concert>", "A concert, as 'maestro ls' lists it"]],
	options: CHANGESET_OPTIONS,
	examples: [
		["What did the concert change?", "maestro changeset show 7f3c2a --stat"],
		[
			"Stage the concert's changeset in a checkout",
			"maestro changeset apply 7f3c2a -C ../app",
		],
		[
			"Take what a failed agent left, from one node instance",
			"maestro changeset apply 7f3c2a --node build --partial",
		],
		["Reset the checkout's uncommitted changes", "maestro changeset drop"],
	],
	execute: changesetRun,
};
