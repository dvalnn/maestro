import {
	closeSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { extname, join } from "node:path";
import { attachmentPath, mountedName } from "../profile/index";

/** The most entries a directory attachment lists, one level deep, before `… N more entries`. */
export const MAX_LISTED_ENTRIES = 12;

const LEAD =
	"Read-only files your task needs. Read a file whole; browse and grep a directory.";
const ROOT = attachmentPath("");
const BYTES_PER_KB = 1024;
const KB_PER_MB = 1024;
const MB_DECIMALS = 1;
const BRANCH = "├── ";
const LAST = "└── ";
const TRUNK = "│   ";
const GAP = "    ";

/** An attachment of a task: its name, its hint, the format its artifact declares if any, and its host path. */
export type Attached = {
	name: string;
	hint: string;
	format?: string;
	source: string;
};

type Facts = { files: number; bytes: number };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function sizeText(bytes: number): string {
	if (bytes < BYTES_PER_KB) return `${bytes} B`;
	const kb = bytes / BYTES_PER_KB;
	return kb < KB_PER_MB
		? `${Math.round(kb)} KB`
		: `${(kb / KB_PER_MB).toFixed(MB_DECIMALS)} MB`;
}

const NEWLINE = 0x0a;
const CHUNK_BYTES = 64 * BYTES_PER_KB;

/** The lines of the file at `path`: its newlines, and one more when its last line has none. Reads in chunks. */
function lineCount(path: string): number {
	const fd = openSync(path, "r");
	const chunk = Buffer.alloc(CHUNK_BYTES);
	let lines = 0;
	let last: number | undefined;
	try {
		for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) {
			for (let i = 0; i < n; i++) if (chunk[i] === NEWLINE) lines++;
			last = chunk[n - 1];
		}
	} finally {
		closeSync(fd);
	}
	return last === undefined || last === NEWLINE ? lines : lines + 1;
}

/** The files and directories directly in `dir`, by name; a symlink is left out, as it may dangle or loop. */
const entriesOf = (dir: string) =>
	readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() || e.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name));

/** The count and total size of the files under `dir`. */
function measure(dir: string): Facts {
	const total: Facts = { files: 0, bytes: 0 };
	for (const entry of entriesOf(dir)) {
		const path = join(dir, entry.name);
		const part = entry.isDirectory()
			? measure(path)
			: { files: 1, bytes: statSync(path).size };
		total.files += part.files;
		total.bytes += part.bytes;
	}
	return total;
}

/** A file's description: its type when known, its lines and its size. */
function fileFacts(path: string, type: string | undefined): string {
	return [type, plural(lineCount(path), "line"), sizeText(statSync(path).size)]
		.filter(Boolean)
		.join(", ");
}

const extensionOf = (path: string) => extname(path).slice(1) || undefined;

function dirFacts(path: string): string {
	const { files, bytes } = measure(path);
	return `${plural(files, "file")}, ${sizeText(bytes)}`;
}

const label = (name: string, dir: boolean) => (dir ? `${name}/` : name);

/** The lines under a directory, one level, each file with its type, lines and size, capped at `MAX_LISTED_ENTRIES`. */
function listing(dir: string, indent: string): string[] {
	const entries = entriesOf(dir);
	const shown = entries.slice(0, MAX_LISTED_ENTRIES).map((e) => {
		const path = join(dir, e.name);
		const isDir = e.isDirectory();
		return {
			text: label(e.name, isDir),
			facts: isDir ? dirFacts(path) : fileFacts(path, extensionOf(path)),
		};
	});
	const hidden = entries.length - shown.length;
	const width = Math.max(0, ...shown.map((r) => r.text.length));
	return [
		...shown.map(
			({ text, facts }, i) =>
				`${indent}${i === shown.length - 1 && !hidden ? LAST : BRANCH}${text.padEnd(width)}   ${facts}`,
		),
		...(hidden
			? [
					`${indent}${LAST}… ${hidden} more ${hidden === 1 ? "entry" : "entries"}`,
				]
			: []),
	];
}

/** The tree of `attached` under `/in/`, one line per attachment with its type, size and hint, a directory's files below. */
function tree(attached: Attached[]): string {
	const rows = attached.map((a) => {
		const source = realpathSync(a.source);
		const dir = statSync(source).isDirectory();
		const name = mountedName(a.name, a.source);
		const facts = dir
			? dirFacts(source)
			: fileFacts(source, extname(name) ? undefined : a.format);
		return { a, source, dir, text: label(name, dir), facts };
	});
	const width = Math.max(...rows.map((r) => r.text.length));
	return [
		ROOT,
		...rows.flatMap(({ a, source, dir, text, facts }, i) => {
			const last = i === rows.length - 1;
			const head = `${last ? LAST : BRANCH}${text.padEnd(width)}   ${facts}: ${a.hint}`;
			return [head, ...(dir ? listing(source, last ? GAP : TRUNK) : [])];
		}),
	].join("\n");
}

/** A value inlined in a task: the title of its section and its text. */
export type Relayed = { title: string; text: string };

/**
 * `task`, then each relay as a `## <title>` section in order, then the attachments the agent must read as a tree under
 * `/in/`; each part left out when it has nothing to say.
 */
export const taskOf = (
	task: string,
	relayed: Relayed[],
	attached: Attached[],
): string =>
	[
		task,
		...relayed.map(({ title, text }) => `## ${title}\n\n${text.trimEnd()}`),
		...(attached.length ? [LEAD, tree(attached)] : []),
	].join("\n\n");
