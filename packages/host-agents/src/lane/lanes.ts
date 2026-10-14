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
import { dirname, join, resolve as resolvePath } from "node:path";
import type { Bind } from "../sandbox/index";

/**
 * A lane version, written `<concert id>.<node instance id>`: the node instance that produced it. The same text is a
 * lane ref (D-27). Concert ids hold no `.`, so the first `.` splits the two.
 */
export type Version = string;

/** A patch series against `base`, the target commit its lane chain was cut from. */
export type Changeset = { base: string; patches: string[] };

export interface Lane {
	/** Host directory of the working copy. This is `SandboxSpec.lane`. */
	readonly dir: string;
	/**
	 * Host paths to bind read-only at the same paths (`SandboxSpec.readOnly`), so that git works in the lane: the
	 * lane's own git directory and the store's objects. git there can read and diff but never write.
	 */
	readonly readOnly: Bind[];
	/**
	 * Records the working copy's content as the node instance's version. Ignored files are left out, and a nested
	 * repository is refused. At most once.
	 */
	seal(): Promise<Version>;
}

export interface Lanes {
	/** `base` is any revision of the target. */
	fresh(base: string, at: Version): Promise<Lane>;
	/** A new lane holding `v`'s content. Any number of times, from any concert (lane refs, D-27). */
	fork(v: Version, at: Version): Promise<Lane>;
	/**
	 * Continues `v`'s working copy in place (ignored files kept) as node instance `at`'s lane.
	 * @throws if `v` was already joined or belongs to another concert.
	 */
	join(v: Version, at: Version): Promise<Lane>;
	/** The patch series from the lane chain's base up to `v`. Unchanged versions add no patch. */
	changeset(v: Version): Promise<Changeset>;
	/** Lane bytes on disk for a concert: its working copies and their git directories. The shared store is not counted. */
	diskUse(concert: string): Promise<number>;
	/** Removes a concert's lanes and versions, and returns the lane bytes freed. Forks other concerts made keep their content. */
	prune(concert: string): Promise<number>;
}

export type LanesOptions = {
	/** The target repository. Only read: its checkout, refs and objects are never written (HOST-03). */
	target: string;
	/** Directory owned by maestro holding the store and the lanes of this target. */
	root: string;
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

async function git(
	args: string[],
	env: Record<string, string> = {},
	stdin?: string,
): Promise<string> {
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
function bytesOnDisk(p: string): number {
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
	const store = join(root, "store.git");
	// The host's git always names the store and the work tree, never a lane's `.git`, which the agent can write.
	const G = (...a: string[]) => [
		`--git-dir=${store}`,
		`--attr-source=${EMPTY_TREE}`,
		...a,
	];
	const refs = (v: Version) => {
		const { concert, node } = parse(v);
		const p = `refs/maestro/${enc(concert)}/${enc(node)}`;
		return {
			version: `${p}/version`,
			base: `${p}/base`,
			joined: `${p}/joined`,
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
		]);
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

	// `mkdir` is atomic, so one node instance gets one lane.
	function claim(at: Version) {
		const p = paths(at);
		mkdirSync(dirname(p.home), { recursive: true });
		try {
			mkdirSync(p.home);
		} catch {
			throw new Error(`${at} already has a lane`);
		}
		return p;
	}

	// The lane's git directory is empty and borrows the store's objects through alternates.
	async function checkout(at: Version, commit: string) {
		const p = claim(at);
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
	function open(at: Version, head: string, base: string): Lane {
		const { dir, gitdir } = paths(at);
		const idx = { GIT_INDEX_FILE: join(gitdir, "index") };
		const point = (commit: string) => {
			writeFileSync(join(gitdir, "HEAD"), `${commit}\n`);
			rmSync(join(dir, ".git"), { recursive: true, force: true });
			writeFileSync(join(dir, ".git"), `gitdir: ${gitdir}\n`);
		};
		point(head);
		return {
			dir,
			readOnly: [{ src: gitdir }, { src: join(store, "objects") }],
			async seal() {
				const wt = G(`--work-tree=${dir}`);
				await git([...wt, "add", "-A"], idx);
				const tree = await value([...wt, "write-tree"], idx);
				const changed = (
					await value(G("diff-tree", "-r", "--no-renames", head, tree))
				)
					.split("\n")
					.filter(Boolean);
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
		};
	}

	async function diskUse(concert: string) {
		return bytesOnDisk(concertDir(concert));
	}

	return {
		async fresh(base, at) {
			parse(at);
			const sha = await importBase(base);
			await checkout(at, sha);
			return open(at, sha, sha);
		},
		async fork(v, at) {
			const { commit, base } = await resolve(v);
			await checkout(at, commit);
			return open(at, commit, base);
		},
		async join(v, at) {
			if (parse(v).concert !== parse(at).concert)
				throw new Error(
					`${at} cannot join ${v}: a lane joins only versions of its own concert. Fork it instead`,
				);
			const { commit, base } = await resolve(v);
			const from = paths(v).home;
			const to = claim(at).home;
			try {
				const joined = refs(v).joined;
				await createOnce(
					[`create ${joined} ${commit}`],
					`version ${v} is already joined`,
				);
				try {
					renameSync(from, to); // replaces the empty claimed directory
				} catch (e) {
					await updateRefs([`delete ${joined} ${commit}`]);
					throw new Error(`the lane of ${v} cannot be moved: ${e}`);
				}
			} catch (e) {
				rmdirSync(to);
				throw e;
			}
			return open(at, commit, base);
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
			const owned = existsSync(store)
				? await value(
						G(
							"for-each-ref",
							"--format=%(refname)",
							`refs/maestro/${enc(concert)}/`,
						),
					)
				: "";
			if (owned) await updateRefs(owned.split("\n").map((r) => `delete ${r}`));
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
