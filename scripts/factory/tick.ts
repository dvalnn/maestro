// What every step of a pass shares: its view of the forge and maestro, and the writes a step routes an issue with.
import { resolve } from "node:path";
import type { Comment, Forge, Issue } from "./forge";
import type { Landing } from "./land";
import type { Concert, Maestro } from "./maestro";
import { riskOf } from "./pick";
import {
	commentOf,
	type Data,
	fenced,
	type Option,
	questionOf,
	relabelled,
	specCommentOf,
	tracked,
} from "./route";
import type { State } from "./transitions";

export const HALT = "maestro-tm:halt";
export const REPO = resolve(import.meta.dir, "../..");
/** The preset a triage and a masterclass perform with, ahead of the pass's own. */
export const TRIAGE_PRESET = "triage";
/** A bare composition file's pack is its stem. */
const TRIAGE = { pack: "triage", composition: "triage" };
const SLICE = { pack: "slice", composition: "slice" };
const STACK_REVIEW = { pack: "review", composition: "review" };
export const BASE = "main";
/** How many closed issues the backlog snapshot lists. */
export const CLOSED = 20;

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

export type Entry = { issue: Issue; comments: Comment[]; data: Data };
/** One pass's view: `login` is the account the tick acts as on the forge. */
export type Pass = Deps &
	Options & {
		milestoneId: number;
		concerts: Concert[];
		login: string;
		/** The newest closed issues, read once per pass. */
		closed: () => Promise<Issue[]>;
	};

export const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export const isTriage = (c: Concert) =>
	c.pack === TRIAGE.pack && c.composition === TRIAGE.composition;
export const isSlice = (c: Concert) =>
	c.pack === SLICE.pack && c.composition === SLICE.composition;
export const isStackReview = (c: Concert) =>
	c.pack === STACK_REVIEW.pack && c.composition === STACK_REVIEW.composition;

export const branchOf = (issue: number) => `maestro-tm/i${issue}`;
export const firstLine = (body: string) => body.split("\n")[0]?.trimEnd();
/** The first line of a child of epic `epic`. */
export const partOf = (epic: number) => `Part of #${epic}`;

/** Files the halt issue: `lead`, then `detail` verbatim in a code block, then what to do next. */
export async function halt(
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
export async function writeSpec(
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
export const whichWay = (lead: string, options: Option[]) =>
	questionOf(
		[{ ask: WHICH_WAY, lead, options, context: [] }],
		"Label the ticket with your choice.",
	);

/**
 * Posts comment `body` on issue `number` unless one above comment id `after` holds it already, so a repeated pass
 * posts it once and a repeat of an answered question is posted again.
 */
export async function ask(
	{ forge }: Deps,
	number: number,
	body: string,
	after = 0,
) {
	const comments = await forge.comments(number);
	if (comments.some((c) => c.id > after && c.body.trim() === body.trim()))
		return;
	await forge.comment(number, body);
}

/** Moves issue `number` to `state`, keeping its other labels. */
export async function move({ forge }: Deps, number: number, state: State) {
	const { labels } = await forge.issue(number);
	if (labels.includes(`state/${state}`)) return;
	await forge.setLabels(
		number,
		relabelled(labels, ["state"], [`state/${state}`]),
	);
}

export const RETRIAGE: Option = {
	label: "`needs-triage`",
	text: "triage it again",
};

/** The data of a ticket with no concert to continue. */
export const UNCONTINUED: Data = { encore: undefined, revisionBase: undefined };

/** Whether `issue` is low risk, so its PR to `main` merges on its own (factory.md, Rules, Policy: Risk and tier). */
export const isLow = (issue: Issue, { result }: Data) =>
	result !== undefined && riskOf(issue, result.risk) === "low";

/**
 * Starts `maestro <args>`, writing what it printed to `log` when given, and returns its concert's id; undefined once
 * it halted on the refusal of `what`.
 */
export async function start(
	pass: Pass,
	what: string,
	args: string[],
	log?: string,
) {
	try {
		return await pass.maestro.start(args, log);
	} catch (error) {
		await halt(
			pass,
			`${what} did not start`,
			`${what[0]?.toUpperCase()}${what.slice(1)} did not start:`,
			message(error),
		);
		return undefined;
	}
}
