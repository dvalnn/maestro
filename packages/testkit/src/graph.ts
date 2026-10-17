import {
	type ComposeInput,
	type ComposeResult,
	compose,
} from "@maestro/core/compose";
import type { CodeEntry } from "@maestro/core/worker";
import { type Ir, TS_RUNTIME } from "@maestro/ir";
import type { Composition, Types } from "@maestro/sdk";
import { build, type CodeFn } from "@maestro/sdk/loader";
import { fakeHost } from "./fake-host";

/** The data root a composed graph is given unless a test gives its own. */
const TEST_DATA_ROOT = "/data";

const TEST_MODULE = "test.ts";
const ZERO_HASH = `sha256:${"0".repeat(64)}`;

/** An IR's size by node kind and by edge kind. */
export type Shape = {
	nodes: number;
	kinds: Readonly<Record<string, number>>;
	edges: Readonly<Record<string, number>>;
};

const tally = (names: readonly string[]) => {
	const counts: Record<string, number> = {};
	for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
	return counts;
};

/** The node count of `ir`, and how many nodes and edges each kind has. */
export function shapeOf(ir: Ir): Shape {
	return {
		nodes: ir.nodes.length,
		kinds: tally(ir.nodes.map((n) => n.kind)),
		edges: tally(ir.edges.map((e) => e.kind)),
	};
}

/**
 * Builds `root` with `params` into its IR, naming each function of `code` as an export of `test.ts`.
 * @throws `BuildError` for any build diagnostic.
 */
export function buildIr<P extends Types, R>(
	root: Composition<P, Types, R>,
	params: Parameters<typeof build<P, R>>[1] = {},
	code: Readonly<Record<string, CodeFn>> = {},
): Ir {
	const exports = new Map<CodeFn, string>(
		Object.entries(code).map(([name, fn]) => [fn, name]),
	);
	return build(root, params, {
		pack: { id: "test", version: "0.1.0" },
		resolveCode: (fn) => {
			const name = exports.get(fn);
			return name === undefined
				? undefined
				: {
						runtime: TS_RUNTIME,
						module: TEST_MODULE,
						export: name,
						codeHash: ZERO_HASH,
					};
		},
	});
}

/**
 * Composes `ir` under the fake host, with no packs and no caps, and every worker reference loading as a function that
 * returns nothing. `over` replaces any of that.
 */
export function composeIr(
	ir: Ir,
	over: Partial<ComposeInput> = {},
): Promise<ComposeResult> {
	const noop: CodeEntry = () => ({});
	return compose({
		ir,
		config: { values: { dataRoot: TEST_DATA_ROOT }, sources: [] },
		core: { dataRoot: { type: "string" } },
		packs: {},
		hosts: [fakeHost()],
		loadCode: async () => noop,
		caps: {},
		...over,
	});
}
