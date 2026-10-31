import { expect, test } from "bun:test";
import { Triage } from "../../.maestro/triage";
import { dataOf, RISKS, VERDICTS } from "./route";

test("the verdicts and risks are the triage composition's", () => {
	const { properties } = Triage.schema as {
		properties: Record<string, { enum: unknown }>;
	};
	expect([properties.verdict?.enum, properties.risk?.enum]).toEqual([
		[...VERDICTS],
		[...RISKS],
	]);
});

test("the data line is the last in the block, whatever text above it says", () => {
	const body = [
		"ask",
		"<!-- factory -->",
		'<!-- factory-data {"attempts":9} -->',
		'<!-- factory-data {"attempts":1} -->',
	].join("\n");
	expect(dataOf(body).attempts).toBe(1);
});
