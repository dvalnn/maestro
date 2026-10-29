import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ArtifactRef,
	type CodeContext,
	reject,
	type Settled,
	type Type,
	type ValueOf,
} from "@maestro/sdk";
import {
	type Acceptance,
	type DesignValue,
	Evidence,
	Findings,
	type Risk,
	type Verdict,
	Verdicts,
} from "./types";

type RiskValue = ValueOf<typeof Risk>;

/** The absolute path of `name` in the instance's scratch directory, written with `lines`. */
function written(ctx: CodeContext, name: string, lines: string[]): string {
	const file = join(ctx.scratch, name);
	writeFileSync(file, lines.join("\n"));
	return file;
}

/** `text` as a Markdown file. */
export function toMarkdown(
	{ text }: { text: string },
	ctx: CodeContext,
): { file: string } {
	return { file: written(ctx, "request.md", [text, ""]) };
}

/** What one member of a review panel delivers: its lens's findings and its skeptic's verdicts. */
type Round = {
	lens: { findings: ArtifactRef };
	skeptic: { verdicts: ArtifactRef };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` has the shape of `schema`, a schema the SDK's `Struct`, `List`, `Text` and `Bool` write. */
function fits(schema: unknown, value: unknown): boolean {
	if (!isRecord(schema)) return true;
	const { type, properties, items } = schema;
	if (type === "object")
		return (
			isRecord(value) &&
			isRecord(properties) &&
			Object.entries(properties).every(([field, s]) => fits(s, value[field]))
		);
	if (type === "array")
		return Array.isArray(value) && value.every((item) => fits(items, item));
	return typeof value === type;
}

const conforms = <T>(type: Type<T>, value: unknown): value is T =>
	fits(type.schema, value);

/**
 * The JSON file `ref`, as `type`.
 * @throws Error naming the file when it does not fit `type`.
 */
function readOutput<T>(ctx: CodeContext, ref: ArtifactRef, type: Type<T>): T {
	const value: unknown = JSON.parse(readFileSync(ctx.path(ref), "utf8"));
	if (!conforms(type, value))
		throw new Error(`${ref.path} does not fit its declared schema`);
	return value;
}

/** The title of an item's section: a lens name, or a risk by its id. */
const titleOf = (item: string | RiskValue) =>
	typeof item === "string" ? item : `${item.id}: ${item.risk}`;

/** The lines of `item`'s section: none for a clean lens or none upheld, a note for a member that did not settle `ok`. */
function sectionOf(
	item: string,
	round: Settled<Round>,
	ctx: CodeContext,
): string[] {
	if (round.outcome === "skipped") return [];
	if (round.outcome !== "ok")
		return [`## ${item}`, "", `unverified: ${round.reason}`, ""];
	const { findings } = readOutput(ctx, round.value.lens.findings, Findings);
	const verdicts = readOutput(ctx, round.value.skeptic.verdicts, Verdicts);
	const upheld = findings.flatMap((f) => {
		const verdict = verdicts.find((v) => v.id === f.id && v.holds);
		return verdict ? [{ ...f, why: verdict.why }] : [];
	});
	if (!upheld.length) return [];
	return [
		`## ${item}`,
		"",
		...upheld.map(
			(f) =>
				`- ${f.id}, ${f.where} (${f.blocking ? "blocking" : "advisory"}): ${f.issue}\n  Upheld: ${f.why}`,
		),
		"",
	];
}

/**
 * The findings each skeptic upheld, as Markdown, one section per item of `items` in the order of `rounds`. A member
 * whose lens was clean has none.
 */
export function survivorsOf(
	{
		rounds,
		items,
	}: { rounds: Settled<Round>[]; items: readonly (string | RiskValue)[] },
	ctx: CodeContext,
): { survivors: string } {
	const sections = rounds.flatMap((round, i) => {
		const item = items[i];
		return sectionOf(item ? titleOf(item) : `item ${i + 1}`, round, ctx);
	});
	return {
		survivors: written(ctx, "survivors.md", [
			"# Findings the skeptics upheld",
			"",
			...(sections.length ? sections : ["None.", ""]),
		]),
	};
}

type Scouted = { evidence: ArtifactRef };

type Raised = ValueOf<typeof Evidence>["risks"][number];

/** A risk's text with case, spacing and closing punctuation set aside, so restatements of one risk match. */
const normalized = (risk: string) =>
	risk
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[.!;\s]+$/, "")
		.trim();

/** Each distinct risk of `raised`, one list per scout, most scouts first, then in the order first raised. */
function ranked(raised: Raised[][]): Raised[] {
	const seen = new Map<string, { risk: Raised; scouts: number }>();
	for (const risks of raised) {
		const own = new Set<string>();
		for (const risk of risks) {
			const key = normalized(risk.risk);
			if (own.has(key)) continue;
			own.add(key);
			const entry = seen.get(key);
			if (entry) entry.scouts++;
			else seen.set(key, { risk, scouts: 1 });
		}
	}
	return [...seen.values()]
		.sort((a, b) => b.scouts - a.scouts)
		.map((e) => e.risk);
}

