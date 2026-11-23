// A cell's width, a line's height, the text size and the margin, in pixels.
const CELL = 8.4;
const LINE = 19;
const SIZE = 14;
const PAD = 14;

const BACK = "#16161e";
const TEXT = "#c8ccd4";
const DIM = "#6b7089";
const LABEL = "#8b90a8";
const EDGE = "#3b3f51";
// The eight colors a terminal names, in SGR order from black to white.
const NAMED = [
	"#414868",
	"#f7768e",
	"#9ece6a",
	"#e0af68",
	"#7aa2f7",
	"#bb9af7",
	"#7dcfff",
	TEXT,
];
// The 256-color grey the live view draws soft text in.
const SOFT_GREY = "#bcbcbc";

type Style = {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	reverse: boolean;
	color: string | undefined;
};
const PLAIN: Style = {
	bold: false,
	dim: false,
	italic: false,
	reverse: false,
	color: undefined,
};

// The SGR parameters maestro writes: reset, bold, dim, italic, reverse, their offs, the named colors and the soft grey.
const CHANGES: Readonly<Record<number, Partial<Style>>> = {
	0: PLAIN,
	1: { bold: true },
	2: { dim: true },
	3: { italic: true },
	7: { reverse: true },
	22: { bold: false, dim: false },
	23: { italic: false },
	27: { reverse: false },
	39: { color: undefined },
	...Object.fromEntries(NAMED.map((color, i) => [30 + i, { color }])),
};

/** `style` after the SGR parameters `codes`. A parameter maestro never writes leaves it as it is. */
function styledBy(style: Style, codes: readonly number[]): Style {
	if (codes[0] === 38) return { ...style, color: SOFT_GREY };
	return Object.assign({}, style, ...codes.map((code) => CHANGES[code]));
}

type Cell = { text: string; column: number; style: Style };
const ESC = "\u001b";
const SGR_SPLIT = new RegExp(`(${ESC}\\[[\\d;]*m)`);
const SGR = new RegExp(`^${ESC}\\[([\\d;]*)m$`);
const graphemes = new Intl.Segmenter();

function cellsOf(line: string): { cells: Cell[]; width: number } {
	const cells: Cell[] = [];
	let style = PLAIN;
	let column = 0;
	for (const part of line.split(SGR_SPLIT)) {
		const codes = SGR.exec(part)?.[1];
		if (codes !== undefined) {
			style = styledBy(style, (codes || "0").split(";").map(Number));
			continue;
		}
		for (const { segment } of graphemes.segment(part)) {
			cells.push({ text: segment, column, style });
			column += Bun.stringWidth(segment);
		}
	}
	return { cells, width: column };
}

export type Drawn = { name: string; columns: number; lines: string[] };

// A header is `## <name>` and the rule that ends in `┐`; a shown line that starts with `## ` is not one.
const HEADER = /^(?=## [^\n]*\n─*┐$)/m;

/** The sections of a transcript's text, colored or not. */
export const sectionsOf = (text: string): Drawn[] =>
	text
		.split(HEADER)
		.filter(Boolean)
		.map((section, i, all) => {
			// A section ends in its own newline, and all but the last in the blank line that parts it from the next.
			const [header = "", edge = "", ...lines] = section
				.slice(0, i < all.length - 1 ? -2 : -1)
				.split("\n");
			return {
				name: header.slice(3),
				columns: Bun.stringWidth(edge),
				lines,
			};
		});

/** The names, this tree's sections first, of the sections that are in only one of the lists or differ in width or lines. */
export function differing(was: readonly Drawn[], now: readonly Drawn[]) {
	const key = (s: Drawn) => `${s.columns}\n${s.lines.join("\n")}`;
	const named = (list: readonly Drawn[], name: string) =>
		list.find((s) => s.name === name);
	const names = new Set([...now, ...was].map((s) => s.name));
	return [...names].filter((name) => {
		const [a, b] = [named(was, name), named(now, name)];
		return !a || !b || key(a) !== key(b);
	});
}

const escaped = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

const label = (x: number, y: number, text: string, bold = false) =>
	`<text x="${x}" y="${y + SIZE}" fill="${LABEL}"${bold ? ' font-weight="bold"' : ""}>${escaped(text)}</text>`;

/** A cell as SVG, in the box of `s` whose corner is at `x`, `y`, `row` lines down before any wrap. */
function drawnCell(cell: Cell, s: Drawn, x: number, y: number, row: number) {
	const { bold, dim, italic, reverse, color } = cell.style;
	const left = (x + (cell.column % s.columns) * CELL).toFixed(1);
	const base = y + 4 + (row + Math.floor(cell.column / s.columns)) * LINE;
	const weight = bold ? ' font-weight="bold"' : "";
	const slant = italic ? ' font-style="italic"' : "";
	const ink = color ?? (dim ? DIM : TEXT);
	const text = `<text x="${left}" y="${base + SIZE}" fill="${reverse ? BACK : ink}"${weight}${slant}>${escaped(cell.text)}</text>`;
	if (!reverse) return text;
	const width = Bun.stringWidth(cell.text) * CELL;
	return `<rect x="${left}" y="${base}" width="${width}" height="${LINE}" fill="${ink}"/>${text}`;
}

/** One section in a box as wide as its terminal; a line wider than that wraps as a terminal wraps it. */
function boxed(s: Drawn, x: number, y: number) {
	const out: string[] = [];
	let row = 0;
	for (const line of s.lines) {
		const { cells, width } = cellsOf(line);
		const inked = cells.filter(
			(cell) => cell.text !== " " || cell.style.reverse,
		);
		out.push(...inked.map((cell) => drawnCell(cell, s, x, y, row)));
		row += Math.max(1, Math.ceil(width / s.columns));
	}
	const height = row * LINE + 8;
	const box = `<rect x="${x - 4}" y="${y}" width="${s.columns * CELL + 8}" height="${height}" fill="none" stroke="${EDGE}"/>`;
	return { svg: box + out.join(""), height };
}

/** A transcript's sections under the label of where they were drawn, such as `before` or `after`. */
export type Panel = { label: string; sections: readonly Drawn[] };

/**
 * An SVG of the sections named `names`, as a terminal shows them: a column per panel, a row per section, a panel that
 * lacks a section left blank there.
 */
export function picture(panels: readonly Panel[], names: readonly string[]) {
	const shown = panels.flatMap((p) =>
		p.sections.filter((s) => names.includes(s.name)),
	);
	const column = Math.max(...shown.map((s) => s.columns)) * CELL + PAD * 2;
	const out = panels.map((p, i) => label(PAD + i * column, PAD, p.label, true));
	let y = PAD + LINE * 1.6;
	for (const name of names) {
		out.push(label(PAD, y, name));
		y += LINE * 1.3;
		const boxes = panels.flatMap((p, i) => {
			const section = p.sections.find((s) => s.name === name);
			return section ? [boxed(section, PAD + i * column, y)] : [];
		});
		out.push(...boxes.map((b) => b.svg));
		y += Math.max(0, ...boxes.map((b) => b.height)) + LINE;
	}
	const width = panels.length * column + PAD;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y}" font-family="ui-monospace, 'Cascadia Mono', 'DejaVu Sans Mono', monospace" font-size="${SIZE}"><rect width="100%" height="100%" fill="${BACK}"/>${out.join("")}</svg>`;
}
