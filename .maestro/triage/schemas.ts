import {
	Bool,
	Enum,
	Int,
	Json,
	List,
	Struct,
	Text,
	type Type,
	type Types,
	type ValueOf,
} from "@maestro/sdk";
import { AREAS, NARROW, RISKS } from "./risk";

/** What the triager rules: `plan` hands the issue on to the scouts and the planner, any other settles it early. */
const RULED = ["direct", "plan", "duplicate", "needs-info"] as const;
export type Ruled = (typeof RULED)[number];
export const PROPOSED = ["ready-for-agent", "split"] as const;
export const VERDICTS = [
	"ready-for-agent",
	"needs-approval",
	"needs-info",
	"split",
	"duplicate",
] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The most requirements a direct ruling's brief holds. */
export const MAX_BRIEF_REQUIREMENTS = 3;
/** The most questions in one group, one scout's run. */
export const GROUP_SIZE = 3;

type Rule = Record<string, unknown>;

/** A rule that an object whose verdict is `verdict` keeps `rule`. */
const forVerdict = (verdict: Verdict | Ruled, rule: Rule): Rule => ({
	anyOf: [{ properties: { verdict: { not: { const: verdict } } } }, rule],
});

/** A rule that `field` is present when the verdict is `verdict`. */
const needs = (verdict: Verdict | Ruled, field: string) =>
	forVerdict(verdict, { required: [field] });

/** A rule that `field` is absent when the verdict is `verdict`. */
const omits = (verdict: Verdict | Ruled, field: string) =>
	forVerdict(verdict, { not: { required: [field] } });

/** The rules that `field` is absent on every verdict of `all` but `only`. */
const onlyOn = <V extends Verdict | Ruled>(
	all: readonly V[],
	only: V,
	field: string,
) => all.filter((v) => v !== only).map((v) => omits(v, field));

/** A rule that a needs-info verdict asks at least one question. */
const ASKS = forVerdict("needs-info", {
	properties: { questions: { minItems: 1 } },
});

/** A rule that a direct ruling names one to `NARROW` files and one to `MAX_BRIEF_REQUIREMENTS` requirements. */
const NARROWS = forVerdict("direct", {
	properties: {
		files: { minItems: 1, maxItems: NARROW },
		requirements: { minItems: 1, maxItems: MAX_BRIEF_REQUIREMENTS },
	},
});

type Shaped<R extends Types, O extends Types> = {
	[K in keyof R]: ValueOf<R[K]>;
} & { [K in keyof O]?: ValueOf<O[K]> };

/** An object with the `required` fields, any of the `optional` ones and nothing else, that keeps every rule. */
function shape<R extends Types, O extends Types>(
	required: R,
	optional: O,
	rules: Rule[] = [],
	description?: string,
): Type<Shaped<R, O>> {
	const properties = Object.fromEntries(
		Object.entries({ ...required, ...optional }).map(([k, t]) => [k, t.schema]),
	);
	return Json<Shaped<R, O>>({
		type: "object",
		properties,
		required: Object.keys(required),
		additionalProperties: false,
		...(description && { description }),
		// JSON Schema refuses an empty allOf.
		...(rules.length > 0 && { allOf: rules }),
	});
}

/** A decision or exclusion: `lead` only titles it, each of `points` holds one fact. */
const Point = Struct({ lead: Text(), points: List(Text()) });
/** The figure kinds of `.maestro/prompts/_figures.md`: Mermaid templates, then `diff` sketches for a change no template fits. */
export const FIGURES = [
	"seams",
	"sequence",
	"state",
	"interface",
	"contract",
	"composition",
	"call-tree",
	"file-tree",
	"pseudocode",
] as const;
const MAX_FIGURES = 2;
/** A figure: `caption` says what its styling means, `notes` what each superscript in `source` points at, in order. */
const Figure = Struct({
	kind: Enum(FIGURES),
	caption: Text(),
	source: Text(),
	notes: List(Text()),
});
const Figures = Json<ValueOf<typeof Figure>[]>({
	type: "array",
	items: Figure.schema,
	maxItems: MAX_FIGURES,
});
const SPEC_FIELDS = {
	what: Text(),
	decisions: List(Point),
	excluded: List(Point),
	subject: Text(),
};
/** The planner's spec: `requirements` in EARS, numbered R1 on by position. */
const SpecPart = shape(
	{ ...SPEC_FIELDS, requirements: List(Text()), consequences: Text() },
	{ figures: Figures },
);
/** A triage spec; a direct ruling's is marked `brief` and has no figures or consequences. */
const Spec = shape(
	{ touches: List(Text()), ...SPEC_FIELDS },
	{
		requirements: List(Text()),
		figures: Figures,
		consequences: Text(),
		brief: Bool(),
	},
);
export type Spec = ValueOf<typeof Spec>;
const Child = Struct({
	title: Text(),
	body: Text(),
	dependsOn: List(Json<number>({ type: "integer", minimum: 0 })),
});
export type Child = ValueOf<typeof Child>;
const Children = Json<Child[]>({
	type: "array",
	items: Child.schema,
	minItems: 1,
});

