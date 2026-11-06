import type { Section, SectionRow } from "@maestro/host-repo";
import { paint } from "./output";

const MARK_STYLE = { "✓": "green", "✗": "red", "?": "dim" } as const;

const INDENT = "  ";
/** A row's key column, so its value starts at column 15 under a section header of the same width. */
const KEY_WIDTH = 12;
const HEAD_WIDTH = INDENT.length + KEY_WIDTH;
const KEY_GAP = "  ";
/** The width a fault's lines wrap at. */
const LINE_WIDTH = 80;

/** `text` broken at spaces into lines of at most `width` cells; a longer word keeps a line of its own. */
function wrapWords(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const word of text.split(" ")) {
		const joined = `${lines.at(-1)} ${word}`;
		if (lines.length && Bun.stringWidth(joined) <= width)
			lines[lines.length - 1] = joined;
		else lines.push(word);
	}
	return lines;
}

/** A row: its mark in place of the indent when it has one, the dim key, the value, the dim `[source]`, each fault under. */
function rowLines(r: SectionRow, color: boolean): string[] {
	const key = paint("dim", `${r.key}${KEY_GAP}`.padEnd(KEY_WIDTH), color);
	const source =
		r.source === undefined ? "" : `  ${paint("dim", `[${r.source}]`, color)}`;
	const lead = r.mark ? `${paint(MARK_STYLE[r.mark], r.mark, color)} ` : INDENT;
	const faults = (r.faults ?? [])
		.flatMap((f) => wrapWords(f, LINE_WIDTH - HEAD_WIDTH))
		.map((l) => `${" ".repeat(HEAD_WIDTH)}${paint("red", l, color)}`);
	return [`${lead}${key}${r.value}${source}`, ...faults];
}

function sectionLines(s: Section, color: boolean): string[] {
	const title = paint(
		"bold",
		s.value === undefined ? s.title : s.title.padEnd(HEAD_WIDTH),
		color,
	);
	const source =
		s.source === undefined ? "" : `  ${paint("dim", `[${s.source}]`, color)}`;
	return [
		`${title}${s.value ?? ""}${source}`,
		...s.rows.flatMap((r) => rowLines(r, color)),
		...(s.foot ?? []).map((f) =>
			f.dim ? paint("dim", f.text, color) : f.text,
		),
	];
}

/** `sections` with bold titles and dim keys, each value at column 15, a blank line between sections. */
export const sectionsText = (sections: readonly Section[], color: boolean) =>
	sections.map((s) => sectionLines(s, color).join("\n")).join("\n\n");
