import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Account } from "./forge";

/** How much of a failed command's output a landing error keeps. */
const OUTPUT_TAIL = 2000;

/** The directory the tick performs compositions from. */
const COMPOSITIONS = ".maestro";

/** The directory of the workspace packs, which an export compares but does not hold. */
const PACKS = "packs";

/** The `.maestro/` tree of one commit, exported for the tick to perform from. */
export type Export = {
	/** The commit the tree is exported at. */
	commit: string;
	/** The directory holding the exported `.maestro/`, beside a link to the checkout's `node_modules`. */
	dir: string;
	/** Whether the checkout's `.maestro/` or `packs/` differs from the commit. */
	differs: boolean;
	/** The checkout's paths under `.maestro/` and `packs/` that differ from the commit, ignored files included. */
	paths: string[];
};

/** The jj workspace a slice lands in (factory.md, Rules, Landing and PRs). */
export type Landing = {
	/** Brings the commits `origin` gained since the last fetch into the repository. */
	fetch(): Promise<void>;
	/**
	 * Creates workspace `name` at `dir` on revision `base`, colocated with git, in place of any a failed landing left
	 * there.
	 */
	open(dir: string, name: string, base: string): Promise<void>;
	/** Describes the change of the workspace at `dir` as `message`, and returns its commit id. */
	describe(dir: string, message: string): Promise<string>;
	/** Folds the change of the workspace at `dir` into its parent, described as `message`, and returns its commit id. */
	squash(dir: string, message: string): Promise<string>;
	/** Forgets workspace `name` and removes `dir`. */
	close(dir: string, name: string): Promise<void>;
	/**
	 * Exports the `.maestro/` tree at the commit `revision` names into `root/<checkout>/<commit>`, once per checkout and
	 * commit: a later call for the same pair reuses it. The export links the checkout's `node_modules`.
	 * @throws Error when `revision` names no single commit, or the commit has no `.maestro/` tree.
	 */
	export(revision: string, root: string): Promise<Export>;
	/**
	 * The export in `root` that holds `moduleDir`, the `.maestro/` an encore reopens, compared with the checkout. It
	 * reads the tree's commit from its place in the cache, in the layout of `export` and in the earlier `root/<commit>`.
	 * @throws Error when `moduleDir` is not an export in `root`, links the `node_modules` of another checkout, or its
	 * commit is unknown to the repository.
	 */
	reopen(moduleDir: string, root: string): Promise<Export>;
};

/**
 * The stdout of `command` in `cwd` as bytes.
 * @throws Error with the tail of its output when it exits non-zero.
 */
async function bytes(cwd: string, command: string[]) {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).bytes(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(
			`${command.join(" ")} exited ${code}:\n${`${new TextDecoder().decode(out)}${err}`.trim().slice(-OUTPUT_TAIL)}`,
		);
	return out;
}

/**
 * The stdout of `command` in `cwd`.
 * @throws Error with the tail of its output when it exits non-zero.
 */
const run = async (cwd: string, command: string[]) =>
	new TextDecoder().decode(await bytes(cwd, command));

/** The jj fileset naming exactly the file at root-relative `path`. */
const rootFile = (path: string) => `root-file:${JSON.stringify(path)}`;

/**
 * Writes the `.maestro/` tree of `commit` in the repository at `repo` into a fresh directory under `root`, beside a
 * link to `repo`'s `node_modules` so its package imports resolve, and returns that directory.
 * @throws Error when `commit` has no `.maestro/` tree.
 */