/** A question for the owner: the ask, a lead line, short options, the option recommended and the evidence by topic. */
export const Question = shape(
	{
		ask: Text({ description: "The question, one line." }),
		options: List(
			Struct(
				{
					label: Text({ description: "The option's label, such as A." }),
					text: Text({ description: "The option, a line or two." }),
				},
				{ description: "One option: a label and a line or two of text." },
			),
			{
				description:
					"Short options for the owner to pick from. An open answer gives an empty list.",
			},
		),
		context: List(
			Struct(
				{
					topic: Text({
						description:
							"A one- or two-word topic, such as Claiming, D-24 or Cost.",
					}),
					text: Text({
						description: "One point of evidence, with its file:line.",
					}),
				},
				{ description: "One point of evidence under a topic." },
			),
			{
				description:
					"The evidence, one point per item, so the options stay short.",
			},
		),
	},
	{
		lead: Text({
			description:
				"A sentence of background. Leave it out when the ask says it all.",
		}),
		recommend: Struct(
			{
				label: Text({
					description: "The label of one of the options.",
				}),
				why: Text({
					description: "The reason, read on from 'Recommended: <label>,'.",
				}),
			},
			{
				description:
					"The option you recommend. Give it only with a reason; leave it out otherwise.",
			},
		),
	},
	[],
	"A question for the owner, who reads it as a comment: keep the options short and put the evidence in context.",
);
export type Question = ValueOf<typeof Question>;

/**
 * An answer still unsure after the scout-deep rung, or whose deep scout failed, which settle asks the owner. `key` is
 * its group's slot and its question's number, such as `G2.1`, unique across the groups where question text is not.
 */
export const Exhausted = Struct({
	key: Text(),
	question: Text(),
	missing: Text(),
});
export type Exhausted = ValueOf<typeof Exhausted>;

/**
 * The planner's proposal: `touches` whatever the verdict, and the part each verdict needs. A revision adds the
 * `questions` its spec check left for the owner. `kept` says the spec the owner approved still holds as written.
 * `answered` names the keys of the exhausted answers an owner's reply answers, which settle then does not ask.
 */
export const Proposal = shape(
	{
		verdict: Enum(PROPOSED),
		touches: List(Text()),
		contract: Text(),
	},
	{
		spec: SpecPart,
		children: Children,
		related: List(Int()),
		questions: List(Question),
		kept: Bool(),
		answered: List(Text()),
	},
	[
		needs("ready-for-agent", "spec"),
		needs("split", "children"),
		omits("ready-for-agent", "children"),
		omits("split", "spec"),
		omits("split", "kept"),
	],
);
export type Proposal = ValueOf<typeof Proposal>;

export const Group = Struct({
	id: Text(),
	area: Text(),
	questions: Json<string[]>({
		type: "array",
		items: Text().schema,
		minItems: 1,
		maxItems: GROUP_SIZE,
	}),
});
export type Group = ValueOf<typeof Group>;

/** The spec check's findings: one per failure of the spec against the code, none when it holds. */
export const Checked = shape({ findings: List(Text()) }, {});
export type Checked = ValueOf<typeof Checked>;

/**
 * The triager's ruling: an early verdict, a direct brief of `what`, `requirements` and `subject`, or at
 * most `maxGroups` groups of questions for the scouts and the planner.
 */
export const Ruling = (maxGroups: number) =>
	shape(
		{
			verdict: Enum(RULED),
			files: List(Text()),
			groups: Json<Group[]>({
				type: "array",
				items: Group.schema,
				maxItems: maxGroups,
			}),
			questions: List(Question),
		},
		{
			what: Text(),
			requirements: List(Text()),
			subject: Text(),
			duplicateOf: Int(),
			related: List(Int()),
			ahead: Text(),
		},
		[
			needs("duplicate", "duplicateOf"),
			needs("direct", "what"),
			...onlyOn(RULED, "needs-info", "ahead"),
			needs("direct", "requirements"),
			needs("direct", "subject"),
			...onlyOn(RULED, "duplicate", "duplicateOf"),
			...["what", "requirements", "subject"].flatMap((f) =>
				onlyOn(RULED, "direct", f),
			),
			NARROWS,
			ASKS,
		],
	);
export type Ruling = ValueOf<ReturnType<typeof Ruling>>;

/**
 * The triage verdict the tick acts on: the part each verdict needs, `area` only when a path falls in one, `related`
 * and `contract` only when there are any, and `kept` when the planner kept the spec the owner approved.
 */
export const Triage = shape(
	{
		verdict: Enum(VERDICTS),
		risk: Enum(RISKS),
		reasons: List(Text()),
		questions: List(Question),
	},
	{
		area: Enum(AREAS),
		spec: Spec,
		children: Children,
		duplicateOf: Int(),
		related: List(Int()),
		contract: Text(),
		ahead: Text(),
		kept: Bool(),
	},
	[
		needs("ready-for-agent", "spec"),
		needs("needs-approval", "spec"),
		...onlyOn(VERDICTS, "needs-info", "ahead"),
		needs("split", "children"),
		needs("duplicate", "duplicateOf"),
		...onlyOn(VERDICTS, "duplicate", "duplicateOf"),
		...onlyOn(VERDICTS, "split", "children"),
		ASKS,
	],
);
export type Triage = ValueOf<typeof Triage>;
