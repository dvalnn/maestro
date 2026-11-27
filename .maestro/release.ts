import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fill, panel } from "@maestro/classics";
import {
	apply,
	changeset,
	check,
	commits,
	fork,
	MarkdownOut,
	read,
	seat,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	approval,
	Bool,
	BuildError,
	type CodeContext,
	code,
	composition,
	Dir,
	Markdown,
	reject,
	Text,
	use,
} from "@maestro/sdk";
import { type Account, type Forge, forge, signingKeyOf } from "./forge";
import { bumpVersions } from "./release/bump";
import { checkNotes } from "./release/notes";
import NOTES from "./release/prompts/notes.md" with { type: "text" };
import REVIEW from "./release/prompts/review.md" with { type: "text" };
import { JUDGED, markdownOf } from "./shared";

// ADR 0008: a code node's function must be exported by its composition file.
export * from "@maestro/classics/code";
export { checkNotes };

/** `main@origin`, as git names it in the target's colocated repository. */
const MAIN = "origin/main";
/** A version maestro releases: `x.y.z`, or `x.y.z-rc.<n>` for a pre-release. */
const VERSION = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;
/**
 * The build, each `dist/` asset copied to the root of the check's output under its own name. `just release` ends in the
 * smoke test, so exit 0 is `smoke: passed`.
 */
const RELEASE = 'just release && cp -r dist/. "$MAESTRO_CHECK_OUTPUT/"';
/**
 * Git's whole environment for the bump, as the lanes' own: no system or user config and a fixed identity, so the
 * operator's settings cannot change the commit, and no forge token reaches git.
 */
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

/**
 * The target repository's path, as the repo host gives code nodes.
 * @throws Error when the host gives none.
 */
export function targetOf(ctx: CodeContext): string {
	const target = ctx.env.repo?.target;
	if (typeof target !== "string")
		throw new Error("the repo host gave no target\nSet target.repo");
	return target;
}

/** The stdout of `git args` in `cwd`. */
const git = (cwd: string, signal: AbortSignal, ...args: string[]) =>
	gitWith({}, cwd, signal, ...args);

/**
 * The stdout of `git args` in `cwd`, with `env` over git's own environment.
 * @throws Error with git's stderr when it fails.
 */
async function gitWith(
	env: Record<string, string>,
	cwd: string,
	signal: AbortSignal,
	...args: string[]
) {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		signal,
		env: { ...GIT_ENV, ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`git ${args[0]} exited ${code}: ${err}`);
	return out;
}

/** The target's forge, called as `MAESTRO_TM_TOKEN` and cancelled with the node. */
function forgeOf(ctx: CodeContext): Forge {
	const send = (url: string, init: RequestInit) =>
		fetch(url, { ...init, signal: ctx.signal });
	return forge(process.env, send, targetOf(ctx));
}

/** Nothing when the milestone titled `title` exists and has no open issue, else a rejection naming each open one. */
export async function milestoneReady(
	issues: Pick<Forge, "milestone" | "open">,
	title: string,
) {
	const id = await issues.milestone(title);
	if (id === undefined)
		return reject(
			`the forge has no milestone ${title}\nCreate it, or check --version`,
		);
	// The forge lists every open issue for a milestone name it does not know, so each is checked again.
	const open = (await issues.open({ milestone: title })).filter(
		(i) => i.milestone === id,
	);
	if (open.length)
		return reject(
			[
				`milestone ${title} has ${open.length} open ${open.length === 1 ? "issue" : "issues"}:`,
				...open.map((i) => `- #${i.number} ${i.title}`),
				"Close each, or move it to the next release's milestone",
			].join("\n"),
		);
	return {};
}

/** The code node that gates the stable release `version` on its milestone, `v<version>`, on the target's forge. */
export function requireMilestone(
	{ version }: { version: string },
	ctx: CodeContext,
) {
	return milestoneReady(forgeOf(ctx), `v${version}`);
}

/**
 * The commit the changeset `dir` of target commits ends at: the one its last patch was made from, as its `From <sha>`
 * line names it, or its `base` when it holds no patch.
 */
export function tipOf(dir: string): string {
	const last = readdirSync(dir)
		.filter((f) => /^\d{4}\.patch$/.test(f))
		.sort()
		.at(-1);
	const text = readFileSync(join(dir, last ?? "base"), "utf8");
	const tip = last ? /^From ([0-9a-f]{40}) /.exec(text)?.[1] : text.trim();
	if (!tip)
		throw new Error(`${last} of ${dir} names no commit it was made from`);
	return tip;
}

