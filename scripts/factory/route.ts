import { createHash } from "node:crypto";
import type { Comment } from "./forge";
import { isJson, type Json } from "./json";
import {
	INTAKE,
	LOGIN,
	type State,
	TRANSITIONS,
	type Transition,
} from "./transitions";

export const VERDICTS = [
	"ready-for-agent",
	"needs-approval",
	"needs-info",
	"split",
	"duplicate",
] as const;
export const RISKS = ["low", "medium", "high"] as const;
type Verdict = (typeof VERDICTS)[number];
export type Risk = (typeof RISKS)[number];
/** How many red slices a ticket spends before it goes to `needs-info` (factory.md, Rules: Attempts). */
export const ATTEMPTS = 2;

export type Spec = {
	touches: string[];
	what: string;
	steps: string[];
	acceptance: string[];
	subject: string;
};
export type Child = { title: string; body: string; dependsOn: number[] };
export type Option = { label: string; text: string };
/** A question for the owner, whose `recommend.label` is one of its options' labels. */
export type Question = {
	ask: string;
	lead?: string;
	options: Option[];
	recommend?: { label: string; why: string };
	context: { topic: string; text: string }[];
};
/** The `triage` output of `.maestro/triage.ts`. `dependsOn` holds 0-based indexes of earlier children. */
export type Triage = {
	verdict: Verdict;
	risk: Risk;
	area?: string;
	reasons: string[];
	questions: Question[];
	spec?: Spec;
	children?: Child[];
	duplicateOf?: number;
	related?: number[];
};
/**
 * The tick's state for one issue (factory.md, Rules: Data): `concert` is the last settled concert it routed, `triage`
 * the last ok triage concert, which a re-triage continues, `read` the id of the newest comment a triage was fed,
 * `version` the spec's, counting routed triages, `pending` marks a routed result whose labels are not yet set, `filed`
 * holds an approved split's children, `slice` the slice concert its last build started, `attempts` the red slices it
 * spent, `failure` the reason its last slice failed, `parked` a slice concert routed but not applied and `stack` the
 * in-review blocker its last build stacked on, with its PR and that PR's head commit, until the restack onto `main`.
 * `encore` is the slice concert a build continues and `review` the id of the newest review requesting changes an
 * encore was fed.
 */
export type Data = {
	concert?: string;
	triage?: string;
	read?: number;
	version?: number;
	result?: Triage;
	pending?: true;
	filed?: number[];
	slice?: string;
	attempts?: number;
	failure?: string;
	parked?: string;
	stack?: Stack;
	encore?: string;
	review?: number;
};
export type Stack = { blocker: number; commit: string; pull: number };

export const VERDICT_STATE: Record<Verdict, State> = {
	"ready-for-agent": "ready-for-agent",
	"needs-approval": "needs-approval",
	"needs-info": "needs-info",
	split: "needs-approval",
	duplicate: "duplicate",
};

export const MARKER = "<!-- maestro-tm -->";
export const QUESTION = "<!-- maestro-tm-question -->";
const DATA_LINE = /^<!-- maestro-tm-data (.*) -->$/gm;
/** What separates the ask from the marker in a body the tick wrote. */
const SEPARATOR = "\n\n";

function field<T>(
	o: Json,
	key: string,
	is: (v: unknown) => v is T,
	what: string,
): T {
	if (!is(o[key])) throw new Error(`${key} is not ${what}`);
	return o[key];
}

