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
	/** The lane-relative files `seal` would record a change to, as git spells them. */
	changes(): Promise<string[]>;
	/**
	 * Records the working copy's content as the node instance's version. Ignored files are left out, and a nested
	 * repository is refused. At most once.
	 */
	seal(): Promise<Version>;
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
	/**
	 * Continues `v`'s working copy in place (ignored files kept) as node instance `at`'s lane. When `at` extended `v`
	 * before, it re-opens `v`'s sealed content instead.
	 * @throws if another instance extended `v`, or `v` belongs to another concert.
	 */
	extend(v: Version, at: Version): Promise<Lane>;
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

async function git(...a: Parameters<typeof spawnGit>): Promise<string> {
	const { out, err, code } = await spawnGit(...a);
	const [args] = a;
	if (code !== 0) {
		const cmd = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-C");
		throw new Error(`git ${cmd} failed: ${err.trim()}`);
	}
	return out;
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
	async function claim(at: Version) {
		const p = paths(at);
		rmSync(p.home, { recursive: true, force: true });
		await deleteRefs(await refsUnder(refs(at).own));
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
		return {
			dir,
			readOnly: [{ src: gitdir }, { src: join(store, "objects") }],
			checkedOut,
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
			apply: (changeset, strategy = "3way") =>
				applyChangeset(lg, changeset, strategy),
			discard: () => rmSync(home, { recursive: true, force: true }),
		};
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

	return {
		async fresh(base, at) {
			parse(at);
			const sha = await importBase(base);
			await checkout(at, sha);
			return checkedOutLane(at, sha, sha);
		},
		async fork(v, at) {
			const { commit, base } = await resolve(v);
			await checkout(at, commit);
			return checkedOutLane(at, commit, base);
		},
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
					throw new Error(`the lane of ${v} cannot be moved: ${e}`);
				}
			} catch (e) {
				rmdirSync(to);
				throw e;
			}
			return open(at, commit, base, false);
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
	};
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
