import { createHash } from "node:crypto";
import type { Comment } from "./forge";
import { isJson, type Json } from "./json";
import { nextOf, type State } from "./transitions";

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
/** The `triage` output of `.maestro/triage.ts`. `dependsOn` holds 0-based indexes of earlier children. */
export type Triage = {
	verdict: Verdict;
	risk: Risk;
	area?: string;
	reasons: string[];
	questions: string[];
	spec?: Spec;
	children?: Child[];
	duplicateOf?: number;
	related?: number[];
};
/**
 * The tick's state for one issue (factory.md, Rules: Factory data): `concert` is the last settled concert it routed,
 * `triage` the last ok triage concert, which a re-triage continues, `read` the id of the newest comment a triage was
 * fed, `pending` marks a routed result whose labels are not yet set, `filed` holds an approved split's children, `slice`
 * the slice concert its last build started, `attempts` the red slices it spent and `failure` the reason its last slice
 * failed.
 */
export type Data = {
	concert?: string;
	triage?: string;
	read?: number;
	result?: Triage;
	pending?: true;
	filed?: number[];
	slice?: string;
	attempts?: number;
	failure?: string;
};

export const VERDICT_STATE: Record<Verdict, State> = {
	"ready-for-agent": "ready-for-agent",
	"needs-approval": "needs-approval",
	"needs-info": "needs-info",
	split: "needs-approval",
	duplicate: "duplicate",
};

export const MARKER = "<!-- factory -->";
const DATA_LINE = /^<!-- factory-data (.*) -->$/gm;

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
		questions: field(value, "questions", isStrings, "a list of strings"),
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

/** The ask: the part of `body` above the factory marker. */
export const askOf = (body: string) => body.split(MARKER)[0]?.trimEnd() ?? "";

const isFactory = (comment: Comment) =>
	comment.body.split("\n")[0]?.trimEnd() === MARKER;

/** The factory comment among `comments`: the first whose first line is the marker. */
export const factoryOf = (comments: readonly Comment[]) =>
	comments.find(isFactory);

/** The comments but the factory's whose id is above `read`. */
export const repliesOf = (comments: readonly Comment[], read = 0) =>
	comments.filter((c) => !isFactory(c) && c.id > read);

/**
 * The tick's data in the factory comment `comment`, empty when it has none. The comment ends with its data line, so the
 * last match is the tick's.
 * @throws Error when the data line is not the JSON the tick wrote.
 */
export function dataOf(comment: string): Data {
	const matches = [...comment.matchAll(DATA_LINE)];
	const line = matches.at(-1)?.[1];
	if (line === undefined) return {};
	const data: unknown = JSON.parse(line);
	if (!isJson(data)) throw new Error("the factory data is not an object");
	return {
		concert: optional(data, "concert", isString, "a concert id"),
		triage: optional(data, "triage", isString, "a concert id"),
		read: optional(data, "read", isNumber, "a comment id"),
		result: data.result === undefined ? undefined : parseTriage(data.result),
		pending: data.pending === true || undefined,
		filed: optional(data, "filed", isNumbers, "a list of issue numbers"),
		slice: optional(data, "slice", isString, "a concert id"),
		attempts: optional(data, "attempts", isNumber, "a count"),
		failure: optional(data, "failure", isString, "a string"),
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
	...section("Questions", numbered(result.questions)),
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

/**
 * The factory comment for `data` (factory.md, Rules: Factory comment): the marker, then readable Markdown, then the one
 * data line the tick reads back.
 */
export function commentOf(data: Data): string {
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
		"_The factory rewrites this comment: answer its questions in a reply._",
		"",
		...shown,
		`<!-- factory-data ${json} -->`,
		"",
	].join("\n");
}

/** `body` with its factory block rewritten for `state` and `result`, linking to the factory comment of id `comment`. */
export function withBlock(
	body: string,
	state: State,
	{ result }: Data,
	comment: number,
): string {
	const labels = [
		`State: \`${state}\``,
		...(result ? [`Risk: \`${result.risk}\``] : []),
		...(result?.area ? [`Area: \`${result.area}\``] : []),
	];
	const shown = [
		`- ${labels.join(" · ")}`,
		`- [Factory comment](#issuecomment-${comment})`,
		"",
		...section("Next", list(nextOf(state, result?.verdict === "split"))),
	].map(inert);
	return [
		askOf(body),
		"",
		MARKER,
		"",
		"_The factory rewrites everything below the marker._",
		"",
		...shown,
	].join("\n");
}

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
