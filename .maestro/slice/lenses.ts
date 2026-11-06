import { LENSES } from "@maestro/classics";
import GROUNDS from "./prompts/_grounds.md" with { type: "text" };
import QUESTIONS from "./prompts/_review-questions.md" with { type: "text" };
import TEST_GROUNDS from "./prompts/_test-grounds.md" with { type: "text" };
import LENS_DESIGN from "./prompts/lens-design.md" with { type: "text" };
import LENS_SPEC_TESTS from "./prompts/lens-spec-tests.md" with {
	type: "text",
};

export { QUESTIONS };

export const task = (...parts: string[]) => parts.join("\n\n");

/** Every ground, which a skeptic or a consolidator rules by whatever lens found what it judges. */
export const JUDGED = task(GROUNDS, TEST_GROUNDS);

/** Each panel tier's lenses, by name, as each lens's task; a lens rules by the grounds of what it looks for. */
export const PANELS = {
	ordinary: {
		correctness: task(LENSES.correctness, GROUNDS),
		"spec-tests": task(LENS_SPEC_TESTS, QUESTIONS, JUDGED),
	},
	risky: {
		correctness: task(LENSES.correctness, GROUNDS),
		"spec-tests": task(LENS_SPEC_TESTS, JUDGED),
		design: task(LENS_DESIGN, QUESTIONS, GROUNDS),
	},
};
