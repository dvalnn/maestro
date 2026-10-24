import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeContext } from "@maestro/sdk";
import { upheldOf } from "./slice";

const scratch = mkdtempSync(join(tmpdir(), "slice-"));
const ctx = { scratch } as CodeContext;

const finding = (id: string, blocking: boolean) => ({
	id,
	where: "a.ts:1",
	issue: "breaks CODING_STANDARDS.md Shape",
	blocking,
});
const found = {
	clean: false,
	findings: [finding("F1", true), finding("F2", true), finding("F3", false)],
};
const held = (...ids: string[]) =>
	["F1", "F2", "F3"].map((id) => ({ id, holds: ids.includes(id), why: "" }));
const verdict = (blocking: string[]) => ({
	approved: !blocking.length,
	criteria: [],
	blocking,
});

const lane = "c.gate";
const cases: [string, Parameters<typeof upheldOf>[0], string[]][] = [
	["a clean lens", { lane, findings: { ...found, clean: true } }, []],
	["no skeptic", { lane, findings: found }, ["F1", "F2"]],
	[
		"a skeptic's holds",
		{
			lane,
			findings: found,
			verdicts: [{ outcome: "ok", value: held("F2", "F3") }],
		},
		["F2"],
	],
	[
		"a failed skeptic",
		{ lane, findings: found, verdicts: [{ outcome: "failed", reason: "x" }] },
		["F1", "F2"],
	],
	[
		"a skipped skeptic",
		{ lane, findings: found, verdicts: [{ outcome: "skipped" }] },
		["F1", "F2"],
	],
	[
		"a malformed skeptic's verdicts",
		{
			lane,
			findings: found,
			verdicts: [{ outcome: "rejected", reason: "schema" }],
		},
		["F1", "F2"],
	],
	[
		"a consolidator's blocking list",
		{ lane, verdict: verdict(["F9"]) },
		["F9"],
	],
	["an approving consolidator", { lane, verdict: verdict([]) }, []],
];

test.each(cases)(
	"upheldOf keeps the upheld blocking findings after %s",
	(_, rulings, ids) => {
		const out = upheldOf(rulings, ctx);
		expect(out).toMatchObject({ lane, clean: !ids.length });
		const upheld: string[] =
			readFileSync(out.upheld, "utf8").match(/F\d/g) ?? [];
		expect(upheld).toEqual(ids);
	},
);

test("the gate's repair agent may run the target's check", async () => {
	const root = join(import.meta.dir, "..");
	const run = Bun.spawn(
		[
			process.execPath,
			join(root, "packages/cli/src/maestro.ts"),
			"compose",
			".maestro/slice.ts",
			"--profile",
			"ordinary",
			"--request",
			"x",
			"--tier",
			"ordinary",
			"--json",
		],
		{ cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" },
	);
	const out = await new Response(run.stdout).text();
	expect(await run.exited).toBe(0);
	const repairs = JSON.parse(out).plan.ir.nodes.filter((n: { id: string }) =>
		n.id.startsWith("gate/loop/repair"),
	);
	expect(repairs.length).toBeGreaterThan(0);
	for (const n of repairs) expect(n.config.checks).toEqual(["check"]);
});
