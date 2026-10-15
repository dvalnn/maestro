import irSchema from "../ir.schema.json";
import { EXPANSION_PATTERN } from "./expansion";
import type { JsonSchema } from "./types";

/** The runtime value of an artifact port (ADR 0007). Its rules are in README.md, "Type markers". */
export type ArtifactRef = {
	path: string;
	contentHash: string;
	producer?: { node: string; expansion: string };
};

// A path segment has no `/`, `\` or control character, and is not `.` or `..`. The pattern avoids lookahead, so
// any JSON Schema validator reads it.
const CHAR = String.raw`[^/\\\x00-\x1f\x7f]`;
const NOT_DOT = String.raw`[^/\\.\x00-\x1f\x7f]`;
const SEGMENT = String.raw`(?:${NOT_DOT}${CHAR}*|\.${NOT_DOT}${CHAR}*|\.\.${CHAR}+)`;

/** The JSON Schema of `ArtifactRef`, closed to its fields, with the path and hash rules. */
export const artifactRefSchema = {
	type: "object",
	required: ["path", "contentHash"],
	additionalProperties: false,
	properties: {
		path: { type: "string", pattern: `^${SEGMENT}(?:/${SEGMENT})*$` },
		contentHash: {
			type: "string",
			pattern: irSchema.$defs.contentHash.pattern,
		},
		producer: {
			type: "object",
			required: ["node", "expansion"],
			additionalProperties: false,
			properties: {
				node: { type: "string", pattern: irSchema.$defs.id.pattern },
				expansion: { type: "string", pattern: EXPANSION_PATTERN },
			},
		},
	},
} as const satisfies Exclude<JsonSchema, boolean>;
