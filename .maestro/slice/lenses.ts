import { LENSES, panel } from "@maestro/classics";
import { type ArtifactRef, type Ref, use } from "@maestro/sdk";
import { task } from "../shared";
import DESIGN_QUESTIONS from "./prompts/_design-questions.md" with {
	type: "text",
};
import DESIGN_SEARCHES from "./prompts/_design-searches.md" with {
	type: "text",
};
import GROUNDS from "./prompts/_grounds.md" with { type: "text" };
import TEST_GROUNDS from "./prompts/_test-grounds.md" with { type: "text" };
import LENS_CORRECTNESS_DESIGN from "./prompts/lens-correctness-design.md" with {
	type: "text",
};
import LENS_DESIGN from "./prompts/lens-design.md" with { type: "text" };
import LENS_SPEC_TESTS from "./prompts/lens-spec-tests.md" with {
	type: "text",
};

export { DESIGN_QUESTIONS, DESIGN_SEARCHES };

/** Every ground, which a skeptic or a consolidator rules by whatever lens found what it judges. */
export const JUDGED = task(GROUNDS, TEST_GROUNDS);

/**
 * Each panel tier's lenses, by name, as each lens's task; a lens rules by the grounds of what it looks for. Each tier
 * asks the design questions of one lens, the design lens where there is one, so no two lenses raise the same finding.
 */
export const PANELS = {
	ordinary: {
		"correctness-design": task(
			LENS_CORRECTNESS_DESIGN,
			DESIGN_SEARCHES,
			DESIGN_QUESTIONS,
			GROUNDS,
		),
		"spec-tests": task(LENS_SPEC_TESTS, JUDGED),
	},
	risky: {
		correctness: task(LENSES.correctness, GROUNDS),
		"spec-tests": task(LENS_SPEC_TESTS, JUDGED),
		design: task(LENS_DESIGN, DESIGN_SEARCHES, DESIGN_QUESTIONS, GROUNDS),
	},
};

/** A tier that reviews by panel. */
type PanelTier = keyof typeof PANELS;

/** The panel params of `tier`: its lenses, no skeptics, every ground. */
export const panelParams = (tier: PanelTier) => ({
	lenses: PANELS[tier],
	skeptics: false,
	grounds: JUDGED,
});

/** A panel of `tier`'s lenses over the lane version `change` against `spec`, no skeptics, one consolidated verdict. Ends in the tally. */
export function panelOf(
	tier: PanelTier,
	ports: { change: Ref<string>; spec: Ref<ArtifactRef> },
) {
	return use(panel, ports, { params: panelParams(tier) });
}
