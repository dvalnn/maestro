import { expect, test } from "bun:test";
import { parseLayer } from "./config/index";
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

test("a host's setup holds its own config namespaces, their sources, layers and command-line part, its store and the roots, and no other's", () => {
	const a = { path: ["a", "n"], source: { layer: "workspace" as const } };
	const b = { path: ["b", "n"], source: { layer: "flag" as const } };
	const config = {
		values: { a: { n: 1 }, b: { n: 2 }, dataRoot: "/data" },
		sources: [a, b],
		replaced: [["b"]],
		layers: [
			parseLayer("a: { n: 1 }\nb: { n: 2 }\n", {
				file: "/w/config.yaml",
				layer: "workspace",
			}),
		],
	};
	const roots = { workspace: "/w", user: "/u", packs: { p: "/p" } };
	const setupOf = (h: Host) => {
		const { layers, ...setup } = hostSetup(h, config, roots);
		return { ...setup, layers: layers.map((l) => [...l.entries.keys()]) };
	};
	expect(setupOf(host("a", ["a", "unset"]))).toEqual({
		config: { a: { n: 1 }, unset: {} },
		sources: [a],
		layers: [["a"]],
		commandLine: { values: {}, replaced: [] },
		store: "/data/hosts/a",
		roots,
	});
	expect(setupOf(host("b", ["b"]))).toEqual({
		config: { b: { n: 2 } },
		sources: [b],
		layers: [["b"]],
		commandLine: { values: { b: { n: 2 } }, replaced: [["b"]] },
		store: "/data/hosts/b",
		roots,
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