function optional<T>(
	o: Json,
	key: string,
	is: (v: unknown) => v is T,
	what: string,
): T | undefined {
	return o[key] === undefined ? undefined : field(o, key, is, what);
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => Number.isInteger(v);
const isStrings = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every(isString);
const isNumbers = (v: unknown): v is number[] =>
	Array.isArray(v) && v.every(isNumber);
const isStack = (v: unknown): v is Stack =>
	isJson(v) && isNumber(v.blocker) && isString(v.commit) && isNumber(v.pull);
const isOneOf =
	<T extends string>(values: readonly T[]) =>
	(v: unknown): v is T =>
		values.includes(v as T);

const isSpec = (v: unknown): v is Spec =>
	isJson(v) &&
	isStrings(v.touches) &&
	isString(v.what) &&
	isStrings(v.steps) &&
	isStrings(v.acceptance) &&
	isString(v.subject);

const isChildren = (v: unknown): v is Child[] =>
	Array.isArray(v) &&
	v.length > 0 &&
	v.every(
		(c, i) =>
			isJson(c) &&
			isString(c.title) &&
			isString(c.body) &&
			isNumbers(c.dependsOn) &&
			c.dependsOn.every((d) => d >= 0 && d < i),
	);

const isPair =
	<K extends string>(...keys: [K, K]) =>
	(v: unknown): v is Record<K, string> =>
		isJson(v) && keys.every((k) => isString(v[k]));
const isOptions = (v: unknown): v is Option[] =>
	Array.isArray(v) && v.every(isPair("label", "text"));
const isContext = (v: unknown): v is Question["context"] =>
	Array.isArray(v) && v.every(isPair("topic", "text"));
const isRecommend = isPair("label", "why");

/**
 * `value` as a question; a string is an ask alone.
 * @throws Error naming the first field that is missing or malformed, or a recommendation naming no option.
 */
function parseQuestion(value: unknown): Question {
	if (isString(value)) return { ask: value, options: [], context: [] };
	if (!isJson(value)) throw new Error("a question is not an object");
	const question: Question = {
		ask: field(value, "ask", isString, "a string"),
		lead: optional(value, "lead", isString, "a string"),
		options: field(value, "options", isOptions, "a list of options"),
		recommend: optional(value, "recommend", isRecommend, "a recommendation"),
		context: field(value, "context", isContext, "a list of topics"),
	};
	const label = question.recommend?.label;
	if (label !== undefined && !question.options.some((o) => o.label === label))
		throw new Error(`recommend names ${label}, which is no option`);
	return question;
}

/** The field each verdict cannot settle without. */
const NEEDS: Partial<Record<Verdict, keyof Triage>> = {
	"ready-for-agent": "spec",
	"needs-approval": "spec",
	split: "children",
	duplicate: "duplicateOf",
};

/**
 * `value` as a triage output.
 * @throws Error naming the first field that is missing or malformed.
 */
export function parseTriage(value: unknown): Triage {
	if (!isJson(value)) throw new Error("the triage output is not an object");
	const triage: Triage = {
		verdict: field(value, "verdict", isOneOf(VERDICTS), "a verdict"),
		risk: field(value, "risk", isOneOf(RISKS), "a risk"),
		area: optional(value, "area", isString, "a string"),
		reasons: field(value, "reasons", isStrings, "a list of strings"),
		questions: field(value, "questions", Array.isArray, "a list").map(
			parseQuestion,
		),
		spec: optional(value, "spec", isSpec, "a spec"),
		children: optional(value, "children", isChildren, "a list of children"),
		duplicateOf: optional(value, "duplicateOf", isNumber, "an issue number"),
		related: optional(value, "related", isNumbers, "a list of issue numbers"),
	};
	const needed = NEEDS[triage.verdict];
	if (needed && triage[needed] === undefined)
		throw new Error(`a ${triage.verdict} verdict has no ${needed}`);
	return triage;
}

/** `labels` without any in `scopes`, plus `added`. */
export const relabelled = (
	labels: readonly string[],
	scopes: readonly string[],
	added: readonly string[],
) => [
	...labels.filter((l) => !scopes.some((s) => l.startsWith(`${s}/`))),
	...added,
];

/** `labels` as a settled triage leaves them: its state, its risk, its area when it has one and no other area. */
export const triaged = (labels: readonly string[], triage: Triage) =>
	relabelled(
		labels,
		["state", "risk", "area"],
		[
			`state/${VERDICT_STATE[triage.verdict]}`,
			`risk/${triage.risk}`,
			...(triage.area ? [`area/${triage.area}`] : []),
		],
	);

/** The ask as the owner wrote it: `body` above the marker, without the separator the tick put before it. */
function exactAsk(body: string) {
	const above = body.split(MARKER)[0] ?? "";
	return body.includes(MARKER) && above.endsWith(SEPARATOR)
		? above.slice(0, -SEPARATOR.length)
		: above;
}

/** The ask: the part of `body` above the marker. */
export const askOf = (body: string) => exactAsk(body).trimEnd();

const opensWith = (marker: string) => (comment: Comment) =>
	comment.body.split("\n")[0]?.trimEnd() === marker;
const isFactory = opensWith(MARKER);
export const isQuestion = opensWith(QUESTION);

/** The spec comment among `comments`: the first whose first line is the marker. */
export const specCommentOf = (comments: readonly Comment[]) =>
	comments.find(isFactory);

/** The comments but the spec comment whose id is above `read`, in id order: those a triage considers. */
export const repliesOf = (comments: readonly Comment[], read = 0) =>
	comments
		.filter((c) => !isFactory(c) && c.id > read)
		.sort((a, b) => a.id - b.id);

/** Whether `comment` is a question comment `login` posted. */
export const isAsked = (comment: Comment, login: string) =>
	isQuestion(comment) && comment.author === login;

/** Whether `body` mentions `@login` as a whole word, in any case. */
const mentions = (body: string, login: string) =>
	new RegExp(
		`(?<![\\w@])@${login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
		"i",
	).test(body);

/** Whether a triage is fed `comment`: a question comment `login` posted, or any comment mentioning `@login`. */
export const isFed = (comment: Comment, login: string) =>
	isAsked(comment, login) || mentions(comment.body, login);

/** Whether `comment` is a reply to `login`: one mentioning `@login` that is no question comment `login` posted. */
export const isReply = (comment: Comment, login: string) =>
	!isAsked(comment, login) && mentions(comment.body, login);

/**
 * The tick's data in the spec comment `comment`, empty when it has none. The comment ends with its data line, so the
 * last match is the tick's.
 * @throws Error when the data line is not the JSON the tick wrote.
 */
export function dataOf(comment: string): Data {
	const matches = [...comment.matchAll(DATA_LINE)];
	const line = matches.at(-1)?.[1];
	if (line === undefined) return {};
	const data: unknown = JSON.parse(line);
	if (!isJson(data))
		throw new Error("the maestro-tm-data line is not an object");
	return {
		concert: optional(data, "concert", isString, "a concert id"),
		triage: optional(data, "triage", isString, "a concert id"),
		read: optional(data, "read", isNumber, "a comment id"),
		version: optional(data, "version", isNumber, "a count"),
		result: data.result === undefined ? undefined : parseTriage(data.result),
		pending: data.pending === true || undefined,
		filed: optional(data, "filed", isNumbers, "a list of issue numbers"),
		slice: optional(data, "slice", isString, "a concert id"),
		attempts: optional(data, "attempts", isNumber, "a count"),
		failure: optional(data, "failure", isString, "a string"),
		parked: optional(data, "parked", isString, "a concert id"),
		stack: optional(data, "stack", isStack, "a stack"),
		encore: optional(data, "encore", isString, "a concert id"),
		review: optional(data, "review", isNumber, "a review id"),
	};
}

/** `text` with its comment delimiters broken, so agent-written text cannot open or close the block's comments. */
const inert = (text: string) =>
	text.replaceAll("<!--", "<! --").replaceAll("-->", "-- >");

/** `text` in a code block whose fence no backtick run inside it can close. */
export const fenced = (text: string) => {
	const runs = [...text.matchAll(/`+/g)].map((m) => m[0].length + 1);
	const fence = "`".repeat(Math.max(3, ...runs));
	return `${fence}text\n${text}\n${fence}`;
};

