// Landing a slice's change as its PR to `main` (factory.md, Rules, Landing and PRs).
import { join } from "node:path";
import type { Forge, Issue, NewPull } from "./forge";
import type { Report, Spend } from "./maestro";
import { riskOf, tourOf } from "./pick";
import { type Data, dataOf, pullBody, specCommentOf } from "./route";
import {
	BASE,
	branchOf,
	type Entry,
	firstLine,
	halt,
	isLow,
	isSlice,
	message,
	move,
	partOf,
	type Tick,
	UNCONTINUED,
	writeSpec,
} from "./tick";

/** The open PR of `pull.head` with `pull`'s title and body, else a new one. */
async function openPull(forge: Forge, pull: NewPull) {
	const open = (await forge.pulls()).find((p) => p.head === pull.head);
	if (!open) return forge.openPull(pull);
	await forge.editPull(open.number, pull.title, pull.body);
	return open.number;
}

/** Forgets and removes a landed workspace; a failure is a warning, since the next landing replaces a leftover. */
async function closeWorkspace(tick: Tick, dir: string, name: string) {
	try {
		await tick.landing.close(dir, name);
	} catch (error) {
		const [reason] = message(error).split("\n");
		tick.say(`could not remove workspace ${name} at ${dir}: ${reason}`);
	}
}

/**
 * Runs `work` in a fresh jj workspace `factory-i<number>` of issue `number`, at
 * `$XDG_CACHE_HOME/maestro-factory/i<number>`, on revision `base`, then forgets and removes it; undefined when it
 * halted, keeping the workspace for the next tick to replace once the halt closes.
 */
async function inWorkspace(
	tick: Tick,
	number: number,
	base: string,
	id: string,
	work: (dir: string) => Promise<number>,
) {
	const name = `factory-i${number}`;
	const dir = join(tick.cache, `i${number}`);
	let done: number;
	try {
		await tick.landing.open(dir, name, base);
		done = await work(dir);
	} catch (error) {
		await halt(
			tick,
			`landing of #${number} failed`,
			`The slice concert \`${id}\` of #${number} did not land from the workspace \`${dir}\`:`,
			message(error),
			"Look at the workspace first: closing this issue lets the next tick replace it with a fresh one.",
		);
		return undefined;
	}
	await closeWorkspace(tick, dir, name);
	return done;
}

/** Forgejo's draft marker: a title with it opens a draft, which the forge refuses to merge. */
const DRAFT_PREFIX = "WIP: ";

/** A PR's title and body, and whether it is a draft, which holds it unarmed. */
type PullText = Pick<NewPull, "title" | "body"> & { draft: boolean };

/** What each slice concert of `issue`'s tour spent, oldest first, the one still running left out. */
async function spendOf(tick: Tick, issue: Issue) {
	const tour = await tick.maestro.concerts(
		tourOf(tick.milestone, issue.number),
	);
	const slices = tour.filter((c) => isSlice(c) && c.status !== "running");
	return Promise.all(slices.reverse().map((c) => tick.maestro.spend(c.id)));
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
		risk: riskOf(issue, result.risk),
		upheld: report.upheld,
		result,
		pr: report.pr,
		notice: report.notice,
	});
	return {
		title: result.spec.subject,
		body,
		draft: report.draft === true,
	};
}

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
async function awaitsStackReview(tick: Tick, { issue, data }: Entry) {
	const epic = epicOf(issue);
	if (epic === undefined) return false;
	const epicData = dataOf(
		specCommentOf(await tick.forge.comments(epic))?.body ?? "",
	);
	if (!epicData.base) return false;
	const siblings = (epicData.filed ?? []).filter((n) => n !== issue.number);
	for (const n of siblings)
		if ((await tick.forge.issue(n)).closed === undefined) return false;
	const routed =
		epicData.stackReview !== undefined &&
		epicData.stackReview === epicData.concert;
	return !routed || data.findings !== undefined;
}

/**
 * Pushes `commit` from `dir` as `entry`'s branch and opens or rewrites its PR, a draft when `draft`, arming a low one
 * unless it is a draft.
 */
async function publish(
	tick: Tick,
	entry: Entry,
	dir: string,
	commit: string,
	{ draft, ...pull }: NewPull & Pick<PullText, "draft">,
) {
	await tick.forge.push(dir, commit, pull.head);
	const title = draft ? `${DRAFT_PREFIX}${pull.title}` : pull.title;
	const number = await openPull(tick.forge, { ...pull, title });
	if (
		!draft &&
		isLow(entry.issue, entry.data) &&
		!(await awaitsStackReview(tick, entry))
	)
		await tick.forge.arm(number);
	return number;
}

/** Writes `entry`'s landed slice `concert` back: `in-review` with its PR `pull`. */
async function record(
	tick: Tick,
	{ issue, data }: Entry,
	concert: string | undefined,
	pull: number,
) {
	await move(tick, issue.number, "in-review");
	await writeSpec(tick, issue.number, "in-review", {
		...data,
		...UNCONTINUED,
		concert,
		failure: undefined,
	});
	tick.say(`#${issue.number} is in review as PR #${pull}`);
}

/**
 * Applies ok slice `id` of `entry` in the workspace at `dir`, squashed into `revisionBase` when it revises, and
 * publishes it to `main`, force-pushing the branch onto the open PR.
 */
async function landIn(
	tick: Tick,
	entry: Entry,
	id: string,
	report: Report,
	dir: string,
) {
	const { issue, data } = entry;
	const text = pullText(issue, data, report, await spendOf(tick, issue));
	await tick.maestro.apply(id, dir);
	const message = `${text.title}\n\nRefs: #${issue.number}\n`;
	const commit = data.revisionBase
		? await tick.landing.squash(dir, message)
		: await tick.landing.describe(dir, message);
	return publish(tick, entry, dir, commit, {
		...text,
		head: branchOf(issue.number),
		base: BASE,
	});
}

/**
 * Lands ok slice `id` of `entry` in a fresh workspace on its base, then records its PR; false when it halted, keeping
 * the workspace.
 */
export async function land(
	tick: Tick,
	entry: Entry,
	id: string,
	report: Report,
) {
	const { issue, data } = entry;
	const pull = await inWorkspace(
		tick,
		issue.number,
		data.revisionBase ?? tick.main,
		id,
		(dir) => landIn(tick, entry, id, report, dir),
	);
	if (pull === undefined) return false;
	await record(tick, entry, id, pull);
	return true;
}