/** A clone of the target at commit `base`, checked out under the scratch directory, that writes nothing to the target. */
async function cloneAt(ctx: CodeContext, base: string) {
	const { scratch, signal } = ctx;
	const tree = join(scratch, "tree");
	await git(
		scratch,
		signal,
		"clone",
		"-q",
		"--shared",
		"--no-checkout",
		targetOf(ctx),
		tree,
	);
	await git(tree, signal, "checkout", "-q", "--detach", base);
	return tree;
}

/**
 * The code node that bumps every version file to `version` on top of the commit the changeset `changes` ends at, the
 * commits the panel reviewed: a changeset of the one commit `chore(release): bump to <version>`, cut in a clone that
 * shares the target's objects and writes nothing to it.
 */
export async function bump(
	{ version, changes }: { version: string; changes: ArtifactRef },
	ctx: CodeContext,
) {
	const { scratch, signal } = ctx;
	const base = tipOf(ctx.path(changes));
	const tree = await cloneAt(ctx, base);
	const bumped = bumpVersions(tree, version);
	if ("problems" in bumped)
		return reject(
			`the version files are not all at one version:\n- ${bumped.problems.join("\n- ")}\nBring each to the version packages/cli/package.json holds`,
		);
	await git(
		tree,
		signal,
		"commit",
		"-q",
		"-a",
		"-m",
		`chore(release): bump to ${version}`,
	);
	const patch = await git(
		tree,
		signal,
		"format-patch",
		"--stdout",
		"--no-signature",
		"-1",
		"HEAD",
	);
	const dir = join(scratch, "changeset");
	mkdirSync(dir);
	writeFileSync(join(dir, "base"), `${base}\n`);
	writeFileSync(join(dir, "0001.patch"), patch);
	return { changeset: dir };
}

/**
 * The review node: the panel's `review`, whatever it upholds, for the operator to rule on at the approval. It rejects
 * when no lens `delivered`, since that review shows no finding without having looked.
 */
export function reviewedOf({
	review,
	delivered,
}: {
	review: ArtifactRef;
	delivered: number;
}) {
	if (delivered === 0)
		return reject(
			"no lens of the review delivered, so it has nothing to show the approval\nResume the concert to review again",
		);
	return { review };
}

/** What a publish node does in a dry run instead of its effect: logs it, and leaves main and the forge as they are. */
function logDry(ctx: CodeContext, effect: string) {
	ctx.log(`dry run: would ${effect}`);
	return {};
}

/**
 * The code node that applies the bump `changeset` in a clone under its scratch directory and pushes it to `main` as a
 * fast-forward, unless the forge's `main` already holds it (ADR 0022). The token's account commits it, signed with the
 * SSH key `MAESTRO_TM_SIGNING_KEY` names. Its output is the bump's commit.
 */
export async function pushBump(
	{ changeset, dry }: { changeset: ArtifactRef; dry: boolean },
	ctx: CodeContext,
) {
	const dir = ctx.path(changeset);
	const base = readFileSync(join(dir, "base"), "utf8").trim();
	const tree = await cloneAt(ctx, base);
	const forge = dry ? undefined : forgeOf(ctx);
	// The forge's main takes signed commits only, so the token's account commits the bump and its key signs it.
	const { env, options } = forge
		? committerOf(await forge.account(), signingKeyOf(process.env))
		: { env: {}, options: [] };
	// The patch's own date commits it, so every run makes the same commit and a resume finds it on main.
	await gitWith(
		env,
		tree,
		ctx.signal,
		...options,
		"am",
		"-q",
		"--committer-date-is-author-date",
		join(dir, "0001.patch"),
	);
	const commit = (await git(tree, ctx.signal, "rev-parse", "HEAD")).trim();
	if (!forge) return { ...logDry(ctx, `push ${commit} to main`), commit };
	const main = await forge.head("main");
	// A main the target has not fetched is unknown here and reads as not holding the bump: the push then fails as a
	// non-fast-forward, and a resume after a fetch finds it.
	const held = await git(
		tree,
		ctx.signal,
		"merge-base",
		"--is-ancestor",
		commit,
		main,
	).then(
		() => true,
		() => false,
	);
	if (!held) await forge.push(tree, commit, "main", false, ctx.signal);
	return { commit };
}

/**
 * The environment and leading git options that commit as `account`, signed with the SSH key at `key` when there is
 * one, as the tour manager signs its commits.
 */
function committerOf(account: Account, key: string | undefined) {
	const env = {
		GIT_COMMITTER_NAME: account.name,
		GIT_COMMITTER_EMAIL: account.email,
	};
	const options = key
		? [
				"-c",
				"gpg.format=ssh",
				"-c",
				`user.signingKey=${key}`,
				"-c",
				"commit.gpgSign=true",
			]
		: [];
	return { env, options };
}

/** The names of the files in the directory `dir`, sorted. */
const filesIn = (dir: string) =>
	readdirSync(dir, { withFileTypes: true })
		.filter((f) => f.isFile())
		.map((f) => f.name)
		.sort();

