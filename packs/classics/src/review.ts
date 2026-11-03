import {
	type Attachment,
	changeset,
	commits,
	Lane,
	read,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	BuildError,
	code,
	composition,
	Enum,
	iter,
	Json,
	lookup,
	Markdown,
	not,
	Optional,
	type Ref,
	readJson,
	Text,
} from "@maestro/sdk";
import { survivorsOf, toMarkdown } from "./code";
import { EXAMPLE_REQUEST } from "./repair";
import { consolidator, lens, skeptic } from "./seats";

type Consolidated = ReturnType<
	typeof consolidator<Record<never, never>, "read">
>;

/** Each lens a review can rule through, by name, as the task of its lens. */
const LENSES = {
	correctness:
		"Rule on the change through this lens only: correctness, every changed path doing what it claims, its error paths included.",
	spec: "Rule on the change through this lens only: the spec, each requirement met by the change, one by one.",
	tests:
		"Rule on the change through this lens only: the tests, each new behaviour pinned by a test that fails without it.",
};

const LENS_NAMES = ["correctness", "spec", "tests"] as const;
type LensName = (typeof LENS_NAMES)[number];

/** The task of a skeptic over a lens's findings, ruling by `grounds` when given. */
export function skepticTask(grounds?: string): string {
	if (grounds === undefined)
		return "A lens ruled on this change. Challenge each of its findings against the code, and rule whether it holds.";
	return `A lens ruled on this change under these grounds: ${grounds} Challenge each of its findings against the code and those grounds, and rule whether it holds. A finding holds when the code shows it and it breaks a rule, requirement or ADR the grounds name; one that cites none does not hold. Uphold a finding only with its evidence in why: the file:line that shows it, or the output of a check you ran; a finding you could not verify does not hold. For a missing test, name in why the line whose removal no test catches, and the tests you read.`;
}

const CONSOLIDATE_TASK =
	"Rule on the change against the spec. Write the ruling for a reader in review.md and as data in verdict.json.";

/** The task of the consolidator over the findings of lenses, kept by skeptics when `skeptics`, ruling by `grounds` when given. */
const consolidateTask = (skeptics: boolean, grounds?: string) => {
	const lead = skeptics
		? "Independent lenses ruled on this change, and skeptics kept the findings the code shows."
		: "Independent lenses ruled on this change.";
	if (grounds === undefined) return `${lead} ${CONSOLIDATE_TASK}`;
	const blocking = skeptics ? "a skeptic upheld" : "a lens raised";
	return `${lead} ${CONSOLIDATE_TASK} Rule by these grounds: ${grounds} A blocking finding ${blocking} blocks approval, unless you dismiss it by naming the ground that excludes it: out of review, or advisory as the grounds rank it. That the spec's steps or acceptance leave a test out is no ground. In review.md, list each finding you dismiss with its ground. Report each finding you dismiss as advisory as one gap, and none you dismiss as out of review.`;
};

type Panel<T extends string> = {
	/** The task of the lens over `item`. */
	task: (item: Ref<T>) => string | Ref<string>;
	/** The lane version under review. */
	change: Ref<string> | string;
	patches: Ref<ArtifactRef>;
	spec: Ref<ArtifactRef>;
	/** The rules a finding must cite, which the skeptics and the consolidator rule by. */
	grounds?: string;
	/** Whether a skeptic rules over each lens's findings; without one, every finding counts as upheld. Default true. */
	skeptics?: boolean;
};

/**
 * A lens per item, a skeptic over each lens that found anything unless `skeptics` is false, and a consolidator ruling
 * on the upheld findings.
 */
export function panel<T extends string>(
	p: Panel<T> & { items: readonly T[] },
): Consolidated {
	const attached = {
		patches: {
			artifact: p.patches,
			hint: "for what the change did, patch by patch",
		},
		spec: { artifact: p.spec, hint: "for what the change must do" },
	};
	const skeptics = p.skeptics ?? true;
	const body = (item: Ref<T>) => round(p, p.task(item), attached, skeptics);
	const rounds = iter.parMap(p.items, body, {
		onError: "continue",
		label: "lenses",
	});
	const kept = code(survivorsOf, {
		in: { rounds: rounds.out.results, items: p.items },
		out: { survivors: Markdown() },
	});
	return consolidator({
		label: "consolidator",
		task: consolidateTask(skeptics, p.grounds),
		lane: read(p.change),
		attachments: {
			survivors: {
				artifact: kept.out.survivors,
				hint: "first, for the upheld findings",
			},
			...attached,
		},
	});
}

/** A lens over one item on `task`, and when `skeptics`, a skeptic over its findings unless it is clean. */
function round(
	{ change, grounds }: Pick<Panel<string>, "change" | "grounds">,
	task: string | Ref<string>,
	attached: { patches: Attachment; spec: Attachment },
	skeptics: boolean,
) {
	const found = lens({
		label: "lens",
		task,
		lane: read(change),
		attachments: attached,
	});
	if (!skeptics) return found;
	const challenged = skeptic({
		label: "skeptic",
		task: skepticTask(grounds),
		lane: read(change),
		when: not(
			readJson(found.out.findings, { tolerate: "rejected" }).get("clean"),
		),
		tolerate: "rejected",
		attachments: {
			findings: {
				artifact: found.out.findings,
				hint: "first, for the findings to challenge",
			},
			...attached,
		},
	});
	return { lens: found, skeptic: challenged };
}

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
		doc: "Review a lane version or target commits: a lens per lens name, a skeptic over each lens that found anything, then a consolidator.",
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
		const patches = changeset(change, { label: "patches" });
		return panel({
			items: lenses,
			task: (name) => lookup(LENSES, name),
			change,
			patches: patches.out.changeset,
			spec: spec.out.file,
		});
	},
);
