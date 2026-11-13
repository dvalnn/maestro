import {
	type Attachment,
	changeset,
	commits,
	Lane,
	type Relays,
	read,
	Session,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	Bool,
	BuildError,
	code,
	composition,
	Enum,
	Int,
	iter,
	Json,
	List,
	lookup,
	Markdown,
	Optional,
	type Ref,
	Struct,
	Text,
	use,
} from "@maestro/sdk";
import { heldOf } from "./code";
import { challenge, requestOf, tally } from "./moves";
import { task } from "./prompt";
import AGENT_DOC from "./prompts/_agent-doc.md" with { type: "text" };
import CORRECTNESS from "./prompts/_correctness.md" with { type: "text" };
import DESIGN from "./prompts/_design.md" with { type: "text" };
import DOCS from "./prompts/_docs.md" with { type: "text" };
import SMELLS from "./prompts/_smells.md" with { type: "text" };
import SPEC from "./prompts/_spec.md" with { type: "text" };
import TESTS from "./prompts/_tests.md" with { type: "text" };
import AGAIN from "./prompts/again.md" with { type: "text" };
import CHECKLIST from "./prompts/checklist.md" with { type: "text" };
import CONSOLIDATOR from "./prompts/consolidator.md" with { type: "text" };
import CONSOLIDATOR_GROUNDS from "./prompts/consolidator-grounds.md" with {
	type: "text",
};
import CONSOLIDATOR_SKEPTICS from "./prompts/consolidator-skeptics.md" with {
	type: "text",
};
import LENS_CORRECTNESS from "./prompts/lens-correctness.md" with {
	type: "text",
};
import LENS_SPEC from "./prompts/lens-spec.md" with { type: "text" };
import LENS_TESTS from "./prompts/lens-tests.md" with { type: "text" };
import { EXAMPLE_REQUEST } from "./repair";
import { consolidator, lens } from "./seats";
import { Brief, PACK, Upheld } from "./types";

/** Every checklist section's text, by section name. */
export const CHECKLISTS = {
	correctness: CORRECTNESS,
	spec: SPEC,
	tests: TESTS,
	design: DESIGN,
	smells: SMELLS,
	docs: DOCS,
	"agent-doc": AGENT_DOC,
};

/** Each panel lens's role, and the checklist sections it rules on, in order. */
const PANEL = {
	correctness: {
		role: LENS_CORRECTNESS,
		sections: ["correctness", "design", "smells"],
	},
	spec: { role: LENS_SPEC, sections: ["spec"] },
	tests: { role: LENS_TESTS, sections: ["tests"] },
} as const;

/** A panel lens's task: its role, each of its sections of the checklist under `### <name>`, then how it is done. */
const lensTask = (name: keyof typeof PANEL) =>
	task(
		PANEL[name].role,
		...PANEL[name].sections.map((s) => `### ${s}\n\n${CHECKLISTS[s]}`),
		CHECKLIST,
	);

/** Each call's task: its own prompt file, then the fragments it rules by, which a flag or a param can add. */
export const TASKS = {
	lens: {
		correctness: lensTask("correctness"),
		spec: lensTask("spec"),
		tests: lensTask("tests"),
	},
	consolidator: (skeptics: boolean, grounds?: string) => {
		const own = skeptics ? CONSOLIDATOR_SKEPTICS : CONSOLIDATOR;
		return grounds === undefined
			? own
			: task(own, CONSOLIDATOR_GROUNDS, grounds);
	},
};

/** Each lens a review can rule through, by name, as the task of its lens. */
export const LENSES = TASKS.lens;

const LENS_NAMES = ["correctness", "spec", "tests"] as const;
type LensName = (typeof LENS_NAMES)[number];

const PATCHES_HINT = "for what the change did, patch by patch";
const SPEC_HINT = "for what the change must do";

/** The attachments every review seat reads: the change's `patches` and the `spec`. */
export const attachmentsOf = (
	patches: Ref<ArtifactRef>,
	spec: Ref<ArtifactRef>,
) => ({
	patches: { artifact: patches, hint: PATCHES_HINT },
	spec: { artifact: spec, hint: SPEC_HINT },
});

/** What a lens reads beside its lane, by name: its `relay`, then the artifact of each of its `attachments`. */
export const readsOf = (
	attachments: Readonly<Record<string, Attachment>>,
	relay: Relays = {},
): Relays => ({
	...relay,
	...Object.fromEntries(
		Object.entries(attachments).map(([name, { artifact }]) => [name, artifact]),
	),
});

/**
 * A lens per lens name, a skeptic over each lens that rejected unless `skeptics` is false, the findings held, and, with
 * `consolidate`, a consolidator ruling on them. Ends in the tally of the change, which rejects while a finding is
 * upheld, or when no lens delivered a review, and, given a consolidator, a `review` rendered from its verdict.
 * @throws BuildError `CFG.param` when it has neither a `session` to carry nor a consolidator's.
 */
