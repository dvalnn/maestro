import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { Bind } from "../sandbox/index";

/**
 * A lane version, written `<concert id>.<node instance id>`: the node instance that produced it. The same text is a
 * lane ref (D-27). Concert ids hold no `.`, so the first `.` splits the two.
 */
export type Version = string;

/** A patch series against `base`, the target commit its lane chain was cut from. */
export type Changeset = { base: string; patches: string[] };

/**
 * How `Lane.apply` meets a patch that does not apply cleanly:
 * - `3way`: merges it, leaving conflict markers in the working copy
 * - `clean`: refuses it, leaving the working copy as it was
 */
export type ApplyStrategy = "3way" | "clean";

export interface Lane {
	/** Host directory of the working copy. This is `SandboxSpec.lane`. */
	readonly dir: string;
	/**
	 * Host paths to bind read-only at the same paths (`SandboxSpec.readOnly`), so that git works in the lane: the
	 * lane's own git directory and the store's objects. git there can read and diff but never write.
	 */
	readonly readOnly: Bind[];
	/** Whether the working copy was checked out from a commit, rather than moved in place by an `extend`. */
	readonly checkedOut: boolean;
	/** The target commit the lane chain was cut from. */
	readonly base: string;
	/** The lane-relative files `seal` would record a change to, as git spells them. */
	changes(): Promise<string[]>;
	/**
	 * Records the working copy's content as the node instance's version. Ignored files are left out, and a nested
	 * repository is refused. At most once.
	 */
	seal(): Promise<Version>;
	/** The working copy's content as a changeset from the lane chain's base. Records no version and no ref. */
	changeset(): Promise<Changeset>;
	/**
	 * Applies the changeset's patches in order to the working copy and returns the lane-relative files that conflict,
	 * none when it applied. `3way` stops at the first conflicting patch with its markers left in place; `clean`
	 * applies all or nothing.
	 * @throws on a malformed patch or objects the store lacks; the working copy is left as it was.
	 */
	apply(changeset: Changeset, strategy?: ApplyStrategy): Promise<string[]>;
	/** Removes the working copy and its git directory. A version it sealed stays. */
	discard(): void;
}

/**
 * Every `at` is the node instance whose lane it opens. A claim belongs to its instance: opening `at` again takes back
 * whatever an earlier run of `at` left, its lane and its version.
 */
export interface Lanes {
	/** `base` is any revision of the target. */
	fresh(base: string, at: Version): Promise<Lane>;
	/** A new lane holding `v`'s content. Any number of times, from any concert (lane refs, D-27). */
	fork(v: Version, at: Version): Promise<Lane>;
	/** `fork` for a node that only reads; the two differ in what a failure calls it. */
	read(v: Version, at: Version): Promise<Lane>;
	/**
	 * Continues `v`'s working copy in place (ignored files kept) as node instance `at`'s lane. When `at` extended `v`
	 * before, it re-opens `v`'s sealed content instead.
	 * @throws if another instance extended `v`, or `v` belongs to another concert.
	 */
	extend(v: Version, at: Version): Promise<Lane>;
	/**
	 * Records the target commits `revs` names (`A..B`, `C^!`, or a bare `B` from `base`) as version `at`, its base the
	 * one merge base of the head and the commit `revs` excludes. It opens no lane.
	 * @throws on a revision git cannot resolve, a range with no commit in it, or one that is not one linear series.
	 */
	commits(revs: string, base: string, at: Version): Promise<void>;
	/** The patch series from the lane chain's base up to `v`. Unchanged versions add no patch. */
	changeset(v: Version): Promise<Changeset>;
	/** Lane bytes on disk for a concert: its working copies and their git directories. The shared store is not counted. */
	diskUse(concert: string): Promise<number>;
	/** Removes a concert's lanes and versions, and returns the lane bytes freed. Forks other concerts made keep their content. */
	prune(concert: string): Promise<number>;
}

/** A sparse checkout: cone-mode directories relative to the repository root, or gitignore-style `patterns`. */
export type Sparse = string[] | { patterns: string[] };

