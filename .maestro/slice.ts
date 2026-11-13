import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildChange, fixUntilClean, type Upheld } from "@maestro/classics";
import {
	changeset,
	commits,
	MarkdownOut,
	read,
	seat,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	allSettled,
	Bool,
	type CodeContext,
	code,
	composition,
	Dir,
	Int,
	Markdown,
	reject,
	type Settled,
	Text,
	use,
	type ValueOf,
} from "@maestro/sdk";
import FIGURES from "./prompts/_figures.md" with { type: "text" };
import PLAIN from "./prompts/_plain.md" with { type: "text" };
import { JUDGED, markdownOf, task } from "./shared";
import WRITER from "./slice/prompts/writer.md" with { type: "text" };

// ADR 0008: a code node's function must be exported by its composition file.
export * from "@maestro/classics/code";

const PATCH_EXT = ".patch";
const NOTHING_CHANGED = "the slice changed nothing";

const WRITER_TASK = task(WRITER, PLAIN, FIGURES);

/** A finding a round upheld. */
type Held = ValueOf<typeof Upheld>;

const NO_FINDINGS = "None.";

/** `upheld` as Markdown, a `### <cites>` section per cite, each finding followed by an `Upheld:` line when it carries a why. */
function upheldMarkdown(upheld: Held[]): string {
	const cited = Map.groupBy(upheld, (f) => f.cites);
	const sections = [...cited].flatMap(([cites, findings]) => [
		`### ${cites}`,
		"",
		...findings.map(
			(f) =>
				`- ${f.lens}/${f.id}, ${f.where}: ${f.issue}${f.why === undefined ? "" : `\n  Upheld: ${f.why}`}`,
		),
		"",
	]);
	return [
		"# Upheld findings",
		"",
		...(upheld.length ? sections : [NO_FINDINGS, ""]),
	].join("\n");
}

/** The paths the owner holds: a change to one opens its PR as a draft. */
const HELD_PATHS = ["docs/rulings.md", "docs/adr/"];
// git quotes a path with non-ASCII bytes; the held prefixes are ASCII, so the raw quoted text is matched as it is.
const DIFF_HEADER = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/gm;

const patchesOf = (dir: string) =>
	readdirSync(dir).filter((f) => f.endsWith(PATCH_EXT));

/** The held paths the patches in the changeset at `dir` touch, each once. */
function heldTouched(dir: string, patches: string[]) {
	const touched = patches.flatMap((f) =>
		[...readFileSync(join(dir, f), "utf8").matchAll(DIFF_HEADER)].flatMap(
			([, from, to]) => [from, to] as string[],
		),
	);
	return [
		...new Set(
			touched.filter((p): p is string =>
				HELD_PATHS.some((h) => (h.endsWith("/") ? p.startsWith(h) : p === h)),
			),
		),
	];
}

const NO_REVIEW_NOTICE = "Draft: no lens delivered a review of this change.";

