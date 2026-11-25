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
import { type Forge, forge } from "../scripts/factory/forge";
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

/**
 * The stdout of `git args` in `cwd`.
 * @throws Error with git's stderr when it fails.
 */
async function git(cwd: string, signal: AbortSignal, ...args: string[]) {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		signal,
		env: GIT_ENV,
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
	const send = (url: string, init: RequestInit) =>
		fetch(url, { ...init, signal: ctx.signal });
	return milestoneReady(forge(process.env, send, targetOf(ctx)), `v${version}`);
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
	const target = targetOf(ctx);
	const tree = join(scratch, "tree");
	const base = tipOf(ctx.path(changes));
	await git(
		scratch,
		signal,
		"clone",
		"-q",
		"--shared",
		"--no-checkout",
		target,
		tree,
	);
	await git(tree, signal, "checkout", "-q", "--detach", base);
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

/** The result node: the candidate's notes, bump changeset, review and `dist/`, once each settled ok. */
export function candidateOf(parts: {
	notes: ArtifactRef;
	changeset: ArtifactRef;
	review: ArtifactRef;
	dist: ArtifactRef;
}) {
	return parts;
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
			"Build a release candidate on main@origin: for a stable, first gate on its milestone having no open issue.",
			"A panel reviews the commits since the previous tag, a writer drafts the release notes and a check holds them to the",
			"release structure, a code node bumps every version file, and `just release` builds and smoke-tests the bumped tree.",
			"Leaves the notes, the bump changeset, the review and `dist/`. Fails while the review upholds a finding.",
			"It reads origin/main as the target last fetched it, so fetch first.",
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
		},
		examples: [{ version: "0.4.1", prev: "v0.4.0" }],
	},
	({ version, prev, prerelease }) => {
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
		const { review } = reviewed.out;
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
		return code(candidateOf, {
			in: {
				notes: notes.out.notes,
				changeset: bumped.out.changeset,
				review,
				dist: built.out.output,
			},
			out: {
				notes: Markdown(),
				changeset: Dir(),
				review: Markdown(),
				dist: Dir(),
			},
			label: "result",
		});
	},
);
