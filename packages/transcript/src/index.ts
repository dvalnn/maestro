import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

/** What a terminal `columns` wide shows at one moment, color codes and all, under a name saying which moment. */
export type Section = { name: string; columns: number; shown: string };

const SUFFIX = /\.txt$/;

/** A section as a transcript holds it: its name, a rule ending at the terminal's edge, then what `show` makes of it. */
const block = (s: Section, show: (shown: string) => string) =>
	`## ${s.name}\n${"─".repeat(Math.max(0, s.columns - 1))}┐\n${show(s.shown)}\n`;

/**
 * Expects `sections`, without their color, to be the text of the committed `file`.
 *
 * With `TRANSCRIPTS=write` it rewrites `file` first, after an intended change. With `TRANSCRIPTS_COLOR=<dir>` it also
 * leaves the sections with their color in `<dir>`, under `file`'s name ending `.ansi`, for `picture.ts` to draw.
 */
export async function transcript(file: URL, sections: readonly Section[]) {
	const text = sections
		.map((s) => block(s, stripVTControlCharacters))
		.join("\n");
	if (process.env.TRANSCRIPTS === "write") await Bun.write(file, text);
	const colored = process.env.TRANSCRIPTS_COLOR;
	if (colored) {
		await mkdir(colored, { recursive: true });
		await Bun.write(
			join(colored, basename(fileURLToPath(file)).replace(SUFFIX, ".ansi")),
			sections.map((s) => block(s, (shown) => shown)).join("\n"),
		);
	}
	const committed = Bun.file(file);
	expect(text).toBe((await committed.exists()) ? await committed.text() : "");
}

export { fixedRun, until } from "./fixed";
