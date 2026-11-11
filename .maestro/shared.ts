import { type tallyOf, toMarkdown } from "@maestro/classics";
import { check, fresh } from "@maestro/host-repo-sdk";
import { code, Markdown, type Ref, reject } from "@maestro/sdk";

/** The review tiers, shallowest first: the tier triage rules is the depth slice reviews at. */
export const TIERS = ["small", "ordinary", "risky"] as const;
export type Tier = (typeof TIERS)[number];

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

/** A round's `tally` with `extra` outputs beside it, a rejection's included. */
export function withOutputs<E extends object>(
	tally: ReturnType<typeof tallyOf>,
	extra: E,
) {
	return "outcome" in tally
		? reject(tally.reason, { ...tally.outputs, ...extra })
		: { ...tally, ...extra };
}
