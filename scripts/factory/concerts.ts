// Starting the tick's concerts and recognising them: each kind is named once here, with the argv its start builds
// (factory.md, Rules, Policy: Tick base, Tour and title).
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Issue } from "../../.maestro/forge";
import type { Risk } from "../../.maestro/triage/risk";
import type { Concert, Maestro } from "./maestro";
import { riskOf } from "./pick";
import { halt, message, type Tick } from "./tick";

/** A concert kind: its composition file in `.maestro/`, and the pack and composition its concerts record. */
type Kind = { file: string; pack: string; composition: string };
// A bare composition file's pack is its stem.
const TRIAGE: Kind = {
	file: "triage.ts",
	pack: "triage",
	composition: "triage",
};
const SLICE: Kind = { file: "slice.ts", pack: "slice", composition: "slice" };
const STACK_REVIEW: Kind = {
	file: "review.ts",
	pack: "review",
	composition: "review",
};
const MASTERCLASS: Kind = {
	file: "masterclass.ts",
	pack: "masterclass",
	composition: "masterclass",
};
/** The preset a triage and a masterclass perform with, ahead of the tick's own. */
const TRIAGE_PRESET = "triage";
/** The preset a stack review rules at. */
const STACK_REVIEW_PRESET = "high";
/** The longest issue title a concert's title carries whole. */
const TITLE_CHARS = 60;

/** The kinds the factory starts. */
const FACTORY_KINDS = [SLICE, TRIAGE, STACK_REVIEW, MASTERCLASS];

const is = (kind: Kind) => (c: Concert) =>
	c.pack === kind.pack && c.composition === kind.composition;
export const isTriage = is(TRIAGE);
export const isSlice = is(SLICE);
export const isStackReview = is(STACK_REVIEW);

/** Whether `c` runs in the code slot: a slice, an encore of one, or a stack review. */
const fillsCode = (c: Concert) => isSlice(c) || isStackReview(c);

/** Which slots hold a running concert: `code` for a slice, an encore or a stack review; `second` for a triage, an encore of one or a masterclass. */
export type Slots = { code: boolean; second: boolean };

/** The slots the running concerts of `concerts` fill: one for code, one for a triage or a masterclass. */
export function busySlots(concerts: readonly Concert[]): Slots {
	const running = concerts.filter((c) => c.status === "running");
	return {
		code: running.some(fillsCode),
		second: running.some((c) => !fillsCode(c)),
	};
}

/**
 * The newest concerts of `milestone`, newest first, listed kind by kind so that a kind's running concert and newest
 * settle are never crowded out by another kind's.
 */
export async function listConcerts(
	maestro: Maestro,
	milestone: string,
): Promise<Concert[]> {
	const lists = await Promise.all(
		FACTORY_KINDS.map((k) => maestro.concerts(milestone, undefined, k)),
	);
	// Equal start times order by descending id, as maestro's own list does.
	return lists
		.flat()
		.sort(
			(a, b) =>
				(b.startedAt ?? 0) - (a.startedAt ?? 0) || (a.id < b.id ? 1 : -1),
		);
}

/** The tour of `issue`'s concerts in `milestone` (factory.md, Rules, Policy: Tour and title). */
export const tourOf = (milestone: string, issue: number) =>
	`${milestone}.i${issue}`;

/** The title of `issue`'s concerts: `factory: ` and the issue's title, cut with an ellipsis past `TITLE_CHARS`. */
export const titleOf = ({ title }: Issue) =>
	`factory: ${title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title}`;

/** The tour of `milestone`'s masterclasses. */
export const masterclassTour = (milestone: string) =>
	`${milestone}.masterclass`;
/** Whether `c` is a masterclass of `milestone`. */
export const isMasterclass = (c: Concert, milestone: string) =>
	is(MASTERCLASS)(c) && c.tour === masterclassTour(milestone);

/** The tour and title of `issue`'s concerts. */
const named = (tick: Tick, issue: Issue) => ({
	tour: tourOf(tick.milestone, issue.number),
	title: titleOf(issue),
});

