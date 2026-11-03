import { expect, test } from "bun:test";
import type { Settled } from "@maestro/sdk";
import {
	askAlone,
	CONTRACT,
	claiming,
	failed,
	medium,
	planning,
	ready,
	spec,
	unspecified,
} from "./fixtures";
import {
	type Checked,
	classify,
	type Proposal,
	settle,
	type Triage,
} from "./verdict";

const LOW = "touches only docs and tests, 3 paths or fewer";
const many = (n: number) =>
	Array.from({ length: n }, (_, i) => `packages/cli/src/f${i}.ts`);

const risks: [string, string[], string, string, string, string[]][] = [
	[
		"a contract path",
		["packages/ir/src/a.ts"],
		"",
		"high",
		"ordinary",
		[CONTRACT],
	],
	[
		"a contract path given as ./",
		["./packages/ir/src/a.ts"],
		"",
		"high",
		"ordinary",
		[CONTRACT],
	],
	[
		"a contract directory given bare",
		["packages/ir"],
		"",
		"high",
		"ordinary",
		["touches packages/ir, which set a contract"],
	],
	[
		"a manifest",
		["packs/classics/package.json"],
		"",
		"high",
		"ordinary",
		["touches packs/classics/package.json, which set a contract"],
	],
	[
		"a test under a contract directory",
		["packages/ir/src/a.test.ts", "packages/cli/src/a.ts"],
		"",
		"medium",
		"ordinary",
		[],
	],
	[
		"the tour manager's code beside its labels",
		["scripts/factory/index.ts", ".maestro/slice.ts"],
		"",
		"medium",
		"ordinary",
		[],
	],
	[
		"8 paths",
		many(8),
		"",
		"high",
		"risky",
		["touches 8 paths besides docs and tests, 8 or more"],
	],
	[
		"7 source paths and their tests",
		[...many(7), "packages/cli/src/a.test.ts", "docs/a.md"],
		"",
		"medium",
		"ordinary",
		[],
	],
	[
		"a contract doc",
		["docs/adr/0001-a.md"],
		"",
		"high",
		"ordinary",
		["touches docs/adr/0001-a.md, which set a contract"],
	],
	[
		"the planner's contract",
		["packages/cli/src/a.ts"],
		"the --json flag",
		"high",
		"ordinary",
		["the planner names a contract: the --json flag"],
	],
	[
		"3 docs and tests",
		["docs/a.md", "docs/architecture.md", "packages/cli/src/a.test.ts"],
		"",
		"low",
		"small",
		[LOW],
	],
	[
		"Markdown outside docs, under a contract directory too",
		[".claude/skills/a/SKILL.md", ".maestro/presets/README.md"],
		"",
		"low",
		"small",
		[LOW],
	],
	[
		"4 docs",
		["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"],
		"",
		"medium",
		"ordinary",
		[],
	],
	["a source file", ["packages/cli/src/a.ts"], "", "medium", "ordinary", []],
	["no paths", [], "", "medium", "ordinary", []],
];

test.each(risks)(
	"classify rules %s",
	(_, touches, contract, risk, tier, reasons) => {
		expect(classify(touches, contract)).toMatchObject({ risk, tier, reasons });
	},
);

const areas: [string, string[], Triage["area"]][] = [
	[
		"core, on a tie with cli",
		["packages/sdk/a.ts", "packages/cli/a.ts"],
		"core",
	],
	[
		"cli, on a tie with host",
		["packages/render-text/a.ts", "packages/harness-pi/a.ts"],
		"cli",
	],
	[
		"host, on a tie with packs",
		["packages/host-repo-sdk/a.ts", "packs/classics/a.ts"],
		"host",
	],
	["packs, on a tie with docs", ["packs/classics/a.ts", "docs/a.md"], "packs"],
	[
		"docs, holding most paths",
		["packages/core/a.ts", "docs/a.md", "docs/b.md"],
		"docs",
	],
	[
		"factory, holding most paths",
		["scripts/factory/a.ts", ".maestro/b.ts", "docs/a.md"],
		"factory",
	],
	["absent, when no path is in an area", ["README.md"], undefined],
];

test.each(areas)("classify's area is %s", (_, touches, area) => {
	expect(classify(touches, "").area).toBe(area);
});

const clean: Settled<Checked>[] = [{ outcome: "ok", value: { questions: [] } }];
const planned = (proposal: Proposal, check = clean) => ({
	ruling: planning,
	proposal: [{ outcome: "ok" as const, value: proposal }],
	check,
});

