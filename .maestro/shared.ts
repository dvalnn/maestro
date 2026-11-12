import { Brief, briefOf, toMarkdown } from "@maestro/classics";
import { check, fresh, type Report } from "@maestro/host-repo-sdk";
import { code, Markdown, type Ref } from "@maestro/sdk";

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

/** The check a repair or fix round runs to format what it changed. */
export const FIX_CHECK = "fmt";

/** Every check of `target.checks` in `.maestro/config.yaml`, as an agent may run only those it names. */
export const REPO_CHECKS = [
	"format",
	"lint",
	"types",
	"test",
	"all",
	FIX_CHECK,
];

/** The builder's report as the brief its review seats read. */
export const briefFrom = (report: Ref<Report>) =>
	code(briefOf, { in: { report }, out: { brief: Brief }, label: "brief" }).out
		.brief;
