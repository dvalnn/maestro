import {
	type Attachment,
	extend,
	type Relays,
	read,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	code,
	Int,
	Markdown,
	not,
	type Ref,
	type ValueOf,
} from "@maestro/sdk";
import { tallyOf, toMarkdown } from "./code";
import { task } from "./prompt";
import FIX from "./prompts/fix.md" with { type: "text" };
import SKEPTIC from "./prompts/skeptic.md" with { type: "text" };
import SKEPTIC_GROUNDS from "./prompts/skeptic-grounds.md" with {
	type: "text",
};
import { builder, skeptic } from "./seats";
import {
	Brief,
	type Findings,
	Tally,
	type Upheld,
	type Verdict,
} from "./types";

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
	}: {
		/** The lane version the skeptic reads. */
		change: Ref<string> | string;
		attached: { patches: Attachment; spec: Attachment };
		/** The rules a finding must cite. */
		grounds?: string;
		/** Relays the skeptic reads after the findings. */
		relay?: Relays;
	},
) {
	return skeptic({
		label: "skeptic",
		task: grounds === undefined ? SKEPTIC : task(SKEPTIC_GROUNDS, grounds),
		lane: read(change),
		when: not(found.ok),
		tolerate: "rejected",
		relay: { findings: found.out.findings, ...relay },
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

/**
 * The tally of a review of `lane`, over the findings `held`.
 * - Without `verdict`, every held finding stands.
 * - With one, the findings it upholds stand, and a `review` is rendered from it.
 *
 * The `brief` and `delivered` given ride beside it; a `delivered` of 0 rejects it.
 */
export function tally({
	lane,
	session,
	held,
	verdict,
	brief,
	delivered,
	label = "upheld",
}: {
	lane: Ref<string>;
	session: Ref<string>;
	held: Held;
	/** The consolidator's `verdict` port. */
	verdict?: Ref<ValueOf<typeof Verdict>>;
	/** The builder's or fix's brief, which the tally carries beside the rest. */
	brief?: Ref<ValueOf<typeof Brief>>;
	/** How many lenses delivered a review. */
	delivered?: Ref<number>;
	label?: string;
}) {
	return code(tallyOf, {
		in: {
			lane,
			session,
			held,
			...(verdict && { verdict }),
			...(brief && { brief }),
			...(delivered && { delivered }),
		},
		out: {
			...Tally,
			...(verdict && { review: Markdown() }),
			...(brief && { brief: Brief }),
			...(delivered && { delivered: Int() }),
		},
		label,
		tolerate: "rejected",
	});
}
