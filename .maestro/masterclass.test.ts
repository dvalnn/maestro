import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CodeContext } from "@maestro/sdk";
import { readJson } from "@maestro/sdk/stdlib";
import { Masterclass, settle } from "./masterclass";
import PLANNER from "./masterclass/prompts/planner.md" with { type: "text" };
import {
	call,
	classics,
	detailed,
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
	["README.md", proposing({ ...one, target: "README.md" }), true],
	["a named ADR", proposing({ ...one, target: "docs/adr/0020-x.md" }), true],
	["CLAUDE.md", proposing({ ...one, target: "CLAUDE.md" }), true],
	["another script", proposing({ ...one, target: "scripts/pack.ts" }), true],
	["no lessons", proposing({ ...one, lessons: [] }), false],
	[
		"reports and no lessons",
		proposing({ ...one, lessons: [], reports: ["No rg on PATH"] }),
		true,
	],
	[
		"neither lessons nor reports",
		proposing({ ...one, lessons: [], reports: [] }),
		false,
	],
	["a kind it has no label for", proposing({ ...one, kind: "feature" }), false],
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

test("settle counts a concert the reports name and the lessons do not, and keeps a cluster mixing read and fresh", () => {
	const dir = mkdtempSync(join(scratch, "settle-reports-"));
	const lessonsFile = join(dir, "lessons.md");
	const reportsFile = join(dir, "reports.md");
	writeFileSync(lessonsFile, "## c1 · t · read\n\n- a\n");
	writeFileSync(reportsFile, "## c1 · t · read\n\n- x\n\n## c2 · t\n\n- y\n");
	const bug = { ...one, kind: "bug", lessons: [], reports: ["y"] };
	const out = settle(
		{
			masterclass: {
				proposals: [
					{ ...bug, title: "fresh", concerts: ["c2"] },
					{ ...bug, title: "mixed", concerts: ["c1", "c2"] },
					{ ...bug, title: "read", concerts: ["c1"] },
				] as Masterclass["proposals"],
			},
			lessons: { path: lessonsFile, contentHash: "sha256:0" },
			reports: { path: reportsFile, contentHash: "sha256:0" },
		},
		{ path: (ref) => ref.path } as CodeContext,
	).masterclass.proposals;
	expect(out.map((p) => [p.title, p.concerts])).toEqual([
		["fresh", ["c2"]],
		["mixed", ["c1", "c2"]],
	]);
});

/** The masterclass CLI with separate lessons and reports, and a scripted planner reply. */
async function withReports(
	mode: string,
	scripted: unknown,
	reports: string,
	text = "# Lessons\n",
) {
	const dir = mkdtempSync(join(scratch, "reports-"));
	const lessonsFile = join(dir, "lessons.md");
	const reportsFile = join(dir, "reports.md");
	writeFileSync(lessonsFile, text);
	writeFileSync(reportsFile, reports);
	return call(
		[
			mode,
			".maestro/masterclass.ts",
			"--preset",
			"stub",
			"--lessons",
			lessonsFile,
			"--reports",
			reportsFile,
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
		join(dir, "data"),
		{
			MAESTRO_STUB_OUTPUTS: stubOutputs({
				"planner/masterclass.json": scripted,
			}),
		},
	);
}

const reportTexts = [
	"No rg on PATH",
	"scripts/factory/maestro.ts · Reports retain sightings · The reader drops sightings.",
];
const reportProposal = {
	...one,
	kind: "bug",
	lessons: [],
	reports: reportTexts,
	concerts: ["c1", "c2"],
};
const reportHeadings =
	"## c1 · v.i1\n\n- No rg on PATH\n\n## c2 · v.i2\n\n- scripts/factory/maestro.ts · Reports retain sightings · The reader drops sightings.\n";

test("the planner receives reports beside lessons and backlog and settles one reports-only bug cluster", async () => {
	const scripted = { proposals: [reportProposal] };
	const composed = await withReports("compose", scripted, reportHeadings);
	expect(composed.code).toBe(0);
	const { plan } = JSON.parse(composed.out);
	const planner = (
		plan.ir.nodes as {
			id: string;
			config: { attachments: Record<string, unknown> };
		}[]
	).find((n) => n.id === "planner");
	expect(Object.keys(planner?.config.attachments ?? {}).sort()).toEqual([
		"backlog",
		"lessons",
		"reports",
	]);
	const performed = await withReports("perform", scripted, reportHeadings);
	expect(performed.code).toBe(0);
	const concert = JSON.parse(performed.out);
	expect(concert.status).toBe("ok");
	expect(concert.outputs.masterclass).toEqual(scripted);
});

// Seam: the masterclass CLI's composed attachments and recorded planner inputs.
test("masterclass feeds parameter-file attachments from code nodes", async () => {
	const result = await withReports(
		"compose",
		{ proposals: [] },
		reportHeadings,
	);
	expect(result.code).toBe(0);
	const { plan } = JSON.parse(result.out);
	const nodes = plan.ir.nodes as {
		id: string;
		kind: string;
		config: { attachments?: Record<string, unknown> };
	}[];
	const edges = plan.ir.edges as {
		from: { node: string };
		to: { node: string; port: string };
	}[];
	const planner = nodes.find((node) => node.id === "planner");
	for (const [port, hint] of [
		[
			"lessons",
			"first, for the lessons to merge, one heading per concert, oldest first, a heading ending in `· read` marking a concert an earlier masterclass read",
		],
		[
			"reports",
			"for the obstacles and sightings to merge, under the lessons' concert headings",
		],
		[
			"backlog",
			"for the open and recently closed issues, to drop a promotion one already proposes",
		],
	] as const) {
		expect(planner?.config.attachments?.[port]).toEqual({
			type: "core.markdown",
			hint,
		});
		const sources = edges.filter(
			(edge) => edge.to.node === "planner" && edge.to.port === port,
		);
		expect(sources).toHaveLength(1);
		expect(nodes.find((node) => node.id === sources[0]?.from.node)?.kind).toBe(
			"code",
		);
	}
});

test("masterclass records the planner's lessons, reports and backlog contents", async () => {
	const dir = mkdtempSync(join(scratch, "recorded-masterclass-"));
	const files = {
		lessons: {
			path: join(dir, "course-notes.md"),
			text: "## c1 · lessons\n\n- a lesson\n",
		},
		reports: {
			path: join(dir, "factory-reports.md"),
			text: "## c1 · reports\n\n- a sighting\n",
		},
		backlog: {
			path: join(dir, "issue-snapshot.md"),
			text: "# Backlog\n\n- #7 Greet\n",
		},
	};
	for (const file of Object.values(files)) writeFileSync(file.path, file.text);
	const data = join(dir, "data");
	const result = await call(
		[
			"perform",
			".maestro/masterclass.ts",
			"--preset",
			"stub",
			"--lessons",
			files.lessons.path,
			"--reports",
			files.reports.path,
			"--backlog",
			files.backlog.path,
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
				"planner/masterclass.json": { proposals: [] },
			}),
		},
	);
	expect(result.code).toBe(0);
	const concert = JSON.parse(result.out);
	expect(concert.status).toBe("ok");
	const instances = await detailed<{
		node: string;
		inputs?: Record<string, string>;
	}>(concert.id, data);
	const inputs = instances.find(
		(instance) => instance.node === "planner",
	)?.inputs;
	const entries = Object.entries(files);
	expect(entries.length).toBeGreaterThan(0);
	const read = (path: string | undefined) =>
		readFileSync(
			join(data, "maestro/concerts", concert.id, "artifacts", path ?? ""),
			"utf8",
		);
	expect(
		entries.map(([port]) => ({
			name: basename(inputs?.[port] ?? ""),
			text: inputs?.[port] === undefined ? undefined : read(inputs[port]),
		})),
	).toEqual(
		entries.map(([, file]) => ({
			name: basename(file.path),
			text: file.text,
		})),
	);
});

