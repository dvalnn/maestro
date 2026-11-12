import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "@maestro/host-repo-sdk";
import { yamlOf } from "@maestro/host-repo-sdk/yaml";
import {
	type ArtifactRef,
	type CodeContext,
	type CodeOutputs,
	type Rejection,
	reject,
	type Settled,
	type ValueOf,
} from "@maestro/sdk";
import type {
	Brief,
	Findings,
	Overrules,
	Tally as Ports,
	Rulings,
	TestMap,
	Upheld,
	Verdict,
} from "./types";

/** `text` as a Markdown file. */
export function toMarkdown(
	{ text }: { text: string },
	ctx: CodeContext,
): { file: string } {
	const file = join(ctx.scratch, "request.md");
	writeFileSync(file, `${text}\n`);
	return { file };
}

/** The request as a Markdown file, then `## map` and `## overrules` as YAML for each one given. */
export function specOf(
	{
		request,
		map,
		overrules,
	}: {
		request: string;
		map?: ValueOf<typeof TestMap>;
		overrules?: ValueOf<typeof Overrules>;
	},
	ctx: CodeContext,
): { file: string } {
	const sections = Object.entries({ map, overrules }).flatMap(([name, v]) =>
		v === undefined
			? []
			: [`## ${name}\n\n\`\`\`yaml\n${yamlOf(v).trimEnd()}\n\`\`\``],
	);
	const file = join(ctx.scratch, "spec.md");
	writeFileSync(file, `${[request, ...sections].join("\n\n")}\n`);
	return { file };
}

/** The builder's report as the brief its review seats read: its summary and gaps, `[]` when it left none. */
export function briefOf({ report }: { report: Report }): {
	brief: ValueOf<typeof Brief>;
} {
	return { brief: { summary: report.summary, gaps: report.gaps ?? [] } };
}

type Found = ValueOf<typeof Findings>;
type Held = ValueOf<typeof Upheld>;

/** What one member of a review panel delivers: its lens's findings, with its skeptic's rulings when it has a skeptic. */
type Member =
	| {
			lens: { findings: Found };
			skeptic: { rulings: ValueOf<typeof Rulings> };
	  }
	| { findings: Found };

/** The findings of `member`, each held by `lens` with its skeptic's why, or every one without a why when no skeptic ruled. */
function heldBy(lens: string, member: Member, ok: boolean): Held[] {
	if (!("lens" in member))
		return ok ? [] : member.findings.map((f) => ({ ...f, lens }));
	return member.lens.findings.flatMap((f) => {
		const ruling = member.skeptic.rulings.find((r) => r.id === f.id && r.holds);
		return ruling ? [{ ...f, lens, why: ruling.why }] : [];
	});
}

/**
 * The findings the review members held, and the lenses that never delivered theirs.
 * - `names` are the members' lens names, in the order of `results`.
 * - A member with a skeptic holds the findings its skeptic's rulings hold, each with that `why`; one without holds every
 *   finding, with no `why`, unless its lens settled ok.
 * - A skipped member, whose lens settled ok, holds none.
 * - One that delivered nothing, a failed skeptic included, is `unreviewed` with its reason: its whole lens is.
 */
export function heldOf({
	results,
	names,
}: {
	results: Settled<Member>[];
	names: readonly string[];
}): {
	held: Held[];
	unreviewed: { lens: string; reason: string }[];
} {
	const held: Held[] = [];
	const unreviewed: { lens: string; reason: string }[] = [];
	results.forEach((result, i) => {
		const lens = names[i] ?? `item ${i + 1}`;
		if (result.outcome === "skipped") return;
		if (result.value !== undefined)
			held.push(...heldBy(lens, result.value, result.outcome === "ok"));
		else
			unreviewed.push({
				lens,
				reason: ("reason" in result && result.reason) || result.outcome,
			});
	});
	return { held, unreviewed };
}

type Result = { changeset: ArtifactRef; upheld: Held[] };

type Tally = CodeOutputs<typeof Ports> & {
	review?: string;
	brief?: ValueOf<typeof Brief>;
};
type Args = {
	lane: string;
	session: string;
	held: Held[];
	verdict?: ValueOf<typeof Verdict>;
	brief?: ValueOf<typeof Brief>;
};

/** Rejects naming `upheld`, with `outputs` as the rejection's outputs. */
const rejection = <O>(upheld: Held[], outputs: O): Required<Rejection<O>> => ({
	...reject(
		`${upheld.length} upheld: ${upheld.map((f) => `${f.lens}/${f.id}`).join(", ")}`,
		outputs,
	),
	outputs,
});

/** The consolidator's name on the criteria it rules not met, held beside the lenses' findings. */
const CONSOLIDATOR = "consolidator";

/** Each criterion of `verdict` ruled not met, as a finding of the consolidator citing the spec. */
const unmetOf = (verdict: ValueOf<typeof Verdict>): Held[] =>
	verdict.criteria
		.filter((c) => !c.met)
		.map((c) => ({
			lens: CONSOLIDATOR,
			id: c.id,
			where: `spec ${c.id}`,
			issue: c.evidence,
			cites: `spec ${c.id}`,
		}));

/** Each of `upheld` as a list item: its issue at its `where`, then its cites and why. */
const upheldItems = (upheld: Held[]): string[] =>
	upheld.map(
		(f) =>
			`- **${f.lens}/${f.id}** at \`${f.where}\`: ${f.issue}\n  Cites: ${f.cites}${f.why ? ` Why: ${f.why}` : ""}`,
	);

/** The review of `verdict` as Markdown: the `upheld` findings, then the criteria it rules met. Empty sections are left out. */
function reviewOf(
	upheld: Held[],
	verdict: ValueOf<typeof Verdict>,
	ctx: CodeContext,
): string {
	const met = verdict.criteria
		.filter((c) => c.met)
		.map((c) => `- **${c.id}**: ${c.evidence}`);
	const sections = (
		[
			["Upheld", upheldItems(upheld)],
			["Met", met],
		] as const
	).flatMap(([title, items]) =>
		items.length ? [`## ${title}\n\n${items.join("\n")}`] : [],
	);
	const file = join(ctx.scratch, "review.md");
	writeFileSync(file, `${sections.join("\n\n")}\n`);
	return file;
}

/**
 * The review round's tally: the lane and session it carries, and the findings upheld.
 * - Without a `verdict`, every held finding.
 * - With one, those held findings whose `<lens>/<id>` its `upholds` names, then each criterion it rules not met, and a
 *   `review` rendered from it.
 *
 * The `brief` given rides beside them. Rejects, with the tally as its outputs, while a finding is upheld.
 */
export function tallyOf(
	{ lane, session, held, verdict, brief }: Args,
	ctx: CodeContext,
): Tally | Required<Rejection<Tally>> {
	const upheld = verdict
		? [
				...held.filter((f) => verdict.upholds.includes(`${f.lens}/${f.id}`)),
				...unmetOf(verdict),
			]
		: held;
	const tally = {
		lane,
		session,
		upheld,
		...(verdict && { review: reviewOf(upheld, verdict, ctx) }),
		...(brief && { brief }),
	};
	if (upheld.length) return rejection(upheld, tally);
	return tally;
}

/**
 * The change's patch series and the findings still upheld on it.
 * Rejects, with both as outputs, while a finding is upheld.
 */
export function resultOf({
	changeset,
	upheld,
}: {
	changeset: ArtifactRef;
	upheld: Held[];
}): { changeset: ArtifactRef; upheld: Held[] } | Required<Rejection<Result>> {
	const result = { changeset, upheld };
	return upheld.length ? rejection(upheld, result) : result;
}
