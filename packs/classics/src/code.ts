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
import { task } from "./prompt";
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
 * Refuses a member named outside `known`, when given.
 * @throws Error naming the first such name and the known ones.
 */
function requireKnown(names: readonly string[], known?: readonly string[]) {
	const unknown = known && names.find((name) => !known.includes(name));
	if (unknown !== undefined)
		throw new Error(
			`no lens named '${unknown}'\nName one of ${known?.join(", ")}`,
		);
}

/**
 * The findings the review members held, the lenses that never delivered theirs, and `delivered`, the count of members
 * that delivered a value.
 * - `names` are the members' lens names, in the order of `results`.
 * - A member with a skeptic holds the findings its skeptic's rulings hold, each with that `why`; one without holds every
 *   finding, with no `why`, unless its lens settled ok.
 * - A skipped member holds none and counts as delivered. `patches` and `spec` are unread inputs, there so the node does
 *   not run when either is unavailable.
 * - One that delivered nothing, a failed skeptic included, is `unreviewed` with its reason: its whole lens is.
 * @throws Error when a member is named outside `known`, when given.
 */
export function heldOf({
	results,
	names,
	known,
}: {
	results: Settled<Member>[];
	names: readonly string[];
	known?: readonly string[];
	patches?: ArtifactRef;
	spec?: ArtifactRef;
}): {
	held: Held[];
	unreviewed: { lens: string; reason: string }[];
	delivered: number;
} {
	const held: Held[] = [];
	const unreviewed: { lens: string; reason: string }[] = [];
	let delivered = 0;
	requireKnown(names, known);
	results.forEach((result, i) => {
		const lens = names[i] ?? `item ${i + 1}`;
		if (result.outcome === "skipped") {
			delivered++;
			return;
		}
		if (result.value !== undefined) {
			delivered++;
			held.push(...heldBy(lens, result.value, result.outcome === "ok"));
		} else
			unreviewed.push({
				lens,
				reason: ("reason" in result && result.reason) || result.outcome,
			});
	});
	return { held, unreviewed, delivered };
}

/**
 * `heldOf` over the members of every seat, joined in seat order, `delivered` summed. Each seat's members are
 * `<seat>Results` and their lens names `<seat>Names`.
 */