type Run = {
	kind: Kind;
	/** What halts the tick when it does not start, such as "masterclass". */
	what: string;
	/** The commit the concert's lane is cut from, which `-c target.base` pins. */
	cut: string;
	/** The concert to continue, else a fresh one performs `kind`'s composition in a tree of the tick's `main`. */
	encore?: string;
	/** The kind's own flags. */
	params: string[];
	/** The kind's presets, ahead of the tick's. */
	presets: string[];
	tour: string;
	title: string;
	/** Where what maestro printed goes. */
	log?: string;
};

/** A full commit id. */
const COMMIT = /^[0-9a-f]{40}$/;

/** What halts the tick when `run` does not start, as `halt` takes it. */
const refused = (run: Run, error: unknown) =>
	[
		`${run.what} did not start`,
		`${run.what[0]?.toUpperCase()}${run.what.slice(1)} did not start:`,
		message(error),
	] as const;

/**
 * The commit encore `id` ran at, from the tree it recorded.
 * @throws Error when the record names no tree, its tree is at no commit, or the repository does not have the commit.
 */
async function encoreCommit(tick: Tick, id: string) {
	const commit = basename(dirname(await tick.maestro.tree(id)));
	if (!COMMIT.test(commit))
		throw new Error(
			`${id}'s tree is not at a commit: ${commit}\nStart a fresh concert for it instead`,
		);
	try {
		return await tick.landing.commit(commit);
	} catch {
		throw new Error(
			`${id}'s tree is at commit ${commit}, which the repository does not have\nStart a fresh concert for it instead`,
		);
	}
}

/** The real path of `path`, or of its nearest existing ancestor with the rest of its spelling after. */
function located(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const up = dirname(resolve(path));
		return up === resolve(path)
			? up
			: join(located(up), basename(resolve(path)));
	}
}

/** The name of the tree under `root` that holds `dir`, whatever its depth or spelling; undefined outside `root`. */
function treeNameUnder(root: string, dir: string) {
	const [name, ...rest] = relative(located(root), located(dir)).split(sep);
	return name && name !== ".." && rest.length > 0 ? name : undefined;
}

/**
 * The commits whose trees a running factory concert of any milestone performs in, which no tree being made may remove;
 * "all" when a concert's tree cannot be read, each such concert logged, so no tree is removed on a guess. A tree
 * outside `root` saves none under it.
 * @throws Error when the running concerts cannot be listed.
 */
async function busyTrees(tick: Tick, root: string) {
	const running = (await tick.maestro.running()).filter((c) =>
		FACTORY_KINDS.some((k) => is(k)(c)),
	);
	const reads = await Promise.allSettled(
		running.map((c) => tick.maestro.tree(c.id)),
	);
	let unreadable = false;
	const keep: string[] = [];
	reads.forEach((read, i) => {
		if (read.status === "fulfilled") {
			const name = treeNameUnder(root, read.value);
			if (name) keep.push(name);
			return;
		}
		unreadable = true;
		const reason = message(read.reason).replace(/\s+/g, " ").trim();
		tick.say(
			`kept every tree: cannot read ${running[i]?.id}'s tree: ${reason}`,
		);
	});
	return unreadable ? "all" : keep;
}

/**
 * The tree `run`'s concert performs in, at the tick's `main` whatever its cut, so only approved code runs, or, for an
 * encore, at the commit its first concert's tree holds; undefined once an encore halted on a commit that is not one the
 * repository has.
 * @throws Error when the tree cannot be made, so the tick ends without a halt and the next retries.
 */
async function treeOf(tick: Tick, run: Run) {
	const root = join(tick.cache, "trees");
	const keep = await busyTrees(tick, root);
	if (!run.encore) return tick.landing.tree(tick.main, root, keep);
	let commit: string;
	try {
		commit = await encoreCommit(tick, run.encore);
	} catch (error) {
		await halt(tick, ...refused(run, error));
		return undefined;
	}
	return tick.landing.tree(commit, root, keep);
}

