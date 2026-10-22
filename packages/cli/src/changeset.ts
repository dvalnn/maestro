import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
	ConcertRecord,
	InstanceRecord,
	Records,
} from "@maestro/core/perform";
import { BASE_FILE, CHANGESET_PORT, patchFiles } from "@maestro/host-repo";
import { isPlainObject } from "@maestro/ir";
import { shortIds } from "@maestro/render-text/live";
import {
	COMMON,
	type Command,
	colorOf,
	type Deps,
	isSet,
	type Options,
	only,
	parse,
	textOf,
	type Values,
} from "./command";
import type { Environment, Overrides } from "./config";
import {
	CliError,
	EXIT,
	instanceName,
	isArtifactRef,
	table,
	usageError,
} from "./output";
import {
	artifactsOf,
	concertOf,
	openSession,
	overridesOf,
	type Stored,
	withStore,
} from "./session";

const FIX = "Flags are listed in 'maestro changeset --help'";

const CHANGESET_OPTIONS = {
	...COMMON,
	repo: {
		type: "string",
		short: "C",
		arg: "repo",
		desc: "The checkout to work in, as -c target.repo=<repo>, a relative path from the current directory",
	},
	node: {
		type: "string",
		arg: "id",
		desc: "show, apply: take this instance's changeset, as 'maestro ls <concert>' prints it",
	},
	stat: { type: "boolean", desc: "show: print a diffstat, not the diff" },
	summary: {
		type: "boolean",
		desc: "show: print the concert's tour and title, and the files changed",
	},
	yes: { type: "boolean", desc: "drop: do not ask before resetting" },
} as const satisfies Options;

type Action = "show" | "apply" | "drop";

/** The flags of this command each action takes; it refuses the others named here. */
const ACTION_FLAGS: Readonly<Record<Action, readonly string[]>> = {
	show: ["node", "stat", "summary"],
	apply: ["node"],
	drop: ["yes"],
};
const OWN_FLAGS = [...new Set(Object.values(ACTION_FLAGS).flat())];

const isAction = (word: string | undefined): word is Action =>
	word !== undefined && Object.hasOwn(ACTION_FLAGS, word);

/**
 * The action `word` names, after checking `values` takes only flags it takes.
 * @throws CliError, a usage error naming an unknown action, `--json`, a flag the action does not take, or
 * `--stat` with `--summary`.
 */
function actionOf(word: string | undefined, values: Values): Action {
	if (!isAction(word))
		throw usageError(
			`expected show, apply or drop, got ${word === undefined ? "nothing" : `'${word}'`}`,
			"Run 'maestro changeset --help'",
		);
	const refused = [
		...(isSet(values, "json") ? ["json"] : []),
		...OWN_FLAGS.filter(
			(f) => values[f] !== undefined && !ACTION_FLAGS[word].includes(f),
		),
	];
	if (refused[0] !== undefined)
		throw usageError(
			`changeset ${word} takes no --${refused[0]}`,
			`Drop --${refused[0]}`,
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

type Ran = { code: number; out: string; err: string };

function run({ repo, env }: Checkout, args: readonly string[]): Ran {
	const p = Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...env } });
	return {
		code: p.exitCode,
		out: p.stdout.toString().trimEnd(),
		err: p.stderr.toString().trim(),
	};
}

/** The stdout of git `args` in `checkout`. @throws CliError naming the git command and its error when it fails. */
function git(checkout: Checkout, args: readonly string[]): string {
	const ran = run(checkout, args);
	if (ran.code !== 0)
		throw new CliError(`git ${args[0]} failed in ${checkout.repo}: ${ran.err}`);
	return ran.out;
}

/** The changeset an instance made, and where it stands. */
type Picked = {
	checkout: Checkout;
	row: ConcertRecord;
	short: string;
	instance: string;
	base: string;
	/** Each patch file's path, in order. */
	patches: string[];
};

const changesetOf = (instance: InstanceRecord) => {
	const value = instance.outputs?.[CHANGESET_PORT];
	return isArtifactRef(value) ? value : undefined;
};

/**
 * The instance whose changeset to take: `node` when given, else the result's instance when it made one, else the last
 * `ok` one that did.
 * @throws CliError, a usage error for a `node` the concert has no instance of, else when the instance made none.
 */
function chosen(store: Records, row: ConcertRecord, node?: string) {
	const instances = store.instances(row.id);
	if (node !== undefined) {
		const named = instances.find((i) => instanceName(row.ir, i) === node);
		if (!named)
			throw usageError(
				`no instance '${node}' in concert ${row.id}`,
				`List them with 'maestro ls ${row.id}'`,
			);
		const ref = changesetOf(named);
		if (!ref)
			throw new CliError(
				`instance '${node}' of concert ${row.id} made no changeset\nName a changeset node from 'maestro ls ${row.id}'`,
			);
		return { instance: named, ref };
	}
	const result = store.result(row.id);
	const made = instances
		.filter((i) => i.status === "ok" && changesetOf(i))
		.sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
	const instance =
		made.find(
			(i) => i.node === result?.node && i.expansion === result?.expansion,
		) ?? made.at(-1);
	const ref = instance && changesetOf(instance);
	if (!instance || !ref)
		throw new CliError(
			`concert ${row.id} made no changeset\nPick a concert that ends in a changeset node, from 'maestro ls'`,
		);
	return { instance, ref };
}

