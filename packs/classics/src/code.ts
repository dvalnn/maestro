import {
	copyFileSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
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
	type Half,
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

/** The Markdown file `file`, unchanged, under its base name in scratch, so a run records what it held. */
export function copyMarkdown(
	{ file }: { file: ArtifactRef },
	ctx: CodeContext,
): { file: string } {
	const source = ctx.path(file);
	const copy = join(ctx.scratch, basename(source));
	copyFileSync(source, copy);
	return { file: copy };
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
export type Member =
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

type Unreviewed = { lens: string; reason: string };

/** What one group of members held: its findings, the lenses that never delivered, and how many members delivered. */
function heldIn(
	results: Settled<Member>[],
	names: readonly string[],
	known?: readonly string[],
): { held: Held[]; unreviewed: Unreviewed[]; delivered: number } {
	const held: Held[] = [];
	const unreviewed: Unreviewed[] = [];
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
 * The findings the members of every group held, in `groups` order, the lenses that never delivered theirs, and
 * `delivered`, the count of members that delivered a value, over all groups but those in `uncounted`.
 * - A group `g` brings its members as `gResults`, their lens names, in that order, as `gNames`, and, when given, the
 *   names a member may take as `gKnown`.
 * - A member with a skeptic holds the findings its skeptic's rulings hold, each with that `why`; one without holds every
 *   finding, with no `why`, unless its lens settled ok.
 * - A skipped member holds none and counts as delivered. `patches`, `spec`, `upheld` and `builder` are unread, there so
 *   the node does not run while any input its lenses read is unavailable.
 * - One that delivered nothing, a failed skeptic included, is `unreviewed` with its reason: its whole lens is.
 * @throws Error when a member is named outside its group's `gKnown`, when given.
 */
export function heldOf(inputs: {
	patches: ArtifactRef;
	spec: ArtifactRef;
	upheld?: Held[];
	builder?: ValueOf<typeof Brief>;
	groups: string[];
	uncounted?: string[];
	[results: `${string}Results`]: Settled<Member>[];
	[names: `${string}Names`]: string[];
	[known: `${string}Known`]: string[];
}): { held: Held[]; unreviewed: Unreviewed[]; delivered: number } {
	const per = inputs.groups.map((g) => ({
		group: g,
		...heldIn(
			inputs[`${g}Results`] ?? [],
			inputs[`${g}Names`] ?? [],
			inputs[`${g}Known`],
		),
	}));
	return {
		held: per.flatMap((p) => p.held),
		unreviewed: per.flatMap((p) => p.unreviewed),
		delivered: per
			.filter((p) => !inputs.uncounted?.includes(p.group))
			.reduce((sum, p) => sum + p.delivered, 0),
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
	delivered: number;
};

/** Rejects with `reason`, naming `upheld` by default, and `outputs` as the rejection's outputs. */
const rejection = <O>(
	upheld: Held[],
	outputs: O,
	reason = `${upheld.length} upheld: ${upheld.map((f) => `${f.lens}/${f.id}`).join(", ")}`,
): Required<Rejection<O>> => ({ ...reject(reason, outputs), outputs });

/** The reason a review rejects when no lens that counts delivered one. */
const NO_REVIEW = "no lens that counts delivered a review";

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
 * The `brief` given rides beside them. Rejects, with the tally as its outputs, while a finding is
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
		delivered,
	};
	if (delivered === 0) return rejection(upheld, tally, NO_REVIEW);
	if (upheld.length) return rejection(upheld, tally);
	return tally;
}

/**
 * The change's patch series and the findings still upheld on it.
 * Rejects, with both as outputs, while a finding is upheld, and when the last review's `delivered` is 0.
 */
export function resultOf({
	changeset,
	upheld,
	delivered,
}: {
	changeset: ArtifactRef;
	upheld: Held[];
	delivered: number;
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

/** A checklist section's `text` under `### <name>`. */
export const sectionOf = (name: string, text: string) =>
	`### ${name}\n\n${text}`;

export type Section = {
	/** The paths that pull the section in; none, it is always in. */
	globs?: string[];
	text: string;
};

/**
 * A tiered review's tier, the checklist of each half and its seats, from its changeset.
 * - `lines` is the added plus removed lines inside the hunks of the `*.patch` files, over paths matching no `ignore` glob.
 *   A renamed file's new path counts no line and is still a touched path.
 * - `tier` is the first of small, medium and large whose threshold `lines` does not pass, else xlarge, raised to
 *   `floor`.
 * - `sections` are the names of each section, half by half in the order given, that has no `globs` or whose globs match
 *   a touched path outside `ignore`.
 * - Each half's checklist is its lead from `leads`, each picked section's text under `### <name>`, then `close`; it is
 *   empty when the half picked none.
 * - `checklist` is each picked section's text under `### <name>`, both halves in order, without leads or `close`.
 * - Each seat's output is a one-item list of its seat name when it rules in `tier` and its half's checklist is not
 *   empty, else empty.
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
		leads,
		close,
	}: {
		changeset: ArtifactRef;
		ignore: string[];
		small: number;
		medium: number;
		large: number;
		floor?: Tier;
		sections: Record<Half, Record<string, Section>>;
		leads: Record<Half, string>;
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
	const halfOf = (half: Half) => {
		const picked = Object.entries(sections[half]).filter(
			([, { globs }]) =>
				!globs || counted.some(([path]) => matchesAny(globs, path)),
		);
		const checklist = picked.length
			? task(
					leads[half],
					...picked.map(([name, { text }]) => sectionOf(name, text)),
					close,
				)
			: "";
		return {
			names: picked.map(([name]) => name),
			checklist,
			sections: picked.map(([name, { text }]) => sectionOf(name, text)),
		};
	};
	const halves = {
		behaviour: halfOf("behaviour"),
		standards: halfOf("standards"),
	};
	const names = [...halves.behaviour.names, ...halves.standards.names];
	const seats = Object.fromEntries(
		SEATS.map((seat) => {
			const { name, tiers, half } = SEAT_TIERS[seat];
			const sits =
				(tiers as readonly Tier[]).includes(tier) &&
				halves[half].checklist !== "";
			return [seat, sits ? [name] : []];
		}),
	) as Record<SeatKey, string[]>;
	ctx.log(`${lines} changed lines, tier ${tier}, sections ${names.join(", ")}`);
	return {
		lines,
		tier,
		sections: names,
		behaviour: halves.behaviour.checklist,
		standards: halves.standards.checklist,
		checklist: [
			...halves.behaviour.sections,
			...halves.standards.sections,
		].join("\n\n"),
		...seats,
	};
}
