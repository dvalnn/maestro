import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeContext } from "@maestro/sdk";
import { readJson } from "@maestro/sdk/stdlib";
import { Masterclass, settle } from "./masterclass";
import PLANNER from "./masterclass/prompts/planner.md" with { type: "text" };
import {
	classics,
	maestro,
	scratch,
	stubOutputs,
	targetRepo,
} from "./testing/stub";

const lessons = join(scratch, "lessons.md");
writeFileSync(lessons, "## c1 · t1\n\n- a lesson\n");
const backlog = join(scratch, "backlog.md");
writeFileSync(backlog, "# Backlog\n\n- #7 Greet\n");

/** A stub perform of the masterclass, the planner replying `masterclass`. */
async function performed(masterclass: unknown) {
	const data = mkdtempSync(join(scratch, "data-"));
	return JSON.parse(
		await maestro(
			[
				"perform",
				".maestro/masterclass.ts",
				"--preset",
				"stub",
				"--lessons",
				lessons,
				"--backlog",
				backlog,
				"--json",
				"-c",
				`packs=[${await classics}]`,
				"-c",
				`target.repo=${targetRepo()}`,
				"-c",
				'target.prepare="true"',
			],
			data,
			{
				MAESTRO_STUB_OUTPUTS: stubOutputs({
					"planner/masterclass.json": masterclass,
				}),
			},
		),
	);
}

test("a stub perform returns the planner's proposals as the masterclass output", async () => {
	const scripted = {
		proposals: [
			{
				target: "CODING_STANDARDS.md",
				title: "Name the unit",
				body: "Say the unit in a name, because a bare number misleads.",
				lessons: ["a lesson"],
				concerts: ["c1"],
			},
			{
				target: "docs/adr/",
				title: "Seal one base",
				body: "Record why seats read one base.",
				lessons: ["a lesson", "another"],
				concerts: ["c1"],
			},
		],
	};
	const concert = await performed(scripted);
	expect(concert.status).toBe("ok");
	expect(concert.outputs.masterclass).toEqual(scripted);
});

test("a stub perform settles ok on no proposals", async () => {
	const concert = await performed({ proposals: [] });
	expect(concert.status).toBe("ok");
	expect(concert.outputs.masterclass).toEqual({ proposals: [] });
});

const one = {
	target: "CODING_STANDARDS.md",
	title: "t",
	body: "b",
	lessons: ["l"],
	concerts: ["c1"],
};
const proposing = (...proposals: object[]) => ({ proposals });

const outputs: [string, object, boolean][] = [
	["CODING_STANDARDS.md", proposing(one), true],
	[
		"a prompt",
		proposing({ ...one, target: ".maestro/slice/prompts/_grounds.md" }),
		true,
	],
	[
		"the tick's code",
		proposing({ ...one, target: "scripts/factory/route.ts" }),
		true,
	],
	["a new ADR", proposing({ ...one, target: "docs/adr/" }), true],
	["the checks' recipes", proposing({ ...one, target: "justfile" }), true],
	["no proposals", proposing(), true],
	["README.md", proposing({ ...one, target: "README.md" }), false],
	["a named ADR", proposing({ ...one, target: "docs/adr/0020-x.md" }), false],
	["CLAUDE.md", proposing({ ...one, target: "CLAUDE.md" }), false],
	["another script", proposing({ ...one, target: "scripts/pack.ts" }), false],
	["no lessons", proposing({ ...one, lessons: [] }), false],
	["no body", proposing({ ...one, body: undefined }), false],
	["no concerts", proposing({ ...one, concerts: undefined }), false],
	["concerts that are no strings", proposing({ ...one, concerts: [1] }), false],
	["an empty concerts list", proposing({ ...one, concerts: [] }), true],
	["an extra field", proposing({ ...one, extra: 1 }), false],
];

test.each(outputs)("readJson of %s takes it: %p", async (_, value, ok) => {
	const file = join(mkdtempSync(join(scratch, "off-")), "off.json");
	writeFileSync(file, JSON.stringify(value));
	const read = await readJson(
		{
			file: { path: file, contentHash: "sha256:0" },
			schema: Masterclass.schema,
		},
		{ path: (ref) => ref.path } as CodeContext,
	);
	expect("value" in read).toBe(ok);
});

test("compose seats the planner with the lessons and the backlog attached, the lessons first", async () => {
	const { plan } = JSON.parse(
		await maestro([
			"compose",
			".maestro/masterclass.ts",
			"--preset",
			"stub",
			"--lessons",
			lessons,
			"--backlog",
			backlog,
			"--json",
			"-c",
			`packs=[${await classics}]`,
		]),
	);
	const planner = (
		plan.ir.nodes as {
			id: string;
			config: { attachments: Record<string, { hint: string }> };
		}[]
	).find((n) => n.id === "planner");
	const attached = planner?.config.attachments ?? {};
	expect(Object.keys(attached).sort()).toEqual(["backlog", "lessons"]);
	expect(attached.lessons?.hint).toStartWith("first, ");
});

/** `settle` on `proposals` over lessons `text`. */
function settled(text: string, ...proposals: object[]) {
	const file = join(mkdtempSync(join(scratch, "settle-")), "lessons.md");
	writeFileSync(file, text);
	return settle(
		{
			masterclass: { proposals: proposals as Masterclass["proposals"] },
			lessons: { path: file, contentHash: "sha256:0" },
		},
		{ path: (ref) => ref.path } as CodeContext,
	).masterclass.proposals;
}
const marked =
	"## c1 · t · read\n\n- a\n\n## c2 · t · read\n\n- b\n\n## c3 · t\n\n- c\n";

test("settle drops an unnamed id and a repeat, keeps the order, drops a proposal left with none", () => {
	const out = settled(
		"# Lessons\n\n## c2 · t\n\n- a\n- z1 · t\n\n## c1 · t\n\n- b\n\n### z2 · t\n  ## z3 · t\n",
		{ ...one, concerts: ["c2", "zz", "z1", "z2", "z3", "c1", "c2"] },
		{ ...one, concerts: ["zz"] },
	);
	expect(out.map((p) => p.concerts)).toEqual([["c2", "c1"]]);
});

test("settle drops a proposal that cites only read concerts or none", () => {
	const out = settled(
		marked,
		{ ...one, title: "old", concerts: ["c1", "c2"] },
		{ ...one, title: "none", concerts: [] },
		{ ...one, title: "new", concerts: ["c3"] },
	);
	expect(out.map((p) => p.title)).toEqual(["new"]);
});

test("settle counts the read concerts of a proposal that cites a new one", () => {
	const out = settled(marked, { ...one, concerts: ["c1", "c2", "c3"] });
	expect(out.map((p) => p.concerts)).toEqual([["c1", "c2", "c3"]]);
});

test("the planner prompt's example is a proposal the schema accepts", async () => {
	const block = /```json\n([\s\S]*?)```/.exec(PLANNER)?.[1] ?? "";
	expect(block).toContain('"concerts"');
	const file = join(mkdtempSync(join(scratch, "ex-")), "ex.json");
	writeFileSync(file, block);
	const read = await readJson(
		{
			file: { path: file, contentHash: "sha256:0" },
			schema: Masterclass.schema,
		},
		{ path: (ref) => ref.path } as CodeContext,
	);
	expect("value" in read).toBe(true);
});
