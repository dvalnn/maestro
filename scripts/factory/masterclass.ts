// The masterclass: once enough factory runs settled, it reads their lessons and files what it proposes
// (factory.md, Rules, Masterclass).
import { join } from "node:path";
import type { Concert, Report, Result } from "./maestro";
import { snapshot } from "./pick";
import {
	type Masterclass,
	parseMasterclass,
	proposalIssue,
	proposalLine,
} from "./route";
import {
	CLOSED,
	type Entry,
	isSlice,
	isTriage,
	message,
	REPO,
	start,
	type Tick,
	TRIAGE_PRESET,
} from "./tick";

const MASTERCLASS_LABEL = "maestro-tm:masterclass";
const MASTERCLASS_FILE = join(REPO, ".maestro/masterclass.ts");
const MASTERCLASS = { pack: "masterclass", composition: "masterclass" };
/** How many settled factory runs newer than the last masterclass make the next one due. */
const MASTERCLASS_EVERY = 10;
/** How many of the newest factory runs a masterclass reads, or every run past the watermark when more. */
const MASTERCLASS_READS = 30;
/**
 * How many of a milestone's newest concerts the masterclass step reads: a masterclass comes last in pick order and may
 * starve while there is other work, so it reads further back than the tick's window.
 */
const MASTERCLASS_WINDOW = 200;

const masterclassTour = (milestone: string) => `${milestone}.masterclass`;
const isMasterclass = (c: Concert, milestone: string) =>
	c.pack === MASTERCLASS.pack &&
	c.composition === MASTERCLASS.composition &&
	c.tour === masterclassTour(milestone);
/** Whether `c` is a settled slice or triage of an issue's tour in `milestone`. */
function isFactoryRun(c: Concert, milestone: string) {
	const prefix = `${milestone}.i`;
	if (!(isSlice(c) || isTriage(c)) || c.status === "running") return false;
	return (
		!!c.tour?.startsWith(prefix) && /^\d+$/.test(c.tour.slice(prefix.length))
	);
}

/** The settled masterclass, or what went wrong with it. */
function masterclassOf(result: Result): Masterclass | string {
	if (result.status !== "ok")
		return `settled ${result.status}: ${result.reason ?? "no reason given"}`;
	try {
		return parseMasterclass(result.outputs.masterclass);
	} catch (error) {
		return `gave a malformed output: ${message(error)}`;
	}
}

/**
 * Files each proposal of masterclass `id` as a `needs-approval` enhancement labelled `maestro-tm:masterclass`, unless
 * an open issue or one of the newest closed ones carries its fingerprint.
 */
async function fileProposals(tick: Tick, id: string, masterclass: Masterclass) {
	const [open, closed] = await Promise.all([
		tick.forge.open({}),
		tick.forge.closed(CLOSED),
	]);
	const bodies = [...open, ...closed].map((i) => i.body);
	for (const proposal of masterclass.proposals) {
		const line = proposalLine(proposal);
		if (bodies.some((b) => b.includes(line))) continue;
		const filed = proposalIssue(proposal);
		const number = await tick.forge.file({
			...filed,
			milestone: tick.milestoneId,
			labels: ["state/needs-approval", "kind/enhancement", MASTERCLASS_LABEL],
		});
		bodies.push(filed.body);
		tick.say(`filed #${number}, proposed by masterclass ${id}`);
	}
}

/** Routes the newest concert when it is a masterclass; one that settled wrong is said, not halted on. */
export async function routeMasterclass(tick: Tick) {
	const newest = tick.concerts[0];
	if (!newest || !isMasterclass(newest, tick.milestone)) return;
	const masterclass = masterclassOf(await tick.maestro.result(newest.id));
	if (typeof masterclass === "string")
		return tick.say(`masterclass ${newest.id} ${masterclass}`);
	await fileProposals(tick, newest.id, masterclass);
}

/** The index of the watermark in `concerts`, newest first: the newest ok masterclass; -1 without one. */
const markOf = (concerts: readonly Concert[], milestone: string) =>
	concerts.findIndex((c) => isMasterclass(c, milestone) && c.status === "ok");

/** The tours of hand-run slices whose lessons a masterclass reads beside the factory runs'. */
const HAND_TOURS = ["release", "trial"];

/**
 * The settled slices of `tours` that started after the watermark of `concerts`, or all of them without one, newest
 * first. They are read but never counted toward `MASTERCLASS_EVERY`.
 */
