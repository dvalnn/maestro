import { createHash } from "node:crypto";
import { type Question, TIERS, type Tier } from "../../.maestro/triage/verdict";
import type { Comment } from "./forge";
import { isJson, type Json } from "./json";
import type { Spend } from "./maestro";
import {
	INTAKE,
	STATES,
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
/** How many red slices a ticket spends before it goes to `needs-info` (factory.md, Rules, Build: Attempts). */
export const ATTEMPTS = 2;

/** A decision or exclusion of a spec: `lead` titles it, each of `points` holds one fact. */
export type Point = { lead: string; points: string[] };
/** Each figure kind of `.maestro/triage/prompts/_figures.md` and the fence its source is shown in. */
const FIGURE_FENCE = {
	seams: "mermaid",
	sequence: "mermaid",
	state: "mermaid",
	interface: "mermaid",
	contract: "mermaid",
	composition: "mermaid",
	"call-tree": "diff",
	"file-tree": "diff",
	pseudocode: "diff",
} as const;
export const FIGURES = Object.keys(FIGURE_FENCE) as FigureKind[];
type FigureKind = keyof typeof FIGURE_FENCE;
/** A figure of a spec: `notes` holds what each superscript in `source` points at, in order. */
export type Figure = {
	kind: FigureKind;
	caption: string;
	source: string;
	notes: string[];
};
/**
 * A triage spec; `decisions` and `excluded` read as empty from a spec stored without them. A planner's spec has
 * `requirements`, numbered R1 on, and `consequences`; a direct ruling's has neither.
 */
export type Spec = {
	touches: string[];
	what: string;
	requirements?: string[];
	figures?: Figure[];
	decisions: Point[];
	consequences?: string;
	excluded: Point[];
	acceptance: string[];
	subject: string;
};
export type Child = { title: string; body: string; dependsOn: number[] };
export type Option = Question["options"][number];
/** The `triage` output of `.maestro/triage.ts`. `dependsOn` holds 0-based indexes of earlier children. */
export type Triage = {
	verdict: Verdict;
	risk: Risk;
	/** The review tier triage gave; absent from a result triaged before it gave one. */
	tier?: Tier;
	area?: string;
	reasons: string[];
	questions: Question[];
	spec?: Spec;
	children?: Child[];
	duplicateOf?: number;
	related?: number[];
	/** The one-way door the planner named, absent when it named none. */
	contract?: string;
};
/**
 * The tick's state for one issue (factory.md, Forge surfaces: Data): `concert` is the last settled concert it routed,
 * `triage` the last ok triage concert, which a re-triage continues, `read` the id of the newest comment a triage was
 * fed, `version` the spec's, counting routed triages, `specAt` when the last routed triage wrote it (ms since the
 * epoch), `pending` marks a routed result whose labels are not yet set, `filed` holds an approved split's children,
 * `slice` the slice concert its last build started, `attempts` the red slices it spent, `failure` the reason its last
 * slice failed, `parked` a slice concert routed but not applied and `stack` the in-review blocker its last build
 * stacked on, with its PR and that PR's head commit, until the restack onto `main`. `encore` is the slice concert a
 * build continues and `review` the id of the newest review requesting changes an encore was fed. `revisionBase` is the
 * head of the PR a revision is cut at and lands on, until it lands.
 */
export type Data = {
	concert?: string;
	triage?: string;
	read?: number;
	version?: number;
	specAt?: number;
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
	revisionBase?: string;
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

const isPoints = (v: unknown): v is Point[] =>
	Array.isArray(v) &&
	v.every((p) => isJson(p) && isString(p.lead) && isStrings(p.points));

const isFigures = (v: unknown): v is Figure[] =>
	Array.isArray(v) &&
	v.every(
		(f) =>
			isJson(f) &&
			isOneOf(FIGURES)(f.kind) &&
			isString(f.caption) &&
			isString(f.source) &&
			isStrings(f.notes),
	);

/**
 * `value` as a spec, its absent `decisions` and `excluded` empty.
 * @throws Error naming the first field that is missing or malformed.
 */
function parseSpec(value: unknown): Spec {
	if (!isJson(value)) throw new Error("spec is not an object");
	return {
		touches: field(value, "touches", isStrings, "a list of strings"),
		what: field(value, "what", isString, "a string"),
		requirements: optional(
			value,
			"requirements",
			isStrings,
			"a list of strings",
		),
		figures: optional(value, "figures", isFigures, "a list of figures"),
		decisions: optional(value, "decisions", isPoints, "a list of points") ?? [],
		consequences: optional(value, "consequences", isString, "a string"),
		excluded: optional(value, "excluded", isPoints, "a list of points") ?? [],
		acceptance: field(value, "acceptance", isStrings, "a list of strings"),
		subject: field(value, "subject", isString, "a string"),
	};
}

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
		tier: optional(value, "tier", isOneOf(TIERS), "a tier"),
		area: optional(value, "area", isString, "a string"),
		reasons: field(value, "reasons", isStrings, "a list of strings"),
		questions: field(value, "questions", Array.isArray, "a list").map(
			parseQuestion,
		),
		spec: value.spec === undefined ? undefined : parseSpec(value.spec),
		children: optional(value, "children", isChildren, "a list of children"),
		duplicateOf: optional(value, "duplicateOf", isNumber, "an issue number"),
		related: optional(value, "related", isNumbers, "a list of issue numbers"),
		contract: optional(value, "contract", isString, "a string"),
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
		specAt: optional(data, "specAt", isNumber, "a time"),
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
		revisionBase: optional(data, "revisionBase", isString, "a commit"),
	};
}

