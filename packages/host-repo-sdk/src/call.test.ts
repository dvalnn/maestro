import { expect, test } from "bun:test";
import { CORE_TYPES, MAESTRO_TYPE } from "@maestro/ir";
import { type CallConfig, callProblems } from "./call";

const FILE = { [MAESTRO_TYPE]: CORE_TYPES.file };
const MARKDOWN = { [MAESTRO_TYPE]: CORE_TYPES.markdown };
const TEXT = { type: "string" };
const att = (...names: string[]) =>
	Object.fromEntries(names.map((n) => [n, {}]));

test.each<[string, CallConfig, [string, string, string][]]>([
	[
		"a clean call, with a Markdown relay and a JSON reply",
		{
			attachments: att("spec"),
			relay: [{ name: "Notes", schema: MARKDOWN }],
			out: att("notes"),
			reply: { map: TEXT },
		},
		[],
	],
	[
		"an attachment named an own port",
		{ attachments: att("lane") },
		[["name", "attachment", "lane"]],
	],
	[
		"an attachment named previous",
		{ attachments: att("previous") },
		[["name", "attachment", "previous"]],
	],
	[
		"a relay named an own port",
		{ relay: [{ name: "prompt", schema: TEXT }] },
		[["name", "relay", "prompt"]],
	],
	[
		"a relay named after an attachment",
		{ attachments: att("spec"), relay: [{ name: "spec", schema: TEXT }] },
		[["name", "relay", "spec"]],
	],
	[
		"a relay named twice",
		{
			relay: [
				{ name: "a", schema: TEXT },
				{ name: "a", schema: TEXT },
			],
		},
		[["name", "relay", "a"]],
	],
	[
		"an output named an own port",
		{ out: att("report") },
		[["name", "output", "report"]],
	],
	[
		"a reply field named an own port",
		{ reply: { staged: TEXT } },
		[["name", "reply", "staged"]],
	],
	[
		"a reply field named an envelope key",
		{ reply: { blocked: TEXT } },
		[["name", "reply", "blocked"]],
	],
	[
		"a reply field named after an output",
		{ out: att("notes"), reply: { notes: TEXT } },
		[["name", "reply", "notes"]],
	],
	[
		"a relay of an artifact",
		{ relay: [{ name: "tree", schema: FILE }] },
		[["type", "relay", "tree"]],
	],
	[
		"a relay of a struct holding Markdown",
		{
			relay: [
				{
					name: "held",
					schema: { type: "object", properties: { doc: MARKDOWN } },
				},
			],
		},
		[["type", "relay", "held"]],
	],
	[
		"a reply field holding an artifact",
		{ reply: { file: FILE } },
		[["type", "reply", "file"]],
	],
	[
		"a name problem hides the same entry's type problem",
		{ relay: [{ name: "lane", schema: FILE }] },
		[["name", "relay", "lane"]],
	],
	[
		"problems across fields, in attachment, relay, output, reply order",
		{
			attachments: att("session"),
			relay: [{ name: "tree", schema: FILE }],
			out: att("lane"),
			reply: { file: FILE },
		},
		[
			["name", "attachment", "session"],
			["type", "relay", "tree"],
			["name", "output", "lane"],
			["type", "reply", "file"],
		],
	],
])("%s", (_, config, triples) => {
	expect(callProblems(config).map((p) => [p.rule, p.field, p.name])).toEqual(
		triples,
	);
});
