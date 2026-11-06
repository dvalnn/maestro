// One pass of the tour manager (docs/agents/factory.md, One tick): it routes settles, reviews an epic's stack, builds a
// ready ticket, triages one or holds a masterclass.
import { dlopen, FFIType, read } from "bun:ffi";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type Comment,
	dotenvPath,
	type Forge,
	forge,
	type Issue,
	loadEnvFile,
	type NewPull,
	type Pull,
	REQUEST_CHANGES,
	type Review,
} from "./forge";
import { type Landing, landing, SIGNING_KEY } from "./land";
import {
	type Concert,
	type Maestro,
	maestro,
	type Report,
	type Result,
	type Spend,
} from "./maestro";
import {
	type Approval,
	buildable,
	isIntake,
	issueText,
	overlaps,
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
	type Change,
	type Child,
	commentOf,
	type Data,
	dataOf,
	encoreRequest,
	fenced,
	fingerprintLine,
	isFed,
	isReply,
	type Masterclass,
	type Option,
	parseMasterclass,
	parseTriage,
	proposalIssue,
	proposalLine,
	pullBody,
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
const MASTERCLASS_LABEL = "maestro-tm:masterclass";
export const MILESTONE_KEY = "MAESTRO_TM_MILESTONE";
const REPO = resolve(import.meta.dir, "../..");
const TRIAGE_FILE = join(REPO, ".maestro/triage.ts");
const SLICE_FILE = join(REPO, ".maestro/slice.ts");
const MASTERCLASS_FILE = join(REPO, ".maestro/masterclass.ts");
const REVIEW_FILE = join(REPO, ".maestro/review.ts");
/** The preset a triage and a masterclass perform with, ahead of the pass's own. */
const TRIAGE_PRESET = "triage";
/** A bare composition file's pack is its stem. */
const TRIAGE = { pack: "triage", composition: "triage" };
const SLICE = { pack: "slice", composition: "slice" };
const MASTERCLASS = { pack: "masterclass", composition: "masterclass" };
const STACK_REVIEW = { pack: "review", composition: "review" };
/** The review tier a stack review rules at. */
const STACK_REVIEW_PRESET = "risky";
/** How many settled factory runs newer than the last masterclass make the next one due. */
const MASTERCLASS_EVERY = 10;
/**
 * How many of a milestone's newest concerts the masterclass step reads: a masterclass comes last in pick order and may
 * starve while there is other work, so it reads further back than the pass's window.
 */
const MASTERCLASS_WINDOW = 200;
/** How a slice's agent reports it blocked (GLOSSARY.md, Blocked). */
const BLOCKED = "blocked:";
const BASE = "main";
/** The states a slice's settle is routed in; on an issue the owner moved elsewhere it is parked. */
const BUILDING: readonly State[] = ["in-progress", "ready-for-agent"];
/** How many closed issues the backlog snapshot lists. */
const CLOSED = 20;

export type Options = {
	milestone: string;
	/** The presets layered last, in order, on each triage, build and masterclass. */
	presets: string[];
	/** Only route settled concerts and sync; start no build, triage or masterclass. */
	routeOnly?: boolean;
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
	/** Whether the repo has a file at `path`, relative to its root. */
	has: (path: string) => boolean;
};

type Entry = { issue: Issue; comments: Comment[]; data: Data };
/** One pass's view: `login` is the account the tick acts as on the forge. */
type Pass = Deps &
	Options & {
		milestoneId: number;
		concerts: Concert[];
		login: string;
		/** The newest closed issues, read once per pass. */
		closed: () => Promise<Issue[]>;
	};

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
const isStackReview = (c: Concert) =>
	c.pack === STACK_REVIEW.pack && c.composition === STACK_REVIEW.composition;
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
const branchOf = (issue: number) => `maestro-tm/i${issue}`;
const firstLine = (body: string) => body.split("\n")[0]?.trimEnd();
/** The first line of a child of epic `epic`. */
const partOf = (epic: number) => `Part of #${epic}`;

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
 * closing line of its body when the comment is new or its version changed. `waiting` lists the open dependencies a
 * queued ticket waits on.
 */
async function writeSpec(
	{ forge, login }: Pass,
	number: number,
	state: State,
	data: Data,
	waiting: readonly number[] = [],
) {
	const comment = commentOf(data, state, login, waiting);
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

/**
 * Posts comment `body` on issue `number` unless one above comment id `after` holds it already, so a repeated pass
 * posts it once and a repeat of an answered question is posted again.
 */
async function ask({ forge }: Deps, number: number, body: string, after = 0) {
	const comments = await forge.comments(number);
	if (comments.some((c) => c.id > after && c.body.trim() === body.trim()))
		return;
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

const RETRIAGE: Option = { label: "`needs-triage`", text: "triage it again" };
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
 * The open PR of `pull.head` with `pull`'s body, retargeted to `pull.base` when it merges elsewhere, else a new one.
 */
async function openPull(forge: Forge, pull: NewPull) {
	const open = (await forge.pulls()).find((p) => p.head === pull.head);
	if (!open) return forge.openPull(pull);
	await forge.editPull(open.number, {
		body: pull.body,
		...(open.base !== pull.base && { base: pull.base }),
	});
	return open.number;
}

/** Whether `issue` is low risk, so its PR to `main` merges on its own (factory.md, Rules, Policy: Risk and tier). */
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
 * Runs `work` in a fresh jj workspace `factory-i<number>` of issue `number`, at
 * `$XDG_CACHE_HOME/maestro-factory/i<number>`, on revision `base`, then forgets and removes it; undefined when it
 * halted on `failure`, keeping the workspace for the next tick to replace once the halt closes.
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

/** The data of a ticket with no concert to continue. */
const UNCONTINUED: Data = { encore: undefined, revisionBase: undefined };

type PullText = Pick<NewPull, "title" | "body">;
/** Where a landing or restack leaves its issue: in review with its PR, stacked while `stack` is set, else asking. */
type Outcome = { pull: number; stack?: Stack } | { question: string };

/** What each slice concert of `issue`'s tour spent, oldest first, the one still running left out. */
async function spendOf(pass: Pass, issue: Issue) {
	const tour = await pass.maestro.concerts(
		tourOf(pass.milestone, issue.number),
	);
	const slices = tour.filter((c) => isSlice(c) && c.status !== "running");
	return Promise.all(slices.reverse().map((c) => pass.maestro.spend(c.id)));
}

/**
 * The PR text of `issue`'s slice, with its `report` and the `spend` of its concerts (factory.md, Rules, Landing and
 * PRs: PRs).
 */
function pullText(
	issue: Issue,
	data: Data,
	report: Report,
	spend: readonly Spend[],
) {
	const result = data.result;
	if (!result?.spec) throw new Error(`#${issue.number} holds no spec`);
	const body = pullBody({
		issue: issue.number,
		spend,
		tier: tierOf(issue, result),
		risk: riskOf(issue, result.risk),
		upheld: report.upheld,
		gaps: report.gaps,
		result,
		pr: report.pr,
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

/** The epic issue `issue` is a child of, by its `Part of #N` first line. */
function epicOf(issue: Issue) {
	const found = /^#(\d+)$/.exec(
		firstLine(issue.body)?.replace(partOf(0).slice(0, -2), "") ?? "",
	);
	return found ? Number(found[1]) : undefined;
}

/**
 * Whether `entry` is the last open child of an epic whose stack review has yet to clear it: none ran, or its findings
 * await an encore (factory.md, Rules, Build: Stack review).
 */
async function awaitsStackReview(pass: Pass, { issue, data }: Entry) {
	const epic = epicOf(issue);
	if (epic === undefined) return false;
	const epicData = dataOf(
		specCommentOf(await pass.forge.comments(epic))?.body ?? "",
	);
	if (!epicData.base) return false;
	const siblings = (epicData.filed ?? []).filter((n) => n !== issue.number);
	for (const n of siblings)
		if ((await pass.forge.issue(n)).closed === undefined) return false;
	const routed =
		epicData.stackReview !== undefined &&
		epicData.stackReview === epicData.concert;
	return !routed || data.findings !== undefined;
}

/**
 * Pushes `commit` from `dir` as `entry`'s branch and opens or retargets its PR into `base`, arming a low one to
 * `main`.
 */
async function publish(
	pass: Pass,
	entry: Entry,
	dir: string,
	commit: string,
	pull: NewPull,
) {
	await pass.forge.push(dir, commit, pull.head);
	const number = await openPull(pass.forge, pull);
	if (
		pull.base === BASE &&
		isLow(entry.issue, entry.data) &&
		!(await awaitsStackReview(pass, entry))
	)
		await pass.forge.arm(number);
	return number;
}

/**
 * Copies the commits `stack.commit..revision` of `entry` onto `main` in the workspace at `dir` and publishes them
 * there; a conflict asks.
 */
async function restackIn(
	pass: Pass,
	entry: Entry,
	dir: string,
	stack: Stack,
	revision: string,
	text: PullText,
): Promise<Outcome> {
	const restacked = await pass.landing.restack(
		dir,
		`${stack.commit}..${revision}`,
		BASE,
	);
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
	const landed = {
		...data,
		...UNCONTINUED,
		concert,
		failure: undefined,
		stack: undefined,
	};
	if ("question" in outcome) {
		const options = [
			{ label: "`ready-for-agent`", text: `build it again on \`${BASE}\`` },
			RETRIAGE,
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
 * Applies ok slice `id` of `entry` in the workspace at `dir`, squashed into `revisionBase` when it revises, and
 * publishes it, force-pushing the branch onto the open PR: to `main`, to its blocker's branch while a blocker is open,
 * else restacked onto `main` (factory.md, Rules, Build: Restack).
 */
async function landIn(
	pass: Pass,
	entry: Entry,
	id: string,
	report: Report,
	dir: string,
): Promise<Outcome> {
	const { issue, data } = entry;
	const text = pullText(issue, data, report, await spendOf(pass, issue));
	await pass.maestro.apply(id, dir);
	const message = `${text.title}\n\nRefs: #${issue.number}\n`;
	const commit = data.revisionBase
		? await pass.landing.squash(dir, message)
		: await pass.landing.describe(dir, message);
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
	if (state === "merged")
		return restackIn(pass, entry, dir, stack, commit, text);
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
		data.revisionBase ?? data.stack?.commit ?? BASE,
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
	) {
		const pull = pullToMain(await pass.forge.pulls(), last.issue.number);
		if (pull) await pass.forge.arm(pull.number);
	}
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
async function routeMasterclass(pass: Pass) {
	const newest = pass.concerts[0];
	if (!newest || !isMasterclass(newest, pass.milestone)) return;
	const masterclass = masterclassOf(await pass.maestro.result(newest.id));
	if (typeof masterclass === "string")
		return pass.say(`masterclass ${newest.id} ${masterclass}`);
	await fileProposals(pass, newest.id, masterclass);
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

/** Restacks `entry`'s pushed branch onto `main` in a fresh workspace, with its landed concert's PR text. */
function restackBranch(pass: Pass, entry: Entry, stack: Stack) {
	const { issue, data } = entry;
	const failure = {
		title: `restack of #${issue.number} failed`,
		lead: `The stacked change of #${issue.number} did not restack onto \`${BASE}\``,
	};
	return inWorkspace(pass, issue.number, BASE, failure, async (dir) => {
		if (!data.concert)
			throw new Error(`#${issue.number} holds no landed concert`);
		const report = await pass.maestro.report(data.concert);
		const text = pullText(issue, data, report, await spendOf(pass, issue));
		return restackIn(
			pass,
			entry,
			dir,
			stack,
			`${branchOf(issue.number)}@origin`,
			text,
		);
	});
}

/**
 * Restacks `entry`'s PR onto `main` once no blocker is open and its blocker's PR merged, or asks when that PR closed
 * unmerged (factory.md, Rules, Build: Restack); false when it halted.
 */
async function restack(pass: Pass, entry: Entry, stack: Stack) {
	const state = await stackState(pass.forge, entry.issue.number, stack);
	if (state === "open") return true;
	const outcome =
		state === "merged"
			? await restackBranch(pass, entry, stack)
			: { question: unmerged(stack) };
	if (!outcome) return false;
	await record(pass, entry, entry.data.concert, outcome);
	return true;
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
 * Performs `perform` for `entry` at its risk's tier, cut at its PR's head when it revises, else on `stack`'s commit
 * when it stacks, and moves it to `in-progress`; halts on a refusal.
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
	const cut = perform.data.revisionBase ?? stack?.commit;
	const name = issue.labels
		.find((l) => l.startsWith("area/"))
		?.slice("area/".length);
	const area =
		name && pass.has(`.maestro/presets/area-${name}.yaml`)
			? ["--preset", `area-${name}`]
			: [];
	let id: string;
	try {
		id = await pass.maestro.start([
			...(perform.encore
				? ["encore", perform.encore]
				: ["perform", SLICE_FILE]),
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
			...(cut ? ["-c", `target.base=${cut}`] : []),
		]);
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
	let id: string;
	try {
		id = await pass.maestro.start([
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
	} catch (error) {
		await halt(
			pass,
			`stack review of #${issue.number} did not start`,
			`The stack review of #${issue.number} did not start:`,
			message(error),
		);
		return;
	}
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

/**
 * Starts triage of the first intake issue, pinned ones first, on its ask and the comments since the last triage read
 * that it is fed, an encore of its last triage when it has one, then records the newest comment it considered; halts on
 * a refusal. A re-triage with nothing new to feed asks for a reply instead. True only when it started nothing, so a
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
	const [closed, pulls] = await Promise.all([
		pass.closed(),
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
		id = await pass.maestro.start([
			...(data.triage ? ["encore", data.triage] : ["perform", TRIAGE_FILE]),
			"--issue",
			issueText(
				entry.issue,
				considered.filter((c) => isFed(c, pass.login)),
				pass.login,
				data.triage ? data.result?.spec : undefined,
			),
			"--backlog",
			backlog,
			"--tour",
			tourOf(pass.milestone, number),
			"--title",
			titleOf(entry.issue),
			"--preset",
			TRIAGE_PRESET,
			...pass.presets.flatMap((p) => ["--preset", p]),
		]);
	} catch (error) {
		await halt(
			pass,
			`triage of #${number} did not start`,
			`Triage of #${number} did not start:`,
			message(error),
		);
		return false;
	}
	pass.say(`triaging #${number}: concert ${id}`);
	const read = considered.at(-1)?.id;
	if (read !== undefined)
		await writeSpec(pass, number, stateOf(entry.issue) ?? "needs-triage", {
			...data,
			read,
		});
	return false;
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
	let id: string;
	try {
		id = await pass.maestro.start(
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
			],
			join(pass.dir, "masterclass.log"),
		);
	} catch (error) {
		await halt(
			pass,
			"masterclass did not start",
			"The masterclass did not start:",
			message(error),
		);
		return;
	}
	pass.say(
		`holding a masterclass on the lessons of ${runs} concerts: concert ${id}`,
	);
}

/**
 * Starts a masterclass on the lessons of the factory runs since the last one, once `MASTERCLASS_EVERY` settled, with
 * the backlog snapshot; true when it started none.
 */
async function masterclass(pass: Pass, entries: Entry[]) {
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