/**
 * The code node that creates the forge release `v<version>`, its tag at `commit` and its body the `notes`, unless it
 * exists, and attaches each file of `dist` the release lacks.
 */
export async function publishRelease(
	inputs: {
		version: string;
		prerelease: boolean;
		commit: string;
		notes: ArtifactRef;
		dist: ArtifactRef;
		dry: boolean;
	},
	ctx: CodeContext,
) {
	const { version, prerelease, commit, dry } = inputs;
	const tag = `v${version}`;
	const dist = ctx.path(inputs.dist);
	const files = filesIn(dist);
	if (dry)
		return logDry(
			ctx,
			`create the ${prerelease ? "pre-release" : "release"} ${tag} at ${commit} with ${files.join(", ")}`,
		);
	const forge = forgeOf(ctx);
	const body = readFileSync(ctx.path(inputs.notes), "utf8");
	const release =
		(await forge.release(tag)) ??
		(await forge.createRelease({ tag, target: commit, body, prerelease }));
	const held = new Set(release.assets.map((a) => a.name));
	for (const file of files)
		if (!held.has(file)) await forge.upload(release.id, join(dist, file));
	return {};
}

/** The first line of a `SHA256SUMS` file: a hash, and the file name it is the hash of. */
const SUM = /^(?<hash>[0-9a-f]{64}) [ *](?<name>.+)$/m;

/**
 * The code node that checks the first asset `SHA256SUMS` in `dist` lists, as the forge release `v<version>` serves it,
 * against its hash. A dry run checks the file in `dist` instead.
 */
export async function verifyRelease(
	{ version, dist, dry }: { version: string; dist: ArtifactRef; dry: boolean },
	ctx: CodeContext,
) {
	const dir = ctx.path(dist);
	const { hash, name } =
		SUM.exec(readFileSync(join(dir, "SHA256SUMS"), "utf8"))?.groups ?? {};
	if (!hash || !name) return reject("dist/SHA256SUMS lists no asset");
	const bytes = dry
		? readFileSync(join(dir, name))
		: await served(forgeOf(ctx), `v${version}`, name);
	if (!bytes) return reject(`the release v${version} has no asset ${name}`);
	const got = createHash("sha256").update(bytes).digest("hex");
	if (got !== hash)
		return reject(
			`the release v${version} serves ${name} with sha256 ${got}, not ${hash} as SHA256SUMS holds\nReplace the asset, then resume`,
		);
	return {};
}

/** The bytes of asset `name` of the release tagged `tag`, or none when it lacks one. */
async function served(forge: Forge, tag: string, name: string) {
	const asset = (await forge.release(tag))?.assets.find((a) => a.name === name);
	return asset && forge.download(asset.url);
}

/** The code node that closes the milestone `v<version>`, unless it is closed. The gate left it no open issue. */
export async function closeMilestone(
	{ version, dry }: { version: string; dry: boolean },
	ctx: CodeContext,
) {
	const title = `v${version}`;
	if (dry) return logDry(ctx, `close the milestone ${title}`);
	const forge = forgeOf(ctx);
	const id = await forge.milestone(title);
	if (id === undefined)
		return reject(
			`the forge has no milestone ${title}\nCreate it, or check --version`,
		);
	await forge.closeMilestone(id);
	return {};
}

/**
 * @throws BuildError `CFG.param` when `version` is not one maestro releases, or `prerelease` disagrees with its
 * `-rc.<n>`.
 */
export function checkVersion(version: string, prerelease: boolean) {
	const parsed = VERSION.exec(version);
	if (!parsed)
		throw new BuildError({
			code: "CFG.param",
			message: `--version ${version} is not a version maestro releases`,
			hint: "Pass x.y.z, or x.y.z-rc.<n> with --prerelease, without the v",
		});
	if ((parsed[1] !== undefined) !== prerelease)
		throw new BuildError({
			code: "CFG.param",
			message: prerelease
				? `--prerelease needs an -rc.<n> version, not ${version}`
				: `--version ${version} is a pre-release`,
			hint: prerelease ? "Pass --version x.y.z-rc.<n>" : "Pass --prerelease",
		});
}

const notesWriter = seat("notes-writer", { profile: "release/notes-writer" });

