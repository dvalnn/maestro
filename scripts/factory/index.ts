// One pass of the factory (docs/agents/factory.md, zoom 1): it routes settles, builds a ready ticket or triages one.
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
	factoryOf,
	fenced,
	fingerprintLine,
	parseTriage,
	pullBody,
	relabelled,
	repliesOf,
	reportIssue,
	requestOf,
	type Triage,
	triaged,
	VERDICT_STATE,
	withBlock,
} from "./route";
import type { State } from "./transitions";

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const LOCK_EX = 2;
const LOCK_NB = 4;
/** Linux's EWOULDBLOCK, which is EAGAIN. */
const EWOULDBLOCK = 11;
export const HALT = "factory:halt";
const REPO = resolve(import.meta.dir, "../..");
const TRIAGE_FILE = join(REPO, ".maestro/triage.ts");
const SLICE_FILE = join(REPO, ".maestro/slice.ts");
/** A bare composition file's pack is its stem. */
const TRIAGE = { pack: "triage", composition: "triage" };
const SLICE = { pack: "slice", composition: "slice" };
/** How a slice's agent reports it blocked (GLOSSARY.md, Blocked). */
const BLOCKED = "blocked:";
const BASE = "main";
/** The states a slice's settle is routed in; an issue the owner moved elsewhere is left alone. */
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
type Pass = Deps & Options & { milestoneId: number; concerts: Concert[] };

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
const branchOf = (issue: number) => `factory/i${issue}`;

/** Files the halt issue: `lead`, then `detail` verbatim in a code block, then what to do next. */
async function halt(
	{ forge, say }: Deps,
	title: string,
	lead: string,
	detail: string,
	next?: string,
) {
	const halted = await forge.file({
		title: `Factory halted: ${title}`,
		body: [lead, fenced(detail), next, "Close this issue to lift the halt."]
			.filter(Boolean)
			.join("\n\n"),
		labels: [HALT],
	});
	say(`halted on #${halted}: ${title}`);
}

/**
 * Writes `data` to the factory comment of issue `number`, creating it on the first write, then rewrites the factory
 * block of its body as it is now for `state`.
 */
async function writeBlock(
	{ forge }: Deps,
	number: number,
	state: State,
	data: Data,
) {
	const comment = commentOf(data);
	const found = factoryOf(await forge.comments(number));
	if (found) await forge.editComment(found.id, comment);
	const id = found?.id ?? (await forge.comment(number, comment));
	const { body } = await forge.issue(number);
	await forge.edit(number, { body: withBlock(body, state, data, id) });
}