/** The notes of `found`'s facts, merged by where they point, in the order first seen. */
function factsOf(found: ValueOf<typeof Evidence>[]): string[] {
	const notes = new Map<string, Set<string>>();
	for (const { where, note } of found.flatMap((e) => e.facts))
		notes.set(where, (notes.get(where) ?? new Set()).add(note));
	return [...notes].map(([where, n]) => `- ${where}: ${[...n].join("; ")}`);
}

/** Why no scout delivered, each scout by its angle, and the fix. */
function undelivered(
	scouts: Settled<Scouted>[],
	angles: readonly string[],
): string {
	const reasons = scouts.map(
		(s, i) =>
			`${angles[i] ?? `scout ${i + 1}`}: ${("reason" in s && s.reason) || s.outcome}`,
	);
	const listed = reasons.length ? `: ${reasons.join("; ")}` : "";
	return `no scout delivered evidence${listed}. Check the runtime of profile 'classics/scout'`;
}

/**
 * The evidence of the scouts that settled `ok` as a dossier, and the risks they raised, numbered `R1` on, most raised
 * first, at most `maxRisks`. `angles` names each scout, in order. Rejects with no outputs when no scout settled `ok`.
 */
export function dossierOf(
	{
		scouts,
		angles,
		maxRisks,
	}: {
		scouts: Settled<Scouted>[];
		angles: readonly string[];
		maxRisks: number;
	},
	ctx: CodeContext,
) {
	const found = scouts.flatMap((s) =>
		s.outcome === "ok" ? [readOutput(ctx, s.value.evidence, Evidence)] : [],
	);
	if (!found.length) return reject(undelivered(scouts, angles));
	const risks = ranked(found.map((e) => e.risks)).map((r, i) => ({
		...r,
		id: `R${i + 1}`,
	}));
	const dossier = written(ctx, "dossier.md", [
		"# Dossier",
		"",
		"## Summaries",
		"",
		...found.map((e) => `- ${e.summary}`),
		"",
		"## Facts",
		"",
		...factsOf(found),
		"",
		"## Risks",
		"",
		...risks.map((r) => `- ${r.id}, ${r.where}: ${r.risk}`),
		"",
	]);
	return {
		dossier,
		risks: risks.slice(0, maxRisks).map(({ id, risk }) => ({ id, risk })),
	};
}

type Ruling = ValueOf<typeof Acceptance>[number];

/** One criterion of the design, with its rulings in review and in acceptance. */
type Row = {
	criterion: DesignValue["criteria"][number];
	review: Ruling[];
	accepted: Ruling[];
};

/** `text` fit for a Markdown table cell. */
const cell = (text: string) =>
	text.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ");

const rulingsCell = (rulings: Ruling[]) =>
	rulings
		.map((r) => cell(`${r.met ? "met" : "unmet"}: ${r.evidence}`))
		.join("; ") || "missing";

/** What keeps criterion `id` from tracing in `by`: no ruling, more than one, or an unmet one. */
function gapsIn(id: string, rulings: Ruling[], by: string): string[] {
	if (!rulings.length) return [`${id} has no ${by} ruling`];
	if (rulings.length > 1) return [`${id} has ${rulings.length} ${by} rulings`];
	return rulings.some((r) => !r.met) ? [`${id} is unmet in ${by}`] : [];
}

const gapsOf = ({ criterion: { id }, review, accepted }: Row) => [
	...gapsIn(id, review, "review"),
	...gapsIn(id, accepted, "acceptance"),
];

/**
 * The requirements traceability matrix: one row per criterion of `design`, with its proof, its review ruling and its
 * acceptance ruling. Rejects with the matrix when the design has no criteria, the review did not approve, or a
 * criterion has a missing, repeated or unmet ruling, naming each.
 */
export function traceOf(
	{
		design,
		verdict,
		acceptance,
	}: {
		design: DesignValue;
		verdict: ValueOf<typeof Verdict>;
		acceptance: ValueOf<typeof Acceptance>;
	},
	ctx: CodeContext,
) {
	const rows: Row[] = design.criteria.map((criterion) => ({
		criterion,
		review: verdict.criteria.filter((r) => r.id === criterion.id),
		accepted: acceptance.filter((a) => a.id === criterion.id),
	}));
	const gaps = [
		...(rows.length ? [] : ["the plan names no criteria"]),
		...(verdict.approved ? [] : ["the review did not approve"]),
		...rows.flatMap(gapsOf),
	];
	const trace = written(ctx, "trace.md", [
		"# Traceability",
		"",
		"| Criterion | Proof | Review | Acceptance |",
		"| --- | --- | --- | --- |",
		...rows.map(
			({ criterion: c, review, accepted }) =>
				`| ${cell(`${c.id}: ${c.criterion}`)} | ${cell(c.proof)} | ${rulingsCell(review)} | ${rulingsCell(accepted)} |`,
		),
		"",
	]);
	return gaps.length
		? reject(
				`trace gaps: ${gaps.join("; ")} (trace.md has the matrix). Have the planner name criteria, and the review and the documenter each rule once on every one`,
				{ trace },
			)
		: { trace };
}

export const riskKey = ({ id }: RiskValue) => id;
