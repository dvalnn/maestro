import { expect, test } from "bun:test";
import { frame, type Run, replyKind, VERDICT, WORK } from "./frame";

const LISTED = `    "gaps": ["<something the task asked that was left undone or unverified, which the reader would otherwise assume done>"],
    "obstacles": ["<something outside the agent's reach that stopped or slowed it, such as a missing attachment or a tool not on the PATH; not a test that failed or a check that was red>"],
    "lessons": ["<something that changes what the next agent in this repository should do, which the code and its docs do not already say>"],
    "sightings": [{ "path": "<the file it is in>", "text": "<a defect or smell in the target outside the task's scope that the agent saw and left unfixed; never something the task asked to be fixed>", "cites": "<the rule, doc or behaviour it breaches>" }]`;

const GIT =
	"Git reads such as `status`, `diff` and `log` work here, and every git write fails by design. Try a git mutation in a fresh `git init` under `/tmp`.";
const SHELL =
	"Your shell is bash, already set up: call tools by their bare names. Judge a command by its exit status, never by words in its output.";

test("a write-lane builder's frame states its working copy, checks, attachments and reply, in that order", () => {
	const run: Run = {
		lane: "write",
		checks: [["all", "format, lint, types and every test"]],
		attachments: [
			["upheld", "first, for the findings to fix", "file"],
			["spec", "for what the change must do", "directory"],
		],
		skills: [
			["tdd", "Test-driven development. Use when building test-first."],
			["codebase-design", "Vocabulary for deep modules. Use when designing."],
		],
		out: [
			{ file: "notes.md", format: "markdown" },
			{ file: "a.json", format: "json", schema: { type: "object" } },
		],
		kind: replyKind(false, { map: { type: "object" } }),
	};
	expect(frame(run)).toBe(`# Your run

## Working copy

Your working copy is the current directory. Leave your changes uncommitted: the run records the working copy as a version when you finish. ${GIT}

${SHELL}

## Checks

Run the target's checks with \`check <name>\`, and never write your own. Each prints the tail of its output, then ok, rejected or failed. Run them to verify your change before you finish.
- \`check all\`: format, lint, types and every test

## Attachments

Read-only, in your sandbox:
- \`/in/upheld\` (file): first, for the findings to fix
- \`/in/spec\` (directory): for what the change must do

## Skills

When your task matches a skill's description, read its file before you act; when none matches, leave it unread.
- \`/skills/tdd/SKILL.md\`: Test-driven development. Use when building test-first.
- \`/skills/codebase-design/SKILL.md\`: Vocabulary for deep modules. Use when designing.

## Reply

Before your final reply, write every one of these files:
- \`/out/notes.md\`: Markdown
- \`/out/a.json\`: JSON matching this JSON Schema:
  \`\`\`json
  {"type":"object"}
  \`\`\`

Your final reply is only this JSON object, with no other text:

\`\`\`json
{
  "report": {
    "summary": "<what you did, in one line>",
${LISTED}
  },
  "map": <JSON value, as described below>
}
\`\`\`

- \`map\`: JSON matching this JSON Schema, left out only with \`blocked\`:
  \`\`\`json
  {"type":"object"}
  \`\`\`
- Most reports are the summary alone: give a list only for an item that clears its bar.
- Leave out what the run already records: your changes, the checks' results and the files you wrote.
- Add \`"blocked": "<the cause>"\` only when you cannot proceed, the cause is outside your reach, and nothing later in this run will change it.`);
});

const VERDICT_REPLY = `Your final reply is only this JSON object, with no other text:

\`\`\`json
{
  "report": {
    "summary": "<your ruling, in one line>",
${LISTED}
  },
  "outcome": "ok",
  "reason": "<why, when rejected>"
}
\`\`\`

- \`outcome\`: \`ok\` when the work passes your ruling, \`rejected\` when it does not.
- \`reason\`: why you rejected; leave it out when \`ok\`.
- Most reports are the summary alone: give a list only for an item that clears its bar.
- Leave out what the run already records: the checks' results and the files you wrote.
- Give \`"blocked": "<the cause>"\` in place of \`outcome\` and \`reason\` only when you cannot proceed, the cause is outside your reach, and nothing later in this run will change it.`;

test.each([
	[
		"a read lane with a check and an output",
		{
			lane: "read",
			checks: [["all", "every test"]],
			out: [{ file: "findings.md", format: "markdown" }],
		},
		[
			`## Working copy\n\nYour working copy is the current directory, and it is discarded when you finish: change files freely to try something, and restore one with \`git show HEAD:<path> > <path>\`. ${GIT}`,
			"or failed.\n- `check all`: every test",
			"## Reply\n\nBefore your final reply, write every one of these files, even when you reject:\n- `/out/findings.md`: Markdown\n\nYour final",
		],
		["Leave your changes uncommitted", "Run them to verify", "## Attachments"],
	],
	[
		"no lane, check or attachment",
		{},
		[`# Your run\n\n## Working copy\n\n${SHELL}\n\n## Reply\n\n`],
		[
			"Your working copy is",
			"Git reads",
			"## Checks",
			"## Attachments",
			"## Skills",
			"## Context",
			"write every one",
		],
	],
	[
		"a handoff policy of three sessions",
		{ sessions: 3 },
		[
			`${SHELL}\n\n## Context\n\nYour context is bounded. When it fills, this session stops, and in one more turn you write a handoff note for a fresh session that continues your task in this working copy. Work in steps that leave the working copy coherent, so a successor can pick up from it. This task allows up to 3 sessions.\n\n## Reply\n\n`,
		],
		["## Checks", "## Attachments"],
	],
] as [string, Partial<Run>, string[], string[]][])(
	"with %s, the frame holds only the sections it has something to say in",
	(_, given, present, absent) => {
		const text = frame({
			checks: [],
			attachments: [],
			skills: [],
			out: [],
			kind: VERDICT,
			...given,
		});
		for (const part of present) expect(text).toContain(part);
		for (const part of absent) expect(text).not.toContain(part);
		expect(text).toEndWith(VERDICT_REPLY);
	},
);
