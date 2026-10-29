import { JsonOut, MarkdownOut, seat } from "@maestro/host-repo-sdk";
import { Acceptance, Evidence, Findings, Verdict, Verdicts } from "./types";

export const scout = seat("scout", {
	profile: "classics/scout",
	out: { evidence: JsonOut("evidence.json", Evidence) },
});

export const planner = seat("planner", {
	profile: "classics/planner",
	out: { plan: MarkdownOut("plan.md") },
});

export const builder = seat("builder", { profile: "classics/builder" });

export const lens = seat("lens", {
	profile: "classics/lens",
	verdict: true,
	out: { findings: JsonOut("findings.json", Findings) },
});

export const skeptic = seat("skeptic", {
	profile: "classics/skeptic",
	verdict: true,
	out: { verdicts: JsonOut("verdicts.json", Verdicts) },
});

export const consolidator = seat("consolidator", {
	profile: "classics/consolidator",
	verdict: true,
	out: {
		review: MarkdownOut("review.md"),
		verdict: JsonOut("verdict.json", Verdict),
	},
});

export const documenter = seat("documenter", {
	profile: "classics/documenter",
	out: {
		notes: MarkdownOut("notes.md"),
		acceptance: JsonOut("acceptance.json", Acceptance),
	},
});