const overrides: [string, Proposal, Triage][] = [
	[
		"no paths into needs-info",
		{ ...ready, touches: [] },
		{
			verdict: "needs-info",
			risk: "medium",
			tier: "ordinary",
			reasons: [],
			questions: [askAlone("Which paths does the change create or edit?")],
			spec: { touches: [], ...spec },
		},
	],
	[
		"paths outside the repo into needs-info",
		{ ...ready, touches: ["../x.ts", "/etc/y"] },
		{
			verdict: "needs-info",
			risk: "medium",
			tier: "ordinary",
			reasons: [],
			questions: [
				askAlone(
					"Which repo-relative paths does the change touch in place of ../x.ts, /etc/y?",
				),
			],
			spec: { touches: [], ...spec },
		},
	],
	[
		"no runnable acceptance into needs-info",
		{ ...ready, spec: { ...spec, acceptance: ["greet.sh greets by name"] } },
		{
			verdict: "needs-info",
			...medium,
			questions: [
				askAlone(
					"Which command proves the change done? Acceptance commands start with bun, bunx, just, mise.",
				),
			],
			spec: {
				touches: ready.touches,
				...spec,
				acceptance: ["greet.sh greets by name"],
			},
		},
	],
	[
		"a high-risk ready into needs-approval",
		{ ...ready, contract: " the --json flag " },
		{
			verdict: "needs-approval",
			risk: "high",
			tier: "ordinary",
			area: "cli",
			reasons: ["the planner names a contract: the --json flag"],
			contract: "the --json flag",
			questions: [],
			spec: { touches: ready.touches, ...spec },
		},
	],
	[
		"a split whose child depends on a later one or itself into needs-info",
		{
			verdict: "split",
			...unspecified,
			children: [
				{ title: "a", body: "first", dependsOn: [1] },
				{ title: "b", body: "second", dependsOn: [1] },
			],
		},
		{
			verdict: "needs-info",
			...medium,
			questions: [
				askAlone(
					'Child 0 ("a") depends on 1, which is not an earlier child: which child does it need?',
				),
				askAlone(
					'Child 1 ("b") depends on 1, which is not an earlier child: which child does it need?',
				),
			],
		},
	],
];

test.each(overrides)("settle turns %s", (_, proposal, triage) => {
	expect(settle(planned(proposal))).toEqual({ triage });
});

test.each([
	["low", ["docs/a.md"]],
	["medium", ["packages/cli/src/a.ts"]],
	["high", ["packages/ir/src/a.ts"]],
])(
	"settle sends a ready proposal with a question to needs-info at %s risk",
	(risk, touches) => {
		const { triage } = settle(
			planned({ ...ready, touches, questions: [askAlone("Greet whom?")] }),
		);
		expect(triage).toMatchObject({
			verdict: "needs-info",
			risk,
			questions: [askAlone("Greet whom?")],
		});
		expect(triage.spec).toEqual({ touches, ...spec });
	},
);

const straying = { ...claiming, recommend: { label: "C", why: "no reason" } };

test("settle turns a failing spec check into questions, sending the spec to needs-info", () => {
	const check: Settled<Checked>[] = [
		{ outcome: "ok", value: { questions: [failed] } },
	];
	const { triage } = settle(planned(ready, check));
	expect(triage).toMatchObject({ verdict: "needs-info", questions: [failed] });
	expect(triage.spec).toEqual({ touches: ready.touches, ...spec });
});

test.each([
	["a clean check", clean],
	["a skipped check", [{ outcome: "skipped" }] as Settled<Checked>[]],
])("settle leaves the triage as it is with %s", (_, check) => {
	expect(settle(planned(ready, check))).toEqual(settle(planned(ready, [])));
	expect(settle(planned(ready, check)).triage.verdict).toBe("ready-for-agent");
});

test.each(["failed", "rejected"] as const)(
	"settle asks the owner, keeping the spec, when the spec check %s to run",
	(outcome) => {
		const check: Settled<Checked>[] = [{ outcome, reason: "pi exited 1" }];
		const { triage } = settle(planned(ready, check));
		expect(triage).toMatchObject({
			verdict: "needs-info",
			questions: [
				askAlone(
					"The spec check did not run: pi exited 1. Approve the spec as is, or re-triage.",
				),
			],
		});
		expect(triage.spec).toMatchObject({ subject: ready.spec?.subject });
	},
);

test("settle fails when the triager handed the issue on and the planner gave nothing", () => {
	expect(() =>
		settle({
			ruling: planning,
			proposal: [{ outcome: "skipped" }],
			check: [],
		}),
	).toThrow("the planner gave no proposal");
});

test("settle drops a recommendation naming none of its question's options, keeping the rest", () => {
	const { recommend: _, ...kept } = straying;
	const { triage } = settle(
		planned({
			...unspecified,
			verdict: "needs-info",
			questions: [straying, claiming],
		}),
	);
	expect(triage.questions).toStrictEqual([kept, claiming]);
});
