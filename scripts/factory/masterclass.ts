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
	type Pass,
	REPO,
	start,
	TRIAGE_PRESET,
} from "./tick";

const MASTERCLASS_LABEL = "maestro-tm:masterclass";
const MASTERCLASS_FILE = join(REPO, ".maestro/masterclass.ts");
const MASTERCLASS = { pack: "masterclass", composition: "masterclass" };
/** How many settled factory runs newer than the last masterclass make the next one due. */
const MASTERCLASS_EVERY = 10;
/**
 * How many of a milestone's newest concerts the masterclass step reads: a masterclass comes last in pick order and may
 * starve while there is other work, so it reads further back than the pass's window.
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
async function fileProposals(pass: Pass, id: string, masterclass: Masterclass) {
	const [open, closed] = await Promise.all([
		pass.forge.open({}),
		pass.forge.closed(CLOSED),
	]);
	const bodies = [...open, ...closed].map((i) => i.body);
	for (const proposal of masterclass.proposals) {
		const line = proposalLine(proposal);
		if (bodies.some((b) => b.includes(line))) continue;
		const filed = proposalIssue(proposal);
		const number = await pass.forge.file({
			...filed,
			milestone: pass.milestoneId,
			labels: ["state/needs-approval", "kind/enhancement", MASTERCLASS_LABEL],
		});
		bodies.push(filed.body);
		pass.say(`filed #${number}, proposed by masterclass ${id}`);
	}
}

/** Routes the newest concert when it is a masterclass; one that settled wrong is said, not halted on. */
export async function routeMasterclass(pass: Pass) {
	const newest = pass.concerts[0];
	if (!newest || !isMasterclass(newest, pass.milestone)) return;
	const masterclass = masterclassOf(await pass.maestro.result(newest.id));
	if (typeof masterclass === "string")
		return pass.say(`masterclass ${newest.id} ${masterclass}`);
	await fileProposals(pass, newest.id, masterclass);
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

/** What `--lessons` takes: each of `reports`' concerts with lessons, under its id and tour. */
function lessonsText(reports: readonly { concert: Concert; report: Report }[]) {
	return [
		"# Lessons since the last masterclass",
		"",
		...reports
			.filter(({ report }) => report.lessons.some((l) => l.trim()))
			.flatMap(({ concert, report }) => [
				`## ${concert.id} · ${concert.tour}`,
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
	pass: Pass,
	lessons: string,
	backlog: string,
	runs: number,
) {
	const id = await start(
		pass,
		"masterclass",
		[
			"perform",
			MASTERCLASS_FILE,
			"--lessons",
			lessons,
			"--backlog",
			backlog,
			"--tour",
			masterclassTour(pass.milestone),
			"--title",
			"factory: masterclass",
			"--preset",
			TRIAGE_PRESET,
			...pass.presets.flatMap((p) => ["--preset", p]),
			"-c",
			`target.base=${pass.main}`,
		],
		join(pass.dir, "masterclass.log"),
	);
	if (id === undefined) return;
	pass.say(
		`holding a masterclass on the lessons of ${runs} concerts: concert ${id}`,
	);
}

/**
 * Starts a masterclass on the lessons of the factory runs since the last one, once `MASTERCLASS_EVERY` settled, with
 * the backlog snapshot; true when it started none.
 */
export async function masterclass(pass: Pass, entries: Entry[]) {
	const listed = await pass.maestro.concerts(
		pass.milestone,
		MASTERCLASS_WINDOW,
	);
	const counted = sinceWatermark(listed, pass.milestone);
	if (!counted) return true;
	const hand = handRuns(
		await Promise.all(
			HAND_TOURS.map((t) => pass.maestro.concerts(t, MASTERCLASS_WINDOW)),
		),
		listed,
		pass.milestone,
	);
	const runs = hand.length
		? [...counted, ...hand].sort(
				(a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
			)
		: counted;
	const reports = [];
	for (const concert of runs.toReversed())
		reports.push({ concert, report: await pass.maestro.report(concert.id) });
	const lessons = join(pass.dir, "masterclass-lessons.md");
	await Bun.write(lessons, lessonsText(reports));
	const [closed, pulls] = await Promise.all([
		pass.forge.closed(CLOSED),
		pass.forge.pulls(),
	]);
	const backlog = join(pass.dir, "backlog-masterclass.md");
	await Bun.write(
		backlog,
		snapshot(
			pass.milestone,
			undefined,
			entries.map((e) => e.issue),
			closed,
			pulls,
		),
	);
	await startMasterclass(pass, lessons, backlog, runs.length);
	return false;
}
