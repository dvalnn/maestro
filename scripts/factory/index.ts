// One tick of the tour manager (docs/agents/factory.md, One tick): it routes settles, reviews an epic's stack, builds a
// ready ticket, triages one or holds a masterclass.
import { dlopen, FFIType, read } from "bun:ffi";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isTourSlug, TOUR_MAX_LENGTH } from "@maestro/core";
import {
	busySlots,
	isSlice,
	isStackReview,
	isTriage,
	listConcerts,
	masterclassTour,
	type Slots,
	startSlice,
	startStackReview,
	startTriage,
	tourOf,
} from "./concerts";
import {
	dotenvPath,
	forge,
	type Issue,
	loadEnvFile,
	type Pull,
	REQUEST_CHANGES,
	type Review,
} from "./forge";
import { type Conflicts, landing, SIGNING_KEY } from "./land";
import {
	type Concert,
	checkMaestroVersion,
	maestro,
	type Report,
	type Result,
} from "./maestro";
import {
	masterclass,
	overdueMasterclass,
	routeMasterclass,
	writeUnreadSightings,
} from "./masterclass";
import {
	buildable,
	citedIn,
	isIntake,
	issueText,
	pick,
	snapshot,
	stateOf,
} from "./pick";
import { land } from "./publish";
import {
	ATTEMPTS,
	type Change,
	type Child,
	commentOf,
	type Data,
	dataOf,
	encoreRequest,
	fingerprintLine,
	isBrief,
	isFed,
	isReply,
	type Option,
	parseTriage,
	questionOf,
	relabelled,
	repliesOf,
	replyHow,
	reportIssue,
	requestOf,
	reviewComment,
	reviewRequest,
	type Spec,
	specCommentOf,
	type Triage,
	triaged,
	unresolvedOf,
	VERDICT_STATE,
} from "./route";
import {
	ask,
	BASE,
	branchOf,
	CLOSED,
	type Deps,
	type Entry,
	firstLine,
	HALT,
	halt,
	isLow,
	message,
	move,
	type Options,
	partOf,
	REPO,
	RETRIAGE,
	type Tick,
	UNCONTINUED,
	whichWay,
	writeSpec,
} from "./tick";
import type { State } from "./transitions";

export { type Deps, HALT, type Options };

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const LOCK_EX = 2;
const LOCK_NB = 4;
/** Linux's EWOULDBLOCK, which is EAGAIN. */
const EWOULDBLOCK = 11;
function requireSlug(milestone: string): void {
	if (isTourSlug(masterclassTour(milestone))) return;
	throw new Error(
		`${MILESTONE_KEY} or --milestone takes a slug of at most ${TOUR_MAX_LENGTH - masterclassTour("").length} characters, not '${milestone}'\nWrite it as lower-case words joined by hyphens, such as factory-self-build: a tour is <milestone>.i<issue>`,
	);
}
export const MILESTONE_KEY = "MAESTRO_TM_MILESTONE";
/** How a slice's agent reports it blocked (ADR 0012). */
const BLOCKED = "blocked:";
/** The states a slice's settle is routed in; on an issue the owner moved elsewhere it is parked. */
const BUILDING: readonly State[] = ["in-progress", "ready-for-agent"];

/**
 * Takes an exclusive `flock` on `path`, false when another holder has it. The descriptor stays open, holding the
 * lock, until the process exits.
 * @throws Error when `flock` fails for any other reason.
 */
export function lock(path: string): boolean {
	const libc = dlopen("libc.so.6", {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		__errno_location: { args: [], returns: FFIType.ptr },
	});
	if (libc.symbols.flock(openSync(path, "w"), LOCK_EX | LOCK_NB) === 0)
		return true;
	const errno = read.i32(libc.symbols.__errno_location() ?? 0, 0);
	if (errno === EWOULDBLOCK) return false;
	throw new Error(`cannot lock ${path}: errno ${errno}`);
}

/** The milestone's open issues with their data, or undefined once it halted on data it cannot read. */
async function load(tick: Tick): Promise<Entry[] | undefined> {
	const issues = (await tick.forge.open({ milestone: tick.milestone })).filter(
		(i) => i.milestone === tick.milestoneId,
	);
	const entries: Entry[] = [];
	for (const issue of issues) {
		const comments = await tick.forge.comments(issue.number);
		try {
			const data = dataOf(specCommentOf(comments)?.body ?? "");
			entries.push({ issue, comments, data });
		} catch (error) {
			await halt(
				tick,
				`#${issue.number} has a malformed maestro-tm-data line`,
				`The maestro-tm-data line of #${issue.number}'s spec comment cannot be read:`,
				message(error),
				"Fix the line, or delete the spec comment.",
			);
			return undefined;
		}
	}
	return entries;
}

/** The settled triage, or what went wrong with it. */
function triageOf(result: Result): Triage | string {
	if (result.status !== "ok")
		return `settled ${result.status}: ${result.reason ?? "no reason given"}`;
	try {
		return parseTriage(result.outputs.triage);
	} catch (error) {
		return `gave a malformed triage: ${message(error)}`;
	}
}

/** The labels of an issue closed without being done. */
const NOT_DONE = ["state/wontfix", "state/duplicate"];

/** The ask of a `needs-info` for duplicate `number` whose `original` tracks nothing, undefined when it tracks it. */
function untracked(number: number, original: number, found?: Issue) {
	const head = `Triage found #${number} a duplicate of #${original}, which`;
	const tail = `so nothing live tracks it.`;
	if (!found)
		return `${head} does not exist, ${tail} Name the original, or say what to do with #${number}.`;
	const label =
		found.closed !== undefined &&
		NOT_DONE.find((l) => found.labels.includes(l));
	return (
		label &&
		`${head} is closed as \`${label}\`, ${tail} Reopen #${original}, or say what to do with #${number}.`
	);
}