/** Moves issue `number` to `state`, keeping its other labels. */
async function move({ forge }: Deps, number: number, state: State) {
	const { labels } = await forge.issue(number);
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
			const data = dataOf(factoryOf(comments)?.body ?? "");
			entries.push({ issue, comments, data });
		} catch (error) {
			await halt(
				pass,
				`#${issue.number} has a malformed factory-data line`,
				`The factory-data line of #${issue.number}'s factory comment cannot be read:`,
				message(error),
				"Fix the line, or delete the factory comment.",
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

/** Sets the labels of `data`'s routed result on `number`, closes a duplicate, then clears `pending`. */
async function apply(pass: Pass, number: number, data: Data, result: Triage) {
	const state = VERDICT_STATE[result.verdict];
	const { labels } = await pass.forge.issue(number);
	await pass.forge.setLabels(number, triaged(labels, result));
	if (result.verdict === "duplicate")
		await pass.forge.edit(number, { closed: true });
	await writeBlock(pass, number, state, { ...data, pending: undefined });
	pass.say(`routed #${number} to ${state}`);
}

/** Routes concert `id`'s settle onto `issue` (zoom 2), and returns false when it halted the factory. */
async function settle(pass: Pass, { issue, data }: Entry, id: string) {
	const result = triageOf(await pass.maestro.result(id));
	const state = stateOf(issue) ?? "needs-triage";
	if (typeof result === "string") {
		const [what, ...why] = result.split(": ");
		// The replies it was fed go to the next triage again, since an encore continues the last ok one.
		await writeBlock(pass, issue.number, state, {
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
	const routed: Data = { ...data, concert: id, triage: id, result };
	await writeBlock(pass, issue.number, VERDICT_STATE[result.verdict], {
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
	await writeBlock(pass, issue.number, state, {
		...data,
		concert: id,
		attempts: attempts || undefined,
		failure: reason,
	});
	pass.say(`routed #${issue.number}'s slice to ${state}: ${reason}`);
}

/** The open PR of `head`, else a new one of `pull`. */
async function openPull(forge: Forge, pull: NewPull) {
	const open = (await forge.pulls()).find((p) => p.head === pull.head);
	return open?.number ?? forge.openPull(pull);
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

/**
 * Lands ok slice `id` of `entry` in a fresh workspace and opens its PR, then moves the issue to `in-review`; false when
 * it halted, keeping the workspace.
 */
async function land(
	pass: Pass,
	{ issue, data }: Entry,
	id: string,
	report: Report,
) {
	const name = `factory-i${issue.number}`;
	const dir = join(pass.cache, `i${issue.number}`);
	let pull: number;
	try {
		const result = data.result;
		if (!result?.spec) throw new Error(`#${issue.number} holds no spec`);
		await pass.landing.open(dir, name);
		await pass.maestro.apply(id, dir);
		const { subject } = result.spec;
		const commit = await pass.landing.describe(
			dir,
			`${subject}\n\nCloses #${issue.number}\n`,
		);
		const head = branchOf(issue.number);
		await pass.forge.push(dir, commit, head);
		const body = pullBody({
			issue: issue.number,
			concert: id,
			tokens: report.tokens,
			upheld: report.upheld ?? "None.",
			result,
		});
		pull = await openPull(pass.forge, {
			title: subject,
			body,
			head,
			base: BASE,
		});
	} catch (error) {
		await halt(
			pass,
			`landing of #${issue.number} failed`,
			`The slice concert \`${id}\` of #${issue.number} did not land from the workspace \`${dir}\`:`,
			message(error),
			"Look at the workspace first: closing this issue lets the next tick replace it with a fresh one.",
		);
		return false;
	}
	await move(pass, issue.number, "in-review");
	await writeBlock(pass, issue.number, "in-review", {
		...data,
		concert: id,
		failure: undefined,
	});
	await closeWorkspace(pass, dir, name);
	pass.say(`landed #${issue.number} as PR #${pull}`);
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

/**
 * The newest concert of `entry`'s tour the tick has yet to route: a slice while the issue is being built, or a triage
 * of an intake issue.
 */
function unrouted(pass: Pass, { issue, data }: Entry) {
	const tour = tourOf(pass.milestone, issue.number);
	const state = stateOf(issue);
	const building = state !== undefined && BUILDING.includes(state);
	const concert = pass.concerts.find(
		(c) =>
			c.tour === tour &&
			((isSlice(c) && building) || (isTriage(c) && isIntake(issue))),
	);
	return concert?.id === data.concert ? undefined : concert;
}

/** Routes each issue's newest concert the tick has not routed yet; false when it halted. */
async function route(pass: Pass, entries: Entry[]) {
	for (const entry of entries) {
		const concert = unrouted(pass, entry);
		if (!concert) continue;
		const go = isSlice(concert)
			? await settleSlice(pass, entry, concert.id)
			: await settle(pass, entry, concert.id);
		if (!go) return false;
	}
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
	await writeBlock(pass, issue.number, "in-progress", { ...data, filed });
	const { labels } = await pass.forge.issue(issue.number);
	await pass.forge.setLabels(
		issue.number,
		relabelled(labels, ["state", "kind"], ["state/in-progress", "kind/epic"]),
	);
	pass.say(`filed #${issue.number}'s children: ${filed.join(", ")}`);
}

/** Sets the labels of each routed result a cut pass left unset, and files each split the owner approved. */
async function sync(pass: Pass, entries: Entry[]) {
	for (const entry of entries) {
		const { issue, data } = entry;
		if (data.pending && data.result)
			await apply(pass, issue.number, data, data.result);
		else if (stateOf(issue) === "ready-for-agent" && data.result?.children)
			await fileSplit(pass, entry, entries);
	}
	return true;
}

/** Starts a fresh slice of `entry`'s spec, at its risk's tier, and moves it to `in-progress`; halts on a refusal. */
async function startSlice(pass: Pass, { issue, data }: Entry) {
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
	await writeBlock(pass, issue.number, "in-progress", { ...data, slice: id });
	pass.say(`building #${issue.number}: concert ${id}`);
}

/** Builds the oldest buildable issue whose dependencies are all closed; true when there was none. */
async function build(pass: Pass, entries: Entry[]) {
	for (const entry of buildable(entries)) {
		if ((await pass.forge.blockers(entry.issue.number)).length) continue;
		await startSlice(pass, entry);
		return false;
	}
	return true;
}

/**
 * Starts triage of the oldest intake issue on its ask and the replies since the last triage read, an encore of its last
 * triage when it has one, then records the newest reply it fed; halts on a refusal.
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
	const replies = repliesOf(comments, data.read);
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
				issueText(entry.issue, replies),
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
	const read = replies.at(-1)?.id;
	if (read !== undefined)
		await writeBlock(pass, number, stateOf(entry.issue) ?? "needs-triage", {
			...data,
			read,
		});
	return true;
}

/**
 * One pass: no action when another pass holds the lock, the factory is halted or a concert of the milestone runs;
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
	const pass: Pass = { ...deps, ...options, milestoneId, concerts };
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
				landing: landing(REPO, BASE),
				lock: () => lock(join(options.dir, "lock")),
				say: console.log,
			},
			options,
		);
	} catch (error) {
		console.error(`factory: ${message(error)}`);
		process.exit(EXIT_FAILED);
	}
}
