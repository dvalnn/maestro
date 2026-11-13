import {
	changeset,
	commits,
	Lane,
	type Relays,
	read,
	Session,
} from "@maestro/host-repo-sdk";
import {
	Bool,
	BuildError,
	code,
	composition,
	Enum,
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
import { heldOf, toMarkdown } from "./code";
import { challenge, tally } from "./moves";
import { task } from "./prompt";
import AGAIN from "./prompts/again.md" with { type: "text" };
import CHECKLIST from "./prompts/checklist.md" with { type: "text" };
import CONSOLIDATOR from "./prompts/consolidator.md" with { type: "text" };
import CONSOLIDATOR_GROUNDS from "./prompts/consolidator-grounds.md" with {
	type: "text",
};
import CONSOLIDATOR_SKEPTICS from "./prompts/consolidator-skeptics.md" with {
	type: "text",
};
import CORRECTNESS from "./prompts/correctness.md" with { type: "text" };
import SPEC from "./prompts/spec.md" with { type: "text" };
import TESTS from "./prompts/tests.md" with { type: "text" };
import { EXAMPLE_REQUEST } from "./repair";
import { consolidator, lens } from "./seats";
import { Brief, Upheld } from "./types";

/** Each call's task: its own prompt file, then the fragments it rules by, which a flag or a param can add. */
const TASKS = {
	lens: {
		correctness: task(CORRECTNESS, CHECKLIST),
		spec: task(SPEC, CHECKLIST),
		tests: task(TESTS, CHECKLIST),
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

/**
 * A lens per lens name, a skeptic over each lens that rejected unless `skeptics` is false, the findings held, and, with
 * `consolidate`, a consolidator ruling on them. Ends in the tally of the change, which rejects while a finding is
 * upheld, and, given a consolidator, a `review` rendered from its verdict.
 * @throws BuildError `CFG.param` when it has neither a `session` to carry nor a consolidator's.
 */
export const panel = composition(
	"panel",
	{
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
		const attached = {
			patches: {
				artifact: changeset(change, { label: "patches" }).out.changeset,
				hint: PATCHES_HINT,
			},
			spec: { artifact: spec, hint: SPEC_HINT },
		};
		const ground = grounds || undefined;
		const common: Relays = brief ? { builder: brief } : {};
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
					relay: { ...(earlier && { upheld: earlier }), ...common },
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
			{ onError: "continue", label: "lenses" },
		);
		const held = code(heldOf, {
			in: { results: rounds.out.results, names: items },
			out: {
				held: List(Upheld),
				unreviewed: List(Struct({ lens: Text(), reason: Text() })),
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
			brief,
		});
	},
);

/**
 * The lane version under review: `change`, or the target commits `revs` names.
 * @throws BuildError `CFG.param` unless exactly one is given.
 */
function reviewed(
	change: string | undefined,
	revs: string | undefined,
): Ref<string> | string {
	if (change !== undefined && revs !== undefined)
		throw new BuildError({
			code: "CFG.param",
			message: "classics.panel_review takes --change or --revs, not both",
			hint: "Drop one of --change and --revs",
		});
	if (change !== undefined) return change;
	if (revs !== undefined) return commits(revs).out.lane;
	throw new BuildError({
		code: "CFG.param",
		message: "classics.panel_review needs --change or --revs",
		hint: "Pass --revs main..feature, or --change <concert id>.<node instance id>",
	});
}

export const panelReview = composition(
	"panel_review",
	{
		doc: "Review a lane version or target commits: a lens per lens name, a skeptic over each lens that found anything, then a consolidator and a tally that rejects while a finding is upheld.",
		params: {
			request: Text({ description: "What the change must do" }),
			change: Optional(Lane),
			revs: Optional(
				Text({
					description:
						"Git revisions of the target: A..B, C^!, or B from target.base",
				}),
			),
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
		const change = reviewed(given, revs);
		const spec = code(toMarkdown, {
			in: { text: request },
			out: { file: Markdown() },
			label: "request",
		});
		return use(
			panel,
			{ change, spec: spec.out.file },
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