function handRuns(
	tours: readonly (readonly Concert[])[],
	concerts: readonly Concert[],
	milestone: string,
): Concert[] {
	const mark = concerts[markOf(concerts, milestone)];
	return tours
		.flat()
		.filter(
			(c) =>
				isSlice(c) &&
				c.status !== "running" &&
				(!mark || (c.startedAt ?? 0) > (mark.startedAt ?? 0)),
		)
		.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * The factory runs among `concerts`, newest first, that no masterclass has read: those newer than the newest ok
 * masterclass, the watermark, or all of them without one (factory.md, Rules, Masterclass). The watermark is read from
 * the record, not kept by the tick: pruning any other concert leaves it intact, and pruning it makes the older
 * masterclass, or none, the watermark, so its lessons are read again. Undefined when no masterclass is due: the newest
 * concert is a masterclass, or fewer than `MASTERCLASS_EVERY` runs are past the watermark.
 */
function sinceWatermark(
	concerts: readonly Concert[],
	milestone: string,
): Concert[] | undefined {
	const [newest] = concerts;
	if (!newest || isMasterclass(newest, milestone)) return undefined;
	const mark = markOf(concerts, milestone);
	const runs = (mark < 0 ? concerts : concerts.slice(0, mark)).filter((c) =>
		isFactoryRun(c, milestone),
	);
	return runs.length >= MASTERCLASS_EVERY ? runs : undefined;
}

/**
 * What `--lessons` takes: each of `reports`' concerts with lessons, under its id and tour, and ` · read` after the tour
 * when an earlier masterclass read it (its id is in `read`).
 */
function lessonsText(
	reports: readonly { concert: Concert; report: Report }[],
	read: ReadonlySet<string>,
) {
	return [
		"# Lessons of the newest factory runs",
		"",
		...reports
			.filter(({ report }) => report.lessons.some((l) => l.trim()))
			.flatMap(({ concert, report }) => [
				`## ${concert.id} · ${concert.tour}${read.has(concert.id) ? " · read" : ""}`,
				"",
				...[...new Set(report.lessons.map((l) => l.trim()))].map(
					(l) => `- ${l.replaceAll("\n", "\n  ")}`,
				),
				"",
			]),
	].join("\n");
}

/** Performs the masterclass on the `lessons` and `backlog` files; halts on a refusal. */
async function startMasterclass(
	tick: Tick,
	lessons: string,
	backlog: string,
	runs: number,
) {
	const id = await start(
		tick,
		"masterclass",
		[
			"perform",
			MASTERCLASS_FILE,
			"--lessons",
			lessons,
			"--backlog",
			backlog,
			"--tour",
			masterclassTour(tick.milestone),
			"--title",
			"factory: masterclass",
			"--preset",
			TRIAGE_PRESET,
			...tick.presets.flatMap((p) => ["--preset", p]),
			"-c",
			`target.base=${tick.main}`,
		],
		join(tick.dir, "masterclass.log"),
	);
	if (id === undefined) return;
	tick.say(
		`holding a masterclass on the lessons of ${runs} concerts: concert ${id}`,
	);
}

/**
 * Starts a masterclass once `MASTERCLASS_EVERY` factory runs settled since the last one, on the lessons of the newest
 * `MASTERCLASS_READS` runs, or every run since the last when more, marking those an earlier masterclass read, with the
 * backlog snapshot; true when it started none.
 */
export async function masterclass(tick: Tick, entries: Entry[]) {
	const listed = await tick.maestro.concerts(
		tick.milestone,
		MASTERCLASS_WINDOW,
	);
	const counted = sinceWatermark(listed, tick.milestone);
	if (!counted) return true;
	const hand = handRuns(
		await Promise.all(
			HAND_TOURS.map((t) => tick.maestro.concerts(t, MASTERCLASS_WINDOW)),
		),
		listed,
		tick.milestone,
	);
	const fresh = new Set(counted.map((c) => c.id));
	const window = listed
		.filter((c) => isFactoryRun(c, tick.milestone))
		.slice(0, Math.max(MASTERCLASS_READS, counted.length));
	const read = new Set(window.filter((c) => !fresh.has(c.id)).map((c) => c.id));
	const runs = hand.length
		? [...window, ...hand].sort(
				(a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
			)
		: window;
	const reports = [];
	for (const concert of runs.toReversed())
		reports.push({ concert, report: await tick.maestro.report(concert.id) });
	const lessons = join(tick.dir, "masterclass-lessons.md");
	await Bun.write(lessons, lessonsText(reports, read));
	const [closed, pulls] = await Promise.all([
		tick.forge.closed(CLOSED),
		tick.forge.pulls(),
	]);
	const backlog = join(tick.dir, "backlog-masterclass.md");
	await Bun.write(
		backlog,
		snapshot(
			tick.milestone,
			undefined,
			entries.map((e) => e.issue),
			closed,
			pulls,
		),
	);
	await startMasterclass(tick, lessons, backlog, runs.length);
	return false;
}
