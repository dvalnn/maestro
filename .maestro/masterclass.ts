import { readFileSync } from "node:fs";
import { planner } from "@maestro/classics";
import { JsonOut, read } from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	type CodeContext,
	code,
	composition,
	Json,
	List,
	literal,
	Markdown,
	readJson,
	Struct,
	Text,
	type ValueOf,
} from "@maestro/sdk";
import PLANNER from "./masterclass/prompts/planner.md" with { type: "text" };
import PLAIN from "./prompts/_plain.md" with { type: "text" };
import { sealedBase, task } from "./shared";

/** What a promotion changes: a path, or `docs/adr/` for a new ADR. */
export const TARGET = String.raw`^(CODING_STANDARDS\.md|docs/adr/|justfile|\.maestro/\S+|scripts/factory/\S+)$`;

export const Promotion = Struct({
	target: Json<string>({ type: "string", pattern: TARGET }),
	title: Text(),
	body: Text(),
	lessons: Json<string[]>({
		type: "array",
		items: Text().schema,
		minItems: 1,
	}),
	concerts: Json<string[]>({ type: "array", items: Text().schema }),
});
export type Promotion = ValueOf<typeof Promotion>;

export const Masterclass = Struct({ proposals: List(Promotion) });
export type Masterclass = ValueOf<typeof Masterclass>;

// ADR 0008: a code node's function must be exported by its composition file.
export function settle(
	{
		masterclass,
		lessons,
	}: {
		masterclass: Masterclass;
		lessons: ArtifactRef;
	},
	ctx: CodeContext,
): {
	masterclass: Masterclass;
} {
	const headings = [
		...readFileSync(ctx.path(lessons), "utf8").matchAll(/^## (.+?) · (.*)$/gm),
	];
	const named = new Set(headings.map((m) => m[1]));
	const read = new Set(
		headings.filter((m) => m[2]?.endsWith(" · read")).map((m) => m[1]),
	);
	return {
		masterclass: {
			proposals: masterclass.proposals
				.map((p) => ({
					...p,
					concerts: [...new Set(p.concerts)].filter((id) => named.has(id)),
				}))
				// Dropped, not refused: docs/agents/factory.md#masterclass.
				.filter((p) => p.concerts.some((id) => !read.has(id))),
		},
	};
}

export const masterclass = composition(
	"masterclass",
	{
		doc: [
			"Merge many concerts' lessons into proposals for the factory. Read-only: it leaves no changeset.",
			"A planner clusters the lessons, drops what they or the backlog already cover, and proposes a target, title and",
			"wording for each: a prompt, standard, composition, config, check or code.",
		].join("\n"),
		params: {
			lessons: Markdown({
				description:
					"The lessons to merge: one `## <concert id> · <tour>` heading per concert, oldest first, with one bullet per lesson; ` · read` ends the heading of a concert an earlier masterclass read",
			}),
			backlog: Markdown({
				description:
					"The backlog snapshot triage takes (`snapshot` in scripts/factory/pick.ts): the open and recently closed issues",
			}),
		},
		examples: [{}],
	},
	({ lessons, backlog }) => {
		const base = sealedBase();
		const planned = planner({
			label: "planner",
			task: task(PLANNER, PLAIN),
			lane: read(base),
			attachments: {
				lessons: {
					artifact: literal(lessons, Markdown()),
					hint: "first, for the lessons to merge, one heading per concert, oldest first, a heading ending in `· read` marking a concert an earlier masterclass read",
				},
				backlog: {
					artifact: literal(backlog, Markdown()),
					hint: "for the open and recently closed issues, to drop a promotion one already proposes",
				},
			},
			out: { plan: JsonOut("masterclass.json", Masterclass) },
		});
		return code(settle, {
			in: { masterclass: readJson(planned.out.plan), lessons },
			out: { masterclass: Masterclass },
			label: "settle",
		});
	},
);