/**
 * `result`, or a `needs-info` asking the owner where the request lives when it is a duplicate of an issue that does
 * not exist or is closed as `wontfix` or `duplicate`, which tracks nothing.
 */
async function liveOriginal(tick: Tick, number: number, result: Triage) {
	const { duplicateOf: original, ...rest } = result;
	if (result.verdict !== "duplicate" || original === undefined) return result;
	const found = await tick.forge.issue(original).catch(() => undefined);
	const ask = untracked(number, original, found);
	if (!ask) return result;
	const question = { ask, options: [], context: [] };
	return { ...rest, verdict: "needs-info" as const, questions: [question] };
}

/**
 * Posts the questions of `data`'s routed result on `number`, sets its labels, closes a duplicate, then clears
 * `pending`.
 */
async function apply(tick: Tick, number: number, data: Data, result: Triage) {
	const state = VERDICT_STATE[result.verdict];
	if (result.questions.length)
		await ask(
			tick,
			number,
			questionOf(
				result.questions,
				replyHow(result.questions, tick.login),
				result.ahead,
			),
		);
	const { labels } = await tick.forge.issue(number);
	await tick.forge.setLabels(number, triaged(labels, result));
	if (result.verdict === "duplicate")
		await tick.forge.edit(number, { closed: true });
	await writeSpec(tick, number, state, { ...data, pending: undefined });
	tick.say(`routed #${number} to ${state}`);
}

/** Whether `data`'s spec is the one a stale bounce took off `ready-for-agent`. */
const isApproved = ({ approved, version }: Data) =>
	approved !== undefined && approved === version;

/** Routes triage `concert`'s settle onto `issue` (factory.md, Routing a settle), and returns false when it halted. */
async function settle(tick: Tick, { issue, data }: Entry, concert: Concert) {
	const { id } = concert;
	const triaged = triageOf(await tick.maestro.result(id));
	const live =
		typeof triaged === "string"
			? triaged
			: await liveOriginal(tick, issue.number, triaged);
	const approved = isApproved(data) ? data.result : undefined;
	const reapproved =
		typeof live !== "string" && live.kept === true && approved !== undefined;
	// A kept spec builds as the owner approved it, word for word.
	const result =
		reapproved && approved
			? { ...approved, verdict: "ready-for-agent" as const, questions: [] }
			: live;
	const state = stateOf(issue) ?? "needs-triage";
	if (typeof result === "string") {
		const [what, ...why] = result.split(": ");
		// The replies it was fed go to the next triage again, since an encore continues the last ok one.
		await writeSpec(tick, issue.number, state, {
			...data,
			concert: id,
			read: undefined,
		});
		await halt(
			tick,
			`triage of #${issue.number} ${what}`,
			`The triage concert \`${id}\` of #${issue.number} ${what}:`,
			why.join(": "),
			`Read it with \`maestro ls ${id}\`. The next tick triages #${issue.number} again.`,
		);
		return false;
	}
	const routed: Data = {
		...data,
		...UNCONTINUED,
		concert: id,
		triage: id,
		result,
		version: (data.version ?? 0) + 1,
		specBase: concert.base,
		approved: undefined,
	};
	if (reapproved)
		await ask(
			tick,
			issue.number,
			questionOf(
				[
					{
						ask: `Triage found the approved spec v${data.version} still holds against current main, so v${routed.version} keeps it as approved.`,
						options: [],
						context: [],
					},
				],
				"No reply needed: the next tick builds it.",
			),
			data.read,
		);
	await writeSpec(tick, issue.number, VERDICT_STATE[result.verdict], {
		...routed,
		pending: true,
	});
	await apply(tick, issue.number, routed, result);
	return true;
}

/** Files each of `texts` as a `needs-triage` bug found by `issue`, unless an open issue carries it (factory.md, Stack review). */
async function fileReports(tick: Tick, issue: Issue, texts: readonly string[]) {
	const bodies = (await tick.forge.open({})).map((i) => i.body);
	for (const text of texts) {
		const line = fingerprintLine(text);
		if (bodies.some((b) => b.includes(line))) continue;
		const filed = reportIssue(text, issue.number);
		const number = await tick.forge.file({
			...filed,
			milestone: issue.milestone,
			labels: ["state/needs-triage", "kind/bug"],
		});
		bodies.push(filed.body);
		tick.say(`filed #${number}, found by #${issue.number}`);
	}
}

const YOUR_CHOICE = "your choice";
const BLOCKED_OPTIONS: Option[] = [
	{ label: "`ready-for-agent`", text: "continue with my answer" },
	RETRIAGE,
];

/** The blocked agent's question: its reason is shown once, under the spec comment's Last failure. */
const BLOCKED_ASK =
	"The build stopped on the reason under Last failure in the spec comment. How should it go on?";

/** Asks the owner about issue `number`'s blocked build, answered by a reply (factory.md, Rules, Build: Blocked). */
async function block(tick: Tick, number: number) {
	const questions = [
		{ ask: BLOCKED_ASK, options: BLOCKED_OPTIONS, context: [] },
	];
	await ask(
		tick,
		number,
		questionOf(questions, replyHow(questions, tick.login, YOUR_CHOICE)),
	);
}

/**
 * Halts the tour manager on slice `id` of `entry` that failed to run, requeuing the ticket to `ready-for-agent` with
 * its attempts kept and no concert to continue (factory.md, Rules, Policy: Halt).
 */
