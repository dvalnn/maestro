import { JsonOut, MarkdownOut, seat } from "@maestro/host-repo-sdk";
import builderIdentity from "./prompts/builder.md" with { type: "text" };
import consolidatorIdentity from "./prompts/consolidator.md" with {
	type: "text",
};
import documenterIdentity from "./prompts/documenter.md" with { type: "text" };
import lensIdentity from "./prompts/lens.md" with { type: "text" };
import plannerIdentity from "./prompts/planner.md" with { type: "text" };
import scoutIdentity from "./prompts/scout.md" with { type: "text" };
import skepticIdentity from "./prompts/skeptic.md" with { type: "text" };
import { Acceptance, Evidence, Findings, Verdict, Verdicts } from "./types";

export const scout = seat({
	role: "scout",
	identity: scoutIdentity,
	out: { evidence: JsonOut("evidence.json", Evidence) },
});

export const planner = seat({
	role: "planner",
	identity: plannerIdentity,
	out: { plan: MarkdownOut("plan.md") },
});

export const builder = seat({ role: "builder", identity: builderIdentity });

export const lens = seat({
	role: "reviewer",
	identity: lensIdentity,
	out: { findings: JsonOut("findings.json", Findings) },
});

export const skeptic = seat({
	role: "skeptic",
	identity: skepticIdentity,
	out: { verdicts: JsonOut("verdicts.json", Verdicts) },
});

export const consolidator = seat({
	role: "reviewer",
	identity: consolidatorIdentity,
	out: {
		review: MarkdownOut("review.md"),
		verdict: JsonOut("verdict.json", Verdict),
	},
});

export const documenter = seat({
	role: "documenter",
	identity: documenterIdentity,
	out: {
		notes: MarkdownOut("notes.md"),
		acceptance: JsonOut("acceptance.json", Acceptance),
	},
});
