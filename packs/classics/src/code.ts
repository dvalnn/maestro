import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ArtifactRef,
	CodeContext,
	Settled,
	Type,
	ValueOf,
} from "@maestro/sdk";
import { Findings, Verdicts } from "./types";

/** The part of a code function's context that reads and writes files. */
type Files = Pick<CodeContext, "scratch" | "path">;

/** The absolute path of `name` in the instance's scratch directory, written with `lines`. */
function written(ctx: Files, name: string, lines: string[]): string {
	const file = join(ctx.scratch, name);
	writeFileSync(file, lines.join("\n"));
	return file;
}

/** `text` as a Markdown file. */
export function toMarkdown(
	{ text }: { text: string },
	ctx: CodeContext,
): { file: string } {
	return { file: written(ctx, "request.md", [text, ""]) };
}

/** What one member of a review panel delivers: its lens's findings, with its skeptic's verdicts when it has a skeptic. */
type Round =
	| { lens: { findings: ArtifactRef }; skeptic: { verdicts: ArtifactRef } }
	| { findings: ArtifactRef };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` has the shape of `schema`, a schema the SDK's `Struct`, `List`, `Text` and `Bool` write. */
function fits(schema: unknown, value: unknown): boolean {
	if (!isRecord(schema)) return true;
	const { type, properties, items } = schema;
	if (type === "object")
		return (
			isRecord(value) &&
			isRecord(properties) &&
			Object.entries(properties).every(([field, s]) => fits(s, value[field]))
		);
	if (type === "array")
		return Array.isArray(value) && value.every((item) => fits(items, item));
	return typeof value === type;
}

const conforms = <T>(type: Type<T>, value: unknown): value is T =>
	fits(type.schema, value);

/**
 * The JSON file `ref`, as `type`.
 * @throws Error naming the file when it does not fit `type`.
 */
function readOutput<T>(ctx: Files, ref: ArtifactRef, type: Type<T>): T {
	const value: unknown = JSON.parse(readFileSync(ctx.path(ref), "utf8"));
	if (!conforms(type, value))
		throw new Error(`${ref.path} does not fit its declared schema`);
	return value;
}

/** The line under an upheld finding: the skeptic's `why`, or a mark that no skeptic ruled on it. */
export const rulingLine = (why?: string) =>
	why === undefined ? "Unverified: no skeptic ruled on it" : `Upheld: ${why}`;

/** A finding the skeptic held and the skeptic's why, absent when no skeptic ruled on it. */
export type Upheld = ValueOf<typeof Findings>["findings"][number] & {
	why?: string;
};

/** The `findings` the skeptic held, each with its why; every one without a why when there are no `verdicts`. */
export function upheld(
	findings: ValueOf<typeof Findings>["findings"],
	verdicts?: ValueOf<typeof Verdicts>,
): Upheld[] {
	if (!verdicts) return findings;
	return findings.flatMap((f) => {
		const verdict = verdicts.find((v) => v.id === f.id && v.holds);
		return verdict ? [{ ...f, why: verdict.why }] : [];
	});
}

/**
 * The lines of `item`'s section: none for a clean lens or none upheld, a note for a member that did not settle `ok`.
 * A member without a skeptic upholds every finding, each marked unverified.
 */
function sectionOf(item: string, round: Settled<Round>, ctx: Files): string[] {
	if (round.outcome === "skipped") return [];
	if (round.outcome !== "ok")
		return [`## ${item}`, "", `unverified: ${round.reason}`, ""];
	const { value } = round;
	const { findings } = readOutput(
		ctx,
		"lens" in value ? value.lens.findings : value.findings,
		Findings,
	);
	const verdicts =
		"skeptic" in value && readOutput(ctx, value.skeptic.verdicts, Verdicts);
	const kept = upheld(findings, verdicts || undefined);
	if (!kept.length) return [];
	return [
		`## ${item}`,
		"",
		...kept.map(
			(f) =>
				`- ${f.id}, ${f.where} (${f.blocking ? "blocking" : "advisory"}): ${f.issue}\n  ${rulingLine(f.why)}`,
		),
		"",
	];
}

/**
 * The findings upheld, as Markdown, one section per lens name of `items` in the order of `rounds`. A member whose lens
 * was clean has none.
 */
export function survivorsOf(
	{ rounds, items }: { rounds: Settled<Round>[]; items: readonly string[] },
	ctx: Files,
): { survivors: string } {
	const sections = rounds.flatMap((round, i) =>
		sectionOf(items[i] ?? `item ${i + 1}`, round, ctx),
	);
	return {
		survivors: written(ctx, "survivors.md", [
			"# Upheld findings",
			"",
			...(sections.length ? sections : ["None.", ""]),
		]),
	};
}
