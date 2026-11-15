import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scan } from "./prompt-imports";

/** A repository root holding `files`, by path relative to it. */
function repo(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "prompt-imports-"));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

const imports = (path: string) =>
	`import TEXT from "${path}" with { type: "text" };\nexport { TEXT };\n`;

test("a composition entry, its test and its nested module may import its own prompts", async () => {
	const dir = repo({
		".maestro/triage.ts": imports("./triage/prompts/planner.md"),
		".maestro/triage.test.ts": imports("./triage/prompts/_gate.md"),
		".maestro/triage/ears.ts": imports("./prompts/_gate.md"),
		".maestro/triage/prompts/planner.md": "Plan.\n",
		".maestro/triage/prompts/_gate.md": "Gate.\n",
	});
	expect(await scan(dir)).toEqual([]);
});

test("any file under .maestro may import a shared prompt", async () => {
	const dir = repo({
		".maestro/shared.ts": imports("./prompts/_grounds.md"),
		".maestro/slice.ts": imports("./prompts/_plain.md"),
		".maestro/triage/ears.ts": imports("../prompts/_figures.md"),
		".maestro/prompts/_grounds.md": "Grounds.\n",
		".maestro/prompts/_plain.md": "Plain.\n",
		".maestro/prompts/_figures.md": "Figures.\n",
	});
	expect(await scan(dir)).toEqual([]);
});

test("a composition entry, test or nested module importing another composition's prompt fails, naming both files", async () => {
	const dir = repo({
		".maestro/review.ts": imports("./slice/prompts/_grounds.md"),
		".maestro/review.test.ts": imports("./slice/prompts/writer.md"),
		".maestro/triage/ears.ts": imports("../slice/prompts/_grounds.md"),
		".maestro/slice.ts": "export const slice = {};\n",
		".maestro/slice/prompts/_grounds.md": "Grounds.\n",
		".maestro/slice/prompts/writer.md": "Write.\n",
	});
	expect((await scan(dir)).toSorted()).toEqual([
		".maestro/review.test.ts: imports .maestro/slice/prompts/writer.md",
		".maestro/review.ts: imports .maestro/slice/prompts/_grounds.md",
		".maestro/triage/ears.ts: imports .maestro/slice/prompts/_grounds.md",
	]);
});

test("a module outside every composition importing a composition's prompt fails", async () => {
	const dir = repo({
		".maestro/shared.ts": imports("./slice/prompts/_grounds.md"),
		".maestro/slice/prompts/_grounds.md": "Grounds.\n",
	});
	expect(await scan(dir)).toEqual([
		".maestro/shared.ts: imports .maestro/slice/prompts/_grounds.md",
	]);
});

test("a .maestro file importing a pack's prompt fails", async () => {
	const dir = repo({
		".maestro/shared.ts": imports("../packs/classics/src/prompts/fix.md"),
		"packs/classics/src/prompts/fix.md": "Fix.\n",
	});
	expect(await scan(dir)).toEqual([
		".maestro/shared.ts: imports packs/classics/src/prompts/fix.md",
	]);
});

test("any file of a pack may import that pack's prompts", async () => {
	const dir = repo({
		"packs/classics/src/review.ts": imports("./prompts/checklist.md"),
		"packs/classics/acceptance/acceptance.test.ts": imports(
			"../src/prompts/checklist.md",
		),
		"packs/classics/src/prompts/checklist.md": "Check.\n",
	});
	expect(await scan(dir)).toEqual([]);
});

test("a pack file importing a prompt outside its own src/prompts fails, naming both files", async () => {
	const dir = repo({
		"packs/classics/src/review.ts": imports(
			"../../../.maestro/prompts/_plain.md",
		),
		"packs/classics/src/moves.ts": imports("../../other/src/prompts/fix.md"),
		"packs/classics/src/repair.ts": imports("./notes/repair.md"),
		".maestro/prompts/_plain.md": "Plain.\n",
		"packs/other/src/prompts/fix.md": "Fix.\n",
		"packs/classics/src/notes/repair.md": "Repair.\n",
	});
	expect((await scan(dir)).toSorted()).toEqual([
		"packs/classics/src/moves.ts: imports packs/other/src/prompts/fix.md",
		"packs/classics/src/repair.ts: imports packs/classics/src/notes/repair.md",
		"packs/classics/src/review.ts: imports .maestro/prompts/_plain.md",
	]);
});

test("the script exits non-zero on a violation and names both files on stderr", async () => {
	const dir = repo({
		".maestro/shared.ts": imports("./slice/prompts/_grounds.md"),
		".maestro/slice/prompts/_grounds.md": "Grounds.\n",
	});
	const child = Bun.spawn(
		["bun", resolve(import.meta.dir, "prompt-imports.ts"), dir],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [err, code] = await Promise.all([
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code).toBe(1);
	expect(err).toContain(
		".maestro/shared.ts: imports .maestro/slice/prompts/_grounds.md",
	);
});

test("this repository has no foreign prompt import", async () => {
	expect(await scan(resolve(import.meta.dir, ".."))).toEqual([]);
});
