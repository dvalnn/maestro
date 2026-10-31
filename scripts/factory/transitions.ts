/** The factory's state machine (D16), mirrored by docs/agents/factory.md and checked against it by a drift test. */

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
export type Transition = {
	from: Node;
	to: Node;
	actor: Actor;
	event: string;
};

export const INTAKE: readonly State[] = ["needs-triage", "needs-spec"];

const fromIntake = (to: State, event: string): Transition[] =>
	INTAKE.map((from) => ({ from, to, actor: "triage", event }));

export const TRANSITIONS: readonly Transition[] = [
	{ from: "new", to: "needs-triage", actor: "owner", event: "filed" },
	{ from: "new", to: "needs-spec", actor: "owner", event: "filed" },
	{ from: "new", to: "needs-triage", actor: "tick", event: "filed" },
	{ from: "new", to: "needs-approval", actor: "harvest", event: "lesson" },
	...fromIntake("ready-for-agent", "low, medium"),
	...fromIntake("needs-approval", "high, split"),
	...fromIntake("needs-info", "no spec"),
	...fromIntake("duplicate", "dup"),
	{
		from: "needs-approval",
		to: "ready-for-agent",
		actor: "owner",
		event: "approve",
	},
	{
		from: "ready-for-agent",
		to: "in-progress",
		actor: "tick",
		event: "split approved",
	},
	{ from: "needs-approval", to: "needs-info", actor: "owner", event: "ask" },
	{
		from: "needs-approval",
		to: "ready-for-human",
		actor: "owner",
		event: "take",
	},
	{ from: "needs-approval", to: "wontfix", actor: "owner", event: "drop" },
	{ from: "ready-for-agent", to: "in-progress", actor: "tick", event: "build" },
	{ from: "in-progress", to: "in-review", actor: "tick", event: "PR" },
	{ from: "in-progress", to: "closed", actor: "tick", event: "epic done" },
	{ from: "in-progress", to: "needs-info", actor: "slice", event: "blocked" },
	{ from: "in-progress", to: "needs-info", actor: "tick", event: "blocked" },
	{
		from: "in-progress",
		to: "ready-for-agent",
		actor: "slice",
		event: "red, infra",
	},
	{ from: "in-review", to: "closed", actor: "owner", event: "merge" },
	{ from: "in-review", to: "closed", actor: "auto-merge", event: "merge" },
	{ from: "in-review", to: "in-progress", actor: "owner", event: "changes" },
	{
		from: "needs-info",
		to: "ready-for-agent",
		actor: "owner",
		event: "answer",
	},
	{
		from: "needs-info",
		to: "ready-for-agent",
		actor: "tick",
		event: "obstacle closed",
	},
	{
		from: "needs-info",
		to: "needs-triage",
		actor: "owner",
		event: "answer triage",
	},
	{ from: "ready-for-human", to: "closed", actor: "owner", event: "done" },
	{ from: "wontfix", to: "closed", actor: "owner", event: "close" },
	{ from: "duplicate", to: "closed", actor: "tick", event: "close" },
];

/** The moves out of `state`, each as `<to> (<actor>: <event>)`. */
export const nextOf = (state: Node): string[] =>
	TRANSITIONS.filter((t) => t.from === state).map(
		(t) => `${t.to} (${t.actor}: ${t.event})`,
	);
