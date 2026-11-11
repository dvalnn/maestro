import { Lane, Session } from "@maestro/host-repo-sdk";
import {
	Bool,
	Enum,
	Json,
	List,
	Struct,
	Text,
	type ValueOf,
} from "@maestro/sdk";

/** An integer param of at least 1, `value` by default. */
export const atLeastOne = (value: number, description: string) =>
	Json<number>(
		{ type: "integer", minimum: 1 },
		{ default: value, description: `${description}, at least 1` },
	);

const FINDING = {
	id: Text(),
	where: Text({ description: "file:line of the defect" }),
	issue: Text({ description: "the failure the defect causes" }),
	cites: Text({
		description:
			"the guideline it breaks, as its source prints it, or source and heading for an unnamed rule; one the lens received",
	}),
	blocking: Bool(),
};

/** A defect a lens found, numbered `F1` on per lens; `cites` names the guideline it breaks, and a blocking one fails the lens. */
export const Finding = Struct(FINDING);

/** What a lens found, none when its work is clean. */
export const Findings = List(Finding);

/** The tester's map: each requirement in one list, a pinned one with its test by file and name. */
const Unpinned = List(Struct({ requirement: Text(), why: Text() }));
export const TestMap = Struct({
	pinned: List(Struct({ requirement: Text(), file: Text(), test: Text() })),
	deferred: Unpinned,
	untestable: Unpinned,
});

/** What a builder reports to the review seats: its summary and the gaps it left. */
export const Brief = Struct({ summary: Text(), gaps: List(Text()) });

/** A skeptic's ruling on each finding of its lens, by the finding's id. */
export const Rulings = List(Struct({ id: Text(), holds: Bool(), why: Text() }));

/** A consolidator's ruling: one entry per criterion, and the findings it upholds as `<lens>/<id>`. */
export const Verdict = Struct({
	criteria: List(Struct({ id: Text(), met: Bool(), evidence: Text() })),
	upholds: List(Text(), {
		description: "<lens>/<id> of each finding upheld",
	}),
});

/** A finding a review held, with its lens and the skeptic's `why`, absent when no skeptic ruled on it. */
export const Upheld = Json<
	ValueOf<typeof Finding> & { lens: string; why?: string }
>({
	type: "object",
	properties: Object.fromEntries(
		Object.entries({ ...FINDING, lens: Text(), why: Text() }).map(
			([name, type]) => [name, type.schema],
		),
	),
	required: [...Object.keys(FINDING), "lens"],
	additionalProperties: false,
});

/** The ports a review round settles to: the lane and the builder's session it carries, and the findings upheld. */
export const Tally = { lane: Lane, session: Session, upheld: List(Upheld) };

const Entry = { question: Text(), answer: Text() };
const Grounded = Struct({ ...Entry, state: Enum(["grounded"]) });
const Unsure = Struct({
	...Entry,
	state: Enum(["unsure"]),
	missing: Json<string>({ type: "string", minLength: 1 }),
});

/**
 * A scout's answers, one entry per question in order: `grounded`, or `unsure` with `missing` naming the evidence it
 * could not get.
 */
export const Answers = List(
	Json<ValueOf<typeof Grounded> | ValueOf<typeof Unsure>>({
		oneOf: [Grounded.schema, Unsure.schema],
	}),
);