/**
 * `text` with each comment opener broken, so agent-written text opens no comment. A `-->` with none open is plain text,
 * and stays whole for Mermaid's edges.
 */
const inert = (text: string) => text.replaceAll("<!--", "<! --");

/** `text` in a code block of `language` whose fence no backtick run inside it can close. */
export const fenced = (text: string, language = "text") => {
	const runs = [...text.matchAll(/`+/g)].map((m) => m[0].length + 1);
	const fence = "`".repeat(Math.max(3, ...runs));
	return `${fence}${language}\n${text}\n${fence}`;
};

const list = (items: readonly string[]) => items.map((i) => `- ${i}`);
const refs = (numbers: readonly number[]) =>
	numbers.map((n) => `#${n}`).join(", ");

const section = (heading: string, lines: string[]) =>
	lines.length ? [`#### ${heading}`, "", ...lines, ""] : [];

/** Each of `items` as a bold lead, its points as sub-bullets. */
const pointLines = (items: readonly Point[]) =>
	items.flatMap(({ lead, points }) => [
		`- **${oneLine(lead)}**`,
		...points.map((p) => `  - ${continued(p, "    ")}`),
	]);

const contextSection = ({ what, subject }: Spec) =>
	section("Context", [what, "", `Subject: \`${subject}\``]);

const requirementLines = (requirements: readonly string[]) =>
	requirements.map((r, i) => `- **R${i + 1}** ${continued(r, "  ")}`);

/** A figure: its caption, its source fenced, then its notes numbered as its superscripts are. */
const figureLines = ({ kind, caption, source, notes }: Figure) => [
	...(caption ? [caption, ""] : []),
	fenced(source, FIGURE_FENCE[kind]),
	...(notes.length ? [""] : []),
	...notes.map((n, i) => `${i + 1}. ${continued(n, "   ")}`),
];

const shapeLines = (figures: readonly Figure[]) =>
	figures.flatMap((f, i) => [...(i ? [""] : []), ...figureLines(f)]);

/** The sections the owner approves a spec by, each it has: requirements, shape, decisions, consequences, left out. */
const designSections = (spec: Spec) => [
	...section("Requirements", requirementLines(spec.requirements ?? [])),
	...section("Shape", shapeLines(spec.figures ?? [])),
	...section("Decisions", pointLines(spec.decisions)),
	...section("Consequences", spec.consequences ? [spec.consequences] : []),
	...section("Left out", pointLines(spec.excluded)),
];

const touchLines = (touches: readonly string[]) =>
	list(touches.map((t) => `\`${t}\``));

const acceptanceLines = (acceptance: readonly string[]) =>
	section(
		"Acceptance",
		acceptance.map((a) => `- [ ] ${a}`),
	);

/** `lines` folded under a summary of `heading` and their `count`, left out when there are none. */
const folded = (heading: string, count: string, lines: string[]) =>
	lines.length
		? [
				`<details><summary><b>${heading}</b> · ${count}</summary>`,
				"",
				...lines,
				"",
				"</details>",
				"",
			]
		: [];

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/**
 * A spec as its comment shows it (factory.md, Forge surfaces: Spec comment): what the owner approves open, the rest
 * folded.
 */
const specLines = (spec: Spec) => [
	...contextSection(spec),
	...designSections(spec),
	...acceptanceLines(spec.acceptance),
	...folded("Touches", files(spec.touches.length), touchLines(spec.touches)),
];

/** A spec as a build's request carries it: every section open, word for word. */
const requestedLines = (spec: Spec) => [
	...contextSection(spec),
	...designSections(spec),
	...section("Touches", touchLines(spec.touches)),
	...acceptanceLines(spec.acceptance),
];

/** The spec a re-triage starts from, every section open, under its own heading. */
export const lastSpecLines = (spec: Spec) => [
	"## The spec the last triage proposed",
	"",
	...requestedLines(spec),
];

const childLines = (children: readonly Child[], filed: readonly number[]) =>
	children.map((c, i) => {
		const after = c.dependsOn.length
			? ` (after ${c.dependsOn.map((d) => filed[d] ?? d + 1).join(", ")})`
			: "";
		return `${i + 1}. ${filed[i] ? `#${filed[i]} ` : ""}${c.title}${after}`;
	});

/** `text` as a quoted Mermaid label, its quotes as entities so no text breaks the parse. */
const mermaidLabel = (text: string) =>
	`"${oneLine(text).replaceAll('"', "#quot;")}"`;

/** The order of `children` drawn from each child to those that depend on it, none when no child depends on another. */
function splitGraph(children: readonly Child[]) {
	if (!children.some((c) => c.dependsOn.length)) return [];
	const nodes = children.map(
		(c, i) => `  c${i + 1}[${mermaidLabel(`${i + 1} · ${c.title}`)}]`,
	);
	const edges = children.flatMap((c, i) =>
		c.dependsOn.map((d) => `  c${d + 1} --> c${i + 1}`),
	);
	const graph = ["flowchart LR", ...nodes, ...edges].join("\n");
	return ["", fenced(graph, "mermaid")];
}

/** What a result proposes: a split's children and their order, a duplicate's original, else its spec. */
function proposalLines(result: Triage, filed: readonly number[]) {
	if (result.children)
		return section("Children", [
			...childLines(result.children, filed),
			...splitGraph(result.children),
		]);
	if (result.duplicateOf) return [`Duplicate of #${result.duplicateOf}`, ""];
	return result.spec ? specLines(result.spec) : [];
}

/** The reasons, related issues and last concert of `data`, each it has, on one line. */
function footLines({ result, concert }: Data) {
	const parts = [
		...(result?.reasons.length
			? [`Reasons: ${result.reasons.map(oneLine).join("; ")}`]
			: []),
		...(result?.related?.length ? [`Relates to ${refs(result.related)}`] : []),
		...(concert ? [`Last concert: \`${concert}\``] : []),
	];
	return parts.length ? [parts.join(" · "), ""] : [];
}

function buildLines({ attempts, failure, slice }: Data) {
	return [
		...(attempts ? [`- Attempts: ${attempts} of ${ATTEMPTS}`, ""] : []),
		...section("Last failure", failure ? [fenced(failure)] : []),
		...(slice ? [`Slice concert: \`${slice}\``, ""] : []),
	];
}

/**
 * What the tick runs or queues next in `state`, one it owns, a queued build waiting on the open dependencies `waiting`.
 */
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

/** What waits on the maintainer in `state`, one where the owner moves. */
function waitsOn(state: State, data: Data) {
	if (state === "needs-approval")
		return data.result?.children
			? "the split awaits approval"
			: `${nameOf(data)} awaits approval`;
	if (state === "in-review") return "the PR awaits review";
	if (state === "needs-info") return "the question awaits an answer";
	if (state === "ready-for-human") return "the build by hand awaits";
	return "closing awaits";
}

const isState = (label: string) => STATES.some((s) => s === label);

const LABEL_HOW = "Label the issue with the choice.";

/**
 * How to take one of `moves`: on the forge, else by label, after a reply mentioning `@login` where a move follows one.
 */
const turnHow = (moves: readonly Option[], login: string) =>
	moves.every((m) => isState(m.label))
		? `${LABEL_HOW} Where it follows a reply, first reply \`@${login} …\` with the answer or a redirect.`
		: "Take the choice on the forge.";

/**
 * Whose turn it is in `state`: the owner's moves `data` leaves open as bullets after a rule, closed by how to take
 * one, answered by mentioning `login`; else one bold line of the tick's move, a queued build waiting on the open
 * dependencies `waiting`.
 */
export function turnLines(
	state: State,
	data: Data,
	login: string,
	waiting: readonly number[] = [],
) {
	const moves = TRANSITIONS.filter(
		(t) => t.from === state && t.actor === "owner" && allows(t, data),
	).flatMap((t) => (t.turn ? [t.turn] : []));
	if (!moves.length)
		return [`**Tour manager's turn · ${tourMove(state, data, waiting)}**`, ""];
	return maintainerLines(waitsOn(state, data), moves, turnHow(moves, login));
}

/** The maintainer's turn after a rule: what `waits`, `moves` as bullets, then `how` to take one. */
const maintainerLines = (
	waits: string,
	moves: readonly Option[],
	how: string,
) => [
	RULE,
	"",
	`**Maintainer's turn · ${waits}**`,
	"",
	...moves.map(({ label, text }) =>
		optionLine({ label: `\`${label}\``, text }),
	),
	"",
	...closingLines(how),
	"",
];

/** The version of a spec no routed triage has written yet. */
const FIRST_VERSION = 1;
const versionOf = ({ version }: Data) => version ?? FIRST_VERSION;
/** What the spec comment calls `data`'s spec: a brief for a direct ruling's, which has no requirements. */
const kindOf = ({ result }: Data) =>
	result?.spec && !result.spec.requirements ? "Brief" : "Spec";
/** `data`'s spec by kind and version, as a sentence names it. */
const nameOf = (data: Data) =>
	`${kindOf(data).toLowerCase()} v${versionOf(data)}`;

/** The spec comment's heading: its kind and version, then the risk and any area of its result. */
function headingOf(data: Data) {
	const { result } = data;
	const labels = result
		? [`risk ${result.risk}`, ...(result.area ? [`area ${result.area}`] : [])]
		: [];
	return [`### ${kindOf(data)} v${versionOf(data)}`, ...labels].join(" · ");
}

/**
 * The spec comment for `data` in `state` (factory.md, Forge surfaces: Spec comment): the marker, then readable Markdown
 * ending in whose move it is, answered by mentioning `login`, then the one data line the tick reads back.
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
		...(data.result ? proposalLines(data.result, data.filed ?? []) : []),
		...buildLines(data),
		...footLines(data),
	].map(inert);
	return [
		MARKER,
		"",
		headingOf(data),
		"",
		...shown,
		...turnLines(state, data, login, waiting),
		`<!-- maestro-tm-data ${json} -->`,
		"",
	].join("\n");
}

/** `body` as the ask the owner wrote, then the marker and the closing line linking spec comment `comment`. */
export const tracked = (body: string, comment: number, data: Data) =>
	`${exactAsk(body)}${SEPARATOR}${MARKER}\nTracked by Maestro Tour Manager · [${nameOf(data)}](#issuecomment-${comment})`;

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

/** Option `o` as a bullet: its label in bold, then its text. */
const optionLine = (o: Option) =>
	`- **${oneLine(o.label)}**: ${continued(o.text, "  ")}`;

/** The rule and the `<sub>` line saying `how` to answer, which close a question comment and the maintainer's turn. */
const closingLines = (how: string) => [RULE, "", `<sub>${how}</sub>`];

/** Question `q`, numbered `n`: its ask, then each of its lead, options, recommendation and context it has. */
const questionLines = (q: Question, n: number) => [
	`**Q${n} · ${oneLine(q.ask)}**`,
	"",
	...(q.lead ? [q.lead, ""] : []),
	...(q.options.length ? [...q.options.map(optionLine), ""] : []),
	...(q.recommend ? tipLines(q.recommend) : []),
	...(q.context.length ? contextLines(q.context) : []),
];

/**
 * A question comment (factory.md, Forge surfaces: Question comments): the marker, the heading, `questions` between
 * rules, then `how` to answer. Agent text in it is made inert.
 */
export const questionOf = (questions: readonly Question[], how: string) =>
	[
		QUESTION,
		"",
		...[
			asks(questions.length),
			"",
			...questions.flatMap((q, i) => [RULE, "", ...questionLines(q, i + 1)]),
			...closingLines(how),
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
		...requestedLines(spec),
		"## The ask",
		"",
		askOf(body),
		"",
	].join("\n");

export type Change = { heading: string; body?: string };

/** `request` followed by each of `changes` under its `##` heading (factory.md, Rules, Build: Encore). */
export const encoreRequest = (request: string, changes: readonly Change[]) =>
	[
		request,
		...changes.map(({ heading, body }) =>
			body?.trim() ? `## ${heading}\n\n${body.trim()}\n` : `## ${heading}\n`,
		),
	].join("\n");

/**
 * What a landed slice's PR says: `spend` holds each slice concert of the issue, oldest first, `upheld` the review's
 * upheld findings as a Markdown list, and `pr` the body the slice's writer wrote.
 */
export type Landed = {
	issue: number;
	spend: readonly Spend[];
	tier: Tier;
	risk: Risk;
	upheld?: string;
	gaps: readonly string[];
	result: Triage;
	pr?: string;
};

const THOUSAND = 1_000;
const MILLION = 1_000_000;
const SIGNIFICANT = 3;
const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

const round = (n: number) => `${Number(n.toPrecision(SIGNIFICANT))}`;

/**
 * `n` tokens to three significant digits, as `999`, `1k`, `957k` or `1.37M`: not `compact` of `@maestro/ir`, which
 * rounds otherwise, since the factory imports no workspace packages.
 */
export function shorthand(n: number) {
	if (n < THOUSAND) return `${n}`;
	const thousands = round(n / THOUSAND);
	return Number(thousands) < THOUSAND
		? `${thousands}k`
		: `${round(n / MILLION)}M`;
}

/** `ms` as `45s`, `12m` or `1h5m`, rounded to the second, minute or minute. */
export function elapsed(ms: number) {
	const seconds = Math.round(ms / MS_PER_SECOND);
	if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
	const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
	return minutes < MINUTES_PER_HOUR
		? `${minutes}m`
		: `${Math.floor(minutes / MINUTES_PER_HOUR)}h${minutes % MINUTES_PER_HOUR}m`;
}

const tokenTotal = (s: Spend) =>
	s.input + s.output + s.cacheRead + s.cacheWrite;
const sum = (rows: readonly Spend[], by: (s: Spend) => number) =>
	rows.reduce((total, s) => total + by(s), 0);

const FINDING = /^- /gm;

function evidenceLines({ upheld, tier, result }: Landed) {
	const gate = (result.spec?.acceptance ?? [])
		.map((a) => `\`${oneLine(a)}\``)
		.join(", ");
	const found = upheld?.trim();
	const findings = found ? found.split("\n") : ["- None."];
	return [
		`- Gate: ${gate ? `${gate} ` : ""}green`,
		`- Review: ${tier} review, upheld ${found?.match(FINDING)?.length ?? 0}`,
		...findings.map((f) => `  ${f}`),
	];
}

function gapLines(gaps: readonly string[]) {
	return gaps.length
		? [
				`<details><summary>Gaps (${gaps.length})</summary>`,
				"",
				...list(gaps),
				"",
				"</details>",
				"",
			]
		: [];
}

function dangerLine({ risk, result }: Landed) {
	const area = result.area ? ` · **Area:** ${result.area}` : "";
	const door = result.contract;
	return [
		`**Risk:** ${risk}${area}`,
		...(door ? ["", `**One-way door:** ${oneLine(door)}`] : []),
	];
}

/** The spend table: a row per concert, a build or an encore as its record says, then the total. */
function spendLines(spend: readonly Spend[]) {
	const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
	return [
		row(["Concert", "Time", "Tokens", "In", "Cache r/w", "Out"]),
		row(["-------", "----", "------", "--", "---------", "---"]),
		...spend.map((s) =>
			row([
				`\`${s.short}\` ${s.encore ? "encore" : "build"}`,
				elapsed(s.elapsedMs),
				shorthand(tokenTotal(s)),
				shorthand(s.input),
				`${shorthand(s.cacheRead)} / ${shorthand(s.cacheWrite)}`,
				shorthand(s.output),
			]),
		),
		row([
			"**Total**",
			elapsed(sum(spend, (s) => s.elapsedMs)),
			shorthand(sum(spend, tokenTotal)),
			"",
			"",
			"",
		]),
	];
}

const block = (heading: string, lines: readonly string[]) => [
	`## ${heading}`,
	"",
	...lines,
	"",
];

const closing = ({ issue, result }: Landed) =>
	`Closes #${issue}${result.related?.length ? ` · relates to ${refs(result.related)}` : ""}`;

/**
 * The writer's `pr`, then the gaps folded, one line of risk, area and review tier with the planner's contract as the
 * one-way door, the spend folded under its total, and the closing line last.
 */
function writtenBody(landed: Landed, pr: string) {
	const { spend, gaps, tier } = landed;
	const [risk, ...door] = dangerLine(landed);
	const riskLines = [`${risk} · **Review:** ${tier}`, ...door];
	const total = `${elapsed(sum(spend, (s) => s.elapsedMs))}, ${shorthand(sum(spend, tokenTotal))} tokens`;
	return [
		pr,
		"",
		...gapLines(gaps),
		...riskLines,
		"",
		`<details><summary>Spend: ${total}</summary>`,
		"",
		...spendLines(spend),
		"",
		"</details>",
		"",
		closing(landed),
	].join("\n");
}

/**
 * The PR body of a landed slice (factory.md, Rules, Landing and PRs: PRs): the writer's followed by the tick's
 * sections, else one built from the tick's data alone, with the subject and each decision's lead as Summary, the
 * acceptance commands as the gate with the review's upheld findings as Evidence, then the gaps, risk and spend.
 */
export function pullBody(landed: Landed) {
	if (landed.pr) return writtenBody(landed, landed.pr);
	const { spend, gaps, result } = landed;
	const decisions = list(
		(result.spec?.decisions ?? []).map((d) => oneLine(d.lead)),
	);
	return [
		closing(landed),
		"",
		...block("Summary", [
			result.spec?.subject ?? "",
			...(decisions.length ? ["", ...decisions] : []),
		]),
		...block("Evidence", evidenceLines(landed)),
		...gapLines(gaps),
		...block("Merge Danger", dangerLine(landed)),
		...block("Spend", spendLines(spend)),
	].join("\n");
}

const FINGERPRINT_HEX = 12;
const TITLE_MAX = 80;

/**
 * The line that marks a filed report: the first 12 hex of SHA-256 over its text lower-cased, whitespace runs folded to
 * one space and trimmed.
 */
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

/** A change a masterclass proposes to the factory's standing text or code, with the lessons it merges. */
export type Proposal = {
	target: string;
	title: string;
	body: string;
	lessons: string[];
};
export type Masterclass = { proposals: Proposal[] };

const isProposals = (v: unknown): v is Proposal[] =>
	Array.isArray(v) &&
	v.every(
		(p) =>
			isJson(p) &&
			isString(p.target) &&
			isString(p.title) &&
			isString(p.body) &&
			isStrings(p.lessons),
	);

/**
 * `value` as a masterclass output.
 * @throws Error naming the field that is missing or malformed.
 */
export function parseMasterclass(value: unknown): Masterclass {
	if (!isJson(value))
		throw new Error("the masterclass output is not an object");
	return {
		proposals: field(value, "proposals", isProposals, "a list of proposals"),
	};
}

/** The line that marks a filed proposal, over its target, title and body. */
export const proposalLine = (p: Proposal) =>
	fingerprintLine(`${p.target}\n${p.title}\n${p.body}`);

const PROPOSAL_MOVES: readonly Option[] = [
	{ label: "needs-triage", text: "specify and build it." },
	{ label: "wontfix", text: "drop it." },
];

/**
 * The title and body of the issue proposal `p` is filed as: the ask, its agent text made inert and its fingerprint
 * last, then the marker and the maintainer's turn.
 */
export function proposalIssue(p: Proposal) {
	const ask = [
		`Target: \`${p.target}\``,
		"",
		p.body.trim(),
		"",
		"## Lessons",
		"",
		...p.lessons.map((l) => `- ${l}`),
	].map(inert);
	const turn = maintainerLines(
		"the proposal awaits approval",
		PROPOSAL_MOVES,
		LABEL_HOW,
	);
	return {
		title: inert(p.title),
		body: [[...ask, "", proposalLine(p)].join("\n"), MARKER, turn.join("\n")]
			.join(SEPARATOR)
			.trimEnd(),
	};
}
