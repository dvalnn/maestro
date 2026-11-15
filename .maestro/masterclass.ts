import { readFileSync } from "node:fs";
import { planner } from "@maestro/classics";
import { read } from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	type CodeContext,
	code,
	composition,
	Json,
	List,
	Markdown,
	Optional,
	Struct,
	Text,
	type ValueOf,
} from "@maestro/sdk";
import { KINDS } from "./masterclass/kinds";
import PLANNER from "./masterclass/prompts/planner.md" with { type: "text" };
import PLAIN from "./prompts/_plain.md" with { type: "text" };
import { fileOf, sealedBase, task } from "./shared";

// ADR 0008: a code node's function must be exported by its composition file.
export * from "@maestro/classics/code";

/** What a promotion changes: a repo-relative path that neither starts with `/` nor holds `..`, `docs/adr/` for a new ADR. */
export const TARGET = String.raw`^(?!/)(?!.*\.\.).+$`;

const texts = (minItems = 0) => ({
	type: "array",
	items: Text().schema,
	minItems,
});

/**
 * A proposal: `kind` and `reports` may be absent in an older output, which reads as an enhancement merging no reports;
 * it merges at least one lesson or one report.
 */
export const Promotion = Json<{
	target: string;
	title: string;
	body: string;
	kind?: (typeof KINDS)[number];
	lessons: string[];
	reports?: string[];
	concerts: string[];
}>({
	type: "object",
	properties: {
		target: { type: "string", pattern: TARGET },
		title: Text().schema,
		body: Text().schema,
		kind: { type: "string", enum: [...KINDS] },
		lessons: texts(),
		reports: texts(),
		concerts: texts(),
	},
	required: ["target", "title", "body", "lessons", "concerts"],
	additionalProperties: false,
	anyOf: [
		{ properties: { lessons: texts(1) } },
		{ required: ["reports"], properties: { reports: texts(1) } },
	],
});
export type Promotion = ValueOf<typeof Promotion>;

export const Masterclass = Struct({ proposals: List(Promotion) });
export type Masterclass = ValueOf<typeof Masterclass>;

/** The concerts `files` have a heading for, and those an earlier masterclass read. */
function concertsIn(files: readonly string[]) {
	const headings = files.flatMap((f) => [...f.matchAll(/^## (.+?) · (.*)$/gm)]);
	const idsOf = (matches: RegExpMatchArray[]) =>
		new Set(matches.map((m) => m[1]));
	return {
		named: idsOf(headings),
		alreadyRead: idsOf(headings.filter((m) => m[2]?.endsWith(" · read"))),
	};
}

/**
 * The planner's proposals, each citing only concerts `lessons` or `reports` names, less any that cites no concert but
 * those an earlier masterclass read.
 */
export function settle(
	{
		masterclass,
		lessons,
		reports,
	}: {
		masterclass: Masterclass;
		lessons: ArtifactRef;
		reports?: ArtifactRef;
	},
	ctx: CodeContext,
): {
	masterclass: Masterclass;
} {
	const { named, alreadyRead } = concertsIn(
		[lessons, reports].flatMap((f) =>
			f ? [readFileSync(ctx.path(f), "utf8")] : [],
		),
	);
	return {
		masterclass: {
			proposals: masterclass.proposals
				.map((p) => ({
					...p,
					concerts: [...new Set(p.concerts)].filter((id) => named.has(id)),
				}))
				// Dropped, not refused: docs/agents/factory.md#masterclass.
				.filter((p) => p.concerts.some((id) => !alreadyRead.has(id))),
		},
	};
}

export const masterclass = composition(
	"masterclass",
	{
		doc: [
			"Merge many concerts' lessons, obstacles and sightings into proposals for the factory. Read-only: it leaves no",
			"changeset. A planner clusters them, drops what the backlog or the factory already covers, and proposes a kind,",
			"target, title and wording for each: a prompt, standard, composition, config, check or code.",
		].join("\n"),
		params: {
			lessons: Markdown({
				description:
					"The lessons to merge: one `## <concert id> · <tour>` heading per concert, oldest first, with one bullet per lesson; ` · read` ends the heading of a concert an earlier masterclass read",
			}),
			reports: Optional(
				Markdown({
					description:
						"The obstacles and sightings to merge, under the same concert headings as `lessons`, one bullet each; a sighting reads `path · cites · text`",
				}),
			),
			backlog: Markdown({
				description:
					"The backlog snapshot triage takes (`snapshot` in scripts/factory/pick.ts): the open and recently closed issues",
			}),
		},
		examples: [{}],
	},
	({ lessons, reports, backlog }) => {
		const base = sealedBase();
		const planned = planner({
			label: "planner",
			task: task(PLANNER, PLAIN),
			lane: read(base),
			attachments: {
				lessons: {
					artifact: fileOf(lessons, "lessons"),
					hint: "first, for the lessons to merge, one heading per concert, oldest first, a heading ending in `· read` marking a concert an earlier masterclass read",
				},
				...(reports && {
					reports: {
						artifact: fileOf(reports, "reports"),
						hint: "for the obstacles and sightings to merge, under the lessons' concert headings",
					},
				}),
				backlog: {
					artifact: fileOf(backlog, "backlog"),
					hint: "for the open and recently closed issues, to drop a promotion one already proposes",
				},
			},
			reply: { masterclass: Masterclass },
		});
		return code(settle, {
			in: {
				masterclass: planned.out.masterclass,
				lessons,
				...(reports && { reports }),
			},
			out: { masterclass: Masterclass },
			label: "settle",
		});
	},
);