/** The draft notice's line for each reason `upheld`, `held` or an `unreviewed` change gives, none when none does. */
const noticeLines = (upheld: number, held: string[], unreviewed: boolean) => [
	...(unreviewed ? [NO_REVIEW_NOTICE] : []),
	...(upheld
		? [
				`Draft: ${upheld} ${upheld === 1 ? "finding remains" : "findings remain"} upheld after the last fix round; see Unresolved review.`,
			]
		: []),
	...(held.length
		? [
				`Draft: this change edits ${held.map((p) => `\`${p}\``).join(", ")}, which the owner holds.`,
			]
		: []),
];

/**
 * The changeset, the last round's upheld findings as `upheld.md`, whether the PR is a draft with its notice, the
 * writer's PR body, unchanged, and the `delivered` given, when the changeset holds a patch; the body is empty when the
 * writer delivered none.
 * A rejection when the changeset holds no patch, so the slice settles `rejected`.
 * - `draft` is true when the last review's `delivered`, if given, is 0, findings remain upheld, or the patches, or those
 *   of the PR `revised`, touch `docs/rulings.md` or `docs/adr/`.
 * - `notice` holds a line per reason, empty when `draft` is false.
 */
export function requirePatch(
	{
		changeset,
		revised,
		upheld,
		delivered,
		written,
	}: {
		changeset: ArtifactRef;
		revised?: ArtifactRef;
		upheld: Held[];
		delivered?: number;
		written: Settled<ArtifactRef>[];
	},
	ctx: CodeContext,
) {
	const dir = ctx.path(changeset);
	const patches = patchesOf(dir);
	if (!patches.length) return reject(NOTHING_CHANGED);
	const revisedDir = revised && ctx.path(revised);
	const held = [
		...new Set([
			...heldTouched(dir, patches),
			...(revisedDir ? heldTouched(revisedDir, patchesOf(revisedDir)) : []),
		]),
	];
	const lines = noticeLines(upheld.length, held, delivered === 0);
	const file = join(ctx.scratch, "upheld.md");
	writeFileSync(file, upheldMarkdown(upheld));
	const notice = join(ctx.scratch, "notice.md");
	writeFileSync(notice, lines.length ? `${lines.join("\n")}\n` : "");
	const draft = lines.length > 0;
	const outputs = {
		changeset,
		upheld: file,
		draft,
		notice,
		...(delivered !== undefined && { delivered }),
	};
	const body = written[0];
	if (body?.outcome === "ok") return { ...outputs, pr: body.value };
	const pr = join(ctx.scratch, "pr.md");
	writeFileSync(pr, "");
	return { ...outputs, pr };
}

/** The PR body's writer: a cheap seat that only reads the finished change. */
const writer = seat("writer");

/** The patches of the PR held by the target revisions `revises`. */
const prPatches = (revises: string) =>
	changeset(commits(revises, { label: "revised" }).out.lane, { label: "pr" })
		.out.changeset;

export const slice = composition(
	"slice",
	{
		doc: [
			"Build a request, review it at the depth its size and the preset's risk call for and fix what the review upholds.",
			"Under a preset that sets classics.build.testFirst, a tester writes the spec's tests first and the build starts from them.",
			"Each round repairs until the target's checks pass, then reviews; up to maxFixes fix rounds follow.",
			"Leaves the changeset, the findings the last review upheld, whether the PR is a draft with its notice, and a",
			"writer's PR body: over the PR it revises when given, empty when the writer failed, and how many lenses the last",
			"review delivered. Fails when the changeset holds no patch.",
		].join("\n"),
		params: {
			request: Text({ description: "The brief: what to build" }),
			revises: Text({
				default: "",
				description:
					"Git revisions of the target holding the PR this build revises, such as C^!; empty for a fresh build",
			}),
		},
		examples: [
			{
				request: "Make greet.sh greet the name given as its first argument.",
			},
		],
	},
	({ request, revises }) => {
		const built = use(
			buildChange,
			{ spec: markdownOf(request, "request") },
			{ params: { request } },
		);
		const reviewed = use(fixUntilClean, built, {
			params: { grounds: JUDGED },
		});
		const brief = reviewed.out.brief;
		const changes = changeset(reviewed.out.lane, {
			label: "changes",
			tolerate: "rejected",
		}).out.changeset;
		const prior = revises ? prPatches(revises) : undefined;
		const written = writer({
			label: "writer",
			task: WRITER_TASK,
			lane: read(reviewed.out.lane),
			attachments: {
				spec: {
					artifact: built.spec,
					hint: "first, for what the change had to do",
				},
				patches: {
					artifact: changes,
					hint: "for what the change did, patch by patch",
				},
				...(prior && {
					revised: {
						artifact: prior,
						hint: "for the PR the patches revise, which the body covers with them as one change",
					},
				}),
			},
			relay: {
				upheld: reviewed.out.upheld,
				...(brief && { builder: brief }),
			},
			out: { pr: MarkdownOut("pr.md") },
			tolerate: "rejected",
		});
		return code(requirePatch, {
			in: {
				changeset: changes,
				...(prior && { revised: prior }),
				upheld: reviewed.out.upheld,
				...(reviewed.out.delivered && { delivered: reviewed.out.delivered }),
				written: allSettled([written.out.pr], { label: "written" }),
			},
			out: {
				changeset: Dir(),
				upheld: Markdown(),
				draft: Bool(),
				notice: Markdown(),
				pr: Markdown(),
				...(reviewed.out.delivered && { delivered: Int() }),
			},
			label: "result",
			tolerate: "rejected",
		});
	},
);
