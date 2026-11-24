// Draws the transcripts as pictures: bun scripts/pictures.ts <out> [<base rev>]
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	differing,
	picture,
	sectionsOf,
} from "../packages/transcript/src/picture";
import { run, withBaseTree } from "./base-tree";

/** The test files of the tree at `cwd` that hold a transcript. */
async function transcriptTests(cwd: string) {
	const tests: string[] = [];
	for (const path of new Bun.Glob(
		"{packages,packs,.maestro}/**/*.test.ts",
	).scanSync({ cwd, dot: true })) {
		if (path.includes("node_modules/")) continue;
		if (
			(await Bun.file(join(cwd, path)).text()).includes('"@maestro/transcript"')
		)
			tests.push(`./${path}`);
	}
	return tests;
}

/** Leaves in `dir` the colored sections of every transcript the tree at `cwd` holds, over what `dir` held. */
async function colored(cwd: string, dir: string, mayFail = false) {
	const tests = await transcriptTests(cwd);
	if (tests.length > 0)
		run(cwd, ["bun", "test", ...tests], { TRANSCRIPTS_COLOR: dir }, mayFail);
}

const read = async (path: string) =>
	(await Bun.file(path).exists())
		? sectionsOf(await Bun.file(path).text())
		: [];

const names = (dir: string) =>
	[...new Bun.Glob("*.ansi").scanSync(dir)].map((f) => basename(f, ".ansi"));

/** The path of this package, which a base's source is run under so that this tree's tests load on it. */
const TRANSCRIPT_PACKAGE = "packages/transcript";

/**
 * Leaves in `dir` the colored sections of revision `base`: those its own tests draw, then those this tree's
 * transcript tests draw from its source, so a section new in this tree has a before too.
 */
async function coloredAt(base: string, dir: string) {
	const cwd = process.cwd();
	await withBaseTree(base, async (tree) => {
		// The base's transcript can differ from its own tests' output, so its run may fail and still leave its sections.
		await colored(tree, dir, true);
		// A test written for this tree may not load on the base's source: the base's own sections then stand.
		for (const path of [TRANSCRIPT_PACKAGE, ...(await transcriptTests(cwd))])
			await cp(join(cwd, path), join(tree, path), {
				recursive: true,
				verbatimSymlinks: true,
			});
		await colored(tree, dir, true);
	});
}

/** Leaves `<out>/<name>.diff`: the sections of `name` as text, the base's against this tree's. */
async function diff(out: string, name: string) {
	for (const side of ["before", "after"]) {
		const drawn = Bun.file(join(out, side, `${name}.ansi`));
		await Bun.write(
			join(out, side, `${name}.txt`),
			(await drawn.exists())
				? stripVTControlCharacters(await drawn.text())
				: "",
		);
	}
	// git's diff exits 1 when the files differ.
	const sides = ["before", "after"].map((side) => `${side}/${name}.txt`);
	await Bun.write(
		join(out, `${name}.diff`),
		run(out, ["git", "diff", "--no-index", "--no-color", ...sides], {}, true),
	);
}

async function draw(out: string, name: string, base: string | undefined) {
	const now = await read(join(out, "after", `${name}.ansi`));
	const was = base ? await read(join(out, "before", `${name}.ansi`)) : [];
	const drawn = base ? differing(was, now) : now.map((s) => s.name);
	if (drawn.length === 0) return;
	const panels = base
		? [
				{ label: `before (${base})`, sections: was },
				{ label: "after", sections: now },
			]
		: [{ label: name, sections: now }];
	if (base) await diff(out, name);
	const svg = join(out, `${name}.svg`);
	await Bun.write(svg, picture(panels, drawn));
	const png = join(out, `${name}.png`);
	if (Bun.which("rsvg-convert")) {
		run(process.cwd(), ["rsvg-convert", "-z", "2", svg, "-o", png]);
		console.log(png);
	} else console.log(`${svg} (install rsvg-convert for a PNG)`);
}

async function main(out: string, base: string | undefined) {
	const after = resolve(out, "after");
	const before = resolve(out, "before");
	for (const dir of [after, before]) {
		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });
	}
	await colored(process.cwd(), after);
	if (base) await coloredAt(base, before);
	const found = new Set([...names(after), ...(base ? names(before) : [])]);
	for (const name of found) await draw(resolve(out), name, base);
}

const [out, base] = process.argv.slice(2);
if (!out) {
	console.error("usage: pictures.ts <out> [<base rev>]");
	process.exit(2);
}
await main(out, base).catch((error: Error) => {
	console.error(error.message);
	process.exit(1);
});
