// Landing a slice's change as its PR to `main` (factory.md, Rules, Landing and PRs).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Forge,
	GHOST,
	type Issue,
	type NewPull,
	REQUEST_CHANGES,
} from "../../.maestro/forge";
import { isJson } from "../../.maestro/json";
import type { Guards, Test } from "../guards";
import { isSlice, tourOf } from "./concerts";
import type { Report, Spend } from "./maestro";
import { riskOf } from "./pick";
import {
	type Data,
	dataOf,
	isInterim,
	type Moved,
	type Proof,
	type ProofResult,
	type ProofRow,
	pullBody,
	seenSection,
	specCommentOf,
	unresolvedOf,
} from "./route";
import {
	BASE,
	branchOf,
	type Entry,
	firstLine,
	halt,
	isLow,
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

/**
 * A PR's title and body, and whether it is a draft, which holds it unarmed. `seen` is the directory of transcripts the
 * slice drew, and the body with a "What the user sees" section in it.
 */
type PullText = Pick<NewPull, "title" | "body"> & {
	draft: boolean;
	seen?: { dir: string; bodyWith(section: string): string };
};

/** What each slice concert of `issue`'s tour spent, oldest first, the one still running left out. */
async function spendOf(tick: Tick, issue: Issue) {
	const tour = await tick.maestro.concerts(
		tourOf(tick.milestone, issue.number),
	);
	const slices = tour.filter((c) => isSlice(c) && c.status !== "running");
	return Promise.all(slices.reverse().map((c) => tick.maestro.spend(c.id)));
}

const GUARDS_FILE = "guards.json";

/**
 * The tests sorted in the `guards` directory `dir`, none when it holds no such file or one that does not parse. A sandbox
 * wrote `dir`, so only a regular file in it is read: a link there could name any file of the host. A malformed
 * file costs the landing nothing.
 */
function guardsOf(dir: string): Guards | undefined {
	const held = readdirSync(dir, { withFileTypes: true }).some(
		(f) => f.isFile() && f.name === GUARDS_FILE,
	);
	if (!held) return undefined;
	let doc: unknown;
	try {
		doc = JSON.parse(readFileSync(join(dir, GUARDS_FILE), "utf8"));
	} catch {
		return undefined;
	}
	if (!isJson(doc)) return undefined;
	const isTest = (t: unknown): t is Test =>
		isJson(t) && typeof t.file === "string" && typeof t.name === "string";
	const tests = (found: unknown) =>
		Array.isArray(found) && found.every(isTest) ? found : undefined;
	const { red, unloaded, green } = {
		red: tests(doc.red),
		unloaded: tests(doc.unloaded),
		green: tests(doc.green),
	};
	return red && unloaded && green ? { red, unloaded, green } : undefined;
}

const SCRIPTS_DIR = "scripts";
const MAIN_SCRIPT = "prove.sh";
const RESULT_FILE = /^(\d+)\.json$/;

const isText = (v: unknown): v is string => typeof v === "string";
const isTexts = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every(isText);

const parsed = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

/** `doc` as a claim's measurement, none when it has the wrong shape or says nothing. */
function measurementOf(doc: unknown): ProofResult | undefined {
	if (!isJson(doc)) return undefined;
	const { result, rows, ignored = [], notCovered = [] } = doc;
	const isRow = (r: unknown): r is ProofRow =>
		isJson(r) && isText(r.what) && isText(r.before) && isText(r.after);
	// A reason counts only with no rows: a script that measured and then hedged still measured.
	const unmeasured = !(Array.isArray(rows) && rows.length);
	if (unmeasured && isText(doc.notMeasured) && doc.notMeasured.trim())
		return { notMeasured: doc.notMeasured };
	if (!isText(result) || !result.trim()) return undefined;
	if (!Array.isArray(rows) || !rows.every(isRow)) return undefined;
	if (!isTexts(ignored) || !isTexts(notCovered)) return undefined;
	return { result, rows, ignored, notCovered };
}

/**
 * The prover's files in the `proof` directory `dir`: each `<n>.json` as claim `n`'s measurement, parsed here, and
 * the files of its `scripts` directory, `prove.sh` first. A sandbox wrote `dir`, so only regular files directly in it
 * and in `scripts` are read: a link there could name any file of the host. A file that does not parse is no measurement.
 */
function proofOf(dir: string): Proof {
	const regular = (at: string) =>
		readdirSync(at, { withFileTypes: true }).filter((f) => f.isFile());
	const read = (name: string) => readFileSync(join(dir, name), "utf8");
	const results: Record<number, ProofResult> = {};
	for (const f of regular(dir)) {
		const n = RESULT_FILE.exec(f.name)?.[1];
		if (!n) continue;
		const measured = measurementOf(parsed(read(f.name)));
		if (measured) results[Number(n)] = measured;
	}
	const scriptsAt = join(dir, SCRIPTS_DIR);
	// A link in place of the directory is no directory here.
	const scripts = readdirSync(dir, { withFileTypes: true }).some(
		(f) => f.isDirectory() && f.name === SCRIPTS_DIR,
	)
		? regular(scriptsAt)
				.map((f) => ({
					name: f.name,
					text: readFileSync(join(scriptsAt, f.name), "utf8").trimEnd(),
				}))
				.sort(
					(a, b) =>
						Number(b.name === MAIN_SCRIPT) - Number(a.name === MAIN_SCRIPT) ||
						(a.name < b.name ? -1 : 1),
				)
		: [];
	return { results, scripts };
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
	const landed = {
		issue: issue.number,
		spend,
		risk: riskOf(issue, result.risk),
		upheld: report.upheld,
		result,
		pr: report.pr,
		notice: report.notice,
		interim: isInterim(report.upheld, data.attempts),
		reviewers: report.reviewers,
		touched: report.touched,
		guards: report.guards ? guardsOf(report.guards) : undefined,
		proof: report.proof ? proofOf(report.proof) : undefined,
	};
	return {
		title: result.spec.subject,
		body: pullBody(landed),
		draft: report.draft === true,
		seen: report.seen
			? {
					dir: report.seen,
					bodyWith: (userSees: string) => pullBody({ ...landed, userSees }),
				}
			: undefined,
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

/** Every review's id, so reading reviews fetches no inline comments. */
const NO_COMMENTS = Number.MAX_SAFE_INTEGER;

/**
 * Says on PR `pull` that revision `id` of `entry` landed on it, with the conflicts it resolved, and asks each official
 * reviewer who requested changes on it, but a deleted one, to review again (factory.md, Rules, Landing and PRs: PRs).
 */
async function answer(tick: Tick, { data }: Entry, id: string, pull: number) {
	const requested = (await tick.forge.reviews(pull, NO_COMMENTS)).filter(
		(r) => r.official && r.state === REQUEST_CHANGES,
	);
	const reviewers = [
		...new Set(requested.map((r) => r.author).filter((a) => a !== GHOST)),
	];
	const conflicted = data.conflicted ?? [];
	await tick.forge.comment(
		pull,
		[
			`Revised by concert \`${id}\`; the description covers the whole PR again.`,
			...(conflicted.length
				? [
						`It is rebased onto \`main\`, with the conflicts in ${conflicted.map((p) => `\`${p}\``).join(", ")} resolved.`,
					]
				: []),
			...(reviewers.length
				? [`Review requested again from ${reviewers.join(", ")}.`]
				: []),
		].join(" "),
	);
	if (reviewers.length) await tick.forge.requestReview(pull, reviewers);
}

/**
 * Pushes `commit` of slice `id` from `dir` as `entry`'s branch and opens or rewrites its PR, a draft when `draft`,
 * shows the transcripts it moved in its body, answers its reviewers when it revised the PR, then arms a low one unless
 * it is a draft.
 */
async function publish(
	tick: Tick,
	entry: Entry,
	id: string,
	dir: string,
	commit: string,
	{ draft, seen, ...pull }: NewPull & Omit<PullText, "title" | "body">,
) {
	await tick.forge.push(dir, commit, pull.head);
	const title = draft ? `${DRAFT_PREFIX}${pull.title}` : pull.title;
	const number = await openPull(tick.forge, { ...pull, title });
	// The pictures are attached to the PR, so its body takes their section once it exists.
	const section = seen
		? seenSection(await attachMoved(tick.forge, seen.dir, number))
		: "";
	if (seen && section)
		await tick.forge.editPull(number, title, seen.bodyWith(section));
	// Answering before arming keeps a PR merged at once open for it, and before recording lets a tick cut while
	// answering land and answer again.
	if (entry.data.revisionBase) await answer(tick, entry, id, number);
	if (
		!draft &&
		isLow(entry.issue, entry.data) &&
		!(await awaitsStackReview(tick, entry))
	)
		await tick.forge.arm(number);
	return number;
}

/**
 * The transcripts in the `seen` directory `dir`, each picture attached to PR `pull`. A sandbox wrote `dir`, so only its
 * regular files are read: a link there could name any file of the host. The pictures go up one at a time, and one the
 * forge refuses is left out with its reason: a picture never costs the landing.
 */
async function attachMoved(forge: Forge, dir: string, pull: number) {
	const files = readdirSync(dir, { withFileTypes: true })
		.filter((f) => f.isFile())
		.map((f) => f.name);
	const names = new Set(
		files.flatMap((f) => /^(.+)\.(?:diff|png)$/.exec(f)?.[1] ?? []),
	);
	const moved: Moved[] = [];
	for (const name of names) {
		const png = `${name}.png`;
		const diff = `${name}.diff`;
		moved.push({
			name,
			picture: files.includes(png)
				? await forge
						.attach(pull, join(dir, png))
						.catch((error) => ({ refused: message(error) }))
				: undefined,
			diff: files.includes(diff)
				? readFileSync(join(dir, diff), "utf8")
				: undefined,
		});
	}
	return moved;
}

/**
 * Writes `entry`'s landed slice `concert` back: `in-review` with its PR `pull`. A slice whose review left `upheld`
 * findings spends an attempt as a rejected one does, and while one is left the ticket is marked `unresolved`, for an
 * encore to take them (factory.md, Rules, Build: Attempts).
 */
async function record(
	tick: Tick,
	{ issue, data }: Entry,
	concert: string | undefined,
	pull: number,
	upheld: string | undefined,
) {
	const left = unresolvedOf(upheld) !== undefined;
	await move(tick, issue.number, "in-review");
	await writeSpec(tick, issue.number, "in-review", {
		...data,
		...UNCONTINUED,
		concert,
		failure: undefined,
		attempts: left ? (data.attempts ?? 0) + 1 : data.attempts,
		unresolved: isInterim(upheld, data.attempts) || undefined,
	});
	tick.say(
		`#${issue.number} is in review as PR #${pull}${isInterim(upheld, data.attempts) ? ", interim: its upheld findings go to the next attempt" : ""}`,
	);
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
	return publish(tick, entry, id, dir, commit, {
		...text,
		head: branchOf(issue.number),
		base: BASE,
	});
}

/**
 * Lands ok slice `id` of `entry` in a fresh workspace on its base, then records its PR; false when it halted, keeping the workspace.
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
	await record(tick, entry, id, pull, report.upheld);
	return true;
}
