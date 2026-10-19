import { JsonOut, MarkdownOut, seat } from "@maestro/host-repo-sdk";
import builderIdentity from "./prompts/builder.md" with { type: "text" };
import consolidatorIdentity from "./prompts/consolidator.md" with {
	type: "text",
};
import lensIdentity from "./prompts/lens.md" with { type: "text" };
import skepticIdentity from "./prompts/skeptic.md" with { type: "text" };
import { Findings, Verdict, Verdicts } from "./types";

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
