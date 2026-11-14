import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { durationMs } from "@maestro/ir";

const SCRIPT = join(import.meta.dir, "ears.ts");

/** Runs the ears script with the whole plan on standard input. */
function run(plan: string) {
	const { exitCode, stdout, stderr } = Bun.spawnSync(["bun", SCRIPT], {
		stdin: Buffer.from(plan),
	});
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
	["input that is not JSON", "plan", 2, ""],
	["empty input", "", 2, ""],
])("check ears on %s exits %i", (_, plan, exitCode, out) => {
	const ran = run(plan);
	expect(ran.exitCode).toBe(exitCode);
	expect(ran.out).toContain(out);
	if (exitCode === 2) expect(ran.err).not.toBe("");
});

test("check ears reports every requirement that breaks the EARS shape", () => {
	const ran = run(planOf(["Exit 0.", "The CLI shall exit 0.", "Print help."]));
	expect(ran.exitCode).toBe(3);
	expect(
		ran.out
			.trim()
			.split("\n")
			.map((line) => line.split(" ")[0]),
	).toEqual(["R1", "R3"]);
});

test("the ears preset reads the plan from standard input and has a short timeout", () => {
	const preset = Bun.YAML.parse(
		readFileSync(join(import.meta.dir, "../presets/triage.yaml"), "utf8"),
	) as {
		target: { checks: { ears: { run: string; timeout?: string } } };
	};
	const ears = preset.target.checks.ears;
	const timeout = ears.timeout ? durationMs(ears.timeout) : undefined;
	expect(timeout).toBeDefined();
	expect(timeout).toBeGreaterThan(0);
	expect(timeout).toBeLessThanOrEqual(60_000);
	const ran = Bun.spawnSync(["sh", "-c", ears.run], {
		stdin: Buffer.from(planOf(["The CLI shall exit 0."])),
	});
	expect(ran.exitCode).toBe(0);
});
