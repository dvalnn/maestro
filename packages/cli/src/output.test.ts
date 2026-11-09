import { describe, expect, test } from "bun:test";
import type { Diagnostic } from "@maestro/ir";
import { diagnosedExit, EXIT } from "./output";

const diagnostic = (extra: Partial<Diagnostic>): Diagnostic => ({
	code: "CFG.param",
	severity: "error",
	message: "m (from -c a)",
	hint: "h",
	...extra,
});

describe("diagnosedExit", () => {
	test.each([
		["a flag", { layer: "flag" }, EXIT.usage],
		[
			"a flag a resume reapplies",
			{ layer: "flag", concert: "7f3c2a" },
			EXIT.failed,
		],
		["a file", { layer: "workspace" }, EXIT.failed],
		["a preset", { layer: "preset" }, EXIT.failed],
		["the example set", { layer: "example" }, EXIT.failed],
		["a default", { layer: "default" }, EXIT.failed],
		["no layer", {}, EXIT.failed],
	] as const)("exits by %s, not by the message", (_, extra, exit) =>
		expect(diagnosedExit([diagnostic({ ...extra })])).toBe(exit),
	);
});