const list = (items: readonly string[]) => items.map((i) => `- ${i}`);
const numbered = (items: readonly string[]) =>
	items.map((item, i) => `${i + 1}. ${item}`);
const refs = (numbers: readonly number[]) =>
	numbers.map((n) => `#${n}`).join(", ");

const section = (heading: string, lines: string[]) =>
	lines.length ? [`#### ${heading}`, "", ...lines, ""] : [];

const specLines = ({ what, steps, touches, acceptance, subject }: Spec) => [
	...section("What", [what, "", `Subject: \`${subject}\``]),
	...section("Steps", numbered(steps)),
	...section("Touches", list(touches.map((t) => `\`${t}\``))),
	...section(
		"Acceptance",
		acceptance.map((a) => `- [ ] ${a}`),
	),
];

const childLines = (children: readonly Child[], filed: readonly number[]) =>
	children.map((c, i) => {
		const after = c.dependsOn.length
			? ` (after ${c.dependsOn.map((d) => filed[d] ?? d + 1).join(", ")})`
			: "";
		return `${i + 1}. ${filed[i] ? `#${filed[i]} ` : ""}${c.title}${after}`;
	});

/** What a result proposes: a split's children, a duplicate's original, else its spec. */
function proposalLines(result: Triage, filed: readonly number[]) {
	if (result.children)
		return section("Children", childLines(result.children, filed));
	if (result.duplicateOf) return [`Duplicate of #${result.duplicateOf}`, ""];
	return result.spec ? specLines(result.spec) : [];
}

