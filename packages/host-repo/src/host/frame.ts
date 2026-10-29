import { type JsonSchema, validator, violations } from "@maestro/ir";
import { OUTBOX, type Output } from "../harness/index";

/** The directory where an agent's sandbox mounts its attachments. */
const ATTACHMENT_DIR = "/in";
/** Where the sandbox sees attachment `name`. */
export const attachmentPath = (name: string) => `${ATTACHMENT_DIR}/${name}`;

const LINE = { type: "string", minLength: 1 } as const;
const LINES = { type: "array", items: LINE } as const;

/** The schema of an agent's report, its `report` output. Equal to the SDK's `REPORT`. */
export const REPORT = {
	type: "object",
	required: ["summary"],
	additionalProperties: false,
	properties: { summary: LINE, gaps: LINES, obstacles: LINES, lessons: LINES },
} as const;

/** A one-line summary, then only what the record cannot show. A list is left out when empty. */
export type Report = {
	summary: string;
	gaps?: string[];
	obstacles?: string[];
	lessons?: string[];
};

/**
 * An agent's final reply (GLOSSARY: Envelope). A work agent's has no `outcome` or `reason`; a verdict agent's has an
 * `outcome` unless blocked.
 */
export type Envelope = {
	report: Report;
	blocked?: string;
	outcome?: "ok" | "rejected";
	reason?: string;
};

const envelopeSchema = (verdict: Record<string, JsonSchema>): JsonSchema => ({
	type: "object",
	required: ["report"],
	additionalProperties: false,
	properties: { report: REPORT, blocked: LINE, ...verdict },
});

/** What a reply kind takes: its envelope's schema, the line that asks for the declared files, and how to reply. */
export type ReplyKind = { schema: JsonSchema; files: string; reply: string[] };

const REPLY_LEAD =
	"Your final reply is only this JSON object, with no other text:";
const BLOCKED_BAR =
	"only when you cannot proceed, the cause is outside your reach, and nothing later in this run will change it.";
const LISTS = [
	"- Leave a list out when it is empty.",
	"- `obstacles` are such as a missing or empty attachment, or a tool not on your PATH.",
];
const LISTED = `    "gaps": ["<what your task asked that you left undone or did not verify>"],
    "obstacles": ["<what in your environment got in your way>"],
    "lessons": ["<what you learnt that the code does not show>"]`;

export const WORK: ReplyKind = {
	schema: envelopeSchema({}),
	files: "Before your final reply, write every one of these files:",
	reply: [
		REPLY_LEAD,
		"",
		`\`\`\`json
{
  "report": {
    "summary": "<what you did, in one line>",
${LISTED}
  }
}
\`\`\``,
		"",
		...LISTS,
		"- Leave out what the run already records: your changes, the checks' results and the files you wrote.",
		`- Add \`"blocked": "<the cause>"\` ${BLOCKED_BAR}`,
	],
};

export const VERDICT: ReplyKind = {
	schema: envelopeSchema({
		outcome: { enum: ["ok", "rejected"] },
		reason: LINE,
	}),
	files:
		"Before your final reply, write every one of these files, even when you reject:",
	reply: [
		REPLY_LEAD,
		"",
		`\`\`\`json
{
  "report": {
    "summary": "<your ruling, in one line>",
${LISTED}
  },
  "outcome": "ok",
  "reason": "<why, when rejected>"
}
\`\`\``,
		"",
		"- `outcome`: `ok` when the work passes your ruling, `rejected` when it does not.",
		"- `reason`: why you rejected; leave it out when `ok`.",
		...LISTS,
		"- Leave out what the run already records: the checks' results and the files you wrote.",
		`- Give \`"blocked": "<the cause>"\` in place of \`outcome\` and \`reason\` ${BLOCKED_BAR}`,
	],
};

/** What the frame says of an agent's run. */
export type Run = {
	/** `write` for a lane the agent changes, `read` for one it reads; absent with no lane. */
	lane?: "write" | "read";
	/** The checks it may run, by name, each with its hint. */
	checks: [name: string, hint: string][];
	/** Its attachments, by name, each with its hint. */
	attachments: [name: string, hint: string][];
	/** The files it writes in the outbox. */
	out: Output[];
	kind: ReplyKind;
};

