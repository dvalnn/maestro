// One pass of the tour manager (docs/agents/factory.md, zoom 1): it routes settles, builds a ready ticket or triages one.
import { dlopen, FFIType, read } from "bun:ffi";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type Comment,
	type Forge,
	forge,
	type Issue,
	type NewPull,
	type Pull,
} from "./forge";
import { type Landing, landing } from "./land";
import {
	type Concert,
	type Maestro,
	maestro,
	type Report,
	type Result,
} from "./maestro";
import {
	buildable,
	isIntake,
	issueText,
	pick,
	riskOf,
	snapshot,
	stateOf,
	tierOf,
	titleOf,
	tourOf,
} from "./pick";
import {
	ATTEMPTS,
	type Child,
	commentOf,
	type Data,
	dataOf,
	fenced,
	fingerprintLine,
	isFed,
	type Option,
	parseTriage,
	pullBody,
	questionOf,
	relabelled,
	repliesOf,
	replyHow,
	reportIssue,
	requestOf,
	type Stack,
	specCommentOf,
	type Triage,
	tracked,
	triaged,
	VERDICT_STATE,
} from "./route";
import type { State } from "./transitions";

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const LOCK_EX = 2;
const LOCK_NB = 4;
/** Linux's EWOULDBLOCK, which is EAGAIN. */
const EWOULDBLOCK = 11;
export const HALT = "maestro-tm:halt";
const REPO = resolve(import.meta.dir, "../..");
const TRIAGE_FILE = join(REPO, ".maestro/triage.ts");
const SLICE_FILE = join(REPO, ".maestro/slice.ts");
/** A bare composition file's pack is its stem. */
const TRIAGE = { pack: "triage", composition: "triage" };
const SLICE = { pack: "slice", composition: "slice" };
/** How a slice's agent reports it blocked (GLOSSARY.md, Blocked). */
const BLOCKED = "blocked:";
const BASE = "main";
/** The states a slice's settle is routed in; on an issue the owner moved elsewhere it is parked. */
const BUILDING: readonly State[] = ["in-progress", "ready-for-agent"];
/** How many closed issues the backlog snapshot lists. */
const CLOSED = 20;

export type Options = {
	milestone: string;
	/** The preset of each triage; a slice takes its tier's. */
	preset?: string;
	/** Where the pass keeps its snapshots and perform logs. */
	dir: string;
	/** Where the landing workspaces live. */
	cache: string;
};
export type Deps = {
	forge: Forge;
	maestro: Maestro;
	landing: Landing;
	/** Takes the pass's lock, false when another pass holds it. */
	lock: () => boolean;
	say: (line: string) => void;
};

type Entry = { issue: Issue; comments: Comment[]; data: Data };
/** One pass's view: `login` is the account the tick acts as on the forge. */
type Pass = Deps &
	Options & { milestoneId: number; concerts: Concert[]; login: string };

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

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const isTriage = (c: Concert) =>
	c.pack === TRIAGE.pack && c.composition === TRIAGE.composition;
const isSlice = (c: Concert) =>
	c.pack === SLICE.pack && c.composition === SLICE.composition;
const branchOf = (issue: number) => `maestro-tm/i${issue}`;

/** Files the halt issue: `lead`, then `detail` verbatim in a code block, then what to do next. */
async function halt(
	{ forge, say }: Deps,
	title: string,
	lead: string,
	detail: string,
	next?: string,
) {
	const halted = await forge.file({
		title: `Tour manager halted: ${title}`,
		body: [lead, fenced(detail), next, "Close this issue to lift the halt."]
			.filter(Boolean)
			.join("\n\n"),
		labels: [HALT],
	});
	say(`halted on #${halted}: ${title}`);
}

/**
 * Writes `data` to the spec comment of issue `number` for `state`, creating it on the first write, then rewrites the
 * closing line of its body when the comment is new or its version changed.
 */
async function writeSpec(
	{ forge, login }: Pass,
	number: number,
	state: State,
	data: Data,
) {
	const comment = commentOf(data, state, login);
	const found = specCommentOf(await forge.comments(number));
	if (found) await forge.editComment(found.id, comment);
	const id = found?.id ?? (await forge.comment(number, comment));
	const { body } = await forge.issue(number);
	const next = tracked(body, id, data);
	if (next !== body) await forge.edit(number, { body: next });
}

const WHICH_WAY = "Which way should this ticket go?";

