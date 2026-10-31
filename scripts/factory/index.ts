// One pass of the factory (docs/agents/factory.md, zoom 1): it triages the milestone's intake issues.
import { dlopen, FFIType, read } from "bun:ffi";
import { mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Forge, forge, type Issue } from "./forge";
import { type Concert, type Maestro, maestro, type Result } from "./maestro";
import { isIntake, issueText, pick, snapshot, stateOf, tourOf } from "./pick";
import {
	type Child,
	type Data,
	dataOf,
	parseTriage,
	relabelled,
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
const TRIAGE_FILE = resolve(import.meta.dir, "../../.maestro/triage.ts");
/** A bare composition file's pack is its stem. */
const TRIAGE = { pack: "triage", composition: "triage" };
/** How many closed issues the backlog snapshot lists. */
const CLOSED = 20;

export type Options = {
	milestone: string;
	preset?: string;
	/** Where the pass keeps its snapshots and perform logs. */
	dir: string;
};
export type Deps = {
	forge: Forge;
	maestro: Maestro;
	/** Takes the pass's lock, false when another pass holds it. */
	lock: () => boolean;
	say: (line: string) => void;
};

type Entry = { issue: Issue; data: Data };
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

/** `text` in a code block whose fence no backtick run inside it can close. */
const fenced = (text: string) => {
	const runs = [...text.matchAll(/`+/g)].map((m) => m[0].length + 1);
	const fence = "`".repeat(Math.max(3, ...runs));
	return `${fence}text\n${text}\n${fence}`;
};

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

/** Rewrites the factory block of issue `number` for `state` and `data`, over its body as it is now. */
async function writeBlock(
	{ forge }: Deps,
	number: number,
	state: State,
	data: Data,
) {
	const { body } = await forge.issue(number);
	await forge.edit(number, { body: withBlock(body, state, data) });
}

/** The milestone's open issues with their data, or undefined once it halted on data it cannot read. */
async function load(pass: Pass): Promise<Entry[] | undefined> {
	const issues = (await pass.forge.open({ milestone: pass.milestone })).filter(
		(i) => i.milestone === pass.milestoneId,
	);
	const entries: Entry[] = [];
	for (const issue of issues) {
		try {
			entries.push({ issue, data: dataOf(issue.body) });
		} catch (error) {
			await halt(
				pass,
				`#${issue.number} has a malformed factory-data line`,
				`The factory-data line of #${issue.number} cannot be read:`,
				message(error),
				"Fix the line, or delete the factory block below the marker.",
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
		await halt(
			pass,
			`triage of #${issue.number} ${what}`,
			`The triage concert \`${id}\` of #${issue.number} ${what}:`,
			why.join(": "),
			`Read it with \`maestro ls ${id}\`. The next tick triages #${issue.number} again.`,
		);
		await writeBlock(pass, issue.number, state, { ...data, concert: id });
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

/** Routes each intake issue's newest triage concert the tick has not routed yet; false when it halted. */
async function route(pass: Pass, entries: Entry[]) {
	for (const entry of entries) {
		if (!isIntake(entry.issue)) continue;
		const tour = tourOf(pass.milestone, entry.issue.number);
		const concert = pass.concerts.find((c) => c.tour === tour && isTriage(c));
		if (!concert || concert.id === entry.data.concert) continue;
		if (!(await settle(pass, entry, concert.id))) return false;
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

/** Starts triage of the oldest intake issue, an encore of its last triage when it has one; halts on a refusal. */
async function triage(pass: Pass, entries: Entry[]) {
	const issue = pick(
		entries.filter((e) => !e.data.pending).map((e) => e.issue),
	);
	const last = entries.find((e) => e.issue === issue)?.data.triage;
	if (!issue) {
		pass.say("nothing to triage");
		return true;
	}
	const [closed, pulls] = await Promise.all([
		pass.forge.closed(CLOSED),
		pass.forge.pulls(),
	]);
	const issues = entries.map((e) => e.issue);
	const backlog = join(pass.dir, `backlog-i${issue.number}.md`);
	await Bun.write(
		backlog,
		snapshot(pass.milestone, issue.number, issues, closed, pulls),
	);
	try {
		const id = await pass.maestro.start(
			[
				"perform",
				...(last ? ["--encore", last] : [TRIAGE_FILE]),
				"--issue",
				issueText(issue),
				"--backlog",
				backlog,
				"--tour",
				tourOf(pass.milestone, issue.number),
				...(pass.preset ? ["--preset", pass.preset] : []),
			],
			join(pass.dir, `i${issue.number}.log`),
		);
		pass.say(`triaging #${issue.number}: concert ${id}`);
	} catch (error) {
		await halt(
			pass,
			`triage of #${issue.number} did not start`,
			`Triage of #${issue.number} did not start:`,
			message(error),
		);
	}
	return true;
}

/**
 * One pass: no action when another pass holds the lock, the factory is halted or a concert of the milestone runs;
 * else it routes settled triages, syncs, and starts one triage.
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
	for (const step of [route, sync, triage]) {
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
