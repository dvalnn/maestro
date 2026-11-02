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
	type ValueOf,
} from "@maestro/sdk";
import { survivorsOf, toMarkdown } from "./code";
import { EXAMPLE_REQUEST } from "./repair";
import { consolidator, lens, skeptic } from "./seats";
import type { Risk } from "./types";

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

const SKEPTIC_TASK =
	"A lens ruled on this change. Challenge each of its findings against the code, and rule whether it holds.";

const CONSOLIDATE_TASK =
	"Independent lenses ruled on this change, and skeptics kept the findings the code shows. Rule on the change against the spec. Write the ruling for a reader in review.md and as data in verdict.json.";

/** An item a panel puts a lens on: a lens name, or a risk. */
type Item = string | ValueOf<typeof Risk>;

type Panel<T extends Item> = {
	/** The task of the lens over `item`. */
	task: (item: Ref<T>) => string | Ref<string>;
	/** The lane version under review. */
	change: Ref<string> | string;
	patches: Ref<ArtifactRef>;
	spec: Ref<ArtifactRef>;
	/** The criteria the consolidator rules on, in place of its own. */
	design?: Ref<ArtifactRef>;
};

/** Items a node delivers, keyed by `key`, an exported function, and at most `max` of them. */
type Delivered<T extends Item> = {
	items: Ref<T[]>;
	key: (item: T) => string;
	max: number;
};

/**
 * A lens per item, a skeptic over each lens that found anything, and a consolidator ruling on the findings the
 * skeptics upheld.
 */
export function panel<T extends string>(
	p: Panel<T> & { items: readonly T[] },
): Consolidated;
export function panel<T extends Item>(p: Panel<T> & Delivered<T>): Consolidated;
export function panel(
	p: Panel<Item> & ({ items: readonly Item[] } | Delivered<Item>),
): Consolidated {
	const attached = {
		patches: {
			artifact: p.patches,
			hint: "for what the change did, patch by patch",
		},
		spec: { artifact: p.spec, hint: "for what the change must do" },
	};
	const body = (item: Ref<Item>) => round(p, p.task(item), attached);
	const rounds =
		"key" in p
			? iter.parMap(p.items, body, {
					onError: "continue",
					label: "lenses",
					key: p.key,
					max: p.max,
				})
			: iter.parMap(p.items, body, { onError: "continue", label: "lenses" });
	const kept = code(survivorsOf, {
		in: { rounds: rounds.out.results, items: p.items },
		out: { survivors: Markdown() },
	});
	return consolidator({
		label: "consolidator",
		task: CONSOLIDATE_TASK,
		lane: read(p.change),
		attachments: {
			survivors: {
				artifact: kept.out.survivors,
				hint: "first, for the findings the skeptics upheld",
			},
			...attached,
			...(p.design === undefined
				? {}
				: {
						design: {
							artifact: p.design,
							hint: "for the criteria to rule on by their ids, in place of your own",
						},
					}),
		},
	});
}

/** A lens over one item on `task`, and a skeptic over its findings unless it is clean. */
function round(
	{ change }: Panel<Item>,
	task: string | Ref<string>,
	attached: { patches: Attachment; spec: Attachment },
) {
	const found = lens({
		label: "lens",
		task,
		lane: read(change),
		attachments: attached,
	});
	const challenged = skeptic({
		label: "skeptic",
		task: SKEPTIC_TASK,
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