async function haltSlice(
	tick: Tick,
	{ issue, data }: Entry,
	id: string,
	reason: string,
) {
	await move(tick, issue.number, "ready-for-agent");
	await writeSpec(tick, issue.number, "ready-for-agent", {
		...data,
		concert: id,
		failure: reason,
		...UNCONTINUED,
	});
	await halt(
		tick,
		`slice of #${issue.number} could not run`,
		`The slice concert \`${id}\` of #${issue.number} could not run:`,
		reason,
		`Read it with \`maestro ls ${id}\`. The ticket is back in \`ready-for-agent\` with its attempts kept.`,
	);
}

/**
 * Routes unlanded slice `id` of `entry` by its outcome (factory.md, Rules, Build): `blocked:` to `needs-info` asking
 * its question; any other `failed` halts the tour manager; `rejected` spends an attempt. One routed to `needs-info` is
 * the concert to continue; a retry is fresh. Returns false when it halted.
 */
async function fail(
	tick: Tick,
	entry: Entry,
	id: string,
	status: string,
	reason: string,
) {
	const { issue, data } = entry;
	const blocked = status === "failed" && reason.startsWith(BLOCKED);
	if (status === "failed" && !blocked) {
		await haltSlice(tick, entry, id, reason);
		return false;
	}
	const attempts = (data.attempts ?? 0) + (blocked ? 0 : 1);
	const waits = blocked || attempts >= ATTEMPTS;
	const state = waits ? "needs-info" : "ready-for-agent";
	if (blocked) await block(tick, issue.number);
	await move(tick, issue.number, state);
	await writeSpec(tick, issue.number, state, {
		...data,
		concert: id,
		attempts: attempts || undefined,
		failure: reason,
		...(waits ? { encore: id } : UNCONTINUED),
	});
	tick.say(`routed #${issue.number}'s slice to ${state}: ${reason}`);
	return true;
}

/**
 * Routes slice `id`'s settle onto `entry` (factory.md, Routing a settle); its reports wait for a masterclass. False
 * when it halted.
 */
async function settleSlice(tick: Tick, entry: Entry, id: string) {
	const [result, report] = await Promise.all([
		tick.maestro.result(id),
		tick.maestro.report(id),
	]);
	if (result.status === "ok") return land(tick, entry, id, report);
	const reason = result.reason ?? `settled ${result.status}`;
	return fail(tick, entry, id, result.status, reason);
}

/** The concerts of `issue`'s tour, newest first. */
const onTour = (tick: Tick, issue: Issue) => {
	const tour = tourOf(tick.milestone, issue.number);
	return tick.concerts.filter((c) => c.tour === tour);
};

/** The newest triage, slice or stack review of `entry`'s tour the tick has yet to route; none while it runs. */
function unrouted(tick: Tick, { issue, data }: Entry) {
	const concert = onTour(tick, issue).find(
		(c) => isSlice(c) || isTriage(c) || isStackReview(c),
	);
	if (concert?.status === "running") return undefined;
	return concert?.id === data.concert ? undefined : concert;
}

/** Whether no concert of `issue`'s tour runs, so a step may triage, build, bounce or queue it. */
function idle(tick: Tick, issue: Issue) {
	return !onTour(tick, issue).some((c) => c.status === "running");
}

/** Whether `issue` is still where `concert` left it: being built for a slice, in intake for a triage. */
function expected(concert: Concert, issue: Issue) {
	const state = stateOf(issue);
	if (!isSlice(concert)) return isIntake(issue);
	return state !== undefined && BUILDING.includes(state);
}

/**
 * Routes `concert` without applying it, since the owner moved `entry` during its run: asks which way, moves the issue
 * to `needs-info`, then marks it routed. A slice is kept as `parked`; a triage's verdict is dropped, since a triage is
 * cheap and its verdict stale.
 */
async function park(tick: Tick, { issue, data }: Entry, concert: Concert) {
	const slice = isSlice(concert);
	const lead = slice
		? `The slice concert \`${concert.id}\` settled after this ticket was moved, so its result is parked.`
		: `Triage \`${concert.id}\` settled after this ticket was moved, so its verdict is not applied.`;
	const options = slice
		? [
				{ label: "`in-progress`", text: "apply the parked result" },
				{ label: "`ready-for-agent`", text: "build it again" },
				RETRIAGE,
			]
		: [RETRIAGE];
	await ask(tick, issue.number, whichWay(lead, options));
	await move(tick, issue.number, "needs-info");
	await writeSpec(tick, issue.number, "needs-info", {
		...data,
		encore: undefined,
		concert: concert.id,
		...(slice ? { parked: concert.id } : await dropped(tick, concert.id)),
	});
	tick.say(`parked #${issue.number}'s concert ${concert.id} in needs-info`);
}

/** The data a dropped triage `id` leaves: no stale result, and `id` as the triage to continue when it settled ok. */
async function dropped(tick: Tick, id: string): Promise<Data> {
	const ok = typeof triageOf(await tick.maestro.result(id)) !== "string";
	return { result: undefined, ...(ok ? { triage: id } : {}) };
}

/**
 * Routes the parked concert of `entry` once the owner chose: applies it in `in-progress`, waits in `needs-info`, and
 * clears it on any other move; false when it halted.
 */
async function unpark(tick: Tick, entry: Entry, parked: string) {
	const { issue } = entry;
	const state = stateOf(issue) ?? "needs-triage";
	if (state === "needs-info") return true;
	const data = { ...entry.data, parked: undefined };
	if (state === "in-progress")
		return settleSlice(tick, { ...entry, data }, parked);
	await writeSpec(tick, issue.number, state, data);
	tick.say(`cleared #${issue.number}'s parked concert ${parked}`);
	return true;
}

/** The one child of epic `data` still open among `entries`, once every other is closed. */
function lastChild(data: Data, entries: readonly Entry[]) {
	const open = entries.filter((e) => data.filed?.includes(e.issue.number));
	return open.length === 1 ? open[0] : undefined;
}

