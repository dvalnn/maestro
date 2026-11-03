import type { Comment, Issue, Pull } from "./forge";
import {
	askOf,
	type Data,
	isAsked,
	lastSpecLines,
	QUESTION,
	RISKS,
	type Risk,
	type Spec,
	type Tier,
	type Triage,
} from "./route";
import { INTAKE, STATES, type State } from "./transitions";

/** The states whose issues have a PR, or are building one. */
const WORK: readonly State[] = ["in-progress", "in-review"];

export const stateOf = (issue: Issue): State | undefined =>
	STATES.find((s) => issue.labels.includes(`state/${s}`));

export const isIntake = (issue: Issue) => {
	const state = stateOf(issue);
	return state !== undefined && INTAKE.includes(state);
};

/** Orders issue numbers `pinned` first, in pinned order, then the rest oldest first. */
const pinnedFirst = (pinned: readonly number[]) => {
	const rank = (n: number) => {
		const at = pinned.indexOf(n);
		return at < 0 ? pinned.length : at;
	};
	return (a: number, b: number) => rank(a) - rank(b) || a - b;
};

/** The intake issue to triage next: a pinned one first, in pinned order, else the oldest. */
export const pick = (
	issues: readonly Issue[],
	pinned: readonly number[] = [],
): Issue | undefined =>
	issues
		.filter(isIntake)
		.sort((a, b) => pinnedFirst(pinned)(a.number, b.number))[0];

/** The slice tier, and preset, of each risk but high, whose tier triage gives (factory.md, Rules: Risk and tier). */
const TIER: Record<Exclude<Risk, "high">, Tier> = {
	low: "small",
	medium: "ordinary",
};

/** The risk of `issue`: its `risk/` label's, else the one triage gave it. */
export const riskOf = (issue: Issue, triaged: Risk) =>
	RISKS.find((r) => issue.labels.includes(`risk/${r}`)) ?? triaged;

/** The slice tier of `issue`: its risk's, or at high risk the tier `triaged` gave, `ordinary` when it gave none. */
export function tierOf(issue: Issue, triaged: Pick<Triage, "risk" | "tier">) {
	const risk = riskOf(issue, triaged.risk);
	if (risk !== "high") return TIER[risk];
	return triaged.tier === "risky" ? "risky" : "ordinary";
}

/**
 * The `ready-for-agent` issues a build may take, pinned ones first in pinned order, then oldest first: each with a
 * spec, no split's epic among them. Their forge dependencies are left to the caller.
 */
export const buildable = <T extends { issue: Issue; data: Data }>(
	entries: readonly T[],
	pinned: readonly number[] = [],
): T[] =>
	entries
		.filter(
			({ issue, data }) =>
				stateOf(issue) === "ready-for-agent" &&
				!data.pending &&
				data.result?.spec !== undefined &&
				data.result.children === undefined &&
				!issue.labels.includes("kind/epic"),
		)
		.sort((a, b) => pinnedFirst(pinned)(a.issue.number, b.issue.number));

/** The tour of `issue`'s concerts in `milestone` (factory.md, Rules: Tour and title). */
export const tourOf = (milestone: string, issue: number) =>
	`${milestone}.i${issue}`;

/** The longest issue title a concert's title carries whole. */
const TITLE_CHARS = 60;

/** The title of `issue`'s concerts: `factory: ` and the issue's title, cut with an ellipsis past `TITLE_CHARS`. */
export const titleOf = ({ title }: Issue) =>
	`factory: ${title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title}`;

/** `comment` as a triage reads it: a question comment `login` posted headed as the tour manager's, any other by its author. */
const fed = (comment: Comment, login: string) =>
	isAsked(comment, login)
		? ["## Question by the tour manager", comment.body.replace(QUESTION, "")]
		: [`## Reply by ${comment.author}`, comment.body];

/**
 * What `--issue` takes: the number, title and ask, the `last` spec a re-triage starts from, then each of `replies` under
 * its heading, `login` being the tick's.
 */
export const issueText = (
	issue: Issue,
	replies: readonly Comment[],
	login: string,
	last?: Spec,
) =>
	[
		`#${issue.number} ${issue.title}`,
		"",
		askOf(issue.body),
		...(last ? ["", ...lastSpecLines(last)] : []),
		...replies.flatMap((r) => {
			const [heading, body] = fed(r, login);
			return ["", heading, "", body?.trim()];
		}),
	].join("\n");

const closes = (pull: Pull, issue: number) =>
	new RegExp(`\\bCloses #${issue}\\b`, "i").test(pull.body);

function openEntry(issue: Issue, pulls: readonly Pull[]): string[] {
	const state = stateOf(issue);
	const pull =
		state && WORK.includes(state)
			? pulls.find((p) => closes(p, issue.number))
			: undefined;
	return [
		`### #${issue.number} ${issue.title}`,
		"",
		`State: \`${state ?? "none"}\``,
		...(pull
			? [
					`PR #${pull.number}: +${pull.additions} -${pull.deletions} in ${pull.files} files`,
				]
			: []),
		"",
		askOf(issue.body),
		"",
	];
}

/**
 * The backlog snapshot `--backlog` takes: the milestone's open issues but `issue`, when given, with their state and,
 * while built or reviewed, their PR's diffstat, then the newest closed issues.
 */
export function snapshot(
	milestone: string,
	issue: number | undefined,
	open: readonly Issue[],
	closed: readonly Issue[],
	pulls: readonly Pull[],
): string {
	return [
		`# Backlog of ${milestone}`,
		"",
		"## Open",
		"",
		...open
			.filter((i) => i.number !== issue)
			.flatMap((i) => openEntry(i, pulls)),
		"## Recently closed",
		"",
		...closed.map((i) => `- #${i.number} ${i.title}`),
		"",
	].join("\n");
}

/** A ticket whose spec was approved, or that closed as completed, at `at` (ms since the epoch), and the files it touches. */
export type Approval = {
	number: number;
	at: number;
	touches: readonly string[];
};

/** Each of `approvals` after `since` whose files include one of `touches`, with the files they share. */
export const overlaps = (
	touches: readonly string[],
	since: number,
	approvals: readonly Approval[],
) =>
	approvals
		.filter((a) => a.at > since)
		.map((a) => ({
			number: a.number,
			files: a.touches.filter((f) => touches.includes(f)),
		}))
		.filter((o) => o.files.length);
