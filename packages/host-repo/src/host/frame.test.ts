import { expect, test } from "bun:test";
import { frame, type Run, replyKind, VERDICT } from "./frame";

const SHELL = "Your shell is bash";

/** The `## ` sections of a frame, by heading, so a test reads one section and not its prose. */
/** The paragraphs of a section, not counting its heading. */
const paragraphs = (section: string | undefined) =>
	(section ?? "").trim().split("\n\n").length - 1;

const REPORT_KEYS = [
	'"report"',
	'"summary"',
	'"gaps"',
	'"obstacles"',
	'"lessons"',
	'"sightings"',
	'"blocked"',
];

const sectionsOf = (text: string) =>
	Object.fromEntries(
		text
			.split(/^## /m)
			.slice(1)
			.map((part) => [part.slice(0, part.indexOf("\n")), part]),
	);

test("a write-lane builder's frame states its working copy, checks and reply, in that order", () => {
	const run: Run = {
		lane: "write",
		checks: [["all", "format, lint, types and every test"]],
		out: [
			{ file: "notes.md", format: "markdown" },
			{ file: "a.json", format: "json", schema: { type: "object" } },
		],
		kind: replyKind(false, { map: { type: "object" } }),
	};
	const text = frame(run);
	expect(text.match(/^## .*$/gm)).toEqual([
		"## Working copy",
		"## Checks",
		"## Reply",
	]);
	const sections = sectionsOf(text);
	expect(sections.Checks).toContain("`check all`");
	expect(sections.Checks).toContain("format, lint, types and every test");
	expect(sections["Working copy"]).not.toContain("git show HEAD:");
	// The agent's reply parser reads these keys and the files in /out.
	const reply = sections.Reply ?? "";
	expect(reply).toContain("`/out/notes.md`");
	expect(reply).toContain("`/out/a.json`");
	expect(reply).toContain('"type": "object"');
	for (const key of [...REPORT_KEYS, '"map"']) expect(reply).toContain(key);
	expect(reply).not.toContain('"outcome"');
	expect(paragraphs(sections["Working copy"])).toBe(3);
	const readChecks = sectionsOf(
		frame({ ...run, lane: "read", kind: VERDICT }),
	).Checks?.split("\n")[2];
	const writeChecks = sections.Checks?.split("\n")[2] ?? "";
	// The write lane's lead extends the read lane's, which holds no verify line.
	expect(writeChecks.startsWith(readChecks ?? "?")).toBe(true);
	expect(writeChecks.length).toBeGreaterThan(readChecks?.length ?? 0);
});

test("a read-lane frame keeps a draft in the working copy and omits the verify line", () => {
	const text = frame({
		lane: "read",
		checks: [["all", "every test"]],
		out: [{ file: "findings.md", format: "markdown" }],
		kind: VERDICT,
	});
	const sections = sectionsOf(text);
	expect(Object.keys(sections)).toEqual(["Working copy", "Checks", "Reply"]);
	expect(sections["Working copy"]).toContain("git show HEAD:<path>");
	expect(sections.Checks).toContain("`check all`");
	expect(sections.Reply).toContain("`/out/findings.md`");
	for (const key of [...REPORT_KEYS, '"outcome"'])
		expect(sections.Reply).toContain(key);
	expect(sections.Reply).not.toContain('"map"');
	expect(paragraphs(sections["Working copy"])).toBe(2);
});

test.each([
	["no lane or check", {}, ["Working copy", "Reply"], []],
	[
		"a handoff policy of three sessions",
		{ sessions: 3 },
		["Working copy", "Context", "Reply"],
		["3"],
	],
] as [string, Partial<Run>, string[], string[]][])(
	"with %s, the frame holds only the sections it has something to say in",
	(_, given, present, inContext) => {
		const text = frame({
			checks: [],
			out: [],
			kind: VERDICT,
			...given,
		});
		const sections = sectionsOf(text);
		expect(Object.keys(sections)).toEqual(present);
		expect(sections["Working copy"]).toContain(SHELL);
		expect(paragraphs(sections["Working copy"])).toBe(1);
		// With no output file the reply holds the kind's contract and no file lead.
		expect(paragraphs(sections.Reply)).toBe(
			VERDICT.reply.join("\n").split("\n\n").length,
		);
		expect(sections.Reply).toContain('"outcome"');
		expect(
			inContext.filter((word) => !sections.Context?.includes(word)),
		).toEqual([]);
	},
);