export const panel = composition(
	"panel",
	{
		pack: PACK,
		doc: "Review a lane version through a lens per name, a skeptic over each lens that found anything, and a consolidator, ending in a Tally.",
		ports: {
			change: Lane,
			spec: Markdown(),
			session: Optional(Session),
			earlier: Optional(List(Upheld)),
			names: Optional(List(Text())),
			brief: Optional(Brief),
		},
		params: {
			lenses: Json<Record<string, string>>(
				{
					type: "object",
					additionalProperties: { type: "string" },
				},
				{ default: LENSES },
			),
			skeptics: Bool({ default: true }),
			consolidate: Bool({ default: true }),
			grounds: Text({ default: "" }),
			checks: List(Text(), { default: [] }),
		},
	},
	(
		{ lenses, skeptics, consolidate, grounds, checks },
		{ change, spec, session, earlier, names, brief },
	) => {
		const attached = attachmentsOf(
			changeset(change, { label: "patches" }).out.changeset,
			spec,
		);
		const ground = grounds || undefined;
		const common: Relays = brief ? { builder: brief } : {};
		const relay = { ...(earlier && { upheld: earlier }), ...common };
		const items = names ?? Object.keys(lenses);
		const tasks = earlier
			? Object.fromEntries(
					Object.entries(lenses).map(([name, own]) => [name, task(AGAIN, own)]),
				)
			: lenses;
		const rounds = iter.parMap(
			items,
			(name) => {
				const found = lens({
					label: "lens",
					task: lookup(tasks, name),
					lane: read(change),
					checks,
					relay,
					attachments: attached,
				});
				if (!skeptics) return found;
				return {
					lens: found,
					skeptic: challenge(found, {
						change,
						attached,
						grounds: ground,
						relay: common,
					}),
				};
			},
			{
				onError: "continue",
				label: "lenses",
				...(names && { max: Object.keys(lenses).length }),
			},
		);
		const held = code(heldOf, {
			in: {
				...readsOf(attached, relay),
				results: rounds.out.results,
				names: items,
				known: Object.keys(lenses),
			},
			out: {
				held: List(Upheld),
				unreviewed: List(Struct({ lens: Text(), reason: Text() })),
				delivered: Int(),
			},
		});
		const consolidated = consolidate
			? consolidator({
					label: "consolidator",
					task: TASKS.consolidator(skeptics, ground),
					lane: read(change),
					relay: {
						findings: held.out.held,
						unreviewed: held.out.unreviewed,
						...common,
					},
					attachments: attached,
				})
			: undefined;
		const carried = session ?? consolidated?.out.session;
		if (!carried)
			throw new BuildError({
				code: "CFG.param",
				message: "classics.panel needs a session or consolidate",
				hint: "Feed the session port, or leave the consolidate param true",
			});
		return tally({
			lane: change,
			session: carried,
			held: held.out.held,
			verdict: consolidated?.out.verdict,
			delivered: held.out.delivered,
			brief,
		});
	},
);

/** The params of an entry that reviews a lane version or target commits. */
export const SUBJECT = {
	change: Optional(Lane),
	revs: Optional(
		Text({
			description:
				"Git revisions of the target: A..B, C^!, or B from target.base",
		}),
	),
};

/**
 * The lane version under review: `change`, or the target commits `revs` names.
 * @throws BuildError `CFG.param` naming composition `id` unless exactly one is given.
 */
export function reviewed(
	id: string,
	change: string | undefined,
	revs: string | undefined,
): Ref<string> | string {
	if (change !== undefined && revs !== undefined)
		throw new BuildError({
			code: "CFG.param",
			message: `classics.${id} takes --change or --revs, not both`,
			hint: "Drop one of --change and --revs",
		});
	if (change !== undefined) return change;
	if (revs !== undefined) return commits(revs).out.lane;
	throw new BuildError({
		code: "CFG.param",
		message: `classics.${id} needs --change or --revs`,
		hint: "Pass --revs main..feature, or --change <concert id>.<node instance id>",
	});
}

export const panelReview = composition(
	"panel_review",
	{
		pack: PACK,
		doc: "Review a lane version or target commits: a lens per lens name, a skeptic over each lens that found anything, then a consolidator and a tally that rejects while a finding is upheld.",
		params: {
			request: Text({ description: "What the change must do" }),
			...SUBJECT,
			lenses: Json<LensName[]>(
				{ type: "array", items: Enum(LENS_NAMES).schema, uniqueItems: true },
				{
					default: [...LENS_NAMES],
					description: "The lenses to rule through, each once",
				},
			),
		},
		examples: [
			{
				request: EXAMPLE_REQUEST,
				change: "c.repair_until_green/loop[1]/recheck",
			},
		],
	},
	({ request, change: given, revs, lenses }) => {
		const change = reviewed("panel_review", given, revs);
		return use(
			panel,
			{ change, spec: requestOf(request) },
			{
				params: {
					lenses: Object.fromEntries(
						lenses.map((name) => [name, LENSES[name]]),
					),
				},
			},
		);
	},
);
