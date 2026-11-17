import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXIT_FOUND = 1;
const MAX_WORDS = 25;
const MAX_SENTENCES = 6;
const BASELINE = "scripts/plain-english-baseline.json";

/** A long sentence or paragraph, by the line where it starts. */
export type Finding = {
	line: number;
	kind: "sentence" | "paragraph";
	words?: number;
	sentences?: number;
};

type Part = { line: number; text: string };

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const FOOTNOTE = /^\s*\[\^[^\]]+\]:\s*/;
const FENCE = /^\s*(```|~~~)/;
const QUOTE = /^\s{0,3}>\s?/;

/** Drops inline code and link targets, keeping link text. */
function cleanInline(text: string) {
	return text
		.replace(/`+[^`]*`+/g, " ")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
		.replace(/<(?:https?:|mailto:)[^>]*>/g, " ")
		.replace(/^\s*\[[^\]]+\]:\s+\S+.*$/, "");
}

type Kind = "blank" | "skip" | "quote" | "item" | "text" | "code";
type Tagged = Part & { kind: Kind };

/** What a line is, outside code fences and HTML blocks; `skip` lines are headings, tables and rules. */
function classify(raw: string): Kind {
	if (raw.trim() === "") return "blank";
	if (/^\s{0,3}<(?!https?:|mailto:)/.test(raw)) return "skip";
	if (/^\s{0,3}#{1,6}(\s|$)|^\s*\||^\s{0,3}(?:[-*_]\s*){3,}$/.test(raw))
		return "skip";
	if (QUOTE.test(raw)) return raw.replace(QUOTE, "").trim() ? "quote" : "blank";
	return LIST_ITEM.test(raw) || FOOTNOTE.test(raw) ? "item" : "text";
}

type State = { fence?: string; html: boolean };

/** The kind of a line, moving the fence and HTML-block state; `code` lines are dropped. */
function tagLine(text: string, state: State): Kind {
	const mark = FENCE.exec(text)?.[1];
	if (state.fence) {
		if (mark === state.fence) state.fence = undefined;
		return "code";
	}
	if (mark) {
		state.fence = mark;
		return "blank";
	}
	const kind = classify(text);
	if (kind === "blank") state.html = false;
	else if (state.html) return "code";
	else if (kind === "skip") state.html = text.trimStart().startsWith("<");
	return kind;
}

/** The lines after front matter, each tagged with its kind. */
function tagged(source: string): Tagged[] {
	const lines = source.split(/\r?\n/);
	const end =
		lines[0]?.trim() === "---"
			? lines.findIndex((l, n) => n > 0 && l.trim() === "---")
			: -1;
	const state: State = { html: false };
	return lines
		.map((text, i) => ({ line: i + 1, text, kind: tagLine(text, state) }))
		.filter((t, i) => i > end && t.kind !== "code");
}

/** A line's prose, without its quote, list or footnote marker, inline code or link targets. */
const proseOf = (text: string) =>
	cleanInline(
		text.replace(QUOTE, "").replace(LIST_ITEM, "").replace(FOOTNOTE, ""),
	);

/** Whether a line of `kind` after one of `previous` begins a new paragraph. */
const startsParagraph = (kind: Kind, previous: Kind) =>
	["blank", "skip", "item"].includes(kind) ||
	(kind === "quote" && previous !== "quote");

/** The prose paragraphs of a Markdown text, each as its cleaned lines with their line numbers. */
function paragraphs(source: string): Part[][] {
	const out: Part[][] = [];
	let current: Part[] = [];
	let previous: Kind = "blank";
	for (const { line, text, kind } of tagged(source)) {
		const breaks = startsParagraph(kind, previous);
		if (breaks && current.length) out.push(current);
		if (breaks) current = [];
		if (["item", "text", "quote"].includes(kind))
			current.push({ line, text: proseOf(text) });
		previous = kind;
	}
	if (current.length) out.push(current);
	return out;
}

/** Splits a paragraph into sentences, each with the line it starts on. */
function sentences(paragraph: Part[]): { line: number; words: number }[] {
	let joined = "";
	const starts: { offset: number; line: number }[] = [];
	for (const part of paragraph) {
		starts.push({ offset: joined.length, line: part.line });
		joined += `${part.text} `;
	}
	const lineAt = (offset: number) => {
		let line = starts[0]?.line ?? 0;
		for (const s of starts) if (s.offset <= offset) line = s.line;
		return line;
	};
	const found: { line: number; words: number }[] = [];
	let start = 0;
	const flushSentence = (end: number) => {
		const piece = joined.slice(start, end);
		const words = piece.split(/\s+/).filter(Boolean);
		if (words.length) {
			const lead = piece.length - piece.trimStart().length;
			found.push({ line: lineAt(start + lead), words: words.length });
		}
		start = end;
	};
	const boundary = /[.!?]+["')\]]*\s+/g;
	for (let m = boundary.exec(joined); m; m = boundary.exec(joined))
		flushSentence(m.index + m[0].length);
	flushSentence(joined.length);
	return found;
}

/** The long sentences and long paragraphs of one Markdown text. */
export function findings(source: string): Finding[] {
	const found: Finding[] = [];
	for (const paragraph of paragraphs(source)) {
		const split = sentences(paragraph);
		for (const s of split)
			if (s.words > MAX_WORDS)
				found.push({ line: s.line, kind: "sentence", words: s.words });
		if (split.length > MAX_SENTENCES)
			found.push({
				line: split[0]?.line ?? 0,
				kind: "paragraph",
				sentences: split.length,
			});
	}
	return found.sort((a, b) => a.line - b.line);
}

/** The tracked Markdown files of the git checkout at `root`, by repo-relative path. */
function tracked(root: string) {
	const result = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.md"], {
		cwd: root,
	});
	if (result.exitCode !== 0)
		throw new Error(`git ls-files failed in ${root}: ${result.stderr}`);
	return result.stdout
		.toString()
		.split("\0")
		.filter((f) => f && existsSync(resolve(root, f)));
}

