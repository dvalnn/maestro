import { LENSES, panel } from "@maestro/classics";
import { changeset } from "@maestro/host-repo-sdk";
import { type ArtifactRef, lookup, type Ref } from "@maestro/sdk";
import { task } from "../shared";
import DESIGN_QUESTIONS from "./prompts/_design-questions.md" with {
	type: "text",
};
import GROUNDS from "./prompts/_grounds.md" with { type: "text" };
import TEST_GROUNDS from "./prompts/_test-grounds.md" with { type: "text" };
import LENS_DESIGN from "./prompts/lens-design.md" with { type: "text" };
import LENS_SPEC_TESTS from "./prompts/lens-spec-tests.md" with {
	type: "text",
};

export { DESIGN_QUESTIONS };

/** Every ground, which a skeptic or a consolidator rules by whatever lens found what it judges. */
export const JUDGED = task(GROUNDS, TEST_GROUNDS);

/**
 * Each panel tier's lenses, by name, as each lens's task; a lens rules by the grounds of what it looks for. Each tier
 * asks the design questions of one lens, the design lens where there is one, so no two lenses raise the same finding.
 */
export const PANELS = {
	ordinary: {
		correctness: task(LENSES.correctness, GROUNDS),
		"spec-tests": task(LENS_SPEC_TESTS, DESIGN_QUESTIONS, JUDGED),
	},
	risky: {
		correctness: task(LENSES.correctness, GROUNDS),
		"spec-tests": task(LENS_SPEC_TESTS, JUDGED),
		design: task(LENS_DESIGN, DESIGN_QUESTIONS, GROUNDS),
	},
};

/** A tier that reviews by panel. */
export type PanelTier = keyof typeof PANELS;

/** A panel of `tier`'s lenses over the lane version `change` against `spec`, no skeptics, one consolidated verdict. */
export function panelOf(
	tier: PanelTier,
	change: Ref<string>,
	spec: Ref<ArtifactRef>,
) {
	const lenses = PANELS[tier];
	return panel({
		items: Object.keys(lenses),
		task: (name) => lookup(lenses, name),
		change,
		patches: changeset(change, { label: "patches" }).out.changeset,
		spec,
		grounds: JUDGED,
		skeptics: false,
	});
}