/** The PR of issue `number` to `main` among `pulls`. */
const pullToMain = (pulls: readonly Pull[], number: number) =>
	pulls.find((p) => p.head === branchOf(number) && p.base === BASE);

/** A stack review's findings as Markdown: its review, else the findings its verdict blocks on. */
const findingsText = ({ review, blocking = [] }: Report) =>
	review ?? blocking.map((b) => `- ${b}`).join("\n");

/** Arms the PR to `main` of `child`, the last child of a cleared stack review, unless its own PR is a draft. */
async function armLast(tick: Tick, { issue, data }: Entry) {
	const report = data.concert
		? await tick.maestro.report(data.concert)
		: undefined;
	if (report?.draft) return;
	const pull = pullToMain(await tick.forge.pulls(), issue.number);
	if (pull) await tick.forge.arm(pull.number);
}

/**
 * Records the findings of stack review `id` on `epic`, then feeds them to the encore of its `last` child, or files each
 * as a report when no one child is open.
 */
async function routeFindings(
	tick: Tick,
	epic: Issue,
	id: string,
	last: Entry | undefined,
) {
	const report = await tick.maestro.report(id);
	const review = findingsText(report);
	if (!last) {
		await ask(
			tick,
			epic.number,
			reviewComment(
				id,
				review,
				"No one child is open to take them, so each finding is filed as an issue.",
			),
		);
		return fileReports(tick, epic, report.blocking ?? []);
	}
	const { issue, data } = last;
	await ask(
		tick,
		epic.number,
		reviewComment(
			id,
			review,
			`Its findings go to the next encore of #${issue.number}.`,
		),
	);
	await writeSpec(tick, issue.number, stateOf(issue) ?? "in-review", {
		...data,
		findings: id,
	});
}

/** The title of the halt stack review `result` raises, none when it settled ok or rejected with a lens delivered. */
function reviewHalt(result: Result) {
	if (result.status === "rejected" && result.outputs.delivered === 0)
		return "delivered no review";
	if (result.status === "ok" || result.status === "rejected") return undefined;
	return "failed";
}

/**
 * Routes stack review `id` of epic `entry` (factory.md, Routing a settle): an ok one arms the last child when low, a
 * rejected one some lens delivered routes its findings, any other halts and runs again once the halt closes. Returns
 * false when it halted.
 */
async function settleReview(
	tick: Tick,
	{ issue, data }: Entry,
	id: string,
	entries: Entry[],
) {
	const state = stateOf(issue) ?? "in-progress";
	const result = await tick.maestro.result(id);
	const halted = reviewHalt(result);
	if (halted) {
		await writeSpec(tick, issue.number, state, {
			...data,
			concert: id,
			stackReview: undefined,
		});
		await halt(
			tick,
			`stack review of #${issue.number} ${halted}`,
			`The stack review \`${id}\` of #${issue.number} settled ${result.status}:`,
			result.reason ?? "no reason given",
			`Read it with \`maestro ls ${id}\`. Closing this issue runs the review again.`,
		);
		return false;
	}
	const last = lastChild(data, entries);
	if (result.status === "rejected") await routeFindings(tick, issue, id, last);
	else if (
		last &&
		stateOf(last.issue) === "in-review" &&
		isLow(last.issue, last.data)
	)
		await armLast(tick, last);
	await writeSpec(tick, issue.number, state, {
		...data,
		concert: id,
		stackReview: id,
	});
	tick.say(`routed #${issue.number}'s stack review ${id}: ${result.status}`);
	return true;
}

/** Routes one issue's newest concert the tick has not routed yet, or its parked one; false when it halted. */
async function routeOne(tick: Tick, entry: Entry, entries: Entry[]) {
	if (entry.data.parked) return unpark(tick, entry, entry.data.parked);
	const concert = unrouted(tick, entry);
	if (!concert) return true;
	if (isStackReview(concert))
		return settleReview(tick, entry, concert.id, entries);
	if (!expected(concert, entry.issue)) {
		await park(tick, entry, concert);
		return true;
	}
	return isSlice(concert)
		? settleSlice(tick, entry, concert.id)
		: settle(tick, entry, concert);
}

/** Routes each issue's settles, then the newest concert when it is a masterclass; false when it halted. */
async function route(tick: Tick, entries: Entry[]) {
	for (const entry of entries)
		if (!(await routeOne(tick, entry, entries))) return false;
	await routeMasterclass(tick);
	return true;
}

const scopeOf = (label: string) => label.split("/")[0];

/**
 * Files child `child` of `epic` unless `entries` hold it, else gives it any label scope it lacks; returns its number.
 */
async function fileChild(
	{ forge }: Tick,
	epic: Issue,
	child: Child,
	entries: Entry[],
) {
	const head = partOf(epic.number);
	const kinds = epic.labels.filter(
		(l) => l.startsWith("kind/") && l !== "kind/epic",
	);
	const labels = ["state/needs-triage", ...kinds];
	const open = entries.find(
		({ issue }) =>
			issue.title === child.title && firstLine(issue.body) === head,
	)?.issue;
	if (!open)
		return forge.file({
			title: child.title,
			body: `${head}\n\n${child.body}`,
			milestone: epic.milestone,
			labels,
		});
	const missing = labels.filter(
		(l) => !open.labels.some((has) => scopeOf(has) === scopeOf(l)),
	);
	if (missing.length)
		await forge.setLabels(open.number, [...open.labels, ...missing]);
	return open.number;
}

