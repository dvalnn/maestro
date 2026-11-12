import { MarkdownOut, seat } from "@maestro/host-repo-sdk";
import { Answers, Findings, Rulings, TestMap, Verdict } from "./types";

export const scout = seat("scout", {
	profile: "classics/scout",
	reply: { answers: Answers },
});

export const planner = seat("planner", {
	profile: "classics/planner",
	out: { plan: MarkdownOut("plan.md") },
});

export const builder = seat("builder", { profile: "classics/builder" });

export const tester = seat("tester", {
	profile: "classics/tester",
	reply: { map: TestMap },
});

export const lens = seat("lens", {
	profile: "classics/lens",
	verdict: true,
	reply: { findings: Findings },
});

export const skeptic = seat("skeptic", {
	profile: "classics/skeptic",
	verdict: true,
	reply: { rulings: Rulings },
});

export const consolidator = seat("consolidator", {
	profile: "classics/consolidator",
	reply: { verdict: Verdict },
});
