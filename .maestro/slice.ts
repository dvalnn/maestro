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
const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/gm;

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

/** The draft notice's line for each reason `upheld` or `held` gives, none when neither does. */
const noticeLines = (upheld: number, held: string[]) => [
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
 * The changeset, the last round's upheld findings as `upheld.md`, whether the PR is a draft with its notice, and the
 * writer's PR body, unchanged, when the changeset holds a patch; the body is empty when the writer delivered none.
 * A rejection when the changeset holds no patch, so the slice settles `rejected`.
 * - `draft` is true when findings remain upheld or the patches touch `docs/rulings.md` or `docs/adr/`.
 * - `notice` holds a line per reason, empty when `draft` is false.
 */
export function requirePatch(
	{
		changeset,
		upheld,
		written,
	}: {
		changeset: ArtifactRef;
		upheld: Held[];
		written: Settled<ArtifactRef>[];
	},
	ctx: CodeContext,
) {
	const dir = ctx.path(changeset);
	const patches = readdirSync(dir).filter((f) => f.endsWith(PATCH_EXT));
	if (!patches.length) return reject(NOTHING_CHANGED);
	const lines = noticeLines(upheld.length, heldTouched(dir, patches));
	const file = join(ctx.scratch, "upheld.md");
	writeFileSync(file, upheldMarkdown(upheld));
	const notice = join(ctx.scratch, "notice.md");
	writeFileSync(notice, lines.length ? `${lines.join("\n")}\n` : "");
	const draft = lines.length > 0;
	const body = written[0];
	if (body?.outcome === "ok")
		return { changeset, upheld: file, draft, notice, pr: body.value };
	const pr = join(ctx.scratch, "pr.md");
	writeFileSync(pr, "");
	return { changeset, upheld: file, draft, notice, pr };
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
			"writer's PR body: over the PR it revises when given, empty when the writer failed. Fails when the changeset holds",
			"no patch.",
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
				...(revises && {
					revised: {
						artifact: prPatches(revises),
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
				upheld: reviewed.out.upheld,
				written: allSettled([written.out.pr], { label: "written" }),
			},
			out: {
				changeset: Dir(),
				upheld: Markdown(),
				draft: Bool(),
				notice: Markdown(),
				pr: Markdown(),
			},
			label: "result",
			tolerate: "rejected",
		});
	},
);
