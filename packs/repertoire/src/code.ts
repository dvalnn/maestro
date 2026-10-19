import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef, CodeContext, Settled, Type } from "@maestro/sdk";
import { Findings, Verdicts } from "./types";

/** `text` as a Markdown file. */
export function toMarkdown(
	{ text }: { text: string },
	ctx: CodeContext,
): { file: string } {
	const file = join(ctx.scratch, "request.md");
	writeFileSync(file, `${text}\n`);
	return { file };
}

/** What one member of a review panel delivers: its lens's findings and its skeptic's verdicts. */
type Round = {
	lens: { findings: ArtifactRef };
	skeptic: { verdicts: ArtifactRef };
};

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
function readOutput<T>(ctx: CodeContext, ref: ArtifactRef, type: Type<T>): T {
	const value: unknown = JSON.parse(readFileSync(ctx.path(ref), "utf8"));
	if (!conforms(type, value))
		throw new Error(`${ref.path} does not fit its declared schema`);
	return value;
}

/** The lines of `item`'s section: none for a clean lens or none upheld, a note for a member that did not settle `ok`. */
function sectionOf(
	item: string,
	round: Settled<Round>,
	ctx: CodeContext,
): string[] {
	if (round.outcome === "skipped") return [];
	if (round.outcome !== "ok")
		return [`## ${item}`, "", `unverified: ${round.reason}`, ""];
	const { findings } = readOutput(ctx, round.value.lens.findings, Findings);
	const verdicts = readOutput(ctx, round.value.skeptic.verdicts, Verdicts);
	const upheld = findings.flatMap((f) => {
		const verdict = verdicts.find((v) => v.id === f.id && v.holds);
		return verdict ? [{ ...f, why: verdict.why }] : [];
	});
	if (!upheld.length) return [];
	return [
		`## ${item}`,
		"",
		...upheld.map(
			(f) =>
				`- ${f.id}, ${f.where} (${f.blocking ? "blocking" : "advisory"}): ${f.issue}\n  Upheld: ${f.why}`,
		),
		"",
	];
}

/**
 * The findings each skeptic upheld, as Markdown, one section per item of `items` in the order of `rounds`. A member
 * whose lens was clean has none.
 */
export function survivorsOf(
	{ rounds, items }: { rounds: Settled<Round>[]; items: string[] },
	ctx: CodeContext,
): { survivors: string } {
	const sections = rounds.flatMap((round, i) =>
		sectionOf(items[i] ?? `item ${i + 1}`, round, ctx),
	);
	const file = join(ctx.scratch, "survivors.md");
	writeFileSync(
		file,
		[
			"# Findings the skeptics upheld",
			"",
			...(sections.length ? sections : ["None.", ""]),
		].join("\n"),
	);
	return { survivors: file };
}
