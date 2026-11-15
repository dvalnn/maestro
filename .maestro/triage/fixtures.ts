import type { Answers } from "@maestro/classics";
import type { ValueOf } from "@maestro/sdk";
import type { Group, Proposal, Question, Ruling, Triage } from "./schemas";

type Answer = ValueOf<typeof Answers>[number];

export const CONTRACT = "touches packages/ir/src/a.ts, which set a contract";

export const askAlone = (ask: string) => ({ ask, options: [], context: [] });

export const spec: NonNullable<Proposal["spec"]> = {
	what: "Make greet.sh greet by name.",
	requirements: [
		"When greet.sh is given a name, greet.sh shall greet that name.",
	],
	figures: [
		{
			kind: "pseudocode",
			caption: "",
			source: " greet(name)\n-  print hello\n+  print hello, name ¹",
			notes: ["The name is the first argument"],
		},
	],
	consequences: "Scripts that call greet.sh bare still greet.",
	decisions: [
		{ lead: "Name source", points: ["The first argument", "In greet.sh"] },
	],
	excluded: [{ lead: "Flags", points: [] }],
	subject: "feat(cli): greet by name",
};
export const unspecified: Pick<Proposal, "touches" | "contract"> = {
	touches: ["packages/cli/src/a.ts"],
	contract: "",
};
export const ready: Proposal = {
	verdict: "ready-for-agent",
	...unspecified,
	spec,
};
export const medium: Pick<Triage, "risk" | "area" | "reasons"> = {
	risk: "medium",
	area: "cli",
	reasons: [],
};

export const groups: Group[] = [
	{ id: "G1", area: "the flag", questions: ["Where are flags parsed?"] },
	{ id: "G2", area: "the tests", questions: ["Which test covers greet?"] },
];
export const planning: Ruling = {
	verdict: "plan",
	files: ["packages/cli/src/a.ts"],
	groups,
	questions: [],
};

export const bugIssue =
	"#2 greet.sh crashes without a name\n\nRunning `greet.sh` with no argument prints `unbound variable`; it should greet the world.";
export const diagnosing: Ruling = {
	verdict: "plan",
	files: ["packages/cli/src/a.ts"],
	groups: [
		{
			id: "G1",
			area: "Diagnose: greet.sh crashes without a name",
			questions: [
				"Which command fails, with what output?",
				"Which file:line holds the cause?",
			],
		},
	],
	questions: [],
};
export const grounded: Answer = {
	question: "Which command fails, with what output?",
	state: "grounded",
	answer:
		"Ran `sh greet.sh`: `greet.sh: 3: name: unbound variable`. Cause at greet.sh:3.",
};
export const unsure: Answer = {
	question: "Which file:line holds the cause?",
	state: "unsure",
	missing: "the reproduction: greet.sh does not exist in the lane",
	answer: "Could not run it.",
};

export const claiming: Question = {
	ask: "Where should a loose file's config live?",
	lead: "A loose file has params.",
	options: [
		{ label: "A", text: "top-level keys" },
		{ label: "B", text: "a files. namespace" },
	],
	recommend: { label: "B", why: "it keeps D-24." },
	context: [{ topic: "D-24", text: "A shared config breaks nothing." }],
};

export const failed =
	"The spec misses uninstall, which removes the file (install.ts:12).";

export const premiseFinding =
	"Premise: greet.sh already greets by name (greet.sh:3), so the spec's missing behaviour exists.";
export const yagniFinding =
	"YAGNI: the flags requirement answers neither the ask nor the replies (greet.sh:9).";
