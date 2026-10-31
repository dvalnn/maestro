import { expect, test } from "bun:test";
import { Triage } from "../../.maestro/triage";
import { RISKS, VERDICTS } from "./route";

test("the verdicts and risks are the triage composition's", () => {
	const { properties } = Triage.schema as {
		properties: Record<string, { enum: unknown }>;
	};
	expect([properties.verdict?.enum, properties.risk?.enum]).toEqual([
		[...VERDICTS],
		[...RISKS],
	]);
});
