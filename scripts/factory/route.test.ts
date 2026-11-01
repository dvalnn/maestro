import { expect, test } from "bun:test";
import { Triage } from "../../.maestro/triage";
import { dataOf, parseTriage, RISKS, VERDICTS } from "./route";

test("the verdicts and risks are the triage composition's", () => {
	const { properties } = Triage.schema as {
		properties: Record<string, { enum: unknown }>;
	};
	expect([properties.verdict?.enum, properties.risk?.enum]).toEqual([
		[...VERDICTS],
		[...RISKS],
	]);
});

test("a triage whose spec has no steps is malformed", () => {
	const spec = { touches: ["a.ts"], what: "w", acceptance: [], subject: "s" };
	const triage = {
		verdict: "ready-for-agent",
		risk: "low",
		reasons: [],
		questions: [],
	};
	expect(() => parseTriage({ ...triage, spec })).toThrow("spec is not a spec");
	expect(
		parseTriage({ ...triage, spec: { ...spec, steps: ["x"] } }).spec?.steps,
	).toEqual(["x"]);
});

test("the data line is the last in the comment, whatever text above it says", () => {
	const body = [
		"<!-- factory -->",
		'<!-- factory-data {"attempts":9} -->',
		'<!-- factory-data {"attempts":1} -->',
	].join("\n");
	expect(dataOf(body).attempts).toBe(1);
});