const resultLines = (result: Triage, filed: readonly number[]) => [
	...proposalLines(result, filed),
	...section("Reasons", list(result.reasons)),
	...(result.related?.length ? [`Relates to ${refs(result.related)}`, ""] : []),
];

function buildLines({ attempts, failure, slice }: Data) {
	return [
		...(attempts ? [`- Attempts: ${attempts} of ${ATTEMPTS}`, ""] : []),
		...section("Last failure", failure ? [fenced(failure)] : []),
		...(slice ? [`Slice concert: \`${slice}\``, ""] : []),
	];
}

/** What the tick runs or queues next in `state`, one it owns, a queued build waiting on the open dependencies `waiting`. */
function tourMove(
	state: State,
	{ result, slice, attempts, filed }: Data,
	waiting: readonly number[],
) {
	if (INTAKE.includes(state)) return "triage queued";
	if (state === "ready-for-agent") {
		if (result?.children) return "filing the split's children";
		return waiting.length
			? `queued, waiting on ${refs(waiting)}`
			: "build queued";
	}
	if (state === "in-progress")
		return filed
			? `building the children ${refs(filed)}`
			: `slice \`${slice}\` running, attempt ${(attempts ?? 0) + 1} of ${ATTEMPTS}`;
	return "closing it";
}

/** Whether `data` leaves owner move `t` open: applying needs a parked concert, building again a spec to build. */
function allows(t: Transition, { parked, result }: Data) {
	if (t.event === "apply") return parked !== undefined;
	if (t.from !== "needs-info" || t.to !== "ready-for-agent") return true;
	return result?.spec !== undefined && result.verdict !== "needs-info";
}

/**
 * The bold line naming whose move it is in `state`: the owner's moves `data` leaves open, `<login>` in them filled with
 * `login`, else the tick's, a queued build waiting on the open dependencies `waiting`.
 */
export function moveLine(
	state: State,
	data: Data,
	login: string,
	waiting: readonly number[] = [],
) {
	const yours = TRANSITIONS.filter(
		(t) => t.from === state && t.actor === "owner" && allows(t, data),
	).map((t) => t.how.replace(LOGIN, login));
	return yours.length
		? `**Your move: ${yours.join(", or ")}**`
		: `**Tour manager's move: ${tourMove(state, data, waiting)}**`;
}

/** The version of a spec no routed triage has written yet. */
const FIRST_VERSION = 1;
const versionOf = ({ version }: Data) => version ?? FIRST_VERSION;

/**
 * The spec comment for `data` in `state` (factory.md, Rules: Spec comment): the marker, then readable Markdown ending in
 * whose move it is, answered by mentioning `login`, then the one data line the tick reads back.
 */
export function commentOf(
	data: Data,
	state: State,
	login: string,
	waiting: readonly number[] = [],
): string {
	// JSON keeps `>` only inside strings, so escaping it keeps a `-->` in the data from closing the comment.
	const json = JSON.stringify(data).replaceAll(">", "\\u003e");
	const shown = [
		...(data.result ? resultLines(data.result, data.filed ?? []) : []),
		...buildLines(data),
		...(data.concert ? [`Last concert: \`${data.concert}\``, ""] : []),
	].map(inert);
	return [
		MARKER,
		"",
		`### Spec v${versionOf(data)}`,
		"",
		...shown,
		moveLine(state, data, login, waiting),
		"",
		`<!-- maestro-tm-data ${json} -->`,
		"",
	].join("\n");
}

/** `body` as the ask the owner wrote, then the marker and the closing line linking spec comment `comment`. */
export const tracked = (body: string, comment: number, data: Data) =>
	`${exactAsk(body)}${SEPARATOR}${MARKER}\nTracked by Maestro Tour Manager · [spec v${versionOf(data)}](#issuecomment-${comment})`;

const RULE = "---";

const asks = (count: number) =>
	`### Maestro asks · ${count} question${count === 1 ? "" : "s"}`;

/** `text` on one line, each run of whitespace one space, for a field set inside bold. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** `text` continued under a list item or a quote opened by `prefix`. */
const continued = (text: string, prefix: string) =>
	text.replaceAll("\n", `\n${prefix}`);

