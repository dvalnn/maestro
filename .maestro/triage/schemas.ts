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
): Type<Shaped<R, O>> {
	const properties = Object.fromEntries(
		Object.entries({ ...required, ...optional }).map(([k, t]) => [k, t.schema]),
	);
	return Json<Shaped<R, O>>({
		type: "object",
		properties,
		required: Object.keys(required),
		additionalProperties: false,
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
	acceptance: List(Text()),
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
		ask: Text(),
		options: List(Struct({ label: Text(), text: Text() })),
		context: List(Struct({ topic: Text(), text: Text() })),
	},
	{ lead: Text(), recommend: Struct({ label: Text(), why: Text() }) },
);
export type Question = ValueOf<typeof Question>;

/**
 * The planner's proposal: `touches` whatever the verdict, and the part each verdict needs. A revision adds the
 * `questions` its spec check left for the owner.
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
	},
	[
		needs("ready-for-agent", "spec"),
		needs("split", "children"),
		omits("ready-for-agent", "children"),
		omits("split", "spec"),
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
 * The triager's ruling: an early verdict, a direct brief of `what`, `requirements`, `acceptance` and `subject`, or at
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
			acceptance: List(Text()),
			subject: Text(),
			duplicateOf: Int(),
			related: List(Int()),
		},
		[
			needs("duplicate", "duplicateOf"),
			needs("direct", "what"),
			needs("direct", "requirements"),
			needs("direct", "acceptance"),
			needs("direct", "subject"),
			NARROWS,
			ASKS,
		],
	);
export type Ruling = ValueOf<ReturnType<typeof Ruling>>;

/**
 * The triage verdict the tick acts on: the part each verdict needs, `area` only when a path falls in one, and `related`
 * and `contract` only when there are any.
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
	},
	[
		needs("ready-for-agent", "spec"),
		needs("needs-approval", "spec"),
		needs("split", "children"),
		needs("duplicate", "duplicateOf"),
		ASKS,
	],
);
export type Triage = ValueOf<typeof Triage>;