/** Files approved split `epic`'s children with their dependencies, then moves it to `in-progress`. */
async function fileSplit(tick: Tick, { issue, data }: Entry, entries: Entry[]) {
	const filed: number[] = [];
	for (const child of data.result?.children ?? []) {
		const number = await fileChild(tick, issue, child, entries);
		for (const blocker of child.dependsOn.map((d) => filed[d]))
			if (blocker !== undefined) await tick.forge.depend(number, blocker);
		filed.push(number);
	}
	await writeSpec(tick, issue.number, "in-progress", {
		...data,
		filed,
		base: data.base ?? tick.main,
	});
	const { labels } = await tick.forge.issue(issue.number);
	await tick.forge.setLabels(
		issue.number,
		relabelled(labels, ["state", "kind"], ["state/in-progress", "kind/epic"]),
	);
	tick.say(`filed #${issue.number}'s children: ${filed.join(", ")}`);
}

/** Closes epic `issue` once every child in `filed` has closed (factory.md, Rules, Triage: Splits). */
async function closeEpic(
	tick: Tick,
	issue: Issue,
	filed: number[],
	entries: Entry[],
) {
	if (entries.some((e) => filed.includes(e.issue.number))) return;
	const children = await Promise.all(filed.map((n) => tick.forge.issue(n)));
	if (children.some((c) => c.closed === undefined)) return;
	await tick.forge.edit(issue.number, { closed: true });
	tick.say(`closed epic #${issue.number}, its children all closed`);
}

/**
 * Sets the labels of a routed result a cut tick left unset, files a split the owner approved, closes an epic whose
 * children all closed.
 */
async function syncOne(tick: Tick, entry: Entry, entries: Entry[]) {
	const { issue, data } = entry;
	const state = stateOf(issue);
	if (data.pending && data.result)
		await apply(tick, issue.number, data, data.result);
	else if (state === "ready-for-agent" && data.result?.children)
		await fileSplit(tick, entry, entries);
	else if (state === "in-progress" && data.filed)
		await closeEpic(tick, issue, data.filed, entries);
}

/** Syncs each issue (factory.md, One tick: sync). */
async function sync(tick: Tick, entries: Entry[]) {
	for (const entry of entries) await syncOne(tick, entry, entries);
	return true;
}

type Perform = { request: string; encore?: string; data: Data };

/**
 * Performs `perform` for `entry`, cut at its PR's head and revising that commit when it revises, else on `main`, and
 * moves it to `in-progress`; halts on a refusal.
 */
async function startBuild(
	tick: Tick,
	{ issue, data }: Entry,
	perform: Perform,
) {
	const result = data.result;
	if (!result) return;
	const id = await startSlice(tick, issue, {
		request: perform.request,
		risk: result.risk,
		encore: perform.encore,
		revisionBase: perform.data.revisionBase,
	});
	if (id === undefined) return;
	await move(tick, issue.number, "in-progress");
	await writeSpec(tick, issue.number, "in-progress", {
		...perform.data,
		slice: id,
	});
	tick.say(`building #${issue.number}: concert ${id}`);
}

/**
 * What a build of ready `entry` performs: an encore of its concert to continue, fed the replies mentioning the login
 * newer than `read`, else a fresh slice, since an encore with nothing changed is refused
 * (factory.md, Rules, Build: Encore).
 */
async function performOf(
	tick: Tick,
	{ issue, comments, data }: Entry,
	spec: Spec,
): Promise<Perform> {
	const request = requestOf(issue, spec);
	const fresh = {
		request,
		data: { ...data, revisionBase: undefined, conflicted: undefined },
	};
	if (!data.encore) return fresh;
	const considered = repliesOf(comments, data.read);
	const changes = considered
		.filter((c) => isReply(c, tick.login))
		.map((c) => ({ heading: `Reply by ${c.author}`, body: c.body }));
	if (!changes.length) return fresh;
	return {
		request: encoreRequest(request, changes),
		encore: data.encore,
		data: { ...data, read: considered.at(-1)?.id ?? data.read },
	};
}

/** The reviews among `reviews` an encore of `data` has yet to be fed: official, not dismissed, asking for changes. */
const requested = (reviews: readonly Review[], { review = 0 }: Data) =>
	reviews.filter(
		(r) =>
			r.official &&
			!r.dismissed &&
			r.state === REQUEST_CHANGES &&
			r.id > review,
	);

/** Review `r` as an encore is fed it: its body, then each inline comment as a `path:line` item. */
const reviewChange = (r: Review): Change => ({
	heading: `Review by ${r.author}`,
	body: [
		r.body.trim(),
		r.comments
			.map(
				(c) =>
					`- \`${c.line ? `${c.path}:${c.line}` : c.path}\`: ${c.body.trim().replaceAll("\n", "\n  ")}`,
			)
			.join("\n"),
	]
		.filter(Boolean)
		.join("\n\n"),
});

/** `paths` as a Markdown list of code spans. */
const pathList = (paths: readonly string[]) =>
	paths.map((p) => `- \`${p}\``).join("\n");

/**
 * What an encore is fed when `pull` conflicts with `main`: it is cut at their merge, whose markers it resolves, and is
 * told which paths one side deleted (factory.md, Rules, Build: Encore).
 */
function conflictChange(
	pull: Pull,
	main: string,
	{ paths, deletedOnto, deletedInHead }: Conflicts,
): Change {
	const marked = paths.filter(
		(p) => !deletedOnto.includes(p) && !deletedInHead.includes(p),
	);
	return {
		heading: "Conflict with main",
		body: [
			`The PR conflicts with \`main\`, so this build starts from the PR merged onto \`main\`'s \`${main}\`.`,
			...(marked.length
				? [
						`Resolve every conflict marker git left, keeping what \`main\` changed and what the PR does: \`<<<<<<< ${main}\` opens \`main\`'s side and \`>>>>>>> ${pull.sha}\` closes the PR's, each label followed by \`:<path>\` where a rename is involved. In:`,
						pathList(marked),
					]
				: []),
			...(deletedOnto.length
				? [
						"`main` deleted these and the PR changed them, and the build holds the PR's version: delete each, or keep it if the PR still needs it:",
						pathList(deletedOnto),
					]
				: []),
			...(deletedInHead.length
				? [
						"The PR deleted these and `main` changed them, and the build holds `main`'s version: delete each as the PR does, or keep `main`'s change if the PR still needs it:",
						pathList(deletedInHead),
					]
				: []),
		].join("\n\n"),
	};
}

