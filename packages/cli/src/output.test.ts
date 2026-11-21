import { describe, expect, test } from "bun:test";
import type { Diagnostic } from "@maestro/ir";
import { diagnosedExit, EXIT, table } from "./output";

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

describe("table fit", () => {
	const rows = [
		["id", "title", "tour"],
		["a1", "a long title indeed", "release-one"],
	];

	test("a table without a fit keeps every cell whole", () => {
		expect(table(rows).split("\n")[1]).toBe(
			"a1  a long title indeed  release-one",
		);
	});

	test("a table that fits is left whole", () => {
		const fit = { columns: 40, give: [{ column: 1, floor: 5 }] };
		expect(table(rows, false, fit)).toBe(table(rows));
	});

	test("the first named column gives way before the second", () => {
		const fit = {
			columns: 30,
			give: [
				{ column: 1, floor: 5 },
				{ column: 2, floor: 5 },
			],
		};
		expect(table(rows, false, fit).split("\n")[1]).toBe(
			"a1  a long title…  release-one",
		);
	});

	test("a column stops at its floor and the next gives way", () => {
		const fit = {
			columns: 20,
			give: [
				{ column: 1, floor: 5 },
				{ column: 2, floor: 5 },
			],
		};
		expect(table(rows, false, fit).split("\n")[1]).toBe("a1  a lo…  release-…");
	});
});
