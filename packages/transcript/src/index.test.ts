import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transcript } from "./index";
import { differing, picture, sectionsOf } from "./picture";

const RED = "\u001b[31m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const REVERSE = "\u001b[7m";
const OFF = "\u001b[22m\u001b[39m";
const RESET = "\u001b[0m";
const GREY = "\u001b[38;5;250m";
const ITALIC = "\u001b[3m";
const ITALIC_OFF = "\u001b[23m";
const REVERSE_OFF = "\u001b[27m";
const SECTION = {
	name: "ls, 6 columns",
	columns: 6,
	shown: `${RED}fail${OFF}`,
};

const scratch = () => mkdtemp(join(tmpdir(), "transcript-"));

const caller = {
	TRANSCRIPTS: process.env.TRANSCRIPTS,
	TRANSCRIPTS_COLOR: process.env.TRANSCRIPTS_COLOR,
};
const setEnv = (name: keyof typeof caller, value: string | undefined) => {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
};
afterEach(() => {
	for (const name of Object.keys(caller) as (keyof typeof caller)[])
		setEnv(name, caller[name]);
});

// Seam: the committed file a transcript is compared with, and the colored copy left for a picture.
describe("transcript", () => {
	test("writes a section without color under its name and its terminal's edge, then holds the code to it", async () => {
		const dir = await scratch();
		const file = pathToFileURL(join(dir, "ls.txt"));
		delete process.env.TRANSCRIPTS;
		await expect(transcript(file, [SECTION])).rejects.toThrow();
		process.env.TRANSCRIPTS = "write";
		process.env.TRANSCRIPTS_COLOR = join(dir, "color");
		await transcript(file, [SECTION]);
		expect(await Bun.file(file).text()).toBe(
			"## ls, 6 columns\n─────┐\nfail\n",
		);
		expect(await Bun.file(join(dir, "color/ls.ansi")).text()).toContain(
			`${RED}fail`,
		);
		delete process.env.TRANSCRIPTS;
		await transcript(file, [SECTION]);
		await expect(
			transcript(file, [{ ...SECTION, shown: "ok" }]),
		).rejects.toThrow();
	});
});

// Seam: the SVG a colored transcript is drawn as.
describe("picture", () => {
	test("draws each cell in its color at its column, wraps a line at the terminal's width, and leaves a panel blank where it lacks the section", () => {
		const styled = `${DIM}${RED}g${RESET}h${REVERSE}i${RESET}${GREY}j`;
		const offs = `${DIM}k${OFF}l${ITALIC}m${ITALIC_OFF}n${REVERSE}o${REVERSE_OFF}p`;
		const lines = [`${BOLD}${RED}ab${OFF}cdef`, styled, offs, "## ?"];
		const text = `## x\n───┐\n${lines.join("\n")}\n\n## y\n─┐\nq\n\n`;
		const sections = sectionsOf(text);
		// a shown line that starts `## ` stays in its section, and so does a blank last row
		expect(sections).toEqual([
			{ name: "x", columns: 4, lines },
			{ name: "y", columns: 2, lines: ["q", ""] },
		]);
		expect(sectionsOf("")).toEqual([]);
		const svg = picture(
			[
				{ label: "before", sections: [] },
				{ label: "after", sections },
			],
			["x"],
		);
		const cells = [
			...svg.matchAll(
				/<text x="([\d.]+)" y="([\d.]+)" fill="([^"]+)"( font-weight="bold")?>(.)</g,
			),
		];
		const cell = (ch: string) => cells.find((c) => c[5] === ch);
		const [a, e] = [cell("a"), cell("e")];
		expect(a?.[3]).toBe("#f7768e");
		expect(a?.[4]).toBeDefined();
		// `e` is the fifth cell of a line four wide: under `a`, one line down, in the terminal's own color
		expect(e?.[1]).toBe(a?.[1]);
		expect(Number(e?.[2])).toBeGreaterThan(Number(a?.[2]));
		expect(e?.[3]).toBe("#c8ccd4");
		// dim keeps its color; a reset clears color and attributes; reverse video paints a cell over its color; soft grey
		expect(cell("g")?.[3]).toBe("#f7768e");
		expect(cell("h")?.[3]).toBe("#c8ccd4");
		expect(cell("i")?.[3]).toBe("#16161e");
		expect(cell("j")?.[3]).toBe("#bcbcbc");
		expect(svg).toContain('width="8.4" height="19" fill="#c8ccd4"/><text');
		// dim alone is grey; each off code ends its own attribute
		expect(cell("k")?.[3]).toBe("#6b7089");
		expect(cell("l")?.[3]).toBe("#c8ccd4");
		expect(svg).toContain(' font-style="italic">m<');
		expect(cell("n")).toBeDefined();
		expect(cell("o")?.[3]).toBe("#16161e");
		expect(cell("p")?.[3]).toBe("#c8ccd4");
		// the background, one box, and the two reversed cells
		expect(svg.match(/<rect /g)).toHaveLength(4);
	});
});

// Seam: which sections a base and this tree draw side by side.
describe("differing", () => {
	test("names a section that changed in width or lines, or that only one side holds", () => {
		const s = (name: string, columns: number, line = "a") => ({
			name,
			columns,
			lines: [line],
		});
		const was = [s("same", 5), s("lines", 5), s("width", 5), s("gone", 5)];
		const now = [s("same", 5), s("lines", 5, "b"), s("width", 6), s("new", 5)];
		expect(differing(was, now)).toEqual(["lines", "width", "new", "gone"]);
	});
});
