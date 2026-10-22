import { expect, test } from "bun:test";
import {
	firstDuplicate,
	formatExpansion,
	formatInstance,
	itemKey,
	parseExpansion,
	parseInstance,
} from "./index";

test.each<[string[], string]>([
	[[], ""],
	[["risk"], "[risk]"],
	[["risk", "2"], "[risk][2]"],
	[["a.b-c_D9", ""], "[a.b-c_D9][]"],
])("expansion %j round-trips through %j", (keys, expansion) => {
	expect(formatExpansion(keys)).toBe(expansion);
	expect(parseExpansion(expansion)).toEqual(keys);
});

test.each(["risk", "[risk", "[a]b", "[a/b]", "[a[b]]", "[a b]", "[é]"])(
	"%j is not an expansion path",
	(expansion) => {
		expect(parseExpansion(expansion)).toBeUndefined();
	},
);

test("an unsanitized key cannot be formatted", () => {
	expect(() => formatExpansion(["ok", "a/b"])).toThrow(
		"expansion key 'a/b' is not sanitized",
	);
});

test.each<[unknown, string]>([
	["risk", "risk"],
	["src/a b.ts", "src_a_b.ts"],
	["héllo👋", "h_llo_"],
	[3, "3"],
	["3", "3"],
	[-1.5, "-1.5"],
	[true, "true"],
	[null, "null"],
	[{ id: "x" }, "7"],
	[["x"], "7"],
])("item %j at index 7 is keyed %j", (item, key) => {
	expect(itemKey(item, 7)).toBe(key);
});

test("keys that sanitize alike are equal, so the number 3 and the string '3' collide", () => {
	expect(itemKey(3, 0)).toBe(itemKey("3", 1));
	expect(itemKey("a/b", 0)).toBe(itemKey("a b", 1));
});

test.each<[string, string, string[], string]>([
	["outside groups", "best", [], "best"],
	["one map", "lens/skeptic", ["lens"], "lens[risk]/skeptic"],
	["nested groups", "a/b/c", ["a", "a/b"], "a[risk]/b[2]/c"],
	["a scope between", "a/s/b/c", ["a", "a/s/b"], "a[risk]/s/b[2]/c"],
])("an instance is shown merged: %s", (_, node, groups, shown) => {
	const keys = ["risk", "2"].slice(0, groups.length);
	expect(
		formatInstance({ node, expansion: formatExpansion(keys) }, groups),
	).toBe(shown);
});

const NESTED = (node: string) =>
	({ "a/b/c": ["a", "a/b"], "a/b": ["a"], a: [] })[node] ?? [];

test.each<[string, ReturnType<typeof parseInstance>]>([
	["a/b/c", { node: "a/b/c", keys: [] }],
	["a[x]/b/c", { node: "a/b/c", keys: ["x"] }],
	["a[x]/b[3]/c", { node: "a/b/c", keys: ["x", "3"] }],
	["a/b[3]/c", undefined],
	["a/b/c[3]", undefined],
	["a[x][3]/b/c", undefined],
	["a[x y]/b/c", undefined],
	["a[x]/b[3]/c[4]", undefined],
])("the instance id %s is read as %j", (text, parsed) => {
	expect(parseInstance(text, NESTED)).toEqual(parsed);
});

test("an instance whose expansion does not fit its groups cannot be shown", () => {
	expect(() => formatInstance({ node: "a/b", expansion: "" }, ["a"])).toThrow(
		"expansion '' of 'a/b' does not have one key per group (1)",
	);
	expect(() =>
		formatInstance({ node: "a/b", expansion: "risk" }, ["a"]),
	).toThrow();
});

test.each<[string[], ReturnType<typeof firstDuplicate>]>([
	[[], undefined],
	[["a", "b"], undefined],
	[["a", "b", "a", "b"], { key: "a", first: 0, second: 2 }],
])("the first duplicate of %j is %j", (keys, duplicate) => {
	expect(firstDuplicate(keys)).toEqual(duplicate);
});
