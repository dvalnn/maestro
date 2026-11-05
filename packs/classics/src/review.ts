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
import CONSOLIDATOR from "./prompts/consolidator.md" with { type: "text" };
import CONSOLIDATOR_GROUNDS from "./prompts/consolidator-grounds.md" with {
	type: "text",
};
import CONSOLIDATOR_SKEPTICS from "./prompts/consolidator-skeptics.md" with {
	type: "text",
};
import CORRECTNESS from "./prompts/correctness.md" with { type: "text" };
import SKEPTIC from "./prompts/skeptic.md" with { type: "text" };
import SKEPTIC_GROUNDS from "./prompts/skeptic-grounds.md" with {
	type: "text",
};
import SPEC from "./prompts/spec.md" with { type: "text" };
import TESTS from "./prompts/tests.md" with { type: "text" };
import { EXAMPLE_REQUEST } from "./repair";
import { consolidator, lens, skeptic } from "./seats";

type Consolidated = ReturnType<
	typeof consolidator<Record<never, never>, "read">
>;

const task = (...parts: string[]) => parts.join("\n\n");

/** Each call's task: its own prompt file, then the fragments it rules by, which a flag or a param can add. */
const TASKS = {
	lens: { correctness: CORRECTNESS, spec: SPEC, tests: TESTS },
	skeptic: (grounds?: string) =>
		grounds === undefined ? SKEPTIC : task(SKEPTIC_GROUNDS, grounds),
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
	const body = (item: Ref<T>) =>
		round({
			change: p.change,
			task: p.task(item),
			attached,
			grounds: p.grounds,
			skeptics,
		});
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
		task: TASKS.consolidator(skeptics, p.grounds),
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

type RoundOptions = {
	change: Ref<string> | string;
	/** The task of the lens. */
	task: string | Ref<string>;
	/** What the lens and the skeptic both read. */
	attached: { patches: Attachment; spec: Attachment };
	grounds?: string;
	/** Whether a skeptic sits over the lens's findings. */
	skeptics: boolean;
	/** The lens's node label. Default `lens`. */
	label?: string;
	/** The session the lens continues. */
	session?: Ref<string>;
	/** Names of `target.checks` the lens may run. */
	checks?: string[];
	/** Attachments for the lens only. */
	extra?: Record<string, Attachment>;
};

/**
 * A lens over one item on `task`, and when `skeptics`, a skeptic over its findings unless it is clean. Without a
 * skeptic it returns the lens alone.
 */
export function round(options: RoundOptions & { skeptics: true }): {
	lens: Lens;
	skeptic: Skeptic;
};
export function round(options: RoundOptions & { skeptics: false }): Lens;
export function round(
	options: RoundOptions,
): Lens | { lens: Lens; skeptic: Skeptic };
export function round(options: RoundOptions) {
	const found = lensOf(options);
	if (!options.skeptics) return found;
	return { lens: found, skeptic: skepticOf(options, found) };
}

function lensOf({
	change,
	task,
	attached,
	label = "lens",
	session,
	checks,
	extra,
}: RoundOptions) {
	return lens({
		label,
		task,
		lane: read(change),
		session,
		checks,
		attachments: { ...attached, ...extra },
	});
}

type Lens = ReturnType<typeof lensOf>;

function skepticOf({ change, grounds, attached }: RoundOptions, found: Lens) {
	return skeptic({
		label: "skeptic",
		task: TASKS.skeptic(grounds),
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
}

type Skeptic = ReturnType<typeof skepticOf>;

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