const tipLines = ({ label, why }: NonNullable<Question["recommend"]>) => [
	"> [!TIP]",
	`> **Recommended: ${oneLine(label)}**, ${continued(why, "> ")}`,
	"",
];

const contextLines = (context: Question["context"]) => [
	"<details>",
	"<summary>Context</summary>",
	"",
	...context.map(
		(c) => `- **${oneLine(c.topic)}.** ${continued(c.text, "  ")}`,
	),
	"",
	"</details>",
	"",
];

/** Question `q`, numbered `n`: its ask, then each of its lead, options, recommendation and context it has. */
const questionLines = (q: Question, n: number) => [
	`**Q${n} · ${oneLine(q.ask)}**`,
	"",
	...(q.lead ? [q.lead, ""] : []),
	...(q.options.length
		? [
				...q.options.map(
					(o) => `- **${oneLine(o.label)}**: ${continued(o.text, "  ")}`,
				),
				"",
			]
		: []),
	...(q.recommend ? tipLines(q.recommend) : []),
	...(q.context.length ? contextLines(q.context) : []),
];

/**
 * A question comment (factory.md, Rules: Question comments): the marker, the heading, `questions` between rules, then
 * `how` to answer. Agent text in it is made inert.
 */
export const questionOf = (questions: readonly Question[], how: string) =>
	[
		QUESTION,
		"",
		...[
			asks(questions.length),
			"",
			...questions.flatMap((q, i) => [RULE, "", ...questionLines(q, i + 1)]),
			RULE,
			"",
			`<sub>${how}</sub>`,
		].map(inert),
		"",
	].join("\n");

/** How to answer `questions`: a reply mentioning `@login` that names each, then `label`, re-triage's by default. */
export const replyHow = (
	questions: readonly Question[],
	login: string,
	label = "`needs-triage`",
) =>
	`Reply \`@${login} ${questions.map((_, i) => `Q${i + 1}: …`).join(", ")}\`, then label ${label}.`;

/** What `--request` takes: the number and title, the spec, then the ask. */
export const requestOf = (
	{ number, title, body }: { number: number; title: string; body: string },
	spec: Spec,
) =>
	[
		`# #${number} ${title}`,
		"",
		...specLines(spec),
		"## The ask",
		"",
		askOf(body),
		"",
	].join("\n");

export type Change = { heading: string; body?: string };

/** `request` followed by each of `changes` under its `##` heading (factory.md, Rules: Encore). */
export const encoreRequest = (request: string, changes: readonly Change[]) =>
	[
		request,
		...changes.map(({ heading, body }) =>
			body?.trim() ? `## ${heading}\n\n${body.trim()}\n` : `## ${heading}\n`,
		),
	].join("\n");

/** What a landed slice's PR says, for an `upheld` Markdown list of the review's upheld findings. */
export type Landed = {
	issue: number;
	concert: string;
	tokens: number;
	upheld: string;
	result: Triage;
};

/** The PR body of a landed slice (factory.md, Rules: PRs). */
export function pullBody({ issue, concert, tokens, upheld, result }: Landed) {
	return [
		`Closes #${issue}`,
		"",
		`- Concert: \`${concert}\``,
		`- Tokens: ${tokens}`,
		...(result.related?.length ? [`- Relates to ${refs(result.related)}`] : []),
		"",
		...section("Acceptance", list(result.spec?.acceptance ?? [])),
		...section("Upheld findings", [upheld]),
	].join("\n");
}

const FINGERPRINT_HEX = 12;
const TITLE_MAX = 80;

/** The line that marks a filed report: the first hex of SHA-256 over its text lower-cased with whitespace folded. */
export function fingerprintLine(text: string) {
	const folded = text.toLowerCase().replace(/\s+/g, " ").trim();
	const hex = createHash("sha256").update(folded).digest("hex");
	return `<!-- factory-fingerprint ${hex.slice(0, FINGERPRINT_HEX)} -->`;
}

/** The title and body of a report issue on `text`, found by the slice of issue `found`. */
export function reportIssue(text: string, found: number) {
	const first = text.trim().split("\n")[0] ?? "";
	const title =
		first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
	const body = [
		`Found by #${found}`,
		"",
		text.trim(),
		"",
		fingerprintLine(text),
	];
	return { title, body: body.join("\n") };
}
