// Sorts the tests a change adds or edits by what they guard: bun scripts/guards.ts <out> <base rev>
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { run, withBaseTree } from "./base-tree";

/** A test by its file, relative to the repository, and its full name, the describes joined with ` > `. */
export type Test = { file: string; name: string };

/**
 * For the tests that pass on this tree: `red` failed on the base's source, `unloaded` had no result there, and `green`
 * passed there and are new by name, so they guard nothing. A test that passed on both and existed on the base is left out.
 */
export type Guards = { red: Test[]; unloaded: Test[]; green: Test[] };

type Result = Test & { status: "pass" | "fail" | "skip" };

const ENTITY = /&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi;
const NAMED: Record<string, string> = {
	quot: '"',
	apos: "'",
	lt: "<",
	gt: ">",
	amp: "&",
};

function decoded(text: string) {
	return text.replace(ENTITY, (_, e: string) => {
		const code = e.startsWith("#x")
			? Number.parseInt(e.slice(2), 16)
			: Number.parseInt(e.slice(1), 10);
		return NAMED[e.toLowerCase()] ?? String.fromCodePoint(code);
	});
}

const attribute = (tag: string, name: string) =>
	decoded(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "");

/** The results in a junit report; a test's `classname` holds its describes, innermost first. */
export function resultsOf(xml: string, cwd: string): Result[] {
	const cases = xml.matchAll(
		/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
	);
	return [...cases].map(([, tag = "", body = ""]) => {
		const describes = attribute(tag, "classname").split(" > ").reverse();
		const file = relative(cwd, resolve(cwd, attribute(tag, "file")));
		const name = [...describes.filter(Boolean), attribute(tag, "name")].join(
			" > ",
		);
		return {
			file,
			name,
			status: /<(failure|error)\b/.test(body)
				? "fail"
				: body.includes("<skipped")
					? "skip"
					: "pass",
		};
	});
}

/** The results of running `files` in the tree at `cwd`; a file that does not load leaves none. */
async function runTests(cwd: string, files: string[], scratch: string) {
	if (files.length === 0) return [];
	const report = join(scratch, `${Bun.randomUUIDv7()}.xml`);
	run(
		cwd,
		[
			"bun",
			"test",
			// The flags `just test` runs bun with: a file per process, so a test cannot change another's result.
			"--parallel",
			"--timeout",
			"30000",
			"--reporter=junit",
			`--reporter-outfile=${report}`,
			...files.map((f) => `./${f}`),
		],
		{},
		true,
	);
	return (await Bun.file(report).exists())
		? resultsOf(await Bun.file(report).text(), cwd)
		: [];
}

/** The test files of `cwd`, tracked or not and not ignored, that `base` lacks or holds differently. */
async function changedTests(cwd: string, base: string) {
	// -z: git quotes a path with non-ASCII bytes otherwise.
	const listed = run(cwd, [
		"git",
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
		"*.test.ts",
	]);
	const changed: string[] = [];
	for (const path of new Set(listed.split("\0").filter(Boolean))) {
		const here = Bun.file(join(cwd, path));
		const was = Bun.file(join(base, path));
		if (!(await here.exists())) continue;
		if (!(await was.exists()) || (await was.text()) !== (await here.text()))
			changed.push(path);
	}
	return changed.sort();
}

const key = ({ file, name }: Test) => `${file}\0${name}`;

/** What each test of `results` did, a name used twice taking the worst: fail, then skip, then pass. */
function statuses(results: Result[]) {
	const rank = { fail: 0, skip: 1, pass: 2 };
	const worst = new Map<string, Result["status"]>();
	for (const r of results) {
		const was = worst.get(key(r));
		if (was === undefined || rank[r.status] < rank[was])
			worst.set(key(r), r.status);
	}
	return worst;
}

/**
 * Sorts the tests that pass `here` by what the base's source `onBase` and its own tests `own` made of them. A test is
 * green only when its file is in `added`, or `own` ran the file and holds no test of that name; a test that fails in
 * `own` too is no evidence and is left out.
 */
export function sorted(
	here: Result[],
	onBase: Result[],
	own: Result[],
	added: ReadonlySet<string> = new Set(),
): Guards {
	const now = statuses(here);
	const base = statuses(onBase);
	const was = statuses(own);
	const ran = new Set(own.map((r) => r.file));
	const isNew = (file: string, k: string) =>
		added.has(file) || (ran.has(file) && !was.has(k));
	const groupOf = ({ file, name }: Test): keyof Guards | undefined => {
		const k = key({ file, name });
		const onBaseStatus = base.get(k);
		if (onBaseStatus === "fail")
			return was.get(k) === "fail" ? undefined : "red";
		if (onBaseStatus !== "pass") return "unloaded";
		return isNew(file, k) ? "green" : undefined;
	};
	const guards: Guards = { red: [], unloaded: [], green: [] };
	for (const [k, status] of now) {
		const [file = "", name = ""] = k.split("\0");
		const group = status === "pass" ? groupOf({ file, name }) : undefined;
		if (group) guards[group].push({ file, name });
	}
	return guards;
}

async function main(out: string, base: string) {
	const cwd = process.cwd();
	const scratch = await mkdtemp(join(tmpdir(), "maestro-guards-"));
	try {
		const guards = await withBaseTree(base, async (tree) => {
			const files = await changedTests(cwd, tree);
			const here = await runTests(cwd, files, scratch);
			const existing = files.filter((f) => existsSync(join(tree, f)));
			const own = await runTests(tree, existing, scratch);
			// This tree's versions of the files, over the base's source.
			for (const f of files) await cp(join(cwd, f), join(tree, f));
			const added = new Set(files.filter((f) => !existing.includes(f)));
			return sorted(here, await runTests(tree, files, scratch), own, added);
		});
		await Bun.write(join(out, "guards.json"), JSON.stringify(guards, null, 2));
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const [out, base] = process.argv.slice(2);
	if (!out || !base) {
		console.error("usage: guards.ts <out> <base rev>");
		process.exit(2);
	}
	await main(out, base).catch((error: Error) => {
		console.error(error.message);
		process.exit(1);
	});
}
