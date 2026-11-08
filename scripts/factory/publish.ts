// Landing a slice's change as its PR, stacked on a blocker's or restacked onto `main` (factory.md, Rules, Build).
import { join } from "node:path";
import type { Forge, Issue, NewPull } from "./forge";
import type { Report, Spend } from "./maestro";
import { riskOf, tierOf, tourOf } from "./pick";
import {
	type Data,
	dataOf,
	fenced,
	pullBody,
	type Stack,
	specCommentOf,
	unresolvedOf,
} from "./route";
import {
	ask,
	BASE,
	branchOf,
	type Entry,
	firstLine,
	halt,
	isLow,
	isSlice,
	message,
	move,
	type Pass,
	partOf,
	RETRIAGE,
	UNCONTINUED,
	whichWay,
	writeSpec,
} from "./tick";

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

/** A PR's title and body, and whether its review left findings unresolved, which holds it unarmed. */
type PullText = Pick<NewPull, "title" | "body"> & { held: boolean };
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
	return {
		title: result.spec.subject,
		body,
		held: unresolvedOf(report.upheld) !== undefined,
	};
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
 * Pushes `commit` from `dir` as `entry`'s branch and opens or retargets its PR into `base`, arming a low one to `main`
 * unless its review left findings unresolved.
 */
async function publish(
	pass: Pass,
	entry: Entry,
	dir: string,
	commit: string,
	{ held, ...pull }: NewPull & Pick<PullText, "held">,
) {
	await pass.forge.push(dir, commit, pull.head);
	const number = await openPull(pass.forge, pull);
	if (
		!held &&
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
		pass.main,
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
export async function land(
	pass: Pass,
	entry: Entry,
	id: string,
	report: Report,
) {
	const { issue, data } = entry;
	const outcome = await inWorkspace(
		pass,
		issue.number,
		data.revisionBase ?? data.stack?.commit ?? pass.main,
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

/** Restacks `entry`'s pushed branch onto `main` in a fresh workspace, with its landed concert's PR text. */
function restackBranch(pass: Pass, entry: Entry, stack: Stack) {
	const { issue, data } = entry;
	const failure = {
		title: `restack of #${issue.number} failed`,
		lead: `The stacked change of #${issue.number} did not restack onto \`${BASE}\``,
	};
	return inWorkspace(pass, issue.number, pass.main, failure, async (dir) => {
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
export async function restack(pass: Pass, entry: Entry, stack: Stack) {
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