/**
 * How PR `pull` to `main` conflicts with the tick's `main`, if it does; a PR to another branch is not checked, and one
 * no build can be told about is said, for a rebase by hand.
 */
async function conflictsOf(tick: Tick, pull: Pull) {
	if (pull.base !== BASE) return undefined;
	const found = await tick.landing.conflicts(pull.sha, tick.main);
	if (found && "untold" in found)
		tick.say(
			`PR #${pull.number} conflicts with main where no build can be told how, so it waits for a rebase by hand: ${found.untold.join(", ")}`,
		);
	return found;
}

/**
 * What a ticket's own record feeds the encore of its landed `concert`: its stack review's `findings`, then those its
 * own review left upheld while it is `unresolved`.
 */
async function recorded(
	tick: Tick,
	concert: string,
	{ findings, unresolved }: Data,
) {
	const upheld = unresolved
		? unresolvedOf((await tick.maestro.report(concert)).upheld)
		: undefined;
	return [
		...(findings
			? [
					{
						heading: "Stack review",
						body: findingsText(await tick.maestro.report(findings)),
					},
				]
			: []),
		...(upheld ? [{ heading: "Unresolved review", body: upheld }] : []),
	];
}

/**
 * The encore of in-review `entry`'s landed concert its PR among `pulls` asks for with changes requested, a conflict
 * with `main`, its stack review's `findings` or its own `unresolved` ones, if any, and none while it conflicts in a way
 * no build can be told. It is fed each review above `review`, the conflict and the findings, moves `review` to the
 * newest, clears `findings` and `unresolved`, and records as `revisionBase` the commit the build is cut
 * at and lands folded into, so the PR keeps one commit per ticket: the PR's head, or its merge onto `main` when they
 * conflict, with the conflicted paths as `conflicted`.
 */
async function revision(
	tick: Tick,
	{ issue, data }: Entry,
	pulls: readonly Pull[],
): Promise<Perform | undefined> {
	const pull = pulls.find((p) => p.head === branchOf(issue.number));
	const spec = data.result?.spec;
	if (!pull || !spec || !data.concert) return undefined;
	const conflicts = await conflictsOf(tick, pull);
	if (conflicts && "untold" in conflicts) return undefined;
	const reviews = requested(
		await tick.forge.reviews(pull.number, data.review ?? 0),
		data,
	);
	const changes = reviews.map(reviewChange);
	if (conflicts) changes.push(conflictChange(pull, tick.main, conflicts));
	changes.push(...(await recorded(tick, data.concert, data)));
	if (!changes.length) return undefined;
	return {
		request: encoreRequest(requestOf(issue, spec), changes),
		encore: data.concert,
		data: {
			...data,
			review: reviews.length
				? Math.max(...reviews.map((r) => r.id))
				: data.review,
			findings: undefined,
			unresolved: undefined,
			revisionBase: conflicts?.commit ?? pull.sha,
			conflicted: conflicts?.paths,
		},
	};
}

/**
 * Starts the encore of the oldest in-review ticket with changes requested where a build would; true when it started
 * none.
 */
async function revise(tick: Tick, entries: Entry[]) {
	const reviewed = entries
		.filter((e) => stateOf(e.issue) === "in-review" && idle(tick, e.issue))
		.sort((a, b) => a.issue.number - b.issue.number);
	if (!reviewed.length) return true;
	const pulls = await tick.forge.pulls();
	for (const entry of reviewed) {
		const perform = await revision(tick, entry, pulls);
		if (!perform) continue;
		await startBuild(tick, entry, perform);
		return false;
	}
	return true;
}

/** The PR of in-progress epic `entry`'s last child, once that child is in review on it and no stack review ran yet. */
async function reviewDue(
	{ issue, data }: Entry,
	entries: readonly Entry[],
	pulls: () => Promise<Pull[]>,
) {
	if (stateOf(issue) !== "in-progress" || !data.base || data.stackReview)
		return undefined;
	const last = lastChild(data, entries);
	if (!last || stateOf(last.issue) !== "in-review") return undefined;
	return pullToMain(await pulls(), last.issue.number);
}

/**
 * Starts the stack review of the first epic whose last child is in review (factory.md, Rules, Build: Stack review),
 * over `main`'s commits from its `base` to that child's PR head; halts on a refusal. True when it started none.
 */
async function stackReview(tick: Tick, entries: Entry[]) {
	let found: Promise<Pull[]> | undefined;
	const pulls = () => (found ??= tick.forge.pulls());
	for (const entry of entries) {
		if (!idle(tick, entry.issue)) continue;
		const pull = await reviewDue(entry, entries, pulls);
		const { base } = entry.data;
		if (!pull || !base) continue;
		await reviewEpic(tick, entry, base, pull.sha);
		return false;
	}
	return true;
}

/**
 * Performs the stack review of epic `entry` over `main`'s commits from `base` to `head`, and records it; halts on a
 * refusal.
 */
async function reviewEpic(
	tick: Tick,
	{ issue, data }: Entry,
	base: string,
	head: string,
) {
	const id = await startStackReview(tick, issue, {
		request: reviewRequest(
			issue,
			data.result?.children ?? [],
			data.filed ?? [],
		),
		base,
		head,
	});
	if (id === undefined) return;
	await writeSpec(tick, issue.number, "in-progress", {
		...data,
		stackReview: id,
	});
	tick.say(`reviewing #${issue.number}'s stack: concert ${id}`);
}