async function exportTree(repo: string, commit: string, root: string) {
	const checkout = resolve(repo);
	const listed = await run(repo, [
		"jj",
		"file",
		"list",
		"-r",
		commit,
		`root:${JSON.stringify(COMPOSITIONS)}`,
	]);
	const files = listed.split("\n").filter(Boolean);
	if (!files.length) throw new Error(`${commit} has no ${COMPOSITIONS}/ tree`);
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, `.${commit}-`));
	try {
		for (const file of files) {
			const path = join(dir, file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				await bytes(repo, ["jj", "file", "show", "-r", commit, rootFile(file)]),
			);
		}
		symlinkSync(join(checkout, "node_modules"), join(dir, "node_modules"));
		return dir;
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

/**
 * The jj config that leaves a pushed branch rewritable, which jj's default protects as an untracked remote bookmark:
 * a revision squashes into the PR head it was cut at.
 */
const REWRITABLE = 'revset-aliases."immutable_heads()"="trunk() | tags()"';

/** The environment variable naming the SSH key that signs the commits the tick makes. */
export const SIGNING_KEY = "MAESTRO_TM_SIGNING_KEY";

/**
 * The jj config that makes `account` author and committer of what jj writes, and signs it with the SSH key at
 * `signingKey` when there is one. It rides each command's `--config`, so no jj config file changes.
 */
function identity(account: Account, signingKey?: string) {
	const settings = [
		`user.name=${JSON.stringify(account.name)}`,
		`user.email=${JSON.stringify(account.email)}`,
		...(signingKey
			? [
					'signing.behavior="own"',
					'signing.backend="ssh"',
					`signing.key=${JSON.stringify(signingKey)}`,
				]
			: []),
	];
	return settings.flatMap((setting) => ["--config", setting]);
}

/**
 * The commit `revision` names in the repository at `repo`.
 * @throws Error when it names none or more than one.
 */
async function commitOf(repo: string, revision: string) {
	const commits = (
		await run(repo, [
			"jj",
			"log",
			"-r",
			revision,
			"--no-graph",
			"-T",
			'commit_id ++ "\\n"',
		])
	)
		.split("\n")
		.filter(Boolean);
	const [commit] = commits;
	if (!commit || commits.length > 1)
		throw new Error(
			`${revision} names ${commits.length} commits, not one, to export ${COMPOSITIONS}/ at`,
		);
	return commit;
}

/** The directory of `repo`'s exports in cache `root`, apart from every other checkout's. */
const cacheOf = (repo: string, root: string) =>
	join(
		root,
		createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 16),
	);

/** The export of `commit`'s `.maestro/` tree at `root/<checkout>/<commit>`, made when it is not there yet. */
async function kept(repo: string, commit: string, root: string) {
	const base = cacheOf(repo, root);
	const dir = join(base, commit);
	if (existsSync(join(dir, COMPOSITIONS))) return dir;
	const made = await exportTree(repo, commit, base);
	try {
		renameSync(made, dir);
	} catch (error) {
		rmSync(made, { recursive: true, force: true });
		if (!existsSync(join(dir, COMPOSITIONS))) throw error;
	}
	return dir;
}

/** The files under `path`, as `root`-relative paths. */
function filesUnder(root: string, path: string): string[] {
	const dir = join(root, path);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const child = `${path}/${entry.name}`;
		return entry.isDirectory() ? filesUnder(root, child) : [child];
	});
}

/** The files on disk under `.maestro/` and each pack, a pack's `node_modules/` left out. */
function workspaceFiles(repo: string) {
	const packs = existsSync(join(repo, PACKS))
		? readdirSync(join(repo, PACKS), { withFileTypes: true })
		: [];
	return [
		...filesUnder(repo, COMPOSITIONS),
		...packs.flatMap((entry) =>
			entry.isDirectory()
				? readdirSync(join(repo, PACKS, entry.name), { withFileTypes: true })
						.filter((child) => child.name !== "node_modules")
						.flatMap((child) => {
							const path = `${PACKS}/${entry.name}/${child.name}`;
							return child.isDirectory() ? filesUnder(repo, path) : [path];
						})
				: [`${PACKS}/${entry.name}`],
		),
	];
}

/** The paths a `jj diff --summary` line names: both sides of a rename. */
function summaryPaths(line: string) {
	const path = line.slice(2);
	const braced = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
	if (braced)
		return [
			`${braced[1]}${braced[2]}${braced[4]}`,
			`${braced[1]}${braced[3]}${braced[4]}`,
		];
	const [from, to] = path.split(" => ");
	return to === undefined ? [path] : [from ?? path, to];
}

/** Whether `path` lies in a pack's `node_modules/`. */
const inPackModules = (path: string) =>
	new RegExp(`^${PACKS}/[^/]+/node_modules(/|$)`).test(path);

/**
 * The paths under `.maestro/` and `packs/` of the checkout at `repo` that differ from `commit`: tracked changes, and
 * the files on disk jj ignores, a pack's `node_modules/` left out.
 */
