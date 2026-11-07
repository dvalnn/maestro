// One pass of the tour manager (docs/agents/factory.md, One tick): it routes settles, reviews an epic's stack, builds a
// ready ticket, triages one or holds a masterclass.
import { dlopen, FFIType, read } from "bun:ffi";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	dotenvPath,
	type Forge,
	forge,
	type Issue,
	loadEnvFile,
	type Pull,
	REQUEST_CHANGES,
	type Review,
} from "./forge";
import { landing, SIGNING_KEY } from "./land";
import { type Concert, maestro, type Report, type Result } from "./maestro";
import { masterclass, routeMasterclass } from "./masterclass";
import {
	type Approval,
	buildable,
	citedIn,
	isIntake,
	issueText,
	overlaps,
	pick,
	snapshot,
	stateOf,
	tierOf,
	titleOf,
	tourOf,
} from "./pick";
import { land, restack } from "./publish";
import {
	ATTEMPTS,
	type Change,
	type Child,
	commentOf,
	type Data,
	dataOf,
	encoreRequest,
	fingerprintLine,
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
	type Stack,
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
	isSlice,
	isStackReview,
	isTriage,
	message,
	move,
	type Options,
	type Pass,
	partOf,
	REPO,
	RETRIAGE,
	start,
	TRIAGE_PRESET,
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
export const MILESTONE_KEY = "MAESTRO_TM_MILESTONE";
const TRIAGE_FILE = join(REPO, ".maestro/triage.ts");
const SLICE_FILE = join(REPO, ".maestro/slice.ts");
const REVIEW_FILE = join(REPO, ".maestro/review.ts");
/** The review tier a stack review rules at. */
const STACK_REVIEW_PRESET = "risky";
/** How a slice's agent reports it blocked (GLOSSARY.md, Blocked). */
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
async function load(pass: Pass): Promise<Entry[] | undefined> {
	const issues = (await pass.forge.open({ milestone: pass.milestone })).filter(
		(i) => i.milestone === pass.milestoneId,
	);
	const entries: Entry[] = [];
	for (const issue of issues) {
		const comments = await pass.forge.comments(issue.number);
		try {
			const data = dataOf(specCommentOf(comments)?.body ?? "");
			entries.push({ issue, comments, data });
		} catch (error) {
			await halt(
				pass,
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
async function liveOriginal(pass: Pass, number: number, result: Triage) {
	const { duplicateOf: original, ...rest } = result;
	if (result.verdict !== "duplicate" || original === undefined) return result;
	const found = await pass.forge.issue(original).catch(() => undefined);
	const ask = untracked(number, original, found);
	if (!ask) return result;
	const question = { ask, options: [], context: [] };
	return { ...rest, verdict: "needs-info" as const, questions: [question] };
}

/**
 * Posts the questions of `data`'s routed result on `number`, sets its labels, closes a duplicate, then clears
 * `pending`.
 */
async function apply(pass: Pass, number: number, data: Data, result: Triage) {
	const state = VERDICT_STATE[result.verdict];
	if (result.questions.length)
		await ask(
			pass,
			number,
			questionOf(result.questions, replyHow(result.questions, pass.login)),
		);
	const { labels } = await pass.forge.issue(number);
	await pass.forge.setLabels(number, triaged(labels, result));
	if (result.verdict === "duplicate")
		await pass.forge.edit(number, { closed: true });
	await writeSpec(pass, number, state, { ...data, pending: undefined });
	pass.say(`routed #${number} to ${state}`);
}

/** Routes triage `id`'s settle onto `issue` (factory.md, Routing a settle), and returns false when it halted. */
async function settle(pass: Pass, { issue, data }: Entry, id: string) {
	const triaged = triageOf(await pass.maestro.result(id));
	const result =
		typeof triaged === "string"
			? triaged
			: await liveOriginal(pass, issue.number, triaged);
	const state = stateOf(issue) ?? "needs-triage";
	if (typeof result === "string") {
		const [what, ...why] = result.split(": ");
		// The replies it was fed go to the next triage again, since an encore continues the last ok one.
		await writeSpec(pass, issue.number, state, {
			...data,
			concert: id,
			read: undefined,
		});
		await halt(
			pass,
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
		specAt: Date.now(),
	};
	await writeSpec(pass, issue.number, VERDICT_STATE[result.verdict], {
		...routed,
		pending: true,
	});
	await apply(pass, issue.number, routed, result);
	return true;
}

/** Files each of `texts` as a `needs-triage` bug found by `issue`, unless an open issue carries it. */
async function fileReports(pass: Pass, issue: Issue, texts: readonly string[]) {
	const bodies = (await pass.forge.open({})).map((i) => i.body);
	for (const text of texts) {
		const line = fingerprintLine(text);
		if (bodies.some((b) => b.includes(line))) continue;
		const filed = reportIssue(text, issue.number);
		const number = await pass.forge.file({
			...filed,
			milestone: issue.milestone,
			labels: ["state/needs-triage", "kind/bug"],
		});
		bodies.push(filed.body);
		pass.say(`filed #${number}, found by #${issue.number}`);
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
async function block(pass: Pass, number: number) {
	const questions = [
		{ ask: BLOCKED_ASK, options: BLOCKED_OPTIONS, context: [] },
	];
	await ask(
		pass,
		number,
		questionOf(questions, replyHow(questions, pass.login, YOUR_CHOICE)),
	);
}

/**
 * Halts the tour manager on slice `id` of `entry` that failed to run, requeuing the ticket to `ready-for-agent` with
 * its attempts kept and no concert to continue (factory.md, Rules, Policy: Halt).
 */
async function haltSlice(
	pass: Pass,
	{ issue, data }: Entry,
	id: string,
	reason: string,
) {
	await move(pass, issue.number, "ready-for-agent");
	await writeSpec(pass, issue.number, "ready-for-agent", {
		...data,
		concert: id,
		failure: reason,
		encore: undefined,
		revisionBase: undefined,
	});
	await halt(
		pass,
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
	pass: Pass,
	entry: Entry,
	id: string,
	status: string,
	reason: string,
) {
	const { issue, data } = entry;
	const blocked = status === "failed" && reason.startsWith(BLOCKED);
	if (status === "failed" && !blocked) {
		await haltSlice(pass, entry, id, reason);
		return false;
	}
	const attempts = (data.attempts ?? 0) + (blocked ? 0 : 1);
	const waits = blocked || attempts >= ATTEMPTS;
	const state = waits ? "needs-info" : "ready-for-agent";
	if (blocked) await block(pass, issue.number);
	await move(pass, issue.number, state);
	await writeSpec(pass, issue.number, state, {
		...data,
		concert: id,
		attempts: attempts || undefined,
		failure: reason,
		...(waits ? { encore: id } : UNCONTINUED),
	});
	pass.say(`routed #${issue.number}'s slice to ${state}: ${reason}`);
	return true;
}

/**
 * Routes slice `id`'s settle onto `entry` (factory.md, Routing a settle), after filing its reports; false when it
 * halted.
 */
async function settleSlice(pass: Pass, entry: Entry, id: string) {
	const [result, report] = await Promise.all([
		pass.maestro.result(id),
		pass.maestro.report(id),
	]);
	await fileReports(pass, entry.issue, report.obstacles);
	if (result.status === "ok") return land(pass, entry, id, report);
	const reason = result.reason ?? `settled ${result.status}`;
	return fail(pass, entry, id, result.status, reason);
}

/** The newest triage, slice or stack review of `entry`'s tour the tick has yet to route. */
function unrouted(pass: Pass, { issue, data }: Entry) {
	const tour = tourOf(pass.milestone, issue.number);
	const concert = pass.concerts.find(
		(c) => c.tour === tour && (isSlice(c) || isTriage(c) || isStackReview(c)),
	);
	return concert?.id === data.concert ? undefined : concert;
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
async function park(pass: Pass, { issue, data }: Entry, concert: Concert) {
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
	await ask(pass, issue.number, whichWay(lead, options));
	await move(pass, issue.number, "needs-info");
	await writeSpec(pass, issue.number, "needs-info", {
		...data,
		encore: undefined,
		concert: concert.id,
		...(slice ? { parked: concert.id } : await dropped(pass, concert.id)),
	});
	pass.say(`parked #${issue.number}'s concert ${concert.id} in needs-info`);
}

/** The data a dropped triage `id` leaves: no stale result, and `id` as the triage to continue when it settled ok. */
async function dropped(pass: Pass, id: string): Promise<Data> {
	const ok = typeof triageOf(await pass.maestro.result(id)) !== "string";
	return { result: undefined, ...(ok ? { triage: id } : {}) };
}

/**
 * Routes the parked concert of `entry` once the owner chose: applies it in `in-progress`, waits in `needs-info`, and
 * clears it on any other move; false when it halted.
 */
async function unpark(pass: Pass, entry: Entry, parked: string) {
	const { issue } = entry;
	const state = stateOf(issue) ?? "needs-triage";
	if (state === "needs-info") return true;
	const data = { ...entry.data, parked: undefined };
	if (state === "in-progress")
		return settleSlice(pass, { ...entry, data }, parked);
	await writeSpec(pass, issue.number, state, data);
	pass.say(`cleared #${issue.number}'s parked concert ${parked}`);
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

/** A stack review's findings as Markdown: its consolidator's review, else the findings its verdict blocks on. */
const findingsText = ({ review, blocking = [] }: Report) =>
	review ?? blocking.map((b) => `- ${b}`).join("\n");

/** Arms the PR to `main` of `child`, the last child of a cleared stack review, unless its own review left findings. */
async function armLast(pass: Pass, { issue, data }: Entry) {
	const report = data.concert && (await pass.maestro.report(data.concert));
	if (report && unresolvedOf(report.upheld)) return;
	const pull = pullToMain(await pass.forge.pulls(), issue.number);
	if (pull) await pass.forge.arm(pull.number);
}

/**
 * Records the findings of stack review `id` on `epic`, then feeds them to the encore of its `last` child, or files each
 * as a report when no one child is open.
 */
async function routeFindings(
	pass: Pass,
	epic: Issue,
	id: string,
	last: Entry | undefined,
) {
	const report = await pass.maestro.report(id);
	const review = findingsText(report);
	if (!last) {
		await ask(
			pass,
			epic.number,
			reviewComment(
				id,
				review,
				"No one child is open to take them, so each finding is filed as an issue.",
			),
		);
		return fileReports(pass, epic, report.blocking ?? []);
	}
	const { issue, data } = last;
	await ask(
		pass,
		epic.number,
		reviewComment(
			id,
			review,
			`Its findings go to the next encore of #${issue.number}.`,
		),
	);
	await writeSpec(pass, issue.number, stateOf(issue) ?? "in-review", {
		...data,
		findings: id,
	});
}

/**
 * Routes stack review `id` of epic `entry` (factory.md, Routing a settle): an ok one arms the last child when low, a
 * rejected one routes its findings, any other halts and runs again once the halt closes. Returns false when it halted.
 */
async function settleReview(
	pass: Pass,
	{ issue, data }: Entry,
	id: string,
	entries: Entry[],
) {
	const state = stateOf(issue) ?? "in-progress";
	const result = await pass.maestro.result(id);
	if (result.status !== "ok" && result.status !== "rejected") {
		await writeSpec(pass, issue.number, state, {
			...data,
			concert: id,
			stackReview: undefined,
		});
		await halt(
			pass,
			`stack review of #${issue.number} failed`,
			`The stack review \`${id}\` of #${issue.number} settled ${result.status}:`,
			result.reason ?? "no reason given",
			`Read it with \`maestro ls ${id}\`. Closing this issue runs the review again.`,
		);
		return false;
	}
	const last = lastChild(data, entries);
	if (result.status === "rejected") await routeFindings(pass, issue, id, last);
	else if (
		last &&
		stateOf(last.issue) === "in-review" &&
		isLow(last.issue, last.data)
	)
		await armLast(pass, last);
	await writeSpec(pass, issue.number, state, {
		...data,
		concert: id,
		stackReview: id,
	});
	pass.say(`routed #${issue.number}'s stack review ${id}: ${result.status}`);
	return true;
}

/** Routes one issue's newest concert the tick has not routed yet, or its parked one; false when it halted. */
async function routeOne(pass: Pass, entry: Entry, entries: Entry[]) {
	if (entry.data.parked) return unpark(pass, entry, entry.data.parked);
	const concert = unrouted(pass, entry);
	if (!concert) return true;
	if (isStackReview(concert))
		return settleReview(pass, entry, concert.id, entries);
	if (!expected(concert, entry.issue)) {
		await park(pass, entry, concert);
		return true;
	}
	return isSlice(concert)
		? settleSlice(pass, entry, concert.id)
		: settle(pass, entry, concert.id);
}

/** Routes each issue's settles, then the newest concert when it is a masterclass; false when it halted. */
async function route(pass: Pass, entries: Entry[]) {
	for (const entry of entries)
		if (!(await routeOne(pass, entry, entries))) return false;
	await routeMasterclass(pass);
	return true;
}

const scopeOf = (label: string) => label.split("/")[0];

/**
 * Files child `child` of `epic` unless `entries` hold it, else gives it any label scope it lacks; returns its number.
 */
async function fileChild(
	{ forge }: Pass,
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
async function fileSplit(pass: Pass, { issue, data }: Entry, entries: Entry[]) {
	const filed: number[] = [];
	for (const child of data.result?.children ?? []) {
		const number = await fileChild(pass, issue, child, entries);
		for (const blocker of child.dependsOn.map((d) => filed[d]))
			if (blocker !== undefined) await pass.forge.depend(number, blocker);
		filed.push(number);
	}
	await writeSpec(pass, issue.number, "in-progress", {
		...data,
		filed,
		base: data.base ?? (await pass.forge.head(BASE)),
	});
	const { labels } = await pass.forge.issue(issue.number);
	await pass.forge.setLabels(
		issue.number,
		relabelled(labels, ["state", "kind"], ["state/in-progress", "kind/epic"]),
	);
	pass.say(`filed #${issue.number}'s children: ${filed.join(", ")}`);
}

/** Closes epic `issue` once every child in `filed` has closed (factory.md, Rules, Triage: Splits). */
async function closeEpic(
	pass: Pass,
	issue: Issue,
	filed: number[],
	entries: Entry[],
) {
	if (entries.some((e) => filed.includes(e.issue.number))) return;
	const children = await Promise.all(filed.map((n) => pass.forge.issue(n)));
	if (children.some((c) => c.closed === undefined)) return;
	await pass.forge.edit(issue.number, { closed: true });
	pass.say(`closed epic #${issue.number}, its children all closed`);
}

/**
 * Sets the labels of a routed result a cut pass left unset, files a split the owner approved, closes an epic whose
 * children all closed, or restacks a stacked PR whose blocker closed; false when it halted.
 */
async function syncOne(pass: Pass, entry: Entry, entries: Entry[]) {
	const { issue, data } = entry;
	const state = stateOf(issue);
	if (data.pending && data.result)
		await apply(pass, issue.number, data, data.result);
	else if (state === "ready-for-agent" && data.result?.children)
		await fileSplit(pass, entry, entries);
	else if (state === "in-progress" && data.filed)
		await closeEpic(pass, issue, data.filed, entries);
	else if (state === "in-review" && data.stack)
		return restack(pass, entry, data.stack);
	return true;
}

/** Syncs each issue (factory.md, One tick: sync); false when it halted. */
async function sync(pass: Pass, entries: Entry[]) {
	for (const entry of entries)
		if (!(await syncOne(pass, entry, entries))) return false;
	return true;
}

type Perform = { request: string; encore?: string; data: Data };

/**
 * Performs `perform` for `entry` at its risk's tier, cut at its PR's head and revising that commit when it revises,
 * else on `stack`'s commit when it stacks, and moves it to `in-progress`; halts on a refusal.
 */
async function startSlice(
	pass: Pass,
	{ issue, data }: Entry,
	stack: Stack | undefined,
	perform: Perform,
) {
	const result = data.result;
	if (!result) return;
	const tier = tierOf(issue, result);
	const { revisionBase } = perform.data;
	const cut = revisionBase ?? stack?.commit;
	const name = issue.labels
		.find((l) => l.startsWith("area/"))
		?.slice("area/".length);
	const area =
		name && pass.has(`.maestro/presets/area-${name}.yaml`)
			? ["--preset", `area-${name}`]
			: [];
	const id = await start(pass, `build of #${issue.number}`, [
		...(perform.encore ? ["encore", perform.encore] : ["perform", SLICE_FILE]),
		"--request",
		perform.request,
		"--tier",
		tier,
		"--preset",
		tier,
		...area,
		...pass.presets.flatMap((p) => ["--preset", p]),
		"--tour",
		tourOf(pass.milestone, issue.number),
		"--title",
		titleOf(issue),
		"--revises",
		revisionBase ? `${revisionBase}^!` : "",
		...(cut ? ["-c", `target.base=${cut}`] : []),
	]);
	if (id === undefined) return;
	await move(pass, issue.number, "in-progress");
	await writeSpec(pass, issue.number, "in-progress", {
		...perform.data,
		slice: id,
		stack,
	});
	pass.say(`building #${issue.number}: concert ${id}`);
}

/** Blocker issue `blocker`'s PR among `pulls` when the issue is `in-review` and the PR merges into `main`. */
async function reviewed(forge: Forge, blocker: number, pulls: Pull[]) {
	const pull = pullToMain(pulls, blocker);
	if (!pull || stateOf(await forge.issue(blocker)) !== "in-review") return;
	const stack: Stack = { blocker, commit: pull.sha, pull: pull.number };
	return stack;
}

/**
 * Where issue `number` builds (factory.md, Rules, Build: Dependencies): on `main` with no open blocker, stacked on the
 * newest blocker PR's head when each blocker is in review on a PR to `main`, else undefined, as it waits.
 */
async function baseOf(
	{ forge }: Pass,
	number: number,
): Promise<{ stack?: Stack } | undefined> {
	const blockers = await forge.blockers(number);
	if (!blockers.length) return {};
	const pulls = await forge.pulls();
	const found = await Promise.all(
		blockers.map((b) => reviewed(forge, b, pulls)),
	);
	const stacks = found.filter((s) => s !== undefined);
	if (stacks.length < blockers.length) return undefined;
	const [newest] = stacks.sort((a, b) => b.pull - a.pull);
	return newest && { stack: newest };
}

/**
 * What a build of ready `entry` performs: an encore of its concert to continue, fed the replies mentioning the login
 * newer than `read`, else a fresh slice, since an encore with nothing changed is refused
 * (factory.md, Rules, Build: Encore).
 */
async function performOf(
	pass: Pass,
	{ issue, comments, data }: Entry,
	spec: Spec,
): Promise<Perform> {
	const request = requestOf(issue, spec);
	const fresh = { request, data: { ...data, revisionBase: undefined } };
	if (!data.encore) return fresh;
	const considered = repliesOf(comments, data.read);
	const changes = considered
		.filter((c) => isReply(c, pass.login))
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

/**
 * The encore of in-review `entry`'s landed concert its PR among `pulls` asks for with changes requested, or its stack
 * review's `findings` ask for, if any. It is fed each review above `review` and the findings, moves `review` to the
 * newest, clears `findings`, and records the PR's head as `revisionBase`: the commit the build is cut at, over a
 * stack's, and lands folded into, so the PR keeps one commit per ticket and its base.
 */
async function revision(
	pass: Pass,
	{ issue, data }: Entry,
	pulls: readonly Pull[],
): Promise<Perform | undefined> {
	const pull = pulls.find((p) => p.head === branchOf(issue.number));
	const spec = data.result?.spec;
	if (!pull || !spec || !data.concert) return undefined;
	const reviews = requested(
		await pass.forge.reviews(pull.number, data.review ?? 0),
		data,
	);
	const changes = reviews.map(reviewChange);
	if (data.findings)
		changes.push({
			heading: "Stack review",
			body: findingsText(await pass.maestro.report(data.findings)),
		});
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
			revisionBase: pull.sha,
		},
	};
}

/**
 * Starts the encore of the oldest in-review ticket with changes requested where a build would; true when it started
 * none.
 */
async function revise(pass: Pass, entries: Entry[]) {
	const reviewed = entries
		.filter((e) => stateOf(e.issue) === "in-review")
		.sort((a, b) => a.issue.number - b.issue.number);
	if (!reviewed.length) return true;
	const pulls = await pass.forge.pulls();
	for (const entry of reviewed) {
		const perform = await revision(pass, entry, pulls);
		const base = perform && (await baseOf(pass, entry.issue.number));
		if (!perform || !base) continue;
		await startSlice(pass, entry, entry.data.stack, perform);
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
async function stackReview(pass: Pass, entries: Entry[]) {
	let found: Promise<Pull[]> | undefined;
	const pulls = () => (found ??= pass.forge.pulls());
	for (const entry of entries) {
		const pull = await reviewDue(entry, entries, pulls);
		if (!pull) continue;
		await startReview(pass, entry, `${entry.data.base}..${pull.sha}`);
		return false;
	}
	return true;
}

/** Performs the stack review of epic `entry` over the commits `revs` names, and records it; halts on a refusal. */
async function startReview(pass: Pass, { issue, data }: Entry, revs: string) {
	const id = await start(pass, `stack review of #${issue.number}`, [
		"perform",
		REVIEW_FILE,
		"--request",
		reviewRequest(issue, data.result?.children ?? [], data.filed ?? []),
		"--revs",
		revs,
		"--preset",
		STACK_REVIEW_PRESET,
		...pass.presets.flatMap((p) => ["--preset", p]),
		"--tour",
		tourOf(pass.milestone, issue.number),
		"--title",
		titleOf(issue),
	]);
	if (id === undefined) return;
	await writeSpec(pass, issue.number, "in-progress", {
		...data,
		stackReview: id,
	});
	pass.say(`reviewing #${issue.number}'s stack: concert ${id}`);
}

/** Says in the spec comment of ready `entry` which open dependencies it waits on, writing only when that changes it. */
async function queue(pass: Pass, { issue, comments, data }: Entry) {
	const waiting = (await pass.forge.blockers(issue.number)).sort(
		(a, b) => a - b,
	);
	const comment = commentOf(data, "ready-for-agent", pass.login, waiting);
	if (specCommentOf(comments)?.body.trim() === comment.trim()) return;
	await writeSpec(pass, issue.number, "ready-for-agent", data, waiting);
}

/** The states whose tickets hold a spec the owner approved. */
const APPROVED: readonly State[] = [
	"ready-for-agent",
	"in-progress",
	"in-review",
];

/** Closed issue `issue` as an approval at its close, undefined when it closed undone or its spec cannot be read. */
async function closedApproval(
	{ forge }: Pass,
	issue: Issue,
): Promise<Approval | undefined> {
	if (
		issue.closed === undefined ||
		NOT_DONE.some((l) => issue.labels.includes(l))
	)
		return undefined;
	const comment = specCommentOf(await forge.comments(issue.number));
	try {
		const touches = dataOf(comment?.body ?? "").result?.spec?.touches;
		return touches && { number: issue.number, at: issue.closed, touches };
	} catch {
		return undefined;
	}
}

/**
 * Every ticket whose spec the owner approved or that closed as completed, with when its spec was written (`specAt`)
 * or the forge's `closed_at` says it closed (factory.md, Rules, Build: Stale spec). A routed triage stamps `specAt`
 * with the tick's clock; rewriting the spec comment does not. A ticket whose data holds no `specAt` is left out.
 */
async function approvals(pass: Pass, entries: Entry[]): Promise<Approval[]> {
	const open = entries.flatMap(({ issue, data }) => {
		const state = stateOf(issue);
		const touches = data.result?.spec?.touches;
		return state &&
			APPROVED.includes(state) &&
			touches &&
			data.specAt !== undefined
			? [{ number: issue.number, at: data.specAt, touches }]
			: [];
	});
	const closed = await Promise.all(
		(await pass.closed()).map((i) => closedApproval(pass, i)),
	);
	return [...open, ...closed.filter((a) => a !== undefined)];
}

/** The lead of the comment saying a spec predates the `found` approvals that share files with it. */
const staleLead = (found: ReturnType<typeof overlaps>) =>
	`The spec predates ${found
		.map(
			(o) =>
				`#${o.number}'s, which also touches ${o.files.map((f) => `\`${f}\``).join(", ")}`,
		)
		.join(" and ")}. Re-triaging against current main.`;

/**
 * Moves ready `entry` to `needs-triage` with a question comment naming the tickets approved or closed after its spec
 * that touch the same files, and returns true; false when it shares none, or holds no `specAt`, and builds
 * (factory.md, Rules, Build: Stale spec).
 */
async function retriage(
	pass: Pass,
	{ issue, data }: Entry,
	spec: Spec,
	approved: () => Promise<Approval[]>,
) {
	if (data.specAt === undefined) return false;
	const others = (await approved()).filter((a) => a.number !== issue.number);
	const found = overlaps(spec.touches, data.specAt, others);
	if (!found.length) return false;
	await ask(
		pass,
		issue.number,
		questionOf(
			[{ ask: staleLead(found), options: [], context: [] }],
			"No reply needed: the next tick triages it again.",
		),
		data.read,
	);
	await move(pass, issue.number, "needs-triage");
	await writeSpec(pass, issue.number, "needs-triage", data);
	pass.say(`#${issue.number}: spec is stale, moved to needs-triage`);
	return true;
}

/**
 * Finishes work first: continues a ticket with changes requested, else builds the first buildable issue, pinned ones
 * first, that its blockers let build and whose spec is not stale; true when it started none.
 */
async function build(pass: Pass, entries: Entry[]) {
	if (!(await revise(pass, entries))) return false;
	let approved: Promise<Approval[]> | undefined;
	const approvedOnce = () => (approved ??= approvals(pass, entries));
	for (const entry of buildable(entries, await pass.forge.pinned())) {
		const spec = entry.data.result?.spec;
		const base = await baseOf(pass, entry.issue.number);
		if (!spec) continue;
		if (!base) {
			await queue(pass, entry);
			continue;
		}
		const perform = await performOf(pass, entry, spec);
		if (!perform.encore && (await retriage(pass, entry, spec, approvedOnce)))
			continue;
		await startSlice(pass, entry, base.stack, perform);
		return false;
	}
	return true;
}

/** Asks for the reply a re-triage of `entry` needs, then moves it to `needs-info` with `read` past that question. */
async function askReply(pass: Pass, { issue, data }: Entry) {
	const questions = [
		{
			ask: `What changed since the last triage? No reply mentions \`@${pass.login}\` yet.`,
			options: [],
			context: [],
		},
	];
	const how = `Reply \`@${pass.login} …\`, then label \`needs-triage\`.`;
	const read = await pass.forge.comment(
		issue.number,
		questionOf(questions, how),
	);
	await move(pass, issue.number, "needs-info");
	await writeSpec(pass, issue.number, "needs-info", { ...data, read });
	pass.say(
		`#${issue.number}: no reply since the last triage, moved to needs-info`,
	);
}

/** How the forge answers for an issue number it does not have. */
const MISSING = /^forge: 404 /;

/** The closed issues `text` cites but `issue`; a number the forge does not have is skipped. */
async function closedCited(pass: Pass, issue: number, text: string) {
	const cited = await Promise.all(
		citedIn(text)
			.filter((n) => n !== issue)
			.map((n) =>
				pass.forge.issue(n).catch((error: unknown) => {
					if (MISSING.test(message(error))) return undefined;
					throw error;
				}),
			),
	);
	return cited.filter((i): i is Issue => i?.closed !== undefined);
}

/**
 * Starts triage of the first intake issue, pinned ones first, on its ask and the comments since the last triage read
 * that it is fed, an encore of its last triage when it has one, respecced when that triage's spec has requirements,
 * then records the newest comment it considered; halts on a refusal. A re-triage with nothing new to feed asks for a reply instead. True only when it started nothing, so a
 * masterclass may follow.
 */
async function triage(pass: Pass, entries: Entry[]) {
	const issue = pick(
		entries.filter((e) => !e.data.pending).map((e) => e.issue),
		await pass.forge.pinned(),
	);
	const entry = entries.find((e) => e.issue === issue);
	if (!entry) {
		pass.say("nothing to triage");
		return true;
	}
	const { data, comments } = entry;
	const { number } = entry.issue;
	const considered = repliesOf(comments, data.read);
	if (data.triage && !considered.some((c) => isFed(c, pass.login))) {
		await askReply(pass, entry);
		return true;
	}
	const last = data.triage ? data.result?.spec : undefined;
	const text = issueText(
		entry.issue,
		considered.filter((c) => isFed(c, pass.login)),
		pass.login,
		last,
	);
	const [closed, pulls, cited] = await Promise.all([
		pass.closed(),
		pass.forge.pulls(),
		closedCited(pass, number, text),
	]);
	const issues = entries.map((e) => e.issue);
	const backlog = join(pass.dir, `backlog-i${number}.md`);
	await Bun.write(
		backlog,
		snapshot(pass.milestone, number, issues, closed, pulls, cited),
	);
	const id = await start(pass, `triage of #${number}`, [
		...(data.triage ? ["encore", data.triage] : ["perform", TRIAGE_FILE]),
		"--issue",
		text,
		"--backlog",
		backlog,
		last?.requirements?.length ? "--respec" : "--no-respec",
		"--tour",
		tourOf(pass.milestone, number),
		"--title",
		titleOf(entry.issue),
		"--preset",
		TRIAGE_PRESET,
		...pass.presets.flatMap((p) => ["--preset", p]),
	]);
	if (id === undefined) return false;
	pass.say(`triaging #${number}: concert ${id}`);
	const read = considered.at(-1)?.id;
	if (read !== undefined)
		await writeSpec(pass, number, stateOf(entry.issue) ?? "needs-triage", {
			...data,
			read,
		});
	return false;
}

/**
 * One pass: no action when another pass holds the lock, the tour manager is halted or a concert of the milestone runs;
 * else it routes settled concerts and a settled masterclass, syncs, and starts one stack review, else one build, else
 * one triage, else a masterclass once due, or none under `routeOnly`. Each step returns whether the pass goes on.
 * @throws Error when the milestone does not exist, or the forge or maestro fails or answers what the tick cannot read.
 */
export async function pass(deps: Deps, options: Options): Promise<void> {
	if (!deps.lock()) return deps.say("another pass holds the lock");
	const halts = await deps.forge.open({ label: HALT });
	if (halts.some((i) => i.labels.includes(HALT)))
		return deps.say(`halted: close the open ${HALT} issue to resume`);
	const milestoneId = await deps.forge.milestone(options.milestone);
	if (milestoneId === undefined)
		throw new Error(
			`no milestone ${options.milestone} upstream\nCreate it, or set ${MILESTONE_KEY} or --milestone to an existing one`,
		);
	const concerts = await deps.maestro.concerts(options.milestone);
	const running = concerts.find((c) => c.status === "running");
	if (running) return deps.say(`concert ${running.id} is still running`);
	const login = await deps.forge.login();
	let closed: Promise<Issue[]> | undefined;
	const pass: Pass = {
		...deps,
		...options,
		milestoneId,
		concerts,
		login,
		closed: () => (closed ??= deps.forge.closed(CLOSED)),
	};
	const steps = options.routeOnly
		? [route, sync]
		: [route, sync, stackReview, build, triage, masterclass];
	for (const step of steps) {
		const entries = await load(pass);
		if (!entries || !(await step(pass, entries))) return;
	}
	if (options.routeOnly)
		pass.say("route-only: routed and synced, started nothing");
}

/**
 * The milestone a pass serves: `flag` when non-empty, else `MAESTRO_TM_MILESTONE` from `env` when non-empty.
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
	let values: { milestone?: string; preset?: string[]; "route-only"?: boolean };
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
		const tm = forge();
		const account = await tm.account();
		await pass(
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