test("a masterclass drops report clusters citing only read concerts and keeps a fresh reports-only cluster", async () => {
	const old = { ...reportProposal, title: "old reports", concerts: ["c1"] };
	const fresh = { ...reportProposal, title: "fresh reports", concerts: ["c2"] };
	const performed = await withReports(
		"perform",
		{ proposals: [old, fresh] },
		reportHeadings.replace("## c1 · v.i1\n", "## c1 · v.i1 · read\n"),
	);
	expect(performed.code).toBe(0);
	const concert = JSON.parse(performed.out);
	expect(concert.status).toBe("ok");
	expect(concert.outputs.masterclass).toEqual({ proposals: [fresh] });
});

test("a proposal can target package source but not an absolute or parent path", async () => {
	for (const [target, accepted] of [
		["packages/host-repo/src/report.ts", true],
		["/packages/host-repo/src/report.ts", false],
		["packages/../outside.ts", false],
	] as const) {
		const file = join(mkdtempSync(join(scratch, "target-")), "proposal.json");
		writeFileSync(
			file,
			JSON.stringify({
				proposals: [{ ...one, kind: "enhancement", reports: [], target }],
			}),
		);
		const read = await readJson(
			{
				file: { path: file, contentHash: "sha256:0" },
				schema: Masterclass.schema,
			},
			{ path: (ref) => ref.path } as CodeContext,
		);
		expect("value" in read).toBe(accepted);
	}
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