/** The tick's question comment: `lead` says what happened, and each of `options` names a label to choose by. */
const whichWay = (lead: string, options: Option[]) =>
	questionOf(
		[{ ask: WHICH_WAY, lead, options, context: [] }],
		"Label the ticket with your choice.",
	);

/** Posts question comment `body` on issue `number` unless one holds it already, so a repeated pass posts it once. */
async function ask({ forge }: Deps, number: number, body: string) {
	const comments = await forge.comments(number);
	if (comments.some((c) => c.body.trim() === body.trim())) return;
	await forge.comment(number, body);
}

/** Moves issue `number` to `state`, keeping its other labels. */
async function move({ forge }: Deps, number: number, state: State) {
	const { labels } = await forge.issue(number);
	if (labels.includes(`state/${state}`)) return;
	await forge.setLabels(
		number,
		relabelled(labels, ["state"], [`state/${state}`]),
	);
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

/** Routes concert `id`'s settle onto `issue` (zoom 2), and returns false when it halted the tour manager. */
async function settle(pass: Pass, { issue, data }: Entry, id: string) {
	const result = triageOf(await pass.maestro.result(id));
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
		concert: id,
		triage: id,
		result,
		version: (data.version ?? 0) + 1,
	};
	await writeSpec(pass, issue.number, VERDICT_STATE[result.verdict], {
		...routed,
		pending: true,
	});
	await apply(pass, issue.number, routed, result);
	return true;
}

/** Files each obstacle and gap of `report` as a `needs-triage` issue found by `issue`, unless an open issue carries it. */
async function fileReports(pass: Pass, issue: Issue, report: Report) {
	const bodies = (await pass.forge.open({})).map((i) => i.body);
	const found = [
		...report.obstacles.map((text) => ({ text, kind: "kind/bug" })),
		...report.gaps.map((text) => ({ text, kind: "kind/enhancement" })),
	];
	for (const { text, kind } of found) {
		const line = fingerprintLine(text);
		if (bodies.some((b) => b.includes(line))) continue;
		const filed = reportIssue(text, issue.number);
		const number = await pass.forge.file({
			...filed,
			milestone: issue.milestone,
			labels: ["state/needs-triage", kind],
		});
		bodies.push(filed.body);
		pass.say(`filed #${number}, found by #${issue.number}`);
	}
}

/** Routes failed slice `id` of `entry`: blocked to `needs-info`, else red, spending an attempt (factory.md, Rules). */
async function fail(
	pass: Pass,
	{ issue, data }: Entry,
	id: string,
	reason: string,
) {
	const blocked = reason.startsWith(BLOCKED);
	const attempts = (data.attempts ?? 0) + (blocked ? 0 : 1);
	const state =
		blocked || attempts >= ATTEMPTS ? "needs-info" : "ready-for-agent";
	await move(pass, issue.number, state);
	await writeSpec(pass, issue.number, state, {
		...data,
		concert: id,
		attempts: attempts || undefined,
		failure: reason,
	});
	pass.say(`routed #${issue.number}'s slice to ${state}: ${reason}`);
}

/** The open PR of `pull.head`, retargeted to `pull.base` when it merges elsewhere, else a new one of `pull`. */
async function openPull(forge: Forge, pull: NewPull) {
	const open = (await forge.pulls()).find((p) => p.head === pull.head);
	if (!open) return forge.openPull(pull);
	if (open.base !== pull.base) await forge.retarget(open.number, pull.base);
	return open.number;
}

/** Whether `issue` is low risk, so its PR to `main` merges on its own (factory.md, Rules: Risk and tier). */
const isLow = (issue: Issue, { result }: Data) =>
	result !== undefined && riskOf(issue, result.risk) === "low";

/** Forgets and removes a landed workspace; a failure is a warning, since the next landing replaces a leftover. */
async function closeWorkspace(pass: Pass, dir: string, name: string) {
	try {
		await pass.landing.close(dir, name);
	} catch (error) {
		const [reason] = message(error).split("\n");
		pass.say(`could not remove workspace ${name} at ${dir}: ${reason}`);
	}
}

type Failure = { title: string; lead: string };

/**
 * Runs `work` in a fresh workspace of issue `number` on revision `base`, then removes it; undefined when it halted on
 * `failure`, keeping the workspace.
 */
