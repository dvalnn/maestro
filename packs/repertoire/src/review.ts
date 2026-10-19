import { changeset, Lane, read } from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	assert,
	code,
	composition,
	Enum,
	iter,
	Json,
	lookup,
	Markdown,
	not,
	type Ref,
	readJson,
	Text,
} from "@maestro/sdk";
import { survivorsOf, toMarkdown } from "./code";
import { EXAMPLE_REQUEST } from "./repair";
import { consolidator, lens, skeptic } from "./seats";

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

/** Model families by the stem a model id starts with. */
const FAMILIES: readonly (readonly [RegExp, string])[] = [
	[/^(claude|opus|sonnet|haiku)/, "anthropic"],
	[/^(gpt|o\d|codex)/, "openai"],
	[/^gemini/, "google"],
	[/^grok/, "xai"],
	[/^llama/, "meta"],
	[/^mistral/, "mistral"],
	[/^deepseek/, "deepseek"],
	[/^qwen/, "alibaba"],
];

/**
 * The family of `model`, the first of:
 * - the family of the stem its id after the last `/` starts with;
 * - its part before the first `/`;
 * - `model` itself.
 */
function family(model: string): string {
	const id = model.slice(model.lastIndexOf("/") + 1);
	const known = FAMILIES.find(([stem]) => stem.test(id))?.[1];
	return known ?? model.split("/")[0] ?? model;
}

type Panel<T extends string> = {
	items: readonly T[];
	/** The task of the lens over `item`. */
	task: (item: Ref<T>) => string | Ref<string>;
	/** The lane version under review. */
	change: Ref<string> | string;
	patches: Ref<ArtifactRef>;
	spec: Ref<ArtifactRef>;
	lensModel: string;
	skepticModel: string;
};

/**
 * A lens per item, a skeptic over each lens that found anything, and a consolidator ruling on the findings the
 * skeptics upheld.
 * @throws `ASSERT.failed` when the skeptic's model is of the family of the lens's.
 */
function panel<T extends string>(p: Panel<T>) {
	const { change, lensModel, skepticModel } = p;
	assert(
		family(lensModel) !== family(skepticModel),
		`skeptic model '${skepticModel}' is of the family of lens model '${lensModel}'`,
	);
	const patches = {
		artifact: p.patches,
		hint: "for what the change did, patch by patch",
	};
	const spec = { artifact: p.spec, hint: "for what the change must do" };
	const rounds = iter.parMap(
		p.items,
		(item) => {
			const found = lens({
				label: "lens",
				task: p.task(item),
				lane: read(change),
				role: { model: lensModel },
				attachments: { patches, spec },
			});
			const challenged = skeptic({
				label: "skeptic",
				task: SKEPTIC_TASK,
				lane: read(change),
				role: { model: skepticModel },
				when: not(readJson(found.out.findings).get("clean")),
				attachments: {
					findings: {
						artifact: found.out.findings,
						hint: "first, for the findings to challenge",
					},
					patches,
					spec,
				},
			});
			return { lens: found, skeptic: challenged };
		},
		{ onError: "continue" },
	);
	const kept = code(survivorsOf, {
		in: { rounds: rounds.out.results, items: [...p.items] },
		out: { survivors: Markdown() },
	});
	return consolidator({
		label: "consolidator",
		task: CONSOLIDATE_TASK,
		lane: read(change),
		attachments: {
			survivors: {
				artifact: kept.out.survivors,
				hint: "first, for the findings the skeptics upheld",
			},
			patches,
			spec,
		},
	});
}

export const review = composition(
	"review",
	{
		doc: "Review a lane version: a lens per lens name, a skeptic of another model family over each lens that found anything, then a consolidator.",
		params: {
			request: Text({ description: "What the change must do" }),
			change: Lane,
			lensModel: Text({ description: "The model every lens runs on" }),
			skepticModel: Text({
				description:
					"The model every skeptic runs on, of another family than lensModel's",
			}),
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
				lensModel: "lab-a/lens-model",
				skepticModel: "lab-b/skeptic-model",
			},
		],
	},
	({ request, change, lensModel, skepticModel, lenses }) => {
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
			lensModel,
			skepticModel,
		});
	},
);