export const release = composition(
	"release",
	{
		doc: [
			"Build a release candidate on main@origin, then publish it once an operator rules ok.",
			"For a stable, it first gates on its milestone having no open issue.",
			"A panel reviews the commits since the previous tag, a writer drafts the release notes and a check holds them to the",
			"release structure, a code node bumps every version file, and `just release` builds and smoke-tests the bumped tree.",
			"It reads origin/main as the target last fetched it, so fetch first. It fails when no lens delivers a review.",
			"The concert then holds at an approval on the notes, the review with any finding it upholds, the bump and dist/,",
			"so perform it with --detach: the operator rules on each finding.",
			"",
			"After an ok it writes outside the concert, as MAESTRO_TM_TOKEN.",
			"It pushes the bump to the forge's main from a clone in its scratch directory, never a force push. That account",
			"commits it, signed with the SSH key MAESTRO_TM_SIGNING_KEY names, as main takes signed commits only.",
			"It creates the forge release with every file of dist/ as an asset, and checks one asset against SHA256SUMS.",
			"For a stable, it closes the milestone. A resume leaves a pushed bump, a release, its assets and a closed milestone as",
			"they are. It does not reinstall maestro, as install.sh refuses while a concert runs: once the concert settles, run",
			"install.sh with MAESTRO_VERSION=v<version>, as INSTALL.md shows.",
			"--dry-run logs each publish step instead: no push or forge write. A stable still reads its milestone.",
		].join("\n"),
		params: {
			version: Text({
				description:
					"The version to cut, without its v: x.y.z, or x.y.z-rc.<n> for a pre-release",
			}),
			prev: Text({
				description:
					"The tag of the last release of the same kind: the last stable for a stable, the last tag for a pre-release",
			}),
			prerelease: Bool({
				default: false,
				description: "Cut an -rc.<n> pre-release, which no milestone gates",
			}),
			dryRun: Bool({
				default: false,
				description:
					"Log each publish step instead of taking it: no push or forge write. A stable still reads its milestone",
			}),
		},
		examples: [{ version: "0.4.1", prev: "v0.4.0" }],
	},
	({ version, prev, prerelease, dryRun: dry }) => {
		checkVersion(version, prerelease);
		const tag = `v${version}`;
		// A stable spends nothing until its milestone has no open issue.
		const ready = prerelease
			? undefined
			: code(requireMilestone, {
					in: { version },
					out: {},
					label: "milestone",
				}).ok;
		const head = commits(`${prev}..${MAIN}`, { label: "head", when: ready }).out
			.lane;
		const spec = markdownOf(fill(REVIEW, { prev, tag }), "request");
		const reviewed = use(
			panel,
			{ change: head, spec },
			{ params: { grounds: JUDGED } },
		);
		const { review, delivered } = reviewed.out;
		// Narrows the type: panel leaves a review unless config turns classics.panel.consolidate off.
		if (!review)
			throw new BuildError({
				code: "CFG.param",
				message: "classics.panel leaves no review the release can show",
				hint: "Leave classics.panel.consolidate true",
			});
		const patches = changeset(head, { label: "changes" }).out.changeset;
		const written = notesWriter({
			label: "notes",
			task: fill(NOTES, { prev, tag }),
			lane: read(head),
			attachments: {
				patches: {
					artifact: patches,
					hint: "to see what each commit changed",
				},
			},
			out: { notes: MarkdownOut("notes.md") },
		});
		const notes = code(checkNotes, {
			in: { notes: written.out.notes },
			out: { notes: Markdown() },
			label: "notes_check",
		});
		const bumped = code(bump, {
			in: { version, changes: patches },
			out: { changeset: Dir() },
			label: "bump",
		});
		const applied = apply(fork(head), bumped.out.changeset, {
			label: "bumped",
		});
		const built = check(
			read(applied.out.lane),
			{ run: RELEASE, timeout: "1h" },
			{ label: "release" },
		);
		const dist = built.out.output;
		// An upheld finding rejects the panel; the operator rules on it at the approval instead.
		const shown = code(reviewedOf, {
			in: { review, delivered },
			out: { review: Markdown() },
			label: "review",
			tolerate: "rejected",
		});
		const approved = approval(
			`Publish ${tag}: push its bump to main and create the forge release from these notes and dist${prerelease ? "" : ", then close its milestone"}?`,
			{
				in: {
					notes: notes.out.notes,
					review: shown.out.review,
					changeset: bumped.out.changeset,
					dist,
				},
				label: "publish",
			},
		);
		const pushed = code(pushBump, {
			in: { changeset: bumped.out.changeset, dry },
			out: { commit: Text() },
			label: "push",
			when: approved.ok,
		});
		const released = code(publishRelease, {
			in: {
				version,
				prerelease,
				commit: pushed.out.commit,
				notes: notes.out.notes,
				dist,
				dry,
			},
			out: {},
			label: "forge_release",
		});
		const verified = code(verifyRelease, {
			in: { version, dist, dry },
			out: {},
			label: "verify",
			when: released.ok,
		});
		// A pre-release has no milestone.
		return prerelease
			? verified
			: code(closeMilestone, {
					in: { version, dry },
					out: {},
					label: "close",
					when: verified.ok,
				});
	},
);
