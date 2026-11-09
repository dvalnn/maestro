import type { Proposal, Question, Ruling, Triage } from "./schemas";

export const CONTRACT = "touches packages/ir/src/a.ts, which set a contract";

export const askAlone = (ask: string) => ({ ask, options: [], context: [] });

export const spec = {
	what: "Make greet.sh greet by name.",
	requirements: [
		"When greet.sh is given a name, greet.sh shall greet that name.",
	],
	figures: [
		{
			kind: "pseudocode" as const,
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
	acceptance: ["bun test ./packages/cli/src/a.test.ts # R1"],
	subject: "feat(cli): greet by name",
};
export const unspecified = {
	touches: ["packages/cli/src/a.ts"],
	contract: "",
};
export const ready: Proposal = {
	verdict: "ready-for-agent",
	...unspecified,
	spec,
};
export const medium: Pick<Triage, "risk" | "tier" | "area" | "reasons"> = {
	risk: "medium",
	tier: "ordinary",
	area: "cli",
	reasons: [],
};

export const groups = [
	{ id: "G1", area: "the flag", questions: ["Where are flags parsed?"] },
	{ id: "G2", area: "the tests", questions: ["Which test covers greet?"] },
];
export const planning: Ruling = {
	verdict: "plan",
	files: ["packages/cli/src/a.ts"],
	groups,
	questions: [],
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