export function heldAcross(
	inputs: Record<string, Settled<Member>[] | string[]>,
): ReturnType<typeof heldOf> {
	const seats = SEATS.map((seat) =>
		heldOf({
			results: inputs[`${seat}Results`] as Settled<Member>[],
			names: inputs[`${seat}Names`] as string[],
		}),
	);
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
	delivered?: number;
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

type Criterion = ValueOf<typeof Verdict>["criteria"][number];

/** The `<lens>/<id>` of `finding`. */
const keyOf = (finding: Held) => `${finding.lens}/${finding.id}`;

/** Whether `criterion` names, as showing it, a finding of `kept`, the keys of the held findings upheld. */
const isShown = (criterion: Criterion, kept: ReadonlySet<string>) =>
	criterion.shownBy.some((id) => kept.has(id));

/** Each criterion of `verdict` ruled not met and shown by no upheld finding, as a finding of the consolidator citing the spec. */
const unmetOf = (
	verdict: ValueOf<typeof Verdict>,
	kept: ReadonlySet<string>,
): Held[] =>
	verdict.criteria
		.filter((c) => !c.met && !isShown(c, kept))
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

/** The review of `verdict` as Markdown: the `upheld` findings, the criteria an upheld finding shows, then those it rules met. Empty sections are left out. */
function reviewOf(
	upheld: Held[],
	verdict: ValueOf<typeof Verdict>,
	kept: ReadonlySet<string>,
	ctx: CodeContext,
): string {
	const met = verdict.criteria
		.filter((c) => c.met)
		.map((c) => `- **${c.id}**: ${c.evidence}`);
	const shown = verdict.criteria
		.filter((c) => !c.met && isShown(c, kept))
		.map(
			(c) => `- **${c.id}**: ${c.evidence} (shown by ${c.shownBy.join(", ")})`,
		);
	const sections = (
		[
			["Upheld", upheldItems(upheld)],
			["Not met", shown],
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
 * - With one, those held findings whose `<lens>/<id>` its `upholds` names, then each criterion it rules not met that no
 *   upheld finding it names in `shownBy` shows, and a `review` rendered from it.
 *
 * The `brief` and `delivered` given ride beside them. Rejects, with the tally as its outputs, while a finding is
 * upheld, and, whatever the verdict, when `delivered` is 0.
 */
export function tallyOf(
	{ lane, session, held, verdict, brief, delivered }: Args,
	ctx: CodeContext,
): Tally | Required<Rejection<Tally>> {
	const stands = verdict
		? held.filter((f) => verdict.upholds.includes(keyOf(f)))
		: held;
	const kept = new Set(stands.map(keyOf));
	const upheld = verdict ? [...stands, ...unmetOf(verdict, kept)] : held;
	const tally = {
		lane,
		session,
		upheld,
		...(verdict && { review: reviewOf(upheld, verdict, kept, ctx) }),
		...(brief && { brief }),
		...(delivered !== undefined && { delivered }),
	};
	if (delivered === 0) return rejection(upheld, tally, NO_REVIEW);
	if (upheld.length) return rejection(upheld, tally);
	return tally;
}

/**
 * The change's patch series and the findings still upheld on it.
 * Rejects, with both as outputs, while a finding is upheld, and when the last review's `delivered`, if given, is 0.
 */
export function resultOf({
	changeset,
	upheld,
	delivered,
}: {
	changeset: ArtifactRef;
	upheld: Held[];
	delivered?: number;
}): Result | Required<Rejection<Result>> {
	const result = { changeset, upheld };
	if (delivered === 0) return rejection(upheld, result, NO_REVIEW);
	return upheld.length ? rejection(upheld, result) : result;
}

const PATCH_EXT = ".patch";
const MAIL_START = /^From [0-9a-f]{40} .*$/gm;
const MESSAGE_END = "\n---\n";
const SIGNATURE = /\n-- \n[^\n]*\n*$/;
const DIFF_START = /^diff --git /m;
const HUNK_START = /^@@.*$/m;
const PLAIN_PATH = /^(?:\+\+\+ b\/|--- a\/|rename to )(.+?)\t?$/;
const QUOTED_PATH = /^(?:\+\+\+ "b\/|--- "a\/|rename to ")(.+)"\t?$/;
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

/** The path one file's diff names and the lines its hunks add or remove; undefined for a diff naming no path. */
function countFile(file: string): [string, number] | undefined {
	const [header = "", ...hunks] = file.split(HUNK_START);
	const path = header
		.split("\n")
		.reduce<string | undefined>(
			(found, line) => pathOf(line) ?? found,
			undefined,
		);
	if (path === undefined) return undefined;
	const changed = hunks
		.join("\n")
		.split("\n")
		.filter((line) => /^[+-]/.test(line));
	return [path, changed.length];
}

/**
 * Adds to `lines`, by path, the lines the diffs of `patch` add or remove inside a hunk.
 * A path touched without a hunk counts 0; a commit message and git's signature count none.
 */
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
 *   A renamed file's new path counts no line and is still a touched path.
 * - `tier` is the first of small, medium and large whose threshold `lines` does not pass, else xlarge, raised to
 *   `floor`.
 * - `sections` are the names of each section, in the order given, that has no `globs` or whose globs match a touched
 *   path outside `ignore`; `checklist` is `lead`, each one's text under `### <name>`, then `close`.
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
	const checklist = task(
		lead,
		...picked.map(([name, { text }]) => `### ${name}\n\n${text}`),
		close,
	);
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