async function inWorkspace<T>(
	pass: Pass,
	number: number,
	base: string,
	failure: Failure,
	work: (dir: string) => Promise<T>,
): Promise<T | undefined> {
	const name = `factory-i${number}`;
	const dir = join(pass.cache, `i${number}`);
	let done: T;
	try {
		await pass.landing.open(dir, name, base);
		done = await work(dir);
	} catch (error) {
		await halt(
			pass,
			failure.title,
			`${failure.lead} from the workspace \`${dir}\`:`,
			message(error),
			"Look at the workspace first: closing this issue lets the next tick replace it with a fresh one.",
		);
		return undefined;
	}
	await closeWorkspace(pass, dir, name);
	return done;
}

type PullText = Pick<NewPull, "title" | "body">;
/** Where a landing or restack leaves its issue: in review with its PR, stacked while `stack` is set, else asking. */
type Outcome = { pull: number; stack?: Stack } | { question: string };

/** The PR text of `issue`'s slice `concert`, with its `report` (factory.md, Rules: PRs). */
function pullText(issue: Issue, data: Data, concert: string, report: Report) {
	const result = data.result;
	if (!result?.spec) throw new Error(`#${issue.number} holds no spec`);
	const body = pullBody({
		issue: issue.number,
		concert,
		tokens: report.tokens,
		upheld: report.upheld ?? "None.",
		result,
	});
	return { title: result.spec.subject, body };
}

/**
 * Where `stack` stands for issue `number`: `open` while any blocker is open, else `merged` or `unmerged` by its
 * blocker's PR.
 */
async function stackState(forge: Forge, number: number, stack: Stack) {
	if ((await forge.blockers(number)).length) return "open";
	return (await forge.pull(stack.pull)).merged ? "merged" : "unmerged";
}

const unmerged = ({ blocker, pull }: Stack) =>
	`Blocker #${blocker} closed without merging its PR #${pull}, so this ticket's change, stacked on it, was not rebased onto \`${BASE}\`.`;

/** Pushes `commit` from `dir` as `entry`'s branch and opens or retargets its PR into `base`, arming a low one to `main`. */
async function publish(
	pass: Pass,
	entry: Entry,
	dir: string,
	commit: string,
	pull: NewPull,
) {
	await pass.forge.push(dir, commit, pull.head);
	const number = await openPull(pass.forge, pull);
	if (pull.base === BASE && isLow(entry.issue, entry.data))
		await pass.forge.arm(number);
	return number;
}

/** Copies `revision` of `entry` alone onto `main` in the workspace at `dir` and publishes it there; a conflict asks. */
async function restackIn(
	pass: Pass,
	entry: Entry,
	dir: string,
	revision: string,
	text: PullText,
): Promise<Outcome> {
	const restacked = await pass.landing.restack(dir, revision, BASE);
	if ("conflict" in restacked)
		return {
			question: `This ticket's change conflicts with \`${BASE}\` once rebased onto it:\n\n${fenced(restacked.conflict)}`,
		};
	const head = branchOf(entry.issue.number);
	const pull = { ...text, head, base: BASE };
	return { pull: await publish(pass, entry, dir, restacked.commit, pull) };
}

/**
 * Writes `outcome` of `entry`'s landed slice `concert` back: `in-review` with its PR, else `needs-info` with a question
 * comment asking which way.
 */
async function record(
	pass: Pass,
	{ issue, data }: Entry,
	concert: string | undefined,
	outcome: Outcome,
) {
	const landed = { ...data, concert, failure: undefined, stack: undefined };
	if ("question" in outcome) {
		const options = [
			{ label: "`ready-for-agent`", text: `build it again on \`${BASE}\`` },
			{ label: "`needs-triage`", text: "triage it again" },
		];
		await ask(pass, issue.number, whichWay(outcome.question, options));
		await move(pass, issue.number, "needs-info");
		await writeSpec(pass, issue.number, "needs-info", landed);
		pass.say(`asked on #${issue.number}: ${outcome.question.split("\n")[0]}`);
		return;
	}
	await move(pass, issue.number, "in-review");
	await writeSpec(pass, issue.number, "in-review", {
		...landed,
		stack: outcome.stack,
	});
	pass.say(`#${issue.number} is in review as PR #${outcome.pull}`);
}

/**
 * Applies ok slice `id` of `entry` in the workspace at `dir` and publishes it: to `main`, to its blocker's branch while
 * a blocker is open, else restacked onto `main` (factory.md, Rules: Blockers).
 */
