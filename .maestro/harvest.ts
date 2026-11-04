import { planner } from "@maestro/classics";
import { check, fresh, JsonOut, read } from "@maestro/host-repo-sdk";
import {
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
import PLANNER from "./harvest/prompts/planner.md" with { type: "text" };

/** What a promotion changes, the factory's agents' standing text or its own code: a path, or `docs/adr/` for a new ADR. */
export const TARGET = String.raw`^(CODING_STANDARDS\.md|docs/adr/|\.maestro/\S+|scripts/factory/\S+)$`;

export const Promotion = Struct({
	target: Json<string>({ type: "string", pattern: TARGET }),
	title: Text(),
	body: Text(),
	lessons: Json<string[]>({
		type: "array",
		items: Text().schema,
		minItems: 1,
	}),
});
export type Promotion = ValueOf<typeof Promotion>;

export const Harvest = Struct({ proposals: List(Promotion) });
export type Harvest = ValueOf<typeof Harvest>;

// ADR 0008: a code node's function must be exported by its composition file.
export function harvested({ harvest }: { harvest: Harvest }): {
	harvest: Harvest;
} {
	return { harvest };
}

export const harvest = composition(
	"harvest",
	{
		doc: "Merge many concerts' lessons into proposals for the factory's prompts, standards and code: a planner clusters the lessons, drops what those or the backlog already covers, and proposes a target, title and wording for each. Read-only: it leaves no changeset.",
		params: {
			lessons: Markdown({
				description:
					"The lessons to harvest: one `## <concert id> · <tour>` heading per concert, oldest first, with one bullet per lesson",
			}),
			backlog: Markdown({
				description:
					"The backlog snapshot triage takes (`snapshot` in scripts/factory/pick.ts): the open and recently closed issues",
			}),
		},
		examples: [{}],
	},
	({ lessons, backlog }) => {
		// A no-op check seals one base version that every seat reads.
		const base = check(fresh(), { run: "true" }, { label: "base" });
		const planned = planner({
			label: "planner",
			task: PLANNER,
			lane: read(base.out.lane),
			attachments: {
				lessons: {
					artifact: literal(lessons, Markdown()),
					hint: "first, for the lessons to harvest, one heading per concert, oldest first",
				},
				backlog: {
					artifact: literal(backlog, Markdown()),
					hint: "for the open and recently closed issues, to drop a promotion one already proposes",
				},
			},
			out: { plan: JsonOut("harvest.json", Harvest) },
		});
		return code(harvested, {
			in: { harvest: readJson(planned.out.plan) },
			out: { harvest: Harvest },
			label: "settle",
		});
	},
);