/**
 * The checkout `target.repo` names in the config files layered with `recorded`, a concert's `--profile` and `-c` when
 * given, then this command's own, `-C` last.
 * @throws CliError, a usage error, when `target.repo` is not set.
 */
async function checkoutOf(
	deps: Deps,
	values: Values,
	...recorded: Overrides[]
): Promise<Checkout> {
	const own = overridesOf(values);
	const repo = textOf(values, "repo");
	const sugar =
		repo === undefined
			? []
			: [`target.repo=${JSON.stringify(resolve(deps.cwd, repo))}`];
	const { config } = await openSession(deps, ...recorded, {
		...own,
		config: [...(own.config ?? []), ...sugar],
	});
	const target = config.composed.values.target;
	const found = isPlainObject(target) ? target.repo : undefined;
	if (typeof found !== "string")
		throw usageError("config 'target.repo' is not set", "Pass -C <repo>");
	return { repo: found, env: deps.env };
}

/**
 * The base and patch files of the changeset in `dir`, concert `short`'s.
 * @throws CliError when `dir` or its `base` file is gone, or it holds no patch.
 */
async function readChangeset(dir: string, short: string) {
	let base: string;
	let patches: string[];
	try {
		base = (await readFile(join(dir, BASE_FILE), "utf8")).trim();
		patches = patchFiles(dir).map((f) => join(dir, f));
	} catch {
		throw new CliError(
			`the changeset of ${short} is not at ${dir}\nPerform the concert again, or pick another node with --node`,
		);
	}
	if (patches.length === 0)
		throw new CliError(`the changeset of ${short} is empty`);
	return { base, patches };
}

async function picked(stored: Stored, prefix: string): Promise<Picked> {
	const { session, store, values } = stored;
	const row = concertOf(store, prefix);
	const { instance, ref } = chosen(store, row, textOf(values, "node"));
	const short = shortIds(store.ids()).label(row.id, false);
	const dir = join(artifactsOf(session, row.id), ref.path);
	const recorded = {
		profile: row.profile,
		config: row.config,
		recorded: short,
	};
	return {
		...(await readChangeset(dir, short)),
		checkout: await checkoutOf(session.deps, values, recorded),
		row,
		short,
		instance: instanceName(row.ir, instance),
	};
}

/**
 * Warns on stderr when the concert is not `ok`.
 * @throws CliError when the checkout lacks the changeset's base.
 */
function checked({ checkout, row, short, instance, base }: Picked, deps: Deps) {
	if (run(checkout, ["cat-file", "-e", `${base}^{commit}`]).code !== 0)
		throw new CliError(
			`base ${base} is not in ${checkout.repo}: fetch it first`,
		);
	if (row.status !== "ok")
		deps.stderr(
			`concert ${short} is ${row.status}: this is node ${instance}'s change, not a delivered result`,
		);
}

const colorFlag = (deps: Deps, values: Values) =>
	colorOf(deps, values).out ? "--color=always" : "--color=never";

const print = (deps: Deps, text: string) => {
	if (text !== "") deps.stdout(text);
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

async function shown(stored: Stored, prefix: string) {
	const { session, values } = stored;
	const { deps } = session;
	const p = await picked(stored, prefix);
	checked(p, deps);
	const tree = await treeOf(p);
	const subject = git(p.checkout, ["log", "-1", "--format=%h %s", p.base]);
	deps.stderr(
		`${p.short} (node ${p.instance}, concert ${p.row.status}) on base ${subject}`,
	);
	const color = colorFlag(deps, values);
	if (isSet(values, "summary")) {
		deps.stdout(
			table([
				["tour", p.row.tour || "-"],
				["title", p.row.title || "-"],
			]),
		);
		print(
			deps,
			git(p.checkout, ["diff", color, "--name-status", p.base, tree]),
		);
	} else {
		const stat = isSet(values, "stat") ? ["--stat"] : [];
		print(deps, git(p.checkout, ["diff", color, ...stat, p.base, tree]));
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
	checked(p, deps);
	if (dirty(p.checkout))
		throw new CliError(
			`${p.checkout.repo} has uncommitted changes: commit them, or maestro cs drop`,
		);
	for (const patch of p.patches) {
		const ran = run(p.checkout, ["apply", "--index", "--3way", patch]);
		if (ran.code !== 0) refused(p, patch, ran, deps);
	}
	const color = colorFlag(deps, values);
	print(deps, git(p.checkout, ["diff", color, "--cached", "--stat"]));
	const head = git(p.checkout, ["rev-parse", "--short", "HEAD"]);
	deps.stderr(
		`applied ${p.short} (node ${p.instance}, concert ${p.row.status}) on ${head}, staged. Next: commit it, or maestro cs drop`,
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

const NAME_CONCERT = "Name the concert, as 'maestro ls' lists it";

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
	const prefix = only(rest, "concert", NAME_CONCERT);
	return withStore(
		CHANGESET_OPTIONS,
		args,
		deps,
		FIX,
		() => prefix,
		(stored, id) =>
			action === "show" ? shown(stored, id) : applied(stored, id),
	);
}

export const changeset: Command = {
	usage:
		"changeset show|apply <concert> [flags]  (alias: cs)\n       maestro changeset drop [flags]",
	options: CHANGESET_OPTIONS,
	execute: changesetRun,
};