async function differing(repo: string, commit: string) {
	const filesets = [
		`root:${JSON.stringify(COMPOSITIONS)}`,
		`root:${JSON.stringify(PACKS)}`,
	];
	const [diff, listed] = await Promise.all([
		run(repo, [
			"jj",
			"diff",
			"--summary",
			"--from",
			commit,
			"--to",
			"@",
			...filesets,
		]),
		run(repo, ["jj", "file", "list", "-r", "@", ...filesets]),
	]);
	const tracked = new Set(listed.split("\n").filter(Boolean));
	const paths = [
		...diff.split("\n").filter(Boolean).flatMap(summaryPaths),
		...workspaceFiles(repo).filter((path) => !tracked.has(path)),
	].filter((path) => !inPackModules(path));
	return [...new Set(paths)].sort();
}

/** The commit the export at `dir` holds, from its place in cache `root` as `repo`'s or in the earlier layout. */
function commitIn(repo: string, dir: string, root: string) {
	const parts = relative(resolve(root), dir).split(sep);
	if (parts.includes("..")) return undefined;
	if (parts.length === 1) return parts[0];
	const mine = basename(cacheOf(repo, root));
	return parts.length === 2 && parts[0] === mine ? parts[1] : undefined;
}

/**
 * Landing workspaces of the jj repository at `repo`, whose commits `account` authors and, given `signingKey`, signs.
 * @throws Error naming `MAESTRO_TM_SIGNING_KEY` and the path when `signingKey` is a file that does not exist.
 */
export function landing(
	repo: string,
	account: Account,
	signingKey?: string,
): Landing {
	if (signingKey && !existsSync(signingKey))
		throw new Error(
			`${SIGNING_KEY} names no file: ${signingKey}\nPoint it at the SSH key, or unset it to leave commits unsigned`,
		);
	const as = identity(account, signingKey);
	const forget = (name: string) =>
		run(repo, ["jj", "workspace", "forget", name]);
	/** Makes the account author of `revision` in the workspace at `dir`, and returns its commit id. */
	const claim = async (dir: string, revision: string) => {
		await run(dir, [
			"jj",
			...as,
			"metaedit",
			"--update-author",
			"-r",
			revision,
		]);
		return (
			await run(dir, [
				"jj",
				"log",
				"-r",
				revision,
				"--no-graph",
				"-T",
				"commit_id",
			])
		).trim();
	};
	return {
		fetch: async () => {
			await run(repo, ["jj", "git", "fetch", "--remote", "origin"]);
		},
		open: async (dir, name, base) => {
			await forget(name);
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dirname(dir), { recursive: true });
			await run(repo, [
				"jj",
				"workspace",
				"add",
				"--colocate",
				"--name",
				name,
				"-r",
				base,
				dir,
			]);
		},
		describe: async (dir, message) => {
			await run(dir, ["jj", ...as, "describe", "-m", message]);
			return claim(dir, "@");
		},
		squash: async (dir, message) => {
			await run(dir, [
				"jj",
				"--config",
				REWRITABLE,
				...as,
				"squash",
				"-m",
				message,
			]);
			return claim(dir, "@-");
		},
		close: async (dir, name) => {
			await forget(name);
			rmSync(dir, { recursive: true, force: true });
		},
		export: async (revision, root) => {
			const commit = await commitOf(repo, revision);
			const dir = await kept(repo, commit, root);
			const paths = await differing(repo, commit);
			return { commit, dir, differs: paths.length > 0, paths };
		},
		reopen: async (moduleDir, root) => {
			const dir = dirname(resolve(moduleDir));
			const commit = commitIn(repo, dir, root);
			if (!commit)
				throw new Error(
					`${moduleDir} is not an export of this checkout in ${root}`,
				);
			let linked: string;
			try {
				linked = readlinkSync(join(dir, "node_modules"));
			} catch {
				throw new Error(`${dir} links no node_modules`);
			}
			if (resolve(dirname(linked)) !== resolve(repo))
				throw new Error(
					`${dir} links ${linked}, the node_modules of another checkout than ${resolve(repo)}`,
				);
			const paths = await differing(repo, commit);
			return { commit, dir, differs: paths.length > 0, paths };
		},
	};
}
