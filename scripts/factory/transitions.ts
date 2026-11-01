/** The factory's state machine, mirrored by docs/agents/factory.md and checked against it by a drift test. */

export const STATES = [
	"needs-triage",
	"needs-spec",
	"needs-approval",
	"ready-for-agent",
	"in-progress",
	"in-review",
	"needs-info",
	"ready-for-human",
	"wontfix",
	"duplicate",
] as const;
export type State = (typeof STATES)[number];
/** `new` is an issue not yet filed, `closed` the forge's closed state, which no label marks. */
export type Node = State | "new" | "closed";
export type Actor =
	| "owner"
	| "tick"
	| "triage"
	| "slice"
	| "harvest"
	| "auto-merge";
/** A move of the state machine; `how` says in a line when and how it is taken, an owner's as an imperative clause. */
export type Transition = {
	from: Node;
	to: Node;
	actor: Actor;
	event: string;
	how: string;
};

export const INTAKE: readonly State[] = ["needs-triage", "needs-spec"];
/** Stands in a `how` for the login the tick acts as, which only a pass knows. */
export const LOGIN = "<login>";

const fromIntake = (to: State, event: string, how: string): Transition[] =>
	INTAKE.map((from) => ({ from, to, actor: "triage", event, how }));

export const TRANSITIONS: readonly Transition[] = [
	{
		from: "new",
		to: "needs-triage",
		actor: "owner",
		event: "filed",
		how: "file it here to triage it",
	},
	{
		from: "new",
		to: "needs-spec",
		actor: "owner",
		event: "filed",
		how: "file it here to design it first",
	},
	{
		from: "new",
		to: "needs-triage",
		actor: "tick",
		event: "filed",
		how: "the tick files obstacles, gaps and children here",
	},
	{
		from: "new",
		to: "needs-approval",
		actor: "harvest",
		event: "lesson",
		how: "harvest files a lesson here",
	},
	...fromIntake(
		"ready-for-agent",
		"low, medium",
		"triage specs it at low or medium risk",
	),
	...fromIntake(
		"needs-approval",
		"high, split",
		"triage specs it at high risk, or splits it",
	),
	...fromIntake("needs-info", "question", "triage asks the owner a question"),
	...fromIntake("duplicate", "dup", "triage finds it repeats an open issue"),
	{
		from: "needs-approval",
		to: "ready-for-agent",
		actor: "owner",
		event: "approve",
		how: "label `ready-for-agent` to approve the spec or split",
	},
	{
		from: "ready-for-agent",
		to: "in-progress",
		actor: "tick",
		event: "split approved",
		how: "the tick files the split's children",
	},
	{
		from: "needs-approval",
		to: "needs-triage",
		actor: "owner",
		event: "answer",
		how: "reply mentioning `@<login>` with an answer or a redirect, then label `needs-triage` to re-triage",
	},
	{
		from: "needs-approval",
		to: "ready-for-human",
		actor: "owner",
		event: "take",
		how: "label `ready-for-human` to build it yourself",
	},
	{
		from: "needs-approval",
		to: "wontfix",
		actor: "owner",
		event: "drop",
		how: "label `wontfix` to drop it",
	},
	{
		from: "ready-for-agent",
		to: "in-progress",
		actor: "tick",
		event: "build",
		how: "the tick starts its build",
	},
	{
		from: "in-progress",
		to: "in-review",
		actor: "tick",
		event: "PR",
		how: "the tick opens the PR of a green slice",
	},
	{
		from: "in-progress",
		to: "closed",
		actor: "tick",
		event: "epic done",
		how: "the tick closes an epic once its last child closes",
	},
	{
		from: "in-progress",
		to: "needs-info",
		actor: "slice",
		event: "blocked",
		how: "a blocked slice asks its question",
	},
	{
		from: "in-progress",
		to: "needs-info",
		actor: "tick",
		event: "blocked",
		how: "the tick asks the owner once out of attempts",
	},
	{
		from: "in-progress",
		to: "ready-for-agent",
		actor: "slice",
		event: "red, infra",
		how: "a red slice with attempts left, or an infra fault, requeues it",
	},
	{
		from: "in-review",
		to: "closed",
		actor: "owner",
		event: "merge",
		how: "merge the PR",
	},
	{
		from: "in-review",
		to: "closed",
		actor: "auto-merge",
		event: "merge",
		how: "auto-merge lands a low-risk PR",
	},
	{
		from: "in-review",
		to: "needs-info",
		actor: "tick",
		event: "conflict",
		how: "the tick asks the owner when a stacked PR conflicts with `main` restacking",
	},
	{
		from: "in-review",
		to: "in-progress",
		actor: "owner",
		event: "changes",
		how: "request changes on the PR",
	},
	{
		from: "needs-info",
		to: "ready-for-agent",
		actor: "owner",
		event: "answer",
		how: "answer the question in a reply mentioning `@<login>`, then label `ready-for-agent` to build again",
	},
	{
		from: "needs-info",
		to: "ready-for-agent",
		actor: "tick",
		event: "obstacle closed",
		how: "the tick requeues it once its obstacle closes",
	},
	{
		from: "needs-info",
		to: "needs-triage",
		actor: "owner",
		event: "answer triage",
		how: "answer the question in a reply mentioning `@<login>`, then label `needs-triage` to re-triage",
	},
	{
		from: "needs-info",
		to: "in-progress",
		actor: "owner",
		event: "apply",
		how: "label `in-progress` to apply the parked result",
	},
	{
		from: "ready-for-human",
		to: "closed",
		actor: "owner",
		event: "done",
		how: "close it once built",
	},
	{
		from: "wontfix",
		to: "closed",
		actor: "owner",
		event: "close",
		how: "close it",
	},
	{
		from: "duplicate",
		to: "closed",
		actor: "tick",
		event: "close",
		how: "the tick closes it",
	},
];
