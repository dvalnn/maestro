import type { Issue, Pull } from "./forge";
import { askOf } from "./route";
import { INTAKE, STATES, type State } from "./transitions";

/** The states whose issues have a PR, or are building one. */
const WORK: readonly State[] = ["in-progress", "in-review"];

export const stateOf = (issue: Issue): State | undefined =>
	STATES.find((s) => issue.labels.includes(`state/${s}`));

export const isIntake = (issue: Issue) => {
	const state = stateOf(issue);
	return state !== undefined && INTAKE.includes(state);
};

/** The intake issue to triage next: the oldest. */
export const pick = (issues: readonly Issue[]): Issue | undefined =>
	issues.filter(isIntake).sort((a, b) => a.number - b.number)[0];

/** The tour of `issue`'s concerts in `milestone` (factory.md, Rules: Tour). */
export const tourOf = (milestone: string, issue: number) =>
	`${milestone}.i${issue}`;

/** What `--issue` takes: the number, title and ask. */
export const issueText = (issue: Issue) =>
	`#${issue.number} ${issue.title}\n\n${askOf(issue.body)}`;

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
 * The backlog snapshot `--backlog` takes: the milestone's open issues but `issue`, with their state and, while
 * built or reviewed, their PR's diffstat, then the newest closed issues.
 */
export function snapshot(
	milestone: string,
	issue: number,
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
