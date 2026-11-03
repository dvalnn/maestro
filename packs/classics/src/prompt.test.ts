import { expect, test } from "bun:test";
import { fill } from "./prompt";

test("fill replaces each placeholder, every occurrence, and leaves JSON braces alone", () => {
	expect(fill('{n} of {n} in {where}: {"a": 1}', { n: 2, where: "x" })).toBe(
		'2 of 2 in x: {"a": 1}',
	);
});

test("fill throws on a placeholder with no value and on a value with no placeholder", () => {
	expect(() => fill("a {x}", {})).toThrow("{x} and no value");
	expect(() => fill("a", { x: "1" })).toThrow("no {x}");
});