export type LanesOptions = {
	/** The target repository. Only read: its checkout, refs and objects are never written (HOST-03). */
	target: string;
	/** Directory owned by maestro holding the store and the lanes of this target. */
	root: string;
	/** What a checked-out working copy is narrowed to. */
	sparse?: Sparse;
};

/** Git with a fixed identity and no system or user config, so the operator's settings cannot change a version. */
const GIT_ENV = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "maestro",
	GIT_AUTHOR_EMAIL: "maestro@localhost",
	GIT_COMMITTER_NAME: "maestro",
	GIT_COMMITTER_EMAIL: "maestro@localhost",
};

/** The base a lane is cut at when neither a lane input nor `target.base` names one. */
export const DEFAULT_BASE = "HEAD";

/** `git merge-base` exits 1 when the commits share no ancestor. */
const NO_COMMON_ANCESTOR = 1;

/** The fix line of revisions git cannot resolve to commits of the target. */
const REVS_FIX = "Pass A..B, C^!, or a branch, tag or commit id";

/** git's well-known empty tree. As the attribute source it disables the lane's `.gitattributes` (git >= 2.40). */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function spawnGit(
	args: string[],
	env: Record<string, string> = {},
	stdin?: string,
) {
	const p = Bun.spawn(["git", ...args], {
		env: { ...GIT_ENV, ...env },
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { out, err, code };
}

/** A git command that exited non-zero: `stderr` is git's own words, `where` the repository it ran against. */
class GitError extends Error {
	constructor(
		readonly cmd: string | undefined,
		readonly stderr: string,
		readonly where: string | undefined,
	) {
		super(`git ${cmd} failed: ${stderr}`);
	}
}

/** The repository git ran against: `-C`'s directory, else the store's `--git-dir`. */
function ranAgainst(args: string[]) {
	const c = args.indexOf("-C");
	if (c >= 0) return args[c + 1];
	return args
		.find((a) => a.startsWith("--git-dir="))
		?.slice("--git-dir=".length);
}

async function git(...a: Parameters<typeof spawnGit>): Promise<string> {
	const { out, err, code } = await spawnGit(...a);
	const [args] = a;
	if (code !== 0) {
		const cmd = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-C");
		throw new GitError(cmd, err.trim(), ranAgainst(args));
	}
	return out;
}

type FsError = Error & { code: string; path?: string };
const isFsError = (e: unknown): e is FsError =>
	e instanceof Error && typeof (e as FsError).code === "string";

/** Errnos that mean the lane root cannot be written. */
const UNWRITABLE = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "ENOTDIR"]);

