import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { check, counts, formatBaseline, lowered, scan } from "./plain-english";

/** A git repository holding `files`, all tracked. */
function repo(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "plain-english-"));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	for (const args of [
		["init", "-q"],
		["add", "."],
	])
		expect(Bun.spawnSync(["git", ...args], { cwd: dir }).exitCode).toBe(0);
	return dir;
}

const words = (n: number) => Array(n).fill("word").join(" ");
const lines = async (text: string) =>
	Object.values(await scan(repo({ "a.md": text })))
		.flat()
		.map((f) => f.line);

test("a sentence of 25 words passes and one of 26 words fails at its line", async () => {
	expect(await lines(`${words(25)}.\n`)).toEqual([]);
	expect(await lines(`Short.\n${words(26)}.\n`)).toEqual([2]);
});

test("a paragraph of six sentences passes and one of seven fails at its line", async () => {
	expect(await lines("# T\n\nA. B. C. D. E. F.\n")).toEqual([]);
	expect(await lines("# T\n\nA. B. C. D.\nE. F. G.\n")).toEqual([3]);
});

test("code, link targets, tables, headings, HTML and front matter are left out", async () => {
	const long = words(30);
	const text = [
		"---",
		`title: ${long}`,
		"---",
		`# ${long}`,
		"",
		"```",
		`${long}.`,
		"```",
		"",
		`| ${long} |`,
		"",
		"<div>",
		`${long}`,
		"</div>",
		"",
		`Short [${words(2)}](http://example.org/${long.replaceAll(" ", "/")}) and \`${long}\`.`,
		"",
	].join("\n");
	expect(await lines(text)).toEqual([]);
});

test("inline code and link targets do not count but link text does", async () => {
	expect(
		await lines(`${words(24)} \`x y z\` [two words](http://a.b).\n`),
	).toEqual([1]);
});

test("each list item, block quote and footnote is a paragraph of its own", async () => {
	const six = "A. B. C. D. E. F.";
	expect(
		await lines(
			`- ${six}\n- ${six}\n\n> ${six}\n\n> ${six}\n\nText.[^1]\n\n[^1]: ${six}\n`,
		),
	).toEqual([]);
	expect(await lines(`- ${six}\n  G.\n`)).toEqual([1]);
});

test("a file git does not track is not scanned and a deleted file is skipped", async () => {
	const dir = repo({ "gone.md": `${words(30)}.\n` });
	rmSync(join(dir, "gone.md"));
	writeFileSync(join(dir, "draft.md"), `${words(30)}.\n`);
	expect(await scan(dir)).toEqual({});
});

test("a file above its baseline fails and an unlisted file has a baseline of zero", async () => {
	const dir = repo({
		"a.md": `${words(26)}.\n`,
		"b.md": `${words(26)}.\n`,
	});
	const { over, under } = await check(dir, { "a.md": 1 });
	expect(Object.keys(over)).toEqual(["b.md"]);
	expect(under).toEqual([]);
});

test("a file below its baseline passes and is named for an update", async () => {
	const dir = repo({ "a.md": `${words(26)}.\n` });
	const { over, under } = await check(dir, { "a.md": 3 });
	expect(over).toEqual({});
	expect(under).toEqual([{ file: "a.md", count: 1, baseline: 3 }]);
});

test("update lowers counts, never raises them, and drops zero and missing files", async () => {
	const dir = repo({
		"a.md": `${words(26)}.\n`,
		"b.md": `${words(26)}.\n\n${words(26)}.\n`,
		"c.md": "Short.\n",
	});
	expect(
		await lowered(dir, { "a.md": 3, "b.md": 1, "c.md": 2, "gone.md": 4 }),
	).toEqual({ "a.md": 1, "b.md": 1 });
});

test("the baseline is one sorted line per file, and empty as braces", () => {
	expect(formatBaseline({ "b.md": 2, "a.md": 1 })).toBe(
		'{\n\t"a.md": 1,\n\t"b.md": 2\n}\n',
	);
	expect(formatBaseline({})).toBe("{}\n");
});

test("the committed baseline lists the counts of main's Markdown files", async () => {
	const root = resolve(import.meta.dir, "..");
	const baseline = await Bun.file(
		join(root, "scripts/plain-english-baseline.json"),
	).json();
	const current = await counts(root);
	for (const [file, count] of Object.entries(current))
		expect(baseline[file] ?? 0).toBeGreaterThanOrEqual(count);
});

test("link titles, reference labels, reference definitions and autolinks do not count", async () => {
	const long = words(30);
	expect(
		await lines(
			[
				`Short [text](http://a.b "${long}").`,
				"",
				`Short [text][${long}].`,
				"",
				`[ref]: http://a.b "${long}"`,
				"",
				`${words(24)} <http://a.b> word.`,
				"",
			].join("\n"),
		),
	).toEqual([]);
});

test("a block quote directly after a list item or text starts its own paragraph", async () => {
	expect(await lines("- A. B. C.\n> D. E. F. G.\n")).toEqual([]);
	expect(await lines("A. B. C.\n> D. E. F. G.\n")).toEqual([]);
});

test("list, quote and footnote markers are not words", async () => {
	const edge = `${words(25)}.`;
	expect(await lines(`- ${edge}\n\n> ${edge}\n\n[^1]: ${edge}\n`)).toEqual([]);
});

test("a footnote's prose is counted after its marker", async () => {
	expect(await lines(`Text.[^1]\n\n[^1]: ${words(26)}.\n`)).toEqual([3]);
});

const script = resolve(import.meta.dir, "plain-english.ts");

/** A tracked checkout holding the script, a baseline and `files`. */
function checkout(baseline: string, files: Record<string, string>) {
	return repo({
		"scripts/plain-english.ts": readFileSync(script, "utf8"),
		"scripts/plain-english-baseline.json": baseline,
		...files,
	});
}

async function cli(dir: string, ...args: string[]) {
	const child = Bun.spawn(["bun", "scripts/plain-english.ts", ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, out, err };
}

test("the command prints every finding of a file above its baseline", async () => {
	const dir = checkout("{}\n", {
		"a.md": `${words(26)}.\n\nShort.\n\n${words(27)}.\n`,
	});
	const result = await cli(dir);
	expect(result.code).toBe(1);
	expect(result.err).toContain("a.md:1:");
	expect(result.err).toContain("a.md:5:");
});

test("update lowers the baseline file, drops finished entries and formats stably", async () => {
	const dir = checkout('{\n\t"a.md": 3,\n\t"b.md": 1,\n\t"gone.md": 2\n}\n', {
		"a.md": `${words(26)}.\n`,
		"b.md": "Short.\n",
	});
	expect((await cli(dir, "--update")).code).toBe(0);
	const path = join(dir, "scripts/plain-english-baseline.json");
	expect(readFileSync(path, "utf8")).toBe('{\n\t"a.md": 1\n}\n');
	const formatted = Bun.spawnSync(
		[
			"bunx",
			"biome",
			"format",
			"--indent-style=tab",
			"--config-path",
			resolve(import.meta.dir, ".."),
			"scripts/plain-english-baseline.json",
		],
		{ cwd: dir },
	);
	expect(formatted.exitCode).toBe(0);
	expect((await cli(dir)).code).toBe(0);
});