/** Starts `run`'s concert in its tree and returns its id; undefined once it halted on a refusal. */
async function startConcert(tick: Tick, run: Run) {
	const dir = await treeOf(tick, run);
	if (!dir) return undefined;
	const head = run.encore
		? ["encore", run.encore]
		: ["perform", join(dir, ".maestro", run.kind.file)];
	// An encore runs under its concert's recorded config, presets included, and takes no --preset (ADR 0019).
	const presets = run.encore ? [] : [...run.presets, ...tick.presets];
	const args = [
		...head,
		...run.params,
		...presets.flatMap((p) => ["--preset", p]),
		"--tour",
		run.tour,
		"--title",
		run.title,
		"-c",
		`target.base=${run.cut}`,
	];
	try {
		return await tick.maestro.start(args, run.log, dir);
	} catch (error) {
		await halt(tick, ...refused(run, error));
		return undefined;
	}
}

/**
 * Starts the triage of `issue` on `main` over its `text` and `backlog` file: a fresh one with the `sightings` file, or
 * an encore of `encore`, which rereads the sightings file its recorded params name, if any.
 */
export const startTriage = (
	tick: Tick,
	issue: Issue,
	input: { text: string; backlog: string; respec: boolean } & (
		| { sightings: string; encore?: undefined }
		| { encore: string }
	),
) =>
	startConcert(tick, {
		kind: TRIAGE,
		what: `triage of #${issue.number}`,
		cut: tick.main,
		encore: input.encore,
		params: [
			"--issue",
			input.text,
			"--backlog",
			input.backlog,
			...(input.encore === undefined ? ["--sightings", input.sightings] : []),
			input.respec ? "--respec" : "--no-respec",
		],
		presets: [TRIAGE_PRESET],
		...named(tick, issue),
	});

/**
 * Starts the build of `issue` for `request`, continuing `encore` when given, under its risk's preset (`risk` is the
 * triaged one) and its area's when the repo has one. A revision cuts at, and revises, `revisionBase`, else the slice
 * cuts at `main`. Returns its id.
 */
export function startSlice(
	tick: Tick,
	issue: Issue,
	input: {
		request: string;
		risk: Risk;
		/** What the spec's proof claims, as `claims` takes them; empty for none. */
		claims?: string;
		encore?: string;
		revisionBase?: string;
	},
) {
	const { revisionBase } = input;
	const area = issue.labels
		.find((l) => l.startsWith("area/"))
		?.slice("area/".length);
	return startConcert(tick, {
		kind: SLICE,
		what: `build of #${issue.number}`,
		cut: revisionBase ?? tick.main,
		encore: input.encore,
		params: [
			"--request",
			input.request,
			"--revises",
			revisionBase ? `${revisionBase}^!` : "",
			...(input.claims ? ["--claims", input.claims] : []),
			// Tests come first only on the first build: an encore's change already holds them.
			...(input.encore ? ["-c", "classics.build.testFirst=false"] : []),
		],
		presets: [
			riskOf(issue, input.risk),
			...(area && tick.has(`.maestro/presets/area-${area}.yaml`)
				? [`area-${area}`]
				: []),
		],
		...named(tick, issue),
	});
}

/**
 * Starts the stack review of epic `issue` for `request`, over the commits from `base` to `head`, with the composition
 * and the lane cut at `base`. Returns its id.
 */
export const startStackReview = (
	tick: Tick,
	issue: Issue,
	input: { request: string; base: string; head: string },
) =>
	startConcert(tick, {
		kind: STACK_REVIEW,
		what: `stack review of #${issue.number}`,
		cut: input.base,
		params: [
			"--request",
			input.request,
			"--revs",
			`${input.base}..${input.head}`,
		],
		presets: [STACK_REVIEW_PRESET],
		...named(tick, issue),
	});

/** Starts the masterclass on the `lessons`, `reports` and `backlog` files, on `main`. Returns its id. */
export const startMasterclass = (
	tick: Tick,
	files: { lessons: string; reports: string; backlog: string },
) =>
	startConcert(tick, {
		kind: MASTERCLASS,
		what: "masterclass",
		cut: tick.main,
		params: [
			"--lessons",
			files.lessons,
			"--reports",
			files.reports,
			"--backlog",
			files.backlog,
		],
		presets: [TRIAGE_PRESET],
		tour: masterclassTour(tick.milestone),
		title: "factory: masterclass",
		log: join(tick.dir, "masterclass.log"),
	});