/** What went wrong of a raw failure, where it happened (none for a missing git) and the fix. */
function reasonOf(e: unknown, root: string) {
	if (e instanceof GitError) {
		const at = e.where ?? root;
		return {
			at,
			why: `git ${e.cmd}: ${e.stderr.replace(/^(fatal|error): /, "")}`,
			fix: `Check that ${at} is an intact git repository, then retry`,
		};
	}
	if (!isFsError(e)) return undefined;
	if (e.code === "ENOENT" && e.path === "git")
		return {
			at: undefined,
			why: "git was not found",
			fix: "Install git, or put it on PATH",
		};
	const at = e.path ?? root;
	return {
		at,
		// "EACCES: permission denied, mkdir '/x'" reads as "permission denied"
		why: e.message.replace(/^[A-Z]+: /, "").replace(/, \w+( '.*)?$/s, ""),
		fix: UNWRITABLE.has(e.code)
			? `Check that ${root} is writable and has free space, then retry`
			: `Check that ${at} still exists and that nothing else is changing ${root}, then retry`,
	};
}

/**
 * The failure of `what`, as the user reads it: what failed and where, then the fix. A raw fs or git error is
 * rewritten; an error the lanes raised on purpose is returned as it is.
 */
export function describeFailure(
	what: string,
	e: unknown,
	root: string,
): unknown {
	const r = reasonOf(e, root);
	if (!r) return e;
	const where = r.at ? ` at ${r.at}` : "";
	return new Error(`cannot ${what}${where}: ${r.why}\n${r.fix}`);
}

/** What each method does in the user's words, given its arguments. */
type Names = Record<string, (args: unknown[]) => string>;

const LANES_NAMES: Names = {
	fresh: ([, at]) => `open a fresh lane for ${at}`,
	fork: ([v, at]) => `fork the lane of ${v} for ${at}`,
	read: ([v, at]) => `read the lane of ${v} for ${at}`,
	extend: ([v, at]) => `extend the lane of ${v} for ${at}`,
	commits: ([, , at]) => `record the target commits as ${at}`,
	changeset: ([v]) => `read the changeset of ${v}`,
	diskUse: ([concert]) => `measure the disk use of concert ${concert}`,
	prune: ([concert]) => `prune concert ${concert}`,
};

const laneNames = (at: Version): Names => ({
	changes: () => `list the changes of lane ${at}`,
	seal: () => `seal lane ${at}`,
	changeset: () => `read the changeset of lane ${at}`,
	apply: () => `apply a changeset to lane ${at}`,
	discard: () => `discard lane ${at}`,
});

/** `obj` with each method's raw failures run through `describeFailure`, so no call site wraps its own. */
function guarded<T extends object>(obj: T, root: string, names: Names): T {
	const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
	for (const [op, fn] of Object.entries(obj)) {
		if (typeof fn !== "function") continue;
		out[op] = (...args: unknown[]) => {
			const fail = (e: unknown) => {
				throw describeFailure(names[op]?.(args) ?? op, e, root);
			};
			try {
				const r = fn(...args);
				return r instanceof Promise ? r.catch(fail) : r;
			} catch (e) {
				return fail(e);
			}
		};
	}
	return out as T;
}

const value = async (...a: Parameters<typeof git>) => (await git(...a)).trim();

/** A ref- and filename-safe, reversible spelling of an id: no `/`, no `.`, nothing git forbids in a ref. */
const enc = (s: string) =>
	encodeURIComponent(s).replace(
		/[.!~*'()]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);

function concertId(c: string): string {
	if (!c || c.includes("."))
		throw new Error(
			`not a concert id: ${JSON.stringify(c)} (must be non-empty and contain no ".")`,
		);
	return c;
}

function parse(v: Version): { concert: string; node: string } {
	const i = v.indexOf(".");
	if (i <= 0 || i === v.length - 1)
		throw new Error(
			`not a version: ${JSON.stringify(v)} (expected <concert id>.<node instance id>)`,
		);
	return { concert: v.slice(0, i), node: v.slice(i + 1) };
}

/** Allocated (not apparent) bytes of a file tree. Links are not followed. */
export function bytesOnDisk(p: string): number {
	const s = lstatSync(p, { throwIfNoEntry: false });
	if (!s) return 0;
	let n = s.blocks * 512;
	if (s.isDirectory())
		for (const e of readdirSync(p)) n += bytesOnDisk(join(p, e));
	return n;
}

export function openLanes(options: LanesOptions): Lanes {
	const target = resolvePath(options.target);
	const root = resolvePath(options.root);
	const { sparse } = options;
	const store = join(root, "store.git");
	// The host's git names the store and the work tree, never a lane's `.git`, which the agent can write. The one
	// exception is `checkedOutLane`, which sets sparse on the lane's git dir before any sandbox runs.
	const G = (...a: string[]) => [
		`--git-dir=${store}`,
		`--attr-source=${EMPTY_TREE}`,
		...a,
	];
	const refs = (v: Version) => {
		const { concert, node } = parse(v);
		const p = `refs/maestro/${enc(concert)}/${enc(node)}`;
		return {
			own: `${p}/`,
			version: `${p}/version`,
			base: `${p}/base`,
			extended: `${p}/extended`,
			extendedBy: (at: Version) => `${p}/extended-by/${enc(parse(at).node)}`,
		};
	};
	const concertDir = (c: string) => join(root, "lanes", enc(concertId(c)));
	// A lane is one directory: `work` is the working copy, `git` its git directory (HEAD, index, no refs).
	const paths = (v: Version) => {
		const { concert, node } = parse(v);
		const home = join(concertDir(concert), enc(node));
		return { home, dir: join(home, "work"), gitdir: join(home, "git") };
	};

	// Created aside and renamed in, so concerts racing to create it all end up with the one store.
	async function initStore() {
		if (existsSync(store)) return;
		mkdirSync(root, { recursive: true });
		const aside = mkdtempSync(join(root, "store.init-"));
		await git(["init", "-q", "--bare", "--template=", aside]);
		try {
			renameSync(aside, store);
		} catch (e) {
			rmSync(aside, { recursive: true, force: true });
			if (!existsSync(store)) throw e;
		}
	}

	// The target is only read (by upload-pack).
	async function importBase(base: string): Promise<string> {
		const sha = await value([
			"-C",
			target,
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${base}^{commit}`,
		]).catch((e) => {
			throw /Needed a single revision/.test(String(e))
				? new Error(
						`base '${base}' is not a commit in ${target}. Pass a branch, tag or commit id`,
					)
				: e;
		});
		return importCommit(sha);
	}

	async function importCommit(sha: string): Promise<string> {
		await initStore();
		const have = await git(G("cat-file", "-e", `${sha}^{commit}`)).then(
			() => true,
			() => false,
		);
		if (!have)
			await git(
				G("fetch", "-q", "--no-tags", "--no-write-fetch-head", target, sha),
			);
		return sha;
	}

	/**
	 * What `git rev-parse` prints for `args` in the target.
	 * @throws with git's own error and the fix line when it refuses them.
	 */
	async function parsedRevs(...args: string[]): Promise<string[]> {
		const { out, err, code } = await spawnGit([
			"-C",
			target,
			"rev-parse",
			...args,
		]);
		if (code !== 0) throw new Error(`${err.trim()}\n${REVS_FIX}`);
		return out.split("\n").filter(Boolean);
	}

	/** The commit object `sha` of the target names, fetched into the store. */
	const peeled = async (sha: string) => {
		const [commit = ""] = await parsedRevs(
			"--verify",
			"--end-of-options",
			`${sha}^{commit}`,
		);
		return importCommit(commit);
	};

	const baseName = (base: string) =>
		base === DEFAULT_BASE ? DEFAULT_BASE : `target.base '${base}'`;

	const notLinear = (revs: string) =>
		new Error(
			`'${revs}' is not one linear series of commits. Pass A..B or C^! with no merge in it`,
		);

	/**
	 * The head `revs` names in the target, and `from`, the commit it excludes, or `base` when it excludes none (`bare`),
	 * both fetched into the store.
	 */
	async function ends(revs: string, base: string) {
		// `--` makes git refuse a name it cannot resolve, rather than drop it as a path.
		const names = await parsedRevs(
			"--revs-only",
			"--end-of-options",
			revs,
			"--",
		);
		const heads = names.filter((n) => !n.startsWith("^"));
		const [head] = heads;
		// Several exclusions come only from a merge's `C^!`, whose merge the merge check refuses.
		const exclusion = names.find((n) => n.startsWith("^"));
		if (head === undefined)
			throw new Error(`'${revs}' names no revision\n${REVS_FIX}`);
		if (heads.length > 1) throw notLinear(revs);
		return {
			head: await peeled(head),
			from: exclusion
				? await peeled(exclusion.slice(1))
				: await importBase(base),
			bare: exclusion === undefined,
		};
	}

	/**
	 * The one merge base of `from` and `head`; of several, git gives one, and they imply a merge in the range, which
	 * the merge check refuses.
	 * @throws when the two share no history, or git refuses them.
	 */
	async function mergeBaseOf(revs: string, from: string, head: string) {
		const found = await spawnGit(G("merge-base", from, head));
		if (found.code === NO_COMMON_ANCESTOR)
			throw new Error(`'${revs}' shares no history with its base\n${REVS_FIX}`);
		if (found.code !== 0) throw new Error(`${found.err.trim()}\n${REVS_FIX}`);
		return found.out.trim();
	}

	/**
	 * The head and the base of the series `revs` names, fetched into the store: the base is the one merge base of the
	 * head and the commit `revs` excludes, else `base`.
	 * @throws when git cannot resolve `revs`, or it names no commit past its base, or no one linear series.
	 */
	async function series(revs: string, base: string) {
		const { head, from, bare } = await ends(revs, base);
		const mergeBase = await mergeBaseOf(revs, from, head);
		if (mergeBase === head) {
			const past = bare
				? baseName(base)
				: `its base ${await value(G("rev-parse", "--short", head))}`;
			throw new Error(
				`'${revs}' names no commit past ${past}. Pass a range with a commit in it, such as main..feature`,
			);
		}
		if (await value(G("rev-list", "--merges", "-1", `${mergeBase}..${head}`)))
			throw notLinear(revs);
		return { head, base: mergeBase };
	}

	// One atomic ref transaction. A `create` fails if the ref exists, which is how "at most once" holds.
	const updateRefs = (lines: string[]) =>
		git(G("update-ref", "--stdin"), {}, `start\n${lines.join("\n")}\ncommit\n`);

	async function createOnce(lines: string[], taken: string) {
		try {
			await updateRefs(lines);
		} catch (e) {
			throw /exists/.test(String(e)) ? new Error(taken) : e;
		}
	}

	const exists = (ref: string) =>
		git(G("rev-parse", "--verify", "-q", ref)).then(
			() => true,
			() => false,
		);

	async function resolve(v: Version) {
		const r = refs(v);
		try {
			return {
				commit: await value(G("rev-parse", "--verify", r.version)),
				base: await value(G("rev-parse", "--verify", r.base)),
			};
		} catch {
			throw new Error(`unknown version ${v}: not sealed, or pruned`);
		}
	}

	const refsUnder = async (prefix: string) =>
		existsSync(store)
			? (await value(G("for-each-ref", "--format=%(refname)", prefix)))
					.split("\n")
					.filter(Boolean)
			: [];
	const deleteRefs = async (names: string[]) => {
		if (names.length) await updateRefs(names.map((r) => `delete ${r}`));
	};

	// Takes back what an earlier run of `at` left: its lane, and its version with the refs under it.
	async function takeBack(at: Version) {
		const p = paths(at);
		rmSync(p.home, { recursive: true, force: true });
		await deleteRefs(await refsUnder(refs(at).own));
		return p;
	}

	async function claim(at: Version) {
		const p = await takeBack(at);
		mkdirSync(p.home, { recursive: true });
		return p;
	}

	// The lane's git directory is empty and borrows the store's objects through alternates.
	async function checkout(at: Version, commit: string) {
		const p = await claim(at);
		try {
			mkdirSync(p.dir);
			mkdirSync(join(p.gitdir, "objects", "info"), { recursive: true });
			mkdirSync(join(p.gitdir, "refs"));
			writeFileSync(
				join(p.gitdir, "objects", "info", "alternates"),
				`${join(store, "objects")}\n`,
			);
			await git(
				[...G(`--work-tree=${p.dir}`), "read-tree", "--reset", "-u", commit],
				{ GIT_INDEX_FILE: join(p.gitdir, "index") },
			);
		} catch (e) {
			rmSync(p.home, { recursive: true, force: true });
			throw e;
		}
	}

	// Points the lane's git at `head`. Its `.git` file is rewritten too, undoing anything the last agent did to it.
	function open(
		at: Version,
		head: string,
		base: string,
		checkedOut: boolean,
	): Lane {
		const { home, dir, gitdir } = paths(at);
		const idx = { GIT_INDEX_FILE: join(gitdir, "index") };
		const point = (commit: string) => {
			writeFileSync(join(gitdir, "HEAD"), `${commit}\n`);
			rmSync(join(dir, ".git"), { recursive: true, force: true });
			writeFileSync(join(dir, ".git"), `gitdir: ${gitdir}\n`);
		};
		point(head);
		const lg: LaneGit = { dir, wt: G(`--work-tree=${dir}`), idx, at };
		const { wt } = lg;
		const staged = async () => {
			await git([...wt, "add", "-A"], idx);
			const tree = await value([...wt, "write-tree"], idx);
			const changed = await lines(lg, [
				"diff-tree",
				"-r",
				"--no-renames",
				head,
				tree,
			]);
			return { tree, changed };
		};
		return guarded<Lane>(
			{
				dir,
				readOnly: [{ src: gitdir }, { src: join(store, "objects") }],
				checkedOut,
				base,
				changes: async () =>
					(await staged()).changed.map((l) => l.slice(l.indexOf("\t") + 1)),
				async seal() {
					const { tree, changed } = await staged();
					const nested = changed
						.filter((l) => l.split(" ")[1] === "160000")
						.map((l) => l.split("\t")[1]);
					if (nested.length)
						throw new Error(
							`${at}: nested repository at ${nested.join(", ")}; its files cannot be sealed. Remove its .git directory`,
						);
					const commit = changed.length
						? await value(G("commit-tree", tree, "-p", head, "-m", at))
						: head;
					const r = refs(at);
					await createOnce(
						[`create ${r.version} ${commit}`, `create ${r.base} ${base}`],
						`${at} is already sealed`,
					);
					point(commit);
					return at;
				},
				async changeset() {
					const { tree, changed } = await staged();
					const commit = changed.length
						? await value(G("commit-tree", tree, "-p", head, "-m", at))
						: head;
					const mbox = await git(
						G(
							"format-patch",
							"--stdout",
							"--no-signature",
							`${base}..${commit}`,
						),
					);
					return { base, patches: splitMbox(mbox) };
				},
				apply: (changeset, strategy = "3way") =>
					applyChangeset(lg, changeset, strategy),
				discard: () => rmSync(home, { recursive: true, force: true }),
			},
			root,
			laneNames(at),
		);
	}

	// A working copy checked out from `head`, narrowed to `sparse`. This is the host's only git call on a lane's git
	// directory, made before any sandbox has run there (ADR 0005).
	async function checkedOutLane(at: Version, head: string, base: string) {
		const lane = open(at, head, base, true);
		if (!sparse) return lane;
		const { dir, gitdir } = paths(at);
		const set = [
			`--git-dir=${gitdir}`,
			`--work-tree=${dir}`,
			`--attr-source=${EMPTY_TREE}`,
			"sparse-checkout",
			"set",
		];
		// Patterns go on stdin, so no argument limit bounds them.
		const { err, code } = Array.isArray(sparse)
			? await spawnGit([...set, "--cone", "--", ...sparse])
			: await spawnGit(
					[...set, "--no-cone", "--stdin"],
					{},
					`${sparse.patterns.join("\n")}\n`,
				);
		if (code === 0) return lane;
		lane.discard();
		throw new Error(`target.sparse: ${err.trim()}`);
	}

	async function diskUse(concert: string) {
		return bytesOnDisk(concertDir(concert));
	}

	async function forkLane(v: Version, at: Version) {
		const { commit, base } = await resolve(v);
		await checkout(at, commit);
		return checkedOutLane(at, commit, base);
	}

	return guarded<Lanes>(
		{
			async fresh(base, at) {
				parse(at);
				const sha = await importBase(base);
				await checkout(at, sha);
				return checkedOutLane(at, sha, sha);
			},
			fork: forkLane,
			read: forkLane,
			async extend(v, at) {
				if (parse(v).concert !== parse(at).concert)
					throw new Error(
						`${at} cannot extend ${v}: a lane extends only versions of its own concert. Fork it instead`,
					);
				const { commit, base } = await resolve(v);
				const r = refs(v);
				if (await exists(r.extendedBy(at))) {
					await checkout(at, commit);
					return checkedOutLane(at, commit, base);
				}
				const from = paths(v).home;
				const to = (await claim(at)).home;
				try {
					const { extended } = r;
					await createOnce(
						[
							`create ${extended} ${commit}`,
							`create ${r.extendedBy(at)} ${commit}`,
						],
						`version ${v} is already extended`,
					);
					try {
						renameSync(from, to); // replaces the empty claimed directory
					} catch (e) {
						await deleteRefs([extended, r.extendedBy(at)]);
						throw e;
					}
				} catch (e) {
					rmdirSync(to);
					throw e;
				}
				return open(at, commit, base, false);
			},
			async commits(revs, base, at) {
				parse(at);
				const found = await series(revs, base);
				const r = refs(at);
				await takeBack(at);
				await createOnce(
					[
						`create ${r.version} ${found.head}`,
						`create ${r.base} ${found.base}`,
					],
					`${at} is already sealed`,
				);
			},
			async changeset(v) {
				const { commit, base } = await resolve(v);
				const mbox = await git(
					G("format-patch", "--stdout", "--no-signature", `${base}..${commit}`),
				);
				return { base, patches: splitMbox(mbox) };
			},
			diskUse,
			async prune(concert) {
				const freed = await diskUse(concert);
				await deleteRefs(await refsUnder(`refs/maestro/${enc(concert)}/`));
				rmSync(concertDir(concert), { recursive: true, force: true });
				return freed;
			},
		},
		root,
		LANES_NAMES,
	);
}

/** Each patch starts with format-patch's fixed `From <sha> Mon Sep 17 ...` line, which no diff line can match. */
function splitMbox(mbox: string): string[] {
	if (!mbox) return [];
	return mbox
		.split(/^(?=From [0-9a-f]{40} Mon Sep 17 00:00:00 2001$)/m)
		.filter(Boolean);
}

/** Git run on one lane: the store, the lane's working copy and its index. */
type LaneGit = {
	dir: string;
	wt: string[];
	idx: Record<string, string>;
	at: Version;
};

const lines = async (l: LaneGit, args: string[], stdin?: string) =>
	(await value([...l.wt, ...args], l.idx, stdin)).split("\n").filter(Boolean);

/** Paths as written: `-z` output is never quoted. */
const nulFields = async (l: LaneGit, args: string[], stdin?: string) =>
	(await git([...l.wt, ...args, "-z"], l.idx, stdin))
		.split("\0")
		.filter(Boolean);

/**
 * The files a patch touches, a rename giving both names.
 * @throws if the patch is malformed
 */
async function patchFiles(l: LaneGit, patch: string) {
	// `-z` numstat: `<added>\t<deleted>\t<path>`, or for a rename `<added>\t<deleted>\t` then old and new path.
	return (await nulFields(l, ["apply", "--numstat"], patch)).flatMap((f) => {
		const m = /^\S+\t\S+\t(.*)$/s.exec(f);
		return m ? (m[1] ? [m[1]] : []) : [f];
	});
}

/** The conflicting files, empty when the patch applied cleanly. */
async function applyPatch(l: LaneGit, patch: string, strategy: ApplyStrategy) {
	const mode = strategy === "3way" ? "--3way" : "--index";
	// git apply resolves the patch's paths against the working directory, not the work tree.
	const clean = await git(
		["-C", l.dir, ...l.wt, "apply", mode],
		l.idx,
		patch,
	).then(
		() => true,
		() => false,
	);
	if (clean) return [];
	const unmerged = (await nulFields(l, ["ls-files", "-u"])).map((f) =>
		f.slice(f.indexOf("\t") + 1),
	);
	return unmerged.length ? [...new Set(unmerged)] : patchFiles(l, patch);
}

/**
 * The first conflicting patch's files, empty when every patch applied cleanly. A `clean` conflict leaves the working
 * copy as it was.
 * @throws on a malformed patch or a base the store lacks
 */
async function applyChangeset(
	l: LaneGit,
	cs: Changeset,
	strategy: ApplyStrategy,
): Promise<string[]> {
	await git([...l.wt, "add", "-A"], l.idx);
	const before = await value([...l.wt, "write-tree"], l.idx);
	const restore = () =>
		git([...l.wt, "read-tree", "--reset", "-u", before], l.idx);
	const conflicts = await applyPatches(l, cs, strategy).catch(async (e) => {
		await restore();
		throw new Error(
			`${l.at}: the changeset cannot be applied: ${e instanceof Error ? e.message : e}`,
		);
	});
	if (conflicts.length && strategy === "clean") await restore();
	return conflicts;
}

async function applyPatches(
	l: LaneGit,
	cs: Changeset,
	strategy: ApplyStrategy,
): Promise<string[]> {
	await git([...l.wt, "cat-file", "-e", `${cs.base}^{commit}`]).catch(() => {
		throw new Error(
			`its base ${cs.base} is not in the store. Pass the changeset of a version sealed from this target`,
		);
	});
	for (const [j, patch] of cs.patches.entries())
		await patchFiles(l, patch).catch(() => {
			throw new Error(
				`patch ${j} is malformed. Pass the changeset of a sealed version`,
			);
		});
	for (const patch of cs.patches) {
		const conflicts = await applyPatch(l, patch, strategy);
		if (conflicts.length) return conflicts;
	}
	return [];
}
