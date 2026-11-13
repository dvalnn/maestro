import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import {
	type Brief,
	type Findings,
	type Overrules,
	type Tally as Ports,
	type Rulings,
	SEAT_TIERS,
	SEATS,
	type SeatKey,
	type TestMap,
	TIERS,
	type Tier,
	type Upheld,
	type Verdict,
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

/** The members of `results` that delivered a value: a skipped member and one that delivered nothing do not count. */
const deliveredOf = (results: Settled<Member>[]): number =>
	results.filter((r) => r.outcome !== "skipped" && r.value !== undefined)
		.length;

/**
 * The findings the members of every seat held, the lenses that never delivered theirs, and `delivered`, the count of
 * members that delivered a value. Each seat's members are `<seat>Results` and their lens names `<seat>Names`, joined
 * in seat order as `heldOf` reads them.
 */
export function heldAcross(
	inputs: Record<string, Settled<Member>[] | string[]>,
): {
	held: Held[];
	unreviewed: { lens: string; reason: string }[];
	delivered: number;
} {
	const seats = SEATS.map((seat) => {
		const results = inputs[`${seat}Results`] as Settled<Member>[];
		return {
			...heldOf({ results, names: inputs[`${seat}Names`] as string[] }),
			delivered: deliveredOf(results),
		};
	});
	return {
		held: seats.flatMap((s) => s.held),
		unreviewed: seats.flatMap((s) => s.unreviewed),
		delivered: seats.reduce((sum, s) => sum + s.delivered, 0),
	};
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
	delivered?: number;
};

/** Rejects with `reason`, naming `upheld` by default, and `outputs` as the rejection's outputs. */
const rejection = <O>(
	upheld: Held[],
	outputs: O,
	reason = `${upheld.length} upheld: ${upheld.map((f) => `${f.lens}/${f.id}`).join(", ")}`,
): Required<Rejection<O>> => ({ ...reject(reason, outputs), outputs });

/** The reason a review rejects when no lens delivered one. */
const NO_REVIEW = "no lens delivered a review";

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
			`- **${f.lens}/${f.id}** at \`${f.where}\`: ${f.issue}\n  - Cites: ${f.cites}${f.why ? `\n  - Why: ${f.why}` : ""}`,
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
 * The `brief` given rides beside them. Rejects, with the tally as its outputs, while a finding is upheld, and, whatever
 * the verdict, when `delivered` is 0.
 */
export function tallyOf(
	{ lane, session, held, verdict, brief, delivered }: Args,
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
	if (delivered === 0) return rejection(upheld, tally, NO_REVIEW);
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

const PATCH_EXT = ".patch";
const MAIL_START = /^From [0-9a-f]{40} .*$/gm;
const MESSAGE_END = "\n---\n";
const SIGNATURE = /\n-- \n[^\n]*\n*$/;
const DIFF_START = /^diff --git /m;
const HUNK_START = /^@@.*$/m;
const PLAIN_PATH = /^(?:\+\+\+ b\/|--- a\/|rename to )(.+)$/;
const QUOTED_PATH = /^(?:\+\+\+ "b\/|--- "a\/|rename to ")(.+)"$/;
const ESCAPES: Record<string, number> = {
	a: 7,
	b: 8,
	t: 9,
	n: 10,
	v: 11,
	f: 12,
	r: 13,
};
const OCTAL_LENGTH = 4;

/** Git's C-style quoting of a path undone: the escapes `\ooo`, `\\`, `\"`, `\t` and the like. */
function unquote(quoted: string): string {
	const bytes = quoted.split(/(\\\d{3}|\\.)/).flatMap((part) => {
		if (!part.startsWith("\\")) return [...Buffer.from(part)];
		if (part.length === OCTAL_LENGTH)
			return [Number.parseInt(part.slice(1), 8)];
		return [ESCAPES[part[1] as string] ?? part.charCodeAt(1)];
	});
	return Buffer.from(bytes).toString("utf8");
}

/** The path a `+++ b/`, `--- a/` or `rename to` header line names, unquoted; undefined for any other line. */
function pathOf(line: string): string | undefined {
	const quoted = QUOTED_PATH.exec(line)?.[1];
	return quoted === undefined ? PLAIN_PATH.exec(line)?.[1] : unquote(quoted);
}

/** The path one file's diff names and the lines its hunks add or remove; undefined for a file with no hunk. */
function countFile(file: string): [string, number] | undefined {
	const [header = "", ...hunks] = file.split(HUNK_START);
	const path = header
		.split("\n")
		.reduce<string | undefined>(
			(found, line) => pathOf(line) ?? found,
			undefined,
		);
	if (path === undefined || hunks.length === 0) return undefined;
	const changed = hunks
		.join("\n")
		.split("\n")
		.filter((line) => /^[+-]/.test(line));
	return [path, changed.length];
}

/** Adds to `lines`, by path, the lines the diffs of `patch` add or remove inside a hunk; a commit message and git's signature count none. */
function countPatch(patch: string, lines: Map<string, number>) {
	for (const mail of patch.split(MAIL_START)) {
		const end = mail.indexOf(MESSAGE_END);
		if (end < 0) continue;
		const diffs = mail.slice(end).replace(SIGNATURE, "");
		for (const file of diffs.split(DIFF_START).slice(1)) {
			const counted = countFile(file);
			if (counted)
				lines.set(counted[0], (lines.get(counted[0]) ?? 0) + counted[1]);
		}
	}
}

const matchesAny = (globs: readonly string[], path: string) =>
	globs.some((g) => new Bun.Glob(g).match(path));

type Section = {
	/** The paths that pull the section in; none, it is always in. */
	globs?: string[];
	text: string;
};

/**
 * A tiered review's tier, checklist and seats, from its changeset.
 * - `lines` is the added plus removed lines inside the hunks of the `*.patch` files, over paths matching no `ignore` glob.
 * - `tier` is the first of small, medium and large whose threshold `lines` does not pass, else xlarge, raised to
 *   `floor`.
 * - `sections` are the names of each section, in the order given, that has no `globs` or whose globs match a counted
 *   path; `checklist` is `lead`, each one's text under `### <name>`, then `close`.
 * - Each seat's output is a one-item list of its seat name when the tier is one it rules in, else empty.
 */
export function tieredOf(
	{
		changeset,
		ignore,
		small,
		medium,
		large,
		floor,
		sections,
		lead,
		close,
	}: {
		changeset: ArtifactRef;
		ignore: string[];
		small: number;
		medium: number;
		large: number;
		floor?: Tier;
		sections: Record<string, Section>;
		lead: string;
		close: string;
	},
	ctx: CodeContext,
) {
	const patches = new Map<string, number>();
	const dir = ctx.path(changeset);
	for (const name of readdirSync(dir).sort())
		if (name.endsWith(PATCH_EXT))
			countPatch(readFileSync(join(dir, name), "utf8"), patches);
	const counted = [...patches].filter(([path]) => !matchesAny(ignore, path));
	const lines = counted.reduce((sum, [, n]) => sum + n, 0);
	const limits = { small, medium, large, xlarge: Number.POSITIVE_INFINITY };
	const tier =
		TIERS.slice(floor ? TIERS.indexOf(floor) : 0).find(
			(t) => lines <= limits[t],
		) ?? "xlarge";
	const picked = Object.entries(sections).filter(
		([, { globs }]) =>
			!globs || counted.some(([path]) => matchesAny(globs, path)),
	);
	const names = picked.map(([name]) => name);
	const checklist = [
		lead,
		...picked.map(([name, { text }]) => `### ${name}\n\n${text}`),
		close,
	].join("\n\n");
	const seats = Object.fromEntries(
		SEATS.map((seat) => [
			seat,
			(SEAT_TIERS[seat].tiers as readonly Tier[]).includes(tier)
				? [SEAT_TIERS[seat].name]
				: [],
		]),
	) as Record<SeatKey, string[]>;
	ctx.log(`${lines} changed lines, tier ${tier}, sections ${names.join(", ")}`);
	return { lines, tier, sections: names, checklist, ...seats };
}
