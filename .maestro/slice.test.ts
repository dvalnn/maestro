import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeContext } from "@maestro/sdk";
import { upheldOf } from "./slice";
import {
	classics,
	maestro,
	scratch,
	stubbed,
	stubOutputs,
	targetRepo,
} from "./stub";

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
const session = "c.build";
const cases: [string, Parameters<typeof upheldOf>[0], string[]][] = [
	[
		"a clean lens",
		{ lane, session, lens: "c.reviewer", findings: { ...found, clean: true } },
		[],
	],
	["no skeptic", { lane, session, findings: found }, ["F1", "F2"]],
	[
		"a skeptic's holds",
		{
			lane,
			session,
			findings: found,
			verdicts: [{ outcome: "ok", value: held("F2", "F3") }],
		},
		["F2"],
	],
	[
		"a failed skeptic",
		{
			lane,
			session,
			findings: found,
			verdicts: [{ outcome: "failed", reason: "x" }],
		},
		["F1", "F2"],
	],
	[
		"a skipped skeptic",
		{ lane, session, findings: found, verdicts: [{ outcome: "skipped" }] },
		["F1", "F2"],
	],
	[
		"a malformed skeptic's verdicts",
		{
			lane,
			session,
			findings: found,
			verdicts: [{ outcome: "rejected", reason: "schema" }],
		},
		["F1", "F2"],
	],
	[
		"a consolidator's blocking list",
		{ lane, session, verdict: verdict(["F9"]) },
		["F9"],
	],
	["an approving consolidator", { lane, session, verdict: verdict([]) }, []],
];

test.each(cases)(
	"upheldOf keeps the upheld blocking findings after %s, and carries the lane and sessions",
	(_, rulings, ids) => {
		const out = upheldOf(rulings, ctx);
		expect(out).toMatchObject({ lane, session, clean: !ids.length });
		expect(out.lens).toBe(rulings.lens);
		const upheld: string[] =
			readFileSync(out.upheld, "utf8").match(/F\d/g) ?? [];
		expect(upheld).toEqual(ids);
	},
);

/** The runtime of each profile a tier seats, as `.maestro/presets/<tier>.yaml` sets it. */
const seated: [string, Record<string, [string, string]>][] = [
	[
		"small",
		{
			"classics/builder": ["claude-sonnet-5-5", "low"],
			"classics/lens": ["claude-opus-5-5", "medium"],
		},
	],
	[
		"ordinary",
		{
			"classics/builder": ["claude-sonnet-5-5", "medium"],
			"classics/lens": ["claude-opus-5-5", "medium"],
			"classics/skeptic": ["claude-sonnet-5-5", "low"],
		},
	],
];

/** The arguments that run `verb` on `.maestro/slice.ts` under `--preset tier` with the packed classics. */
const slice = async (verb: string, tier: string) => [
	verb,
	".maestro/slice.ts",
	"--preset",
	tier,
	"--request",
	"x",
	"--tier",
	tier,
	"--json",
	"-c",
	`packs=[${await classics}]`,
];

test.each(seated)(
	"under --preset %s, the gate's repair agent may run the target's check, and each agent runs its tier's classics profile",
	async (tier, runtimes) => {
		const out = await maestro(await slice("compose", tier));
		const { plan, agents } = JSON.parse(out);
		const repairs = plan.ir.nodes.filter((n: { id: string }) =>
			n.id.startsWith("gate/loop/repair"),
		);
		expect(repairs.length).toBeGreaterThan(0);
		for (const n of repairs) expect(n.config.checks).toEqual(["all"]);
		type Agent = {
			profile: string;
			harness: string;
			model: string;
			thinking: string;
		};
		for (const a of agents as Agent[])
			expect([a.harness, a.model, a.thinking]).toEqual([
				"claude",
				...(runtimes[a.profile] ?? []),
			]);
		expect(new Set((agents as Agent[]).map((a) => a.profile))).toEqual(
			new Set(Object.keys(runtimes)),
		);
	},
);

test.each(seated)(
	"a stub perform under --preset %s continues the builder and the lens in their sessions across review rounds",
	async (tier, runtimes) => {
		const target = targetRepo();
		const flagged = {
			clean: false,
			findings: [finding("F1", true)],
		};
		const outputs = stubOutputs({
			"reviewer/findings.json": flagged,
			"fixes[0]/reviewer/findings.json": flagged,
			"skeptic/verdicts.json": held("F1"),
			"fixes/skeptic/verdicts.json": held("F1"),
		});
		const data = mkdtempSync(join(scratch, "data-"));
		const performed = JSON.parse(
			await maestro(
				[
					...(await slice("perform", tier)),
					"-c",
					`target.repo=${target}`,
					"-c",
					'target.prepare="true"',
					"-c",
					'target.checks.all={run: "true", hint: all}',
					...stubbed(Object.keys(runtimes)),
				],
				data,
				{ MAESTRO_STUB_OUTPUTS: outputs },
			),
		);
		expect(performed.status).toBe("ok");
		type Instance = {
			node: string;
			expansion: string;
			outputs?: { session?: string };
		};
		const { instances }: { instances: Instance[] } = JSON.parse(
			await maestro(["ls", performed.id, "--json"], data),
		);
		const sessions = (node: string) =>
			instances
				.filter((i) => i.node === node)
				.map((i) => [i.expansion, i.outputs?.session]);
		const { id } = performed;
		expect(sessions("fixes/fix")).toEqual([
			["[0]", `${id}.build`],
			["[1]", `${id}.build`],
		]);
		expect(sessions("fixes/reviewer")).toEqual([
			["[0]", `${id}.reviewer`],
			["[1]", `${id}.reviewer`],
		]);
	},
);
