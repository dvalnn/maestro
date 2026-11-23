// Draws the transcripts as pictures: bun packages/transcript/src/pictures.ts <out> [<base rev>]
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { differing, picture, sectionsOf } from "./picture";

/** Runs `command` in `cwd`; a failure throws with the command's output, unless it `mayFail`. */
function run(cwd: string, command: string[], env = {}, mayFail = false) {
	const ran = Bun.spawnSync(command, { cwd, env: { ...process.env, ...env } });
	if (ran.exitCode !== 0 && !mayFail)
		throw new Error(ran.stderr.toString() || ran.stdout.toString());
	return ran.stdout.toString();
}

/** Leaves in a fresh `dir` the colored sections of every transcript the tree at `cwd` holds. */
async function colored(cwd: string, dir: string, mayFail = false) {
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
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
	if (tests.length > 0)
		run(cwd, ["bun", "test", ...tests], { TRANSCRIPTS_COLOR: dir }, mayFail);
}

const read = async (path: string) =>
	(await Bun.file(path).exists())
		? sectionsOf(await Bun.file(path).text())
		: [];

const names = (dir: string) =>
	[...new Bun.Glob("*.ansi").scanSync(dir)].map((f) => basename(f, ".ansi"));

/** Leaves in `dir` the colored sections of the tree at revision `base`, run in a worktree of its own. */
async function coloredAt(base: string, dir: string) {
	const tree = await mkdtemp(join(tmpdir(), "maestro-transcripts-"));
	try {
		run(process.cwd(), ["git", "worktree", "add", "--detach", tree, base]);
		run(tree, ["bun", "install", "--frozen-lockfile"]);
		// The base's transcript can differ from its own tests' output, so its run may fail and still leave its sections.
		await colored(tree, dir, true);
	} finally {
		Bun.spawnSync(["git", "worktree", "remove", "--force", tree]);
		await rm(tree, { recursive: true, force: true });
	}
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
