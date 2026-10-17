import { expect, test } from "bun:test";
import type { Host, NodeKind } from "./host";
import { hostSetup } from "./host";
import { kindLookup } from "./shared";

const kind = (name: string): NodeKind => ({
	name,
	config: { type: "object" },
	ports: () => ({ in: {}, out: {} }),
	execute: async () => ({ outcome: "ok", outputs: {} }),
	cancel: async () => {},
});

const host = (
	name: string,
	namespaces: string[],
	...kinds: NodeKind[]
): Host => ({
	name,
	kinds,
	types: [],
	config: Object.fromEntries(namespaces.map((ns) => [ns, { type: "object" }])),
	validate: () => [],
	bounds: () => ({}),
	environment: () => ({}),
});

test("a host's setup holds its own config namespaces and store, and no other's", () => {
	const config = {
		values: { a: { n: 1 }, b: { n: 2 }, dataRoot: "/data" },
		sources: [],
	};
	expect(hostSetup(host("a", ["a", "unset"]), config)).toEqual({
		config: { a: { n: 1 }, unset: {} },
		store: "/data/hosts/a",
	});
	expect(hostSetup(host("b", ["b"]), config)).toEqual({
		config: { b: { n: 2 } },
		store: "/data/hosts/b",
	});
});

test("a kind name resolves to its host and kind across hosts", () => {
	const two = kind("a.two");
	const a = host("a", [], kind("a.one"), two);
	const b = host("b", [], kind("b.one"));
	const lookup = kindLookup([a, b]);
	expect(lookup("a.two")?.host).toBe(a);
	expect(lookup("a.two")?.kind).toBe(two);
	expect(lookup("b.one")?.host).toBe(b);
	expect(lookup("c.one")).toBeUndefined();
});
