import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "@maestro/host-repo-sdk";
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
	Tally as Ports,
	Rulings,
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
function heldBy(lens: string, member: Member): Held[] {
	if (!("lens" in member)) return member.findings.map((f) => ({ ...f, lens }));
	return member.lens.findings.flatMap((f) => {
		const ruling = member.skeptic.rulings.find((r) => r.id === f.id && r.holds);
		return ruling ? [{ ...f, lens, why: ruling.why }] : [];
	});
}

/**
 * The findings the review members held, and the lenses that never delivered theirs.
 * - `names` are the members' lens names, in the order of `results`.
 * - A member with a skeptic holds the findings its skeptic's rulings hold, each with that `why`; one without holds every
 *   finding, with no `why`.
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
		if (result.value !== undefined) held.push(...heldBy(lens, result.value));
		else
			unreviewed.push({
				lens,
				reason: ("reason" in result && result.reason) || result.outcome,
			});
	});
	return { held, unreviewed };
}

type Tally = CodeOutputs<typeof Ports>;

const rejection = (
	reason: string,
	tally: Tally,
): Required<Rejection<Tally>> => ({
	...reject(reason, tally),
	outputs: tally,
});

/**
 * The review round's tally: the lane and session it carries, and the findings upheld.
 * - Without a `verdict`, those held findings that block.
 * - With one, those held findings whose `<lens>/<id>` its `upholds` names.
 *
 * The `review` given rides beside them. Rejects, with the tally as its outputs, while a finding is upheld.
 * @throws Error with the consolidator's reason when it failed.
 */
export function tallyOf({
	lane,
	session,
	held,
	verdict,
	review,
}: {
	lane: string;
	session: string;
	held: Held[];
	verdict?: Settled<ValueOf<typeof Verdict>>[];
	review?: ArtifactRef;
}): Tally | Required<Rejection<Tally>> {
	const [ruled] = verdict ?? [];
	if (ruled?.outcome === "failed") throw new Error(ruled.reason);
	const upholds = ruled?.value?.upholds;
	const upheld = verdict
		? held.filter((f) => upholds?.includes(`${f.lens}/${f.id}`))
		: held.filter((f) => f.blocking);
	const tally = { lane, session, upheld, ...(review && { review }) };
	if (upheld.length)
		return rejection(
			`${upheld.length} upheld: ${upheld.map((f) => `${f.lens}/${f.id}`).join(", ")}`,
			tally,
		);
	return tally;
}