/** The findings of each tracked Markdown file under `root` that has any, by repo-relative path. */
export async function scan(root: string): Promise<Record<string, Finding[]>> {
	const out: Record<string, Finding[]> = {};
	for (const file of tracked(root).sort()) {
		const found = findings(await Bun.file(resolve(root, file)).text());
		if (found.length) out[file] = found;
	}
	return out;
}

export type Baseline = Record<string, number>;

/** The baseline at `path`, empty when there is none. */
export async function readBaseline(path: string): Promise<Baseline> {
	const file = Bun.file(path);
	if (!(await file.exists())) return {};
	return parseBaseline(await file.json(), path);
}

/** The baseline in `value`, read from `path`; throws an error naming the file and key when it is not an object of non-negative integer counts. */
function parseBaseline(value: unknown, path: string): Baseline {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${path}: the baseline must be a JSON object of counts`);
	const entries: [string, number][] = [];
	for (const [key, count] of Object.entries(value)) {
		if (!Number.isInteger(count) || count < 0)
			throw new Error(
				`${path}: the count for ${JSON.stringify(key)} must be a non-negative integer`,
			);
		entries.push([key, count]);
	}
	return Object.fromEntries(entries);
}

/** The baseline as JSON, one line per file, sorted by path, as Biome formats it. */
export function formatBaseline(baseline: Baseline): string {
	const keys = Object.keys(baseline).sort();
	if (!keys.length) return "{}\n";
	return `{\n${keys.map((k) => `\t${JSON.stringify(k)}: ${baseline[k]}`).join(",\n")}\n}\n`;
}

/** The counts of every file with findings, for the first baseline. */
export async function counts(root: string): Promise<Baseline> {
	const found = await scan(root);
	return Object.fromEntries(
		Object.entries(found).map(([f, list]) => [f, list.length]),
	);
}

/** The files above their baseline, with their findings, and the files below it, with their counts. */
export async function check(root: string, baseline: Baseline) {
	const found = await scan(root);
	const over: Record<string, Finding[]> = {};
	const under: { file: string; count: number; baseline: number }[] = [];
	for (const [file, list] of Object.entries(found))
		if (list.length > (baseline[file] ?? 0)) over[file] = list;
	for (const [file, limit] of Object.entries(baseline)) {
		const count = found[file]?.length ?? 0;
		if (count < limit) under.push({ file, count, baseline: limit });
	}
	return { over, under };
}

/** The baseline with each count lowered to the current count; zero or missing files dropped; no count raised. */
export async function lowered(root: string, baseline: Baseline) {
	const found = await scan(root);
	const next: Baseline = {};
	for (const [file, limit] of Object.entries(baseline)) {
		const count = Math.min(limit, found[file]?.length ?? 0);
		if (count > 0) next[file] = count;
	}
	return next;
}

const describe = (f: Finding) =>
	f.kind === "sentence"
		? `a sentence of ${f.words} words, over ${MAX_WORDS}`
		: `a paragraph of ${f.sentences} sentences, over ${MAX_SENTENCES}`;

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	const path = resolve(root, BASELINE);
	let baseline: Baseline;
	try {
		baseline = await readBaseline(path);
	} catch (e) {
		if (e instanceof SyntaxError) throw e;
		console.error(
			`${(e as Error).message}\nFix the baseline, or restore it from git`,
		);
		process.exit(EXIT_FOUND);
	}
	if (process.argv.includes("--update")) {
		await Bun.write(path, formatBaseline(await lowered(root, baseline)));
	} else {
		const { over, under } = await check(root, baseline);
		for (const { file, count, baseline: limit } of under)
			console.log(
				`${file}: count ${count} is below its baseline ${limit}; run bun scripts/plain-english.ts --update`,
			);
		const files = Object.keys(over);
		if (files.length) {
			console.error(
				`docs prose over the Plain English limits (.maestro/prompts/_plain.md), above the baseline:\n${files
					.flatMap((f) =>
						(over[f] as Finding[]).map(
							(x) => `  ${f}:${x.line}: ${describe(x)}`,
						),
					)
					.join("\n")}\nShorten the prose; --update only lowers the baseline`,
			);
			process.exit(EXIT_FOUND);
		}
	}
}
