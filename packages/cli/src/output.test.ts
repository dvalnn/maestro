import { describe, expect, test } from "bun:test";
import type { Diagnostic } from "@maestro/ir";
import type { Deps } from "./command";
import { diagnosedExit, EXIT, jsonOf, paint, table, wrapping } from "./output";

// Seam: the one-document JSON text the shared formatter returns for the command's stdout.
const formatJson: (value: unknown, deps: Deps) => string = jsonOf;
const jsonDeps: Deps = {
	hosts: [],
	cwd: "/",
	env: {},
	stdout: () => {},
	stdoutBytes: () => {},
	stderrBytes: () => {},
	stderr: () => {},
	self: [],
};
const jsonValue = { outputs: { text: "first\nsecond", count: 2 }, ok: true };

test("a JSON document off a terminal is compact and keeps its value", () => {
	const shown = formatJson(jsonValue, jsonDeps);
	expect(shown).toBe(
		'{"outputs":{"text":"first\\nsecond","count":2},"ok":true}',
	);
	expect(JSON.parse(shown)).toEqual({
		outputs: { text: "first\nsecond", count: 2 },
		ok: true,
	});
});

test("a JSON document on a terminal is indented by two spaces and keeps its value", () => {
	const shown = formatJson(jsonValue, {
		...jsonDeps,
		terminal: () => ({ columns: 20, rows: 24 }),
	});
	expect(shown).toBe(
		'{\n  "outputs": {\n    "text": "first\\nsecond",\n    "count": 2\n  },\n  "ok": true\n}',
	);
	expect(JSON.parse(shown)).toEqual({
		outputs: { text: "first\nsecond", count: 2 },
		ok: true,
	});
});

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

// Seams: the text returned by paint and table for terminal output.
test("paint leaves empty text empty with color on or off", () => {
	expect(paint("dim", "", true)).toBe("");
	expect(paint("bold", "", true)).toBe("");
	expect(paint("dim", "", false)).toBe("");
});

test("a table leaves no trailing padding for empty terminal headers and cells", () => {
	const rows = [
		["name", ""],
		["a", paint("dim", "", true)],
	];
	expect(table(rows, true)).toBe("\u001b[1mname\u001b[22m\na");
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

	test("a fitted painted cell keeps its visible width and ends its style", () => {
		const rows = [
			["id", "v"],
			["a", "\u001b[2mabcdefgh\u001b[22m"],
		];
		const fit = { columns: 8, give: [{ column: 1, floor: 2 }] };
		expect(table(rows, false, fit)).toBe("id  v\na   \u001b[2mabc…\u001b[0m");
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

describe("table wraps its last column under itself", () => {
	// Seam: the lines `table` returns at a width narrower than 20 cells, where the last column keeps only what is left.
	test("a last column left few cells wraps at those cells and every line fits the width", () => {
		expect(
			table([["a", "one two three four five six"]], false, wrapping(10)),
		).toBe("a  one two\n   three\n   four\n   five\n   six");
		// A newline in the text starts a line under the column too, never at the first.
		expect(table([["a", "one\ntwo three"]], false, wrapping(9))).toBe(
			"a  one\n   two\n   three",
		);
	});

	// Seam: the narrowest a last column breaks at, two cells: a wide character still advances there.
	test("a last column two cells wide breaks at two cells, and a narrower one breaks there too", () => {
		expect(table([["a", "ab cd"]], false, wrapping(5))).toBe("a  ab\n   cd");
		expect(table([["a", "中文字"]], false, wrapping(3))).toBe(
			"a  中\n   文\n   字",
		);
	});
});