/** Says in the spec comment of ready `entry` which open dependencies, `waiting`, it waits on, writing only when that changes it. */
async function queue(
	tick: Tick,
	{ issue, comments, data }: Entry,
	waiting: number[],
) {
	const comment = commentOf(data, "ready-for-agent", tick.login, waiting);
	if (specCommentOf(comments)?.body.trim() === comment.trim()) return;
	await writeSpec(tick, issue.number, "ready-for-agent", data, waiting);
}

/** The lead of the comment saying main changed `files` since `base`, the commit the spec was written on. */
const staleLead = (base: string, files: readonly string[]) =>
	`The spec was written on main at ${base.slice(0, 12)}; main has since changed ${files
		.map((f) => `\`${f}\``)
		.join(", ")}. Re-triaging against current main.`;

/**
 * Moves ready `entry` to `needs-triage` with a question comment naming the files of its spec that changed on main since
 * the commit its triage read, and returns true; false when none did, or it holds no `specBase`, and builds (factory.md,
 * Rules, Build: Stale spec).
 */
async function retriage(tick: Tick, { issue, data }: Entry, spec: Spec) {
	if (data.specBase === undefined) return false;
	const files = await tick.landing.changed(
		data.specBase,
		tick.main,
		spec.touches,
	);
	if (!files.length) return false;
	await ask(
		tick,
		issue.number,
		questionOf(
			[{ ask: staleLead(data.specBase, files), options: [], context: [] }],
			"No reply needed: the next tick triages it again.",
		),
		data.read,
	);
	await move(tick, issue.number, "needs-triage");
	await writeSpec(tick, issue.number, "needs-triage", {
		...data,
		approved: data.version,
	});
	tick.say(`#${issue.number}: spec is stale, moved to needs-triage`);
	return true;
}

/**
 * Finishes work first: continues a ticket with changes requested, else builds the first buildable issue, pinned ones
 * first, that its blockers let build and whose spec is not stale; true when it started none.
 */
async function build(tick: Tick, entries: Entry[]) {
	if (!(await revise(tick, entries))) return false;
	for (const entry of buildable(entries, await tick.forge.pinned()).filter(
		(e) => idle(tick, e.issue),
	)) {
		const spec = entry.data.result?.spec;
		if (!spec) continue;
		const waiting = (await tick.forge.blockers(entry.issue.number)).sort(
			(a, b) => a - b,
		);
		if (waiting.length) {
			await queue(tick, entry, waiting);
			continue;
		}
		const perform = await performOf(tick, entry, spec);
		if (!perform.encore && (await retriage(tick, entry, spec))) continue;
		await startBuild(tick, entry, perform);
		return false;
	}
	return true;
}

/** Asks for the reply a re-triage of `entry` needs, then moves it to `needs-info` with `read` past that question. */
async function askReply(tick: Tick, { issue, data }: Entry) {
	const questions = [
		{
			ask: `What changed since the last triage? No reply mentions \`@${tick.login}\` yet.`,
			options: [],
			context: [],
		},
	];
	const how = `Reply \`@${tick.login} …\`, then label \`needs-triage\`.`;
	const read = await tick.forge.comment(
		issue.number,
		questionOf(questions, how),
	);
	await move(tick, issue.number, "needs-info");
	await writeSpec(tick, issue.number, "needs-info", { ...data, read });
	tick.say(
		`#${issue.number}: no reply since the last triage, moved to needs-info`,
	);
}

/** How the forge answers for an issue number it does not have. */
const MISSING = /^forge: 404 /;

/** The closed issues `text` cites but `issue`; a number the forge does not have is skipped. */
async function closedCited(tick: Tick, issue: number, text: string) {
	const cited = await Promise.all(
		citedIn(text)
			.filter((n) => n !== issue)
			.map((n) =>
				tick.forge.issue(n).catch((error: unknown) => {
					if (MISSING.test(message(error))) return undefined;
					throw error;
				}),
			),
	);
	return cited.filter((i): i is Issue => i?.closed !== undefined);
}

/** The triage concert `id` an encore continues; undefined when there is none or `maestro prune` deleted it, so triage afresh. */
const continuable = async (tick: Tick, id: string | undefined) =>
	id && (await tick.maestro.has(id)) ? id : undefined;

/**
 * Starts triage of the first intake issue with no open dependency, pinned ones first, on its ask and the comments since
 * the last triage read that it is fed and the unread sightings, an encore of its last triage when it has one, respecced when that triage gave a spec rather than a
 * brief, then records the newest comment it considered; halts on a refusal. A re-triage with nothing new to feed asks
 * for a reply instead. True only when it started nothing, so a masterclass may follow.
 */
async function triage(tick: Tick, entries: Entry[]) {
	const issue = await pick(
		entries
			.filter((e) => !e.data.pending && idle(tick, e.issue))
			.map((e) => e.issue),
		await tick.forge.pinned(),
		async (n) => (await tick.forge.blockers(n)).length === 0,
	);
	const entry = entries.find((e) => e.issue === issue);
	if (!entry) {
		tick.say("nothing to triage");
		return true;
	}
	const { data, comments } = entry;
	const { number } = entry.issue;
	const considered = repliesOf(comments, data.read);
	if (data.triage && !considered.some((c) => isFed(c, tick.login))) {
		await askReply(tick, entry);
		return true;
	}
	const last = data.triage ? data.result?.spec : undefined;
	const text = issueText(
		entry.issue,
		considered.filter((c) => isFed(c, tick.login)),
		tick.login,
		last,
		isApproved(data),
	);
	const [closed, pulls, cited] = await Promise.all([
		tick.closed(),
		tick.forge.pulls(),
		closedCited(tick, number, text),
	]);
	const issues = entries.map((e) => e.issue);
	const backlog = join(tick.dir, `backlog-i${number}.md`);
	await Bun.write(
		backlog,
		snapshot(tick.milestone, number, issues, closed, pulls, cited),
	);
	// Rewritten before an encore too: the encore of a triage the tick started rereads this path from its params.
	const sightings = join(tick.dir, `sightings-i${number}.md`);
	await writeUnreadSightings(tick, sightings);
	const encore = await continuable(tick, data.triage);
	const id = await startTriage(tick, entry.issue, {
		text,
		backlog,
		respec: last !== undefined && !isBrief(last),
		...(encore ? { encore } : { sightings }),
	});
	if (id === undefined) return false;
	tick.say(`triaging #${number}: concert ${id}`);
	const read = considered.at(-1)?.id;
	if (read !== undefined)
		await writeSpec(tick, number, stateOf(entry.issue) ?? "needs-triage", {
			...data,
			read,
		});
	return false;
}