const LANE_TEXT = {
	write:
		"Your working copy is the current directory. Leave your changes uncommitted: the run records the working copy as a version when you finish.",
	read: "Your working copy is the current directory, and it is read-only: change nothing in it.",
};
const SHELL =
	"Your shell is already set up: call tools by their bare names. Judge a command by its exit status, never by words in its output.";
const CHECKS =
	"Run the target's checks with `check <name>`, and never write your own. Each prints the tail of its output, then ok, rejected or failed.";
const VERIFY = "Run them to verify your change before you finish.";

/** A `## heading` section of `paragraphs`, or nothing when it has none. */
const section = (heading: string, paragraphs: string[]) =>
	paragraphs.length ? [`## ${heading}`, ...paragraphs] : [];

const workingCopy = (lane: Run["lane"]) =>
	section("Working copy", [...(lane ? [LANE_TEXT[lane]] : []), SHELL]);

function checks({ checks, lane }: Run) {
	if (!checks.length) return [];
	const lead = lane === "write" ? `${CHECKS} ${VERIFY}` : CHECKS;
	const lines = checks.map(([name, hint]) => `- \`check ${name}\`: ${hint}`);
	return section("Checks", [[lead, ...lines].join("\n")]);
}

function attachments({ attachments }: Run) {
	const lines = attachments.map(
		([name, hint]) => `- \`${attachmentPath(name)}\`: ${hint}`,
	);
	return section(
		"Attachments",
		lines.length ? [["Read-only, in your sandbox:", ...lines].join("\n")] : [],
	);
}

const fileLine = (o: Output) =>
	o.format === "json"
		? `- \`${OUTBOX}/${o.file}\`: JSON matching this JSON Schema:\n  \`\`\`json\n  ${JSON.stringify(o.schema)}\n  \`\`\``
		: `- \`${OUTBOX}/${o.file}\`: Markdown`;

function reply({ out, kind }: Run) {
	const files = out.length
		? [[kind.files, ...out.map(fileLine)].join("\n")]
		: [];
	return section("Reply", [...files, kind.reply.join("\n")]);
}

/**
 * The host's frame of an agent's run, appended to its profile's instructions: `# Your run`, then its working copy,
 * checks, attachments and reply, each section left out when it has nothing to say.
 */
export const frame = (run: Run): string =>
	[
		"# Your run",
		...workingCopy(run.lane),
		...checks(run),
		...attachments(run),
		...reply(run),
	].join("\n\n");

export const correction = (problem: string, kind: ReplyKind) =>
	[
		`Your final reply is not the JSON object asked for: ${problem}.`,
		...kind.reply,
	].join("\n");

export const CUT_OFF =
	"Your last turn was cut off by a provider error. Carry on from where you were.";

const FENCED = /^```(?:json)?\n([\s\S]*)\n```$/;

const ajv = validator();

/** `report` without its empty lists. */
const compacted = (report: Report): Report =>
	Object.fromEntries(
		Object.entries(report).filter(([, v]) => !Array.isArray(v) || v.length),
	) as Report;

/** The envelope of reply kind `kind` that `reply` holds, bare or in one fenced block, or what is wrong with it. */
export function envelopeOf(reply: string, kind: ReplyKind): Envelope | string {
	const trimmed = reply.trim();
	let value: unknown;
	try {
		value = JSON.parse(FENCED.exec(trimmed)?.[1] ?? trimmed);
	} catch {
		return "it is not a JSON object";
	}
	const found = violations(ajv, kind.schema, value, (at) =>
		["reply", ...at].join("."),
	);
	if (found.length) return found.join("; ");
	const envelope = value as Envelope;
	const verdict = envelope.outcome ?? envelope.reason;
	if (envelope.blocked !== undefined && verdict !== undefined)
		return "reply.blocked excludes reply.outcome and reply.reason";
	if (kind === VERDICT && envelope.blocked === undefined && !envelope.outcome)
		return "reply.outcome is required unless reply.blocked is set";
	if (envelope.outcome === "rejected" && !envelope.reason)
		return "reply.reason is required when outcome is rejected";
	return { ...envelope, report: compacted(envelope.report) };
}
