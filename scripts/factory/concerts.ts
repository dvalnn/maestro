// Starting the tick's concerts and recognising them: each kind is named once here, with the argv its start builds
// (factory.md, Rules, Policy: Tick base, Tour and title).
import { join } from "node:path";
import type { Risk } from "../../.maestro/triage/risk";
import type { Issue } from "./forge";
import type { Concert } from "./maestro";
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

const is = (kind: Kind) => (c: Concert) =>
	c.pack === kind.pack && c.composition === kind.composition;
export const isTriage = is(TRIAGE);
export const isSlice = is(SLICE);
export const isStackReview = is(STACK_REVIEW);

/** The tour of `issue`'s concerts in `milestone` (factory.md, Rules, Policy: Tour and title). */
export const tourOf = (milestone: string, issue: number) =>
	`${milestone}.i${issue}`;

/** The title of `issue`'s concerts: `factory: ` and the issue's title, cut with an ellipsis past `TITLE_CHARS`. */
export const titleOf = ({ title }: Issue) =>
	`factory: ${title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title}`;

/** The tour of `milestone`'s masterclasses. */
const masterclassTour = (milestone: string) => `${milestone}.masterclass`;
/** Whether `c` is a masterclass of `milestone`. */
export const isMasterclass = (c: Concert, milestone: string) =>
	is(MASTERCLASS)(c) && c.tour === masterclassTour(milestone);

/** The tour and title of `issue`'s concerts. */
const named = (tick: Tick, issue: Issue) => ({
	tour: tourOf(tick.milestone, issue.number),
	title: titleOf(issue),
});

/**
 * The path of composition `file` of `.maestro/` as it stands at `cut`, or at `compositionsAt` when set, exported into
 * the cache once per commit; says so when the checkout's `.maestro/` differs from it.
 * @throws Error when the tree cannot be exported, so the tick ends without starting a concert.
 */
async function compositionAt(tick: Tick, file: string, cut: string) {
	const exported = await tick.landing.export(
		tick.compositionsAt ?? cut,
		join(tick.cache, "compositions"),
	);
	if (exported.differs)
		tick.say(
			`performing .maestro/ at ${exported.commit}, which differs from the checkout's; config, presets and profiles still come from the checkout's .maestro/config.yaml`,
		);
	return join(exported.dir, ".maestro", file);
}

type Run = {
	kind: Kind;
	/** What halts the tick when it does not start, such as "masterclass". */
	what: string;
	/** The commit the concert's lane is cut from, which `-c target.base` pins. */
	cut: string;
	/** The concert to continue, else a fresh one performs `kind`'s composition at `cut`. */
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

/** Starts `run`'s concert and returns its id; undefined once it halted on maestro's refusal. */
async function startConcert(tick: Tick, run: Run) {
	const head = run.encore
		? ["encore", run.encore]
		: ["perform", await compositionAt(tick, run.kind.file, run.cut)];
	const args = [
		...head,
		...run.params,
		...[...run.presets, ...tick.presets].flatMap((p) => ["--preset", p]),
		"--tour",
		run.tour,
		"--title",
		run.title,
		"-c",
		`target.base=${run.cut}`,
	];
	try {
		return await tick.maestro.start(args, run.log);
	} catch (error) {
		await halt(
			tick,
			`${run.what} did not start`,
			`${run.what[0]?.toUpperCase()}${run.what.slice(1)} did not start:`,
			message(error),
		);
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
