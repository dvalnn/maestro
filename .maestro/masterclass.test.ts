import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeContext } from "@maestro/sdk";
import { readJson } from "@maestro/sdk/stdlib";
import { Masterclass } from "./masterclass";
import { classics, maestro, scratch, stubOutputs, targetRepo } from "./stub";

const lessons = join(scratch, "lessons.md");
writeFileSync(lessons, "## c1 · t1\n\n- a lesson\n");
const backlog = join(scratch, "backlog.md");
writeFileSync(backlog, "# Backlog\n\n- #7 Greet\n");

/** A stub perform of the masterclass, the planner writing `masterclass`. */
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
			},
			{
				target: "docs/adr/",
				title: "Seal one base",
				body: "Record why seats read one base.",
				lessons: ["a lesson", "another"],
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
