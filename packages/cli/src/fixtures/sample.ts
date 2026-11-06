// A composition whose required file param its example set gives as a sample file beside this source.

import { readFileSync } from "node:fs";
import {
	type ArtifactRef,
	type CodeContext,
	code,
	composition,
	Markdown,
	Text,
} from "@maestro/sdk";

export function read(inputs: { doc: ArtifactRef }, ctx: CodeContext) {
	return { text: readFileSync(ctx.path(inputs.doc), "utf8") };
}

export const sample = composition(
	"sample",
	{
		params: { doc: Markdown() },
		examples: [{ doc: "sample.md" }],
	},
	({ doc }) => code(read, { in: { doc }, out: { text: Text() } }),
);
