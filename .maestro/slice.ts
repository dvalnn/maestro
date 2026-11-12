import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	builder,
	fixUntilClean,
	maxFixes,
	maxRepairs,
	testFirst,
	type Upheld,
} from "@maestro/classics";
import {
	changeset,
	commits,
	fresh,
	MarkdownOut,
	read,
	seat,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	allSettled,
	type CodeContext,
	code,
	composition,
	Dir,
	Enum,
	Markdown,
	type Ref,
	reject,
	type Settled,
	Text,
	use,
	type ValueOf,
} from "@maestro/sdk";
import FIGURES from "./prompts/_figures.md" with { type: "text" };
import PLAIN from "./prompts/_plain.md" with { type: "text" };
import {
	briefFrom,
	FIX_CHECK,
	markdownOf,
	REPO_CHECKS,
	TIERS,
	type Tier,
	task,
} from "./shared";
import { panelParams } from "./slice/lenses";
import WRITER from "./slice/prompts/writer.md" with { type: "text" };
import { smallLoop } from "./slice/small";

// ADR 0008: a code node's function must be exported by its composition file.
export * from "@maestro/classics/code";
export { reviewedOf } from "./slice/small";

const PATCH_EXT = ".patch";
const NOTHING_CHANGED = "the slice changed nothing";

const WRITER_TASK = task(WRITER, PLAIN, FIGURES);

/** A finding a round upheld. */
type Held = ValueOf<typeof Upheld>;

const UNVERIFIED = "Unverified: no skeptic ruled on it";
const NO_FINDINGS = "None.";

/** `upheld` as Markdown, a `### <cites>` section per cite, each finding with its skeptic's why or a mark that none ruled. */
function upheldMarkdown(upheld: Held[]): string {
	const cited = Map.groupBy(upheld, (f) => f.cites);
	const sections = [...cited].flatMap(([cites, findings]) => [
		`### ${cites}`,
		"",
		...findings.map(
			(f) =>
				`- ${f.lens}/${f.id}, ${f.where}: ${f.issue}\n  ${f.why === undefined ? UNVERIFIED : `Upheld: ${f.why}`}`,
		),
		"",
	]);
	return [
		"# Upheld findings",
		"",
		...(upheld.length ? sections : [NO_FINDINGS, ""]),
	].join("\n");
}

/**
 * The changeset, the last round's upheld findings as `upheld.md` and the writer's PR body, unchanged, when the changeset
 * holds a patch; the body is empty when the writer delivered none. A rejection when the changeset holds no patch, so the slice
 * settles `rejected`.
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
	if (!readdirSync(ctx.path(changeset)).some((f) => f.endsWith(PATCH_EXT)))
		return reject(NOTHING_CHANGED);
	const file = join(ctx.scratch, "upheld.md");
	writeFileSync(file, upheldMarkdown(upheld));
	const body = written[0];
	if (body?.outcome === "ok")
		return { changeset, upheld: file, pr: body.value };
	const pr = join(ctx.scratch, "pr.md");
	writeFileSync(pr, "");
	return { changeset, upheld: file, pr };
}

/** The PR body's writer: a cheap seat that only reads the finished change. */
const writer = seat("writer");

/** The tiers whose build starts from a tester's tests. */
const TESTED: readonly Tier[] = ["ordinary", "risky"];

/**
 * The build of `request` against `spec`: in a fresh lane, or at a tested `tier` by `test_first`. Gives the tester's map and
 * the tests the builder overruled when tested.
 */
function build(tier: Tier, request: string, spec: Ref<ArtifactRef>) {
	if (!TESTED.includes(tier))
		return {
			built: builder({
				label: "build",
				task: request,
				lane: fresh(),
				checks: REPO_CHECKS,
			}),
		};
	const { built, map } = use(
		testFirst,
		{ spec },
		{ params: { request, checks: REPO_CHECKS }, label: "tested" },
	);
	return { built, map, overrules: built.out.overrules };
}

/** The patches of the PR held by the target revisions `revises`. */
const prPatches = (revises: string) =>
	changeset(commits(revises, { label: "revised" }).out.lane, { label: "pr" })
		.out.changeset;

export const slice = composition(
	"slice",
	{
		doc: [
			"Build a request, review it at the tier's depth and fix what the review upholds.",
			"At ordinary and risky, a tester writes the spec's tests first and the build starts from them.",
			"Each round repairs until the target's checks pass, then reviews; up to maxFixes fix rounds follow.",
			"Leaves the changeset, the findings the last review upheld and a writer's PR body: over the PR it revises",
			"when given, empty when the writer failed. Fails when the changeset holds no patch.",
		].join("\n"),
		params: {
			request: Text({ description: "The brief: what to build" }),
			tier: Enum(TIERS, { description: "How deep the review goes" }),
			maxRepairs,
			maxFixes,
			revises: Text({
				default: "",
				description:
					"Git revisions of the target holding the PR this build revises, such as C^!; empty for a fresh build",
			}),
		},
		examples: [
			{
				request: "Make greet.sh greet the name given as its first argument.",
				tier: "small",
			},
		],
	},
	({ request, tier, maxRepairs, maxFixes, revises }) => {
		const spec = markdownOf(request, "request");
		const { built, map, overrules } = build(tier, request, spec);
		const reviewed =
			tier === "small"
				? smallLoop(built, spec, maxRepairs, maxFixes)
				: use(
						fixUntilClean,
						{
							lane: built.out.lane,
							session: built.out.session,
							spec,
							brief: briefFrom(built.out.report),
						},
						{
							params: {
								maxFixes,
								maxRepairs,
								checks: REPO_CHECKS,
								fix: FIX_CHECK,
								...panelParams(tier),
							},
						},
					);
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
				spec: { artifact: spec, hint: "first, for what the change had to do" },
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
				...(map && { map }),
				...(overrules && { overrules }),
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
			out: { changeset: Dir(), upheld: Markdown(), pr: Markdown() },
			label: "result",
			tolerate: "rejected",
		});
	},
);