async function landIn(
	pass: Pass,
	entry: Entry,
	id: string,
	report: Report,
	dir: string,
): Promise<Outcome> {
	const { issue, data } = entry;
	const text = pullText(issue, data, id, report);
	await pass.maestro.apply(id, dir);
	const commit = await pass.landing.describe(
		dir,
		`${text.title}\n\nCloses #${issue.number}\n`,
	);
	const head = branchOf(issue.number);
	const { stack } = data;
	if (!stack)
		return {
			pull: await publish(pass, entry, dir, commit, {
				...text,
				head,
				base: BASE,
			}),
		};
	const state = await stackState(pass.forge, issue.number, stack);
	if (state === "unmerged") return { question: unmerged(stack) };
	if (state === "merged") return restackIn(pass, entry, dir, commit, text);
	const base = branchOf(stack.blocker);
	const pull = { ...text, head, base };
	return { pull: await publish(pass, entry, dir, commit, pull), stack };
}

/**
 * Lands ok slice `id` of `entry` in a fresh workspace on its base, then records where it left the issue; false when it
 * halted, keeping the workspace.
 */
async function land(pass: Pass, entry: Entry, id: string, report: Report) {
	const { issue, data } = entry;
	const outcome = await inWorkspace(
		pass,
		issue.number,
		data.stack?.commit ?? BASE,
		{
			title: `landing of #${issue.number} failed`,
			lead: `The slice concert \`${id}\` of #${issue.number} did not land`,
		},
		(dir) => landIn(pass, entry, id, report, dir),
	);
	if (!outcome) return false;
	await record(pass, entry, id, outcome);
	return true;
}

/** Routes slice `id`'s settle onto `entry` (zoom 2), after filing its reports; false when it halted. */
async function settleSlice(pass: Pass, entry: Entry, id: string) {
	const [result, report] = await Promise.all([
		pass.maestro.result(id),
		pass.maestro.report(id),
	]);
	await fileReports(pass, entry.issue, report);
	if (result.status === "ok") return land(pass, entry, id, report);
	await fail(pass, entry, id, result.reason ?? `settled ${result.status}`);
	return true;
}

