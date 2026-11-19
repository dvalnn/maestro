import {
	type Attachment,
	changeset,
	extend,
	type Relays,
	read,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	code,
	Int,
	List,
	Markdown,
	not,
	type Ref,
	type Settled,
	Struct,
	Text,
	type ValueOf,
} from "@maestro/sdk";
import { heldOf, type Member, tallyOf, toMarkdown } from "./code";
import { task } from "./prompt";
import FIX from "./prompts/fix.md" with { type: "text" };
import SKEPTIC from "./prompts/skeptic.md" with { type: "text" };
import SKEPTIC_GROUNDS from "./prompts/skeptic-grounds.md" with {
	type: "text",
};
import { builder, consolidator, skeptic } from "./seats";
import { Brief, type Findings, Tally, Upheld, type Verdict } from "./types";

/** The request as a Markdown file. */
export const requestOf = (request: string) =>
	code(toMarkdown, {
		in: { text: request },
		out: { file: Markdown() },
		label: "request",
	}).out.file;

export type Held = Ref<ValueOf<typeof Upheld>[]>;

/** A skeptic over the findings of `found`, skipped when `found` settled ok. */
export function challenge(
	found: { ok: Ref<boolean>; out: { findings: Ref<ValueOf<typeof Findings>> } },
	{
		change,
		attached,
		grounds,
		relay,
		checklist,
	}: {
		/** The lane version the skeptic reads. */
		change: Ref<string> | string;
		attached: { patches: Attachment; spec: Attachment };
		/** The rules a finding must cite. */
		grounds?: string;
		/** Relays the skeptic reads after the findings. */
		relay?: Relays;
		/** The checklist the lens ruled on, relayed after `relay`. */
		checklist?: Ref<string>;
	},
) {
	return skeptic({
		label: "skeptic",
		task: grounds === undefined ? SKEPTIC : task(SKEPTIC_GROUNDS, grounds),
		lane: read(change),
		when: not(found.ok),
		tolerate: "rejected",
		relay: { findings: found.out.findings, ...relay, checklist },
		attachments: attached,
	});
}

/** A builder fixing the findings `round` upheld, in a lane extending its lane and continuing its session. */
export function fix(
	round: { lane: Ref<string>; session: Ref<string>; upheld: Held },
	spec: Ref<ArtifactRef>,
	{ checks, label = "fix" }: { checks?: string[]; label?: string } = {},
) {
	return builder({
		label,
		task: FIX,
		lane: extend(round.lane),
		session: round.session,
		checks,
		relay: { upheld: round.upheld },
		attachments: {
			spec: { artifact: spec, hint: "for what the change must do" },
		},
	});
}

const PATCHES_HINT = "for what the change did, patch by patch";
const SPEC_HINT = "for what the change must do";

/** The attachments every review seat reads: the change's `patches` and the `spec`. */
const attachmentsOf = (patches: Ref<ArtifactRef>, spec: Ref<ArtifactRef>) => ({
	patches: { artifact: patches, hint: PATCHES_HINT },
	spec: { artifact: spec, hint: SPEC_HINT },
});

/** What a review's lenses read, from `reviewReads`, and what its tally reads back. */
export type Reads = {
	/** The lane version under review. */
	change: Ref<string>;
	/** The previous round's findings, which a lens reads. */
	earlier?: Held;
	brief?: Ref<ValueOf<typeof Brief>>;
	attached: { patches: Attachment; spec: Attachment };
	/** What a lens reads beside its lane: the `earlier` findings and the `brief`, when given. */
	relay: Relays;
	/** What every review seat reads beside its lane: the `brief`, when given. */
	common: Relays;
};

/** What the lenses of a review of `change` against `spec` read: its patches and spec as attachments, and the relays. */
export function reviewReads(review: {
	change: Ref<string>;
	spec: Ref<ArtifactRef>;
	earlier?: Held;
	brief?: Ref<ValueOf<typeof Brief>>;
}): Reads {
	const { change, spec, earlier, brief } = review;
	const patches = changeset(change, { label: "patches" }).out.changeset;
	const common: Relays = brief ? { builder: brief } : {};
	return {
		change,
		earlier,
		brief,
		attached: attachmentsOf(patches, spec),
		relay: { upheld: earlier, ...common },
		common,
	};
}

/** One group of a review's members: their settled results and the lens name of each, in order. */
export type Group = {
	results: Ref<Settled<Member>[]>;
	names: Ref<string[]> | string[];
	/** The names a member may take. */
	known?: string[];
	/** Whether its members delivering counts toward the review being delivered; their findings count either way. */
	counts?: boolean;
};

/** How a review settles: through a consolidator's `task`, or on a `session` it carries, or both. */
type Settles =
	| { consolidator: string; session?: Ref<string> }
	| { consolidator?: undefined; session: Ref<string> };

/**
 * The tally of a review over the `groups` of lenses built from `reads`, which must be those its lenses read.
 * - The held node waits on every input the lenses read, and counts the members that delivered, outside groups that do
 *   not count, so a review whose lenses were all skipped, or none of those counted delivered, rejects.
 * - With a `consolidator`, a consolidator ruling on the held findings, which reads the `checklist` when given, and a
 *   `review` rendered from its verdict, then a tally of those it upholds; without, every held finding stands.
 * - The session carried is `session`, else the consolidator's.
 *
 * The `brief` read rides beside the tally.
 */
export function tally(
	reads: Reads,
	groups: Record<string, Group>,
	settles: Settles & {
		label?: string;
		/** The checklists the lenses ruled on, relayed to the consolidator only. */
		checklist?: Ref<string>;
	},
) {
	const { change, earlier, brief, attached, common } = reads;
	const { label = "upheld" } = settles;
	const uncounted = Object.keys(groups).filter(
		(g) => groups[g]?.counts === false,
	);
	const groupPorts = Object.fromEntries(
		Object.entries(groups).flatMap(([g, { results, names, known }]) => [
			[`${g}Results`, results],
			[`${g}Names`, names],
			...(known ? [[`${g}Known`, known]] : []),
		]),
	);
	// Hold: gather every group's findings and count the members that delivered, once all the lenses settled.
	const held = code(heldOf, {
		in: {
			patches: attached.patches.artifact,
			spec: attached.spec.artifact,
			upheld: earlier,
			builder: brief,
			groups: Object.keys(groups),
			...(uncounted.length && { uncounted }),
			...groupPorts,
		},
		out: {
			held: List(Upheld),
			unreviewed: List(Struct({ lens: Text(), reason: Text() })),
			delivered: Int(),
		},
	});
	// Settle: tally the held findings, or the ones a verdict upholds, into the review's outcome.
	const settle = (
		session: Ref<string>,
		verdict?: Ref<ValueOf<typeof Verdict>>,
	) =>
		code(tallyOf, {
			in: {
				lane: change,
				session,
				held: held.out.held,
				verdict,
				brief,
				delivered: held.out.delivered,
			},
			out: {
				...Tally,
				...(verdict && { review: Markdown() }),
				...(brief && { brief: Brief }),
			},
			label,
			tolerate: "rejected",
		});
	// Without a consolidator, every held finding stands.
	if (settles.consolidator === undefined) return settle(settles.session);
	// Consolidate: one seat rules on the held findings and the lenses that never delivered.
	const consolidated = consolidator({
		label: "consolidator",
		task: settles.consolidator,
		lane: read(change),
		relay: {
			findings: held.out.held,
			unreviewed: held.out.unreviewed,
			...common,
			checklist: settles.checklist,
		},
		attachments: attached,
	});
	return settle(
		settles.session ?? consolidated.out.session,
		consolidated.out.verdict,
	);
}
