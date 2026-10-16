import { expect, test } from "bun:test";
import { type Host, kindLookup, type NodeKind } from "./host";

const kind = (name: string): NodeKind => ({
	name,
	config: { type: "object" },
	ports: () => ({ in: {}, out: {} }),
	execute: async () => ({ outcome: "ok", outputs: {} }),
	cancel: async () => {},
});

const host = (name: string, ...kinds: NodeKind[]): Host => ({
	name,
	kinds,
	types: [],
	config: {},
	validate: () => [],
	bounds: () => ({}),
	environment: () => ({}),
});

test("a kind name resolves to its host and kind across hosts", () => {
	const two = kind("a.two");
	const a = host("a", kind("a.one"), two);
	const b = host("b", kind("b.one"));
	const lookup = kindLookup([a, b]);
	expect(lookup("a.two")?.host).toBe(a);
	expect(lookup("a.two")?.kind).toBe(two);
	expect(lookup("b.one")?.host).toBe(b);
	expect(lookup("c.one")).toBeUndefined();
});

test("a kind registered twice is refused", () => {
	expect(() =>
		kindLookup([host("a", kind("x.one")), host("b", kind("x.one"))]),
	).toThrow(
		"node kind 'x.one' is registered twice, by host 'a' and by host 'b'\nLoad only one host that registers 'x.one'",
	);
});