/** The newest triage or slice of `entry`'s tour the tick has yet to route. */
function unrouted(pass: Pass, { issue, data }: Entry) {
	const tour = tourOf(pass.milestone, issue.number);
	const concert = pass.concerts.find(
		(c) => c.tour === tour && (isSlice(c) || isTriage(c)),
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
	const retriage = { label: "`needs-triage`", text: "triage it again" };
	const options = slice
		? [
				{ label: "`in-progress`", text: "apply the parked result" },
				{ label: "`ready-for-agent`", text: "build it again" },
				retriage,
			]
		: [retriage];
	await ask(pass, issue.number, whichWay(lead, options));
	await move(pass, issue.number, "needs-info");
	await writeSpec(pass, issue.number, "needs-info", {
		...data,
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

/** Routes one issue's newest concert the tick has not routed yet, or its parked one; false when it halted. */
async function routeOne(pass: Pass, entry: Entry) {
	if (entry.data.parked) return unpark(pass, entry, entry.data.parked);
	const concert = unrouted(pass, entry);
	if (!concert) return true;
	if (!expected(concert, entry.issue)) {
		await park(pass, entry, concert);
		return true;
	}
	return isSlice(concert)
		? settleSlice(pass, entry, concert.id)
		: settle(pass, entry, concert.id);
}

/** Routes each issue's settles; false when it halted. */
async function route(pass: Pass, entries: Entry[]) {
	for (const entry of entries) if (!(await routeOne(pass, entry))) return false;
	return true;
}

const firstLine = (body: string) => body.split("\n")[0]?.trimEnd();
const scopeOf = (label: string) => label.split("/")[0];

/** Files child `child` of `epic` unless `entries` hold it, else gives it any label scope it lacks; returns its number. */
async function fileChild(
	{ forge }: Pass,
	epic: Issue,
	child: Child,
	entries: Entry[],
) {
	const partOf = `Part of #${epic.number}`;
	const kinds = epic.labels.filter(
		(l) => l.startsWith("kind/") && l !== "kind/epic",
	);
	const labels = ["state/needs-triage", ...kinds];
	const open = entries.find(
		({ issue }) =>
			issue.title === child.title && firstLine(issue.body) === partOf,
	)?.issue;
	if (!open)
		return forge.file({
			title: child.title,
			body: `${partOf}\n\n${child.body}`,
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
	await writeSpec(pass, issue.number, "in-progress", { ...data, filed });
	const { labels } = await pass.forge.issue(issue.number);
	await pass.forge.setLabels(
		issue.number,
		relabelled(labels, ["state", "kind"], ["state/in-progress", "kind/epic"]),
	);
	pass.say(`filed #${issue.number}'s children: ${filed.join(", ")}`);
}

/** Restacks `entry`'s pushed branch onto `main` in a fresh workspace, with its landed concert's PR text. */
function restackBranch(pass: Pass, entry: Entry) {
	const { issue, data } = entry;
	const failure = {
		title: `restack of #${issue.number} failed`,
		lead: `The stacked change of #${issue.number} did not restack onto \`${BASE}\``,
	};
	return inWorkspace(pass, issue.number, BASE, failure, async (dir) => {
		if (!data.concert)
			throw new Error(`#${issue.number} holds no landed concert`);
		const report = await pass.maestro.report(data.concert);
		const text = pullText(issue, data, data.concert, report);
		return restackIn(
			pass,
			entry,
			dir,
			`${branchOf(issue.number)}@origin`,
			text,
		);
	});
}

/**
 * Restacks `entry`'s PR onto `main` once no blocker is open and its blocker's PR merged, or asks when that PR closed
 * unmerged (factory.md, Rules: Blockers); false when it halted.
 */
async function restack(pass: Pass, entry: Entry, stack: Stack) {
	const state = await stackState(pass.forge, entry.issue.number, stack);
	if (state === "open") return true;
	const outcome =
		state === "merged"
			? await restackBranch(pass, entry)
			: { question: unmerged(stack) };
	if (!outcome) return false;
	await record(pass, entry, entry.data.concert, outcome);
	return true;
}

/**
 * Sets the labels of a routed result a cut pass left unset, files a split the owner approved, or restacks a stacked PR
 * whose blocker closed; false when it halted.
 */
async function syncOne(pass: Pass, entry: Entry, entries: Entry[]) {
	const { issue, data } = entry;
	const state = stateOf(issue);
	if (data.pending && data.result)
		await apply(pass, issue.number, data, data.result);
	else if (state === "ready-for-agent" && data.result?.children)
		await fileSplit(pass, entry, entries);
	else if (state === "in-review" && data.stack)
		return restack(pass, entry, data.stack);
	return true;
}

/** Syncs each issue (zoom 1, note 2); false when it halted. */
async function sync(pass: Pass, entries: Entry[]) {
	for (const entry of entries)
		if (!(await syncOne(pass, entry, entries))) return false;
	return true;
}

/**
 * Starts a fresh slice of `entry`'s spec, at its risk's tier and on `stack`'s commit when it stacks, and moves it to
 * `in-progress`; halts on a refusal.
 */
async function startSlice(pass: Pass, { issue, data }: Entry, stack?: Stack) {
	const result = data.result;
	if (!result?.spec) return;
	const tier = tierOf(issue, result.risk);
	let id: string;
	try {
		id = await pass.maestro.start(
			[
				"perform",
				SLICE_FILE,
				"--request",
				requestOf(issue, result.spec),
				"--tier",
				tier,
				"--preset",
				tier,
				"--tour",
				tourOf(pass.milestone, issue.number),
				"--title",
				titleOf(issue),
				...(stack ? ["-c", `target.base=${stack.commit}`] : []),
			],
			join(pass.dir, `i${issue.number}.log`),
		);
	} catch (error) {
		await halt(
			pass,
			`build of #${issue.number} did not start`,
			`The build of #${issue.number} did not start:`,
			message(error),
		);
		return;
	}
	await move(pass, issue.number, "in-progress");
	await writeSpec(pass, issue.number, "in-progress", {
		...data,
		slice: id,
		stack,
	});
	pass.say(`building #${issue.number}: concert ${id}`);
}

/** Blocker issue `blocker`'s PR among `pulls` when the issue is `in-review` and the PR merges into `main`. */
async function reviewed(forge: Forge, blocker: number, pulls: Pull[]) {
	const pull = pulls.find(
		(p) => p.head === branchOf(blocker) && p.base === BASE,
	);
	if (!pull || stateOf(await forge.issue(blocker)) !== "in-review") return;
	const stack: Stack = { blocker, commit: pull.sha, pull: pull.number };
	return stack;
}

/**
 * Where issue `number` builds (factory.md, Rules: Blockers): on `main` with no open blocker, stacked on the newest
 * blocker PR's head when each blocker is in review on a PR to `main`, else undefined, as it waits.
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

/** Builds the oldest buildable issue its blockers let build; true when there was none. */
async function build(pass: Pass, entries: Entry[]) {
	for (const entry of buildable(entries)) {
		const base = await baseOf(pass, entry.issue.number);
		if (!base) continue;
		await startSlice(pass, entry, base.stack);
		return false;
	}
	return true;
}

/**
 * Starts triage of the oldest intake issue on its ask and the comments since the last triage read that it is fed, an
 * encore of its last triage when it has one, then records the newest comment it considered; halts on a refusal.
 */
async function triage(pass: Pass, entries: Entry[]) {
	const issue = pick(
		entries.filter((e) => !e.data.pending).map((e) => e.issue),
	);
	const entry = entries.find((e) => e.issue === issue);
	if (!entry) {
		pass.say("nothing to triage");
		return true;
	}
	const { data, comments } = entry;
	const { number } = entry.issue;
	const considered = repliesOf(comments, data.read);
	const [closed, pulls] = await Promise.all([
		pass.forge.closed(CLOSED),
		pass.forge.pulls(),
	]);
	const issues = entries.map((e) => e.issue);
	const backlog = join(pass.dir, `backlog-i${number}.md`);
	await Bun.write(
		backlog,
		snapshot(pass.milestone, number, issues, closed, pulls),
	);
	let id: string;
	try {
		id = await pass.maestro.start(
			[
				"perform",
				...(data.triage ? ["--encore", data.triage] : [TRIAGE_FILE]),
				"--issue",
				issueText(
					entry.issue,
					considered.filter((c) => isFed(c, pass.login)),
					pass.login,
				),
				"--backlog",
				backlog,
				"--tour",
				tourOf(pass.milestone, number),
				"--title",
				titleOf(entry.issue),
				...(pass.preset ? ["--preset", pass.preset] : []),
			],
			join(pass.dir, `i${number}.log`),
		);
	} catch (error) {
		await halt(
			pass,
			`triage of #${number} did not start`,
			`Triage of #${number} did not start:`,
			message(error),
		);
		return true;
	}
	pass.say(`triaging #${number}: concert ${id}`);
	const read = considered.at(-1)?.id;
	if (read !== undefined)
		await writeSpec(pass, number, stateOf(entry.issue) ?? "needs-triage", {
			...data,
			read,
		});
	return true;
}

/**
 * One pass: no action when another pass holds the lock, the tour manager is halted or a concert of the milestone runs;
 * else it routes settled concerts, syncs, and starts one build or else one triage. Each step returns whether the pass
 * goes on.
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
			`no milestone ${options.milestone} on the forge\nCreate it, or pass an existing one to --milestone`,
		);
	const concerts = await deps.maestro.concerts(options.milestone);
	const running = concerts.find((c) => c.status === "running");
	if (running) return deps.say(`concert ${running.id} is still running`);
	const login = await deps.forge.login();
	const pass: Pass = { ...deps, ...options, milestoneId, concerts, login };
	for (const step of [route, sync, build, triage]) {
		const entries = await load(pass);
		if (!entries || !(await step(pass, entries))) return;
	}
}

if (import.meta.main) {
	let options: Options;
	try {
		const { values } = parseArgs({
			options: { milestone: { type: "string" }, preset: { type: "string" } },
		});
		if (!values.milestone) throw new Error("--milestone is required");
		const runtime = process.env.XDG_RUNTIME_DIR;
		if (!runtime)
			throw new Error(
				"XDG_RUNTIME_DIR is not set\nRun the tick in a user session, such as under systemctl --user",
			);
		options = {
			...values,
			milestone: values.milestone,
			dir: join(runtime, "maestro-factory"),
			cache: join(
				process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
				"maestro-factory",
			),
		};
	} catch (error) {
		console.error(
			`${message(error)}\nusage: bun scripts/factory/index.ts --milestone <name> [--preset <name>]`,
		);
		process.exit(EXIT_USAGE);
	}
	mkdirSync(options.dir, { recursive: true });
	try {
		await pass(
			{
				forge: forge(),
				maestro: maestro(),
				landing: landing(REPO),
				lock: () => lock(join(options.dir, "lock")),
				say: console.log,
			},
			options,
		);
	} catch (error) {
		console.error(`tour manager: ${message(error)}`);
		process.exit(EXIT_FAILED);
	}
}
