/** The factory's state machine, mirrored by docs/agents/factory.md and checked against it by a drift test. */

export const STATES = [
	"needs-triage",
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
	| "masterclass"
	| "auto-merge";
/**
 * A move of the state machine. An owner's move out of a state has a `turn`: the label or action that takes it and, as
 * an imperative, what it does.
 */
export type Transition = {
	from: Node;
	to: Node;
	actor: Actor;
	event: string;
	turn?: { label: string; text: string };
};

export const INTAKE: readonly State[] = ["needs-triage"];

const fromIntake = (to: State, event: string): Transition[] =>
	INTAKE.map((from) => ({ from, to, actor: "triage", event }));

export const TRANSITIONS: readonly Transition[] = [
	{
		from: "new",
		to: "needs-triage",
		actor: "owner",
		event: "filed",
	},
	{
		from: "new",
		to: "needs-triage",
		actor: "tick",
		event: "filed",
	},
	{
		from: "new",
		to: "needs-approval",
		actor: "masterclass",
		event: "lesson",
	},
	...fromIntake("ready-for-agent", "low, medium"),
	...fromIntake("needs-approval", "high, split"),
	...fromIntake("needs-info", "question"),
	...fromIntake("duplicate", "dup"),
	{
		from: "needs-approval",
		to: "ready-for-agent",
		actor: "owner",
		event: "approve",
		turn: {
			label: "ready-for-agent",
			text: "approve it, and the tour manager builds the spec or files the split.",
		},
	},
	{
		from: "ready-for-agent",
		to: "in-progress",
		actor: "tick",
		event: "split approved",
	},
	{
		from: "needs-approval",
		to: "needs-triage",
		actor: "owner",
		event: "answer",
		turn: {
			label: "needs-triage",
			text: "re-triage it, after a reply with an answer or a redirect.",
		},
	},
	{
		from: "needs-approval",
		to: "ready-for-human",
		actor: "owner",
		event: "take",
		turn: {
			label: "ready-for-human",
			text: "build it by hand.",
		},
	},
	{
		from: "needs-approval",
		to: "wontfix",
		actor: "owner",
		event: "drop",
		turn: { label: "wontfix", text: "drop it." },
	},
	{
		from: "ready-for-agent",
		to: "in-progress",
		actor: "tick",
		event: "build",
	},
	{
		from: "ready-for-agent",
		to: "needs-triage",
		actor: "tick",
		event: "stale",
	},
	{
		from: "in-progress",
		to: "in-review",
		actor: "tick",
		event: "PR",
	},
	{
		from: "in-progress",
		to: "closed",
		actor: "tick",
		event: "epic done",
	},
	{
		from: "in-progress",
		to: "needs-info",
		actor: "slice",
		event: "blocked",
	},
	{
		from: "in-progress",
		to: "needs-info",
		actor: "tick",
		event: "blocked",
	},
	{
		from: "in-progress",
		to: "ready-for-agent",
		actor: "slice",
		event: "red, infra",
	},
	{
		from: "in-review",
		to: "closed",
		actor: "owner",
		event: "merge",
		turn: { label: "merge", text: "land the PR." },
	},
	{
		from: "in-review",
		to: "closed",
		actor: "auto-merge",
		event: "merge",
	},
	{
		from: "in-review",
		to: "in-progress",
		actor: "owner",
		event: "changes",
		turn: {
			label: "request changes",
			text: "send the PR back for an encore, in an official review.",
		},
	},
	{
		from: "needs-info",
		to: "ready-for-agent",
		actor: "owner",
		event: "answer",
		turn: {
			label: "ready-for-agent",
			text: "build it again, after a reply with the answer.",
		},
	},
	{
		from: "needs-info",
		to: "needs-triage",
		actor: "owner",
		event: "answer triage",
		turn: {
			label: "needs-triage",
			text: "re-triage it, after a reply with the answer.",
		},
	},
	{
		from: "needs-info",
		to: "in-progress",
		actor: "owner",
		event: "apply",
		turn: { label: "in-progress", text: "apply the parked result." },
	},
	{
		from: "ready-for-human",
		to: "closed",
		actor: "owner",
		event: "done",
		turn: { label: "close", text: "close it once built." },
	},
	{
		from: "wontfix",
		to: "closed",
		actor: "owner",
		event: "close",
		turn: { label: "close", text: "close it." },
	},
	{
		from: "duplicate",
		to: "closed",
		actor: "tick",
		event: "close",
	},
];
