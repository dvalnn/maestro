import { expect, test } from "bun:test";
import { validator, violations } from "./index";

test("violations name a key containing tilde and slash as written", () => {
	const schema = {
		type: "object",
		properties: { "a~1b/c": { type: "string" } },
	};
	const paths: string[][] = [];
	const report = violations(
		validator(),
		schema,
		{ "a~1b/c": 7 },
		(segments) => {
			paths.push(segments);
			return JSON.stringify(segments);
		},
	);

	expect(report).toHaveLength(1);
	expect(paths).toEqual([["a~1b/c"]]);
});
