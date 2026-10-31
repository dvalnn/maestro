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

export type Spec = {
	touches: string[];
	what: string;
	acceptance: string[];
	subject: string;
};
export type Child = { title: string; body: string; dependsOn: number[] };
/** The `triage` output of `.maestro/triage.ts`. `dependsOn` holds 0-based indexes of earlier children. */
export type Triage = {
	verdict: Verdict;
	risk: (typeof RISKS)[number];
	area?: string;
	reasons: string[];
	questions: string[];
	spec?: Spec;
	children?: Child[];
	duplicateOf?: number;
	related?: number[];
};
/**
 * The tick's state for one issue (factory.md, Rules: Factory block): `concert` is the last settled concert it routed, `triage` the last ok triage
 * concert, which a re-triage continues, `pending` marks a routed result whose labels are not yet set, and `filed`
 * holds an approved split's children.
 */
export type Data = {
	concert?: string;
	triage?: string;
	result?: Triage;
	pending?: true;
	filed?: number[];
};

export const VERDICT_STATE: Record<Verdict, State> = {
	"ready-for-agent": "ready-for-agent",
	"needs-approval": "needs-approval",
	"needs-info": "needs-info",
	split: "needs-approval",
	duplicate: "duplicate",
};

export const MARKER = "<!-- factory -->";
const DATA_LINE = /^<!-- factory-data (.*) -->$/m;

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

/**
 * The tick's data in `body`'s factory block, empty when it has none.
 * @throws Error when the data line is not the JSON the tick wrote.
 */
export function dataOf(body: string): Data {
	const line = DATA_LINE.exec(body.slice(askOf(body).length))?.[1];
	if (line === undefined) return {};
	const data: unknown = JSON.parse(line);
	if (!isJson(data)) throw new Error("the factory data is not an object");
	return {
		concert: optional(data, "concert", isString, "a concert id"),
		triage: optional(data, "triage", isString, "a concert id"),
		result: data.result === undefined ? undefined : parseTriage(data.result),
		pending: data.pending === true || undefined,
		filed: optional(data, "filed", isNumbers, "a list of issue numbers"),
	};
}

const list = (items: readonly string[]) => items.map((i) => `- ${i}`);
const refs = (numbers: readonly number[]) =>
	numbers.map((n) => `#${n}`).join(", ");

const section = (heading: string, lines: string[]) =>
	lines.length ? [`#### ${heading}`, "", ...lines, ""] : [];

const specLines = ({ what, touches, acceptance, subject }: Spec) => [
	what,
	"",
	`- Subject: \`${subject}\``,
	`- Touches: ${touches.map((t) => `\`${t}\``).join(", ")}`,
	"- Acceptance:",
	...acceptance.map((a) => `  - ${a}`),
];

const childLines = (children: readonly Child[], filed: readonly number[]) =>
	children.map((c, i) => {
		const after = c.dependsOn.length
			? ` (after ${c.dependsOn.map((d) => filed[d] ?? d + 1).join(", ")})`
			: "";
		return `${i + 1}. ${filed[i] ? `#${filed[i]} ` : ""}${c.title}${after}`;
	});

function resultLines(result: Triage | undefined, filed: readonly number[]) {
	if (!result) return [];
	return [
		`- Risk: \`${result.risk}\`${result.area ? ` · Area: \`${result.area}\`` : ""}`,
		...(result.duplicateOf ? [`- Duplicate of #${result.duplicateOf}`] : []),
		...(result.related?.length ? [`- Relates to ${refs(result.related)}`] : []),
		"",
		...section("Spec", result.spec ? specLines(result.spec) : []),
		...section("Children", childLines(result.children ?? [], filed)),
		...section("Questions", list(result.questions)),
		...section("Reasons", list(result.reasons)),
	];
}

/**
 * `body` with its factory block rewritten for `state` and `data`: readable Markdown, then the one data line the tick
 * reads back.
 */
export function withBlock(body: string, state: State, data: Data): string {
	// JSON keeps `>` only inside strings, so escaping it keeps a `-->` in the data from closing the comment.
	const json = JSON.stringify(data).replaceAll(">", "\\u003e");
	return [
		askOf(body),
		"",
		MARKER,
		"",
		"_The factory rewrites everything below the marker: edit the ask above it._",
		"",
		`- State: \`${state}\``,
		...resultLines(data.result, data.filed ?? []),
		...section("Next", list(nextOf(state, data.result?.verdict === "split"))),
		...(data.concert ? [`Last concert: \`${data.concert}\``, ""] : []),
		`<!-- factory-data ${json} -->`,
		"",
	].join("\n");
}
