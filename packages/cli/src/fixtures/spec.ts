// A bare composition: reads a Markdown spec, then a gate reads it again, failing while the file `stop` names exists.
import { existsSync, readFileSync } from "node:fs";
import {
	type ArtifactRef,
	type CodeContext,
	code,
	composition,
	JsonFile,
	List,
	Markdown,
	Optional,
	Text,
} from "@maestro/sdk";

export function read(inputs: { spec: ArtifactRef }, ctx: CodeContext) {
	return { text: readFileSync(ctx.path(inputs.spec), "utf8") };
}

export function gate(
	inputs: { spec: ArtifactRef; text: string; stop: string },
	ctx: CodeContext,
) {
	if (existsSync(inputs.stop)) throw new Error("stopped");
	const again = readFileSync(ctx.path(inputs.spec), "utf8");
	return { text: `${inputs.text}|${again}` };
}

export const spec = composition(
	"spec",
	{
		params: {
			spec: Markdown(),
			stop: Text({ default: "" }),
			items: Optional(JsonFile(List(Text()))),
		},
		examples: [{}],
	},
	({ spec, stop }) => {
		const first = code(read, { in: { spec }, out: { text: Text() } });
		return code(gate, {
			in: { spec, text: first.out.text, stop },
			out: { text: Text() },
		});
	},
);
