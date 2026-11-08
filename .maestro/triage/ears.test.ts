import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "ears.ts");

/** Runs `check ears` on a plan file holding `plan`, as the planner's check does. */
function run(plan: string) {
	const file = join(mkdtempSync(join(tmpdir(), "ears-")), "plan.json");
	writeFileSync(file, plan);
	const { exitCode, stdout, stderr } = Bun.spawnSync(["bun", SCRIPT, file]);
	return { exitCode, out: stdout.toString(), err: stderr.toString() };
}

const planOf = (requirements: unknown) =>
	JSON.stringify({ spec: { requirements } });

test.each([
	["a plain spec", planOf(["The CLI shall exit 0."]), 0, ""],
	["a requirement off the shape", planOf(["Exit 0."]), 3, "R1 breaks"],
	[
		"a split plan",
		JSON.stringify({
			verdict: "split",
			children: [{ title: "a", body: "b", dependsOn: [] }],
		}),
		0,
		"split: no requirements to check",
	],
	["no requirements list", "{}", 2, ""],
	["requirements that are not text", planOf([1]), 2, ""],
	["a file that is not JSON", "plan", 2, ""],
])("check ears on %s exits %i", (_, plan, exitCode, out) => {
	const ran = run(plan);
	expect(ran.exitCode).toBe(exitCode);
	expect(ran.out).toContain(out);
	if (exitCode === 2) expect(ran.err).not.toBe("");
});