/** Whether the `check` push status of `commit` is `failure` or `error`; says so when it is. */
async function failsCheck(deps: Deps, commit: string): Promise<boolean> {
	const state = await deps.forge.status(commit);
	const red = state === "failure" || state === "error";
	if (red)
		deps.say(`main ${commit} fails check: no build starts until it is green`);
	return red;
}

/** The tick's steps: route and sync, then each start step whose slot is free, in pick order. */
const stepsFor = (busy: Slots, red: boolean) => [
	route,
	sync,
	...(busy.code || red ? [] : [stackReview, build]),
	...(busy.second ? [] : [overdueMasterclass, triage, masterclass]),
];

/**
 * One tick: routes settled concerts, syncs, and starts at most one concert in a free slot; the order is in
 * `docs/agents/factory.md`, One tick. Each step returns whether the tick goes on.
 * @throws Error when the milestone does not exist, or the forge or maestro fails or answers what the tick cannot read.
 */
export async function tick(deps: Deps, options: Options): Promise<void> {
	requireSlug(options.milestone);
	if (!deps.lock()) return deps.say("another tick holds the lock");
	const halts = await deps.forge.open({ label: HALT });
	if (halts.some((i) => i.labels.includes(HALT)))
		return deps.say(`halted: close the open ${HALT} issue to resume`);
	const milestoneId = await deps.forge.milestone(options.milestone);
	if (milestoneId === undefined)
		throw new Error(
			`no milestone ${options.milestone} upstream\nCreate it, or set ${MILESTONE_KEY} or --milestone to an existing one`,
		);
	const concerts = await listConcerts(deps.maestro, options.milestone);
	const busy = busySlots(concerts);
	const login = await deps.forge.login();
	const main = await deps.forge.head(BASE);
	const red = !options.routeOnly && (await failsCheck(deps, main));
	await deps.landing.fetch();
	let closed: Promise<Issue[]> | undefined;
	const tick: Tick = {
		...deps,
		...options,
		milestoneId,
		concerts,
		login,
		main,
		closed: () => (closed ??= deps.forge.closed(CLOSED)),
	};
	const steps = options.routeOnly ? [route, sync] : stepsFor(busy, red);
	for (const step of steps) {
		const entries = await load(tick);
		if (!entries || !(await step(tick, entries))) return;
	}
	if (options.routeOnly)
		tick.say("route-only: routed and synced, started nothing");
}

/**
 * The milestone a tick serves: `flag` when non-empty, else `MAESTRO_TM_MILESTONE` from `env` when non-empty.
 * @throws Error naming `MAESTRO_TM_MILESTONE` and its file when neither is set.
 */
export function milestoneOf(
	flag: string | undefined,
	env: NodeJS.ProcessEnv,
): string {
	if (flag) return flag;
	const milestone = env[MILESTONE_KEY];
	if (milestone) return milestone;
	throw new Error(
		`${MILESTONE_KEY} is not set\nSet it in ${dotenvPath(env)}, or pass --milestone <name>`,
	);
}

if (import.meta.main) {
	try {
		loadEnvFile();
	} catch (error) {
		console.error(`tour manager: ${message(error)}`);
		process.exit(EXIT_FAILED);
	}
	let values: {
		milestone?: string;
		preset?: string[];
		"route-only"?: boolean;
	};
	try {
		({ values } = parseArgs({
			options: {
				milestone: { type: "string" },
				preset: { type: "string", multiple: true },
				"route-only": { type: "boolean" },
			},
		}));
	} catch (error) {
		console.error(
			`${message(error)}\nusage: bun scripts/factory/index.ts [--milestone <name>] [--preset <name>]... [--route-only]`,
		);
		process.exit(EXIT_USAGE);
	}
	let options: Options;
	try {
		const runtime = process.env.XDG_RUNTIME_DIR;
		if (!runtime)
			throw new Error(
				"XDG_RUNTIME_DIR is not set\nRun the tick in a user session, such as under systemctl --user",
			);
		options = {
			presets: values.preset ?? [],
			routeOnly: values["route-only"],
			milestone: milestoneOf(values.milestone, process.env),
			dir: join(runtime, "maestro-factory"),
			cache: join(
				process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
				"maestro-factory",
			),
		};
	} catch (error) {
		console.error(`tour manager: ${message(error)}`);
		process.exit(EXIT_FAILED);
	}
	mkdirSync(options.dir, { recursive: true });
	try {
		await checkMaestroVersion();
		const tm = forge();
		const account = await tm.account();
		await tick(
			{
				forge: tm,
				maestro: maestro(),
				landing: landing(REPO, account, process.env[SIGNING_KEY] || undefined),
				lock: () => lock(join(options.dir, "lock")),
				say: console.log,
				has: (path) => existsSync(join(REPO, path)),
			},
			options,
		);
	} catch (error) {
		console.error(`tour manager: ${message(error)}`);
		process.exit(EXIT_FAILED);
	}
}
