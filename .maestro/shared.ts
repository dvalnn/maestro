import { toMarkdown } from "@maestro/classics";
import { check, fresh } from "@maestro/host-repo-sdk";
import { code, Markdown, type Ref } from "@maestro/sdk";
import GROUNDS from "./slice/prompts/_grounds.md" with { type: "text" };
import TEST_GROUNDS from "./slice/prompts/_test-grounds.md" with {
	type: "text",
};

/** A seat's task: `parts`, each a prompt file or fragment, a blank line apart. */
export const task = (...parts: string[]) => parts.join("\n\n");

/** One base version of the target, sealed by a no-op check, for every seat of a read-only composition to read. */
export const sealedBase = () =>
	check(fresh(), { run: "true" }, { label: "base" }).out.lane;

/**
 * `text` as a Markdown file, by a code node labelled `label`; the calling composition must export `toMarkdown`
 * (ADR 0008).
 */
export const markdownOf = (text: Ref<string> | string, label: string) =>
	code(toMarkdown, {
		in: { text },
		out: { file: Markdown() },
		label,
	}).out.file;

/** Every ground, which the consolidator rules a finding by whatever lens found it. */
export const JUDGED = task(GROUNDS, TEST_GROUNDS);
