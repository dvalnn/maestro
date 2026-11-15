// The masterclass: once enough factory runs settled, it reads their lessons and reports and files what it proposes
// (factory.md, Rules, Masterclass).
import { join } from "node:path";
import { isMasterclass, isSlice, isTriage, startMasterclass } from "./concerts";
import type { Concert, Report, Result, Sighting } from "./maestro";
import { snapshot } from "./pick";
import {
	type Masterclass,
	parseMasterclass,
	proposalIssue,
	proposalLine,
} from "./route";
import { CLOSED, type Entry, message, type Tick } from "./tick";

const MASTERCLASS_LABEL = "maestro-tm:masterclass";
/** How many settled factory runs newer than the last masterclass make the next one due. */
const MASTERCLASS_EVERY = 10;
/** How many settled factory runs newer than the last masterclass make the next one overdue: it starts ahead of triage. */
const MASTERCLASS_OVERDUE = 2 * MASTERCLASS_EVERY;
/** How many of the newest factory runs a masterclass reads, or every run past the watermark when more. */
const MASTERCLASS_READS = 30;
/**
 * How many of a milestone's newest concerts the masterclass step reads: a masterclass comes last in pick order and may
 * starve while there is other work, so it reads further back than the tick's window.
 */
const MASTERCLASS_WINDOW = 200;

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
 * Files each proposal of masterclass `id` as a `needs-approval` issue of its kind labelled `maestro-tm:masterclass`,
 * unless an open issue or one of the newest closed ones carries its fingerprint.
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
			labels: [
				"state/needs-approval",
				`kind/${proposal.kind}`,
				MASTERCLASS_LABEL,
			],
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
 * masterclass, or none, the watermark, so its lessons are read again.
 */
function unreadRuns(concerts: readonly Concert[], milestone: string) {
	const mark = markOf(concerts, milestone);
	return (mark < 0 ? concerts : concerts.slice(0, mark)).filter((c) =>
		isFactoryRun(c, milestone),
	);
}

/**
 * The unread factory runs among `concerts`, or undefined when no masterclass is due: the newest concert is a
 * masterclass, or fewer than `due` runs are unread.
 */
function sinceWatermark(
	concerts: readonly Concert[],
	milestone: string,
	due: number,
): Concert[] | undefined {
	const [newest] = concerts;
	if (!newest || isMasterclass(newest, milestone)) return undefined;
	const runs = unreadRuns(concerts, milestone);
	return runs.length >= due ? runs : undefined;
}

/** The milestone's newest `MASTERCLASS_WINDOW` concerts, newest first. */
const listMilestone = (tick: Tick) =>
	tick.maestro.concerts(tick.milestone, MASTERCLASS_WINDOW);

/** The hand runs of `HAND_TOURS` past the watermark of `listed`, the milestone's listing. */
const listHandRuns = async (tick: Tick, listed: readonly Concert[]) =>
	handRuns(
		await Promise.all(
			HAND_TOURS.map((t) => tick.maestro.concerts(t, MASTERCLASS_WINDOW)),
		),
		listed,
		tick.milestone,
	);

/** A concert's heading in `--lessons` and `--reports`: its id and tour, and ` · read` when its id is in `read`. */
const heading = (concert: Concert, read: ReadonlySet<string>) =>
	`## ${concert.id} · ${concert.tour}${read.has(concert.id) ? " · read" : ""}`;

const bullet = (text: string) => `- ${text.replaceAll("\n", "\n  ")}`;

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
				heading(concert, read),
				"",
				...[...new Set(report.lessons.map((l) => l.trim()))].map(bullet),
				"",
			]),
	].join("\n");
}

/** One report list item as a line: a sighting reads `path · cites · text`, as the host writes its note. */
const reportLine = (r: string | Sighting) =>
	(typeof r === "string" ? r : `${r.path} · ${r.cites} · ${r.text}`).trim();

/**
 * What `--reports` takes: each of `reports`' concerts with obstacles or sightings, under the heading `--lessons` gives
 * it, one bullet per distinct report.
 */
function reportsText(
	reports: readonly { concert: Concert; report: Report }[],
	read: ReadonlySet<string>,
) {
	return [
		"# Obstacles and sightings of the newest factory runs",
		"",
		...reports.flatMap(({ concert, report }) => {
			const lines = [
				...new Set(
					[...report.obstacles, ...report.sightings]
						.map(reportLine)
						.filter(Boolean),
				),
			];
			return lines.length
				? [heading(concert, read), "", ...lines.map(bullet), ""]
				: [];
		}),
	].join("\n");
}

/**
 * Writes to `file` each distinct sighting of the runs the next masterclass reads as unread: the factory runs past the
 * watermark and the hand runs that started after it, one bullet each as `path · cites · text`, or a line saying there
 * are none. It moves no watermark, so those runs stay unread.
 */
export async function writeUnreadSightings(tick: Tick, file: string) {
	const listed = await listMilestone(tick);
	const runs = [
		...unreadRuns(listed, tick.milestone),
		...(await listHandRuns(tick, listed)),
	];
	const lines = new Set<string>();
	for (const run of runs)
		for (const sighting of (await tick.maestro.report(run.id)).sightings) {
			const line = reportLine(sighting);
			if (line) lines.add(line);
		}
	await Bun.write(
		file,
		[
			"# Sightings of the factory runs no masterclass has read",
			"",
			...(lines.size
				? [...lines].map(bullet)
				: ["No unread factory run reported a sighting."]),
			"",
		].join("\n"),
	);
}

/**
 * Starts a masterclass once `due` factory runs settled since the last one, on the lessons and reports of the newest
 * `MASTERCLASS_READS` runs, or every run since the last when more, marking those an earlier masterclass read, with the
 * backlog snapshot; true when it started none.
 */
async function hold(tick: Tick, entries: Entry[], due: number) {
	const listed = await listMilestone(tick);
	const counted = sinceWatermark(listed, tick.milestone, due);
	if (!counted) return true;
	const hand = await listHandRuns(tick, listed);
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
	const reported = join(tick.dir, "masterclass-reports.md");
	await Bun.write(reported, reportsText(reports, read));
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
	const id = await startMasterclass(tick, {
		lessons,
		reports: reported,
		backlog,
	});
	if (id !== undefined)
		tick.say(
			`holding a masterclass on the lessons of ${runs.length} concerts: concert ${id}`,
		);
	return false;
}

/** Starts a masterclass once `MASTERCLASS_EVERY` factory runs settled since the last one; true when it started none. */
export const masterclass = (tick: Tick, entries: Entry[]) =>
	hold(tick, entries, MASTERCLASS_EVERY);

/**
 * Starts a masterclass once `MASTERCLASS_OVERDUE` factory runs settled since the last one, so that triage cannot starve
 * it; true when it started none.
 */
export const overdueMasterclass = (tick: Tick, entries: Entry[]) =>
	hold(tick, entries, MASTERCLASS_OVERDUE);
