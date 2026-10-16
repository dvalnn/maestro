import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type Ir, parseIr, TS_RUNTIME } from "@maestro/ir";
import type { Host, NodeKind } from "../../host";
import type { CodeFunction, KeyFunction, LoadCode } from "../../worker";
import { type ComposeInput, compose } from "../index";

const GOLDEN = resolve(import.meta.dir, "../../../../ir/fixtures");
const TEST_MODULE = "test.ts";
const STDLIB_MODULE = "maestro:stdlib";

const kind = (name: string): NodeKind => ({
	name,
	config: { type: "object" },
	outcomes: ["ok", "rejected", "failed"],
	cacheable: false,
	ports: (node) => ({ in: node.in ?? {}, out: node.out ?? {} }),
	execute: () => Promise.reject(new Error("compose starts no host node")),
	cancel: () => Promise.resolve(),
});

/** A host named `fake` with the kinds `fake.task` and `fake.check`, claiming config namespace `fake`. */
export function fakeHost(over: Partial<Host> = {}): Host {
	return {
		name: "fake",
		kinds: [kind("fake.task"), kind("fake.check")],
		types: [],
		config: {
			fake: { type: "object", properties: { retries: { type: "integer" } } },
		},
		validate: () => [],
		bounds: () => ({}),
		environment: () => ({}),
		...over,
	};
}

/** The function of a `test.ts` export a test does not give, which throws when called. */
const unset = (name: string) => () => {
	throw new Error(`'${name}' is not given to this test`);
};

/** Stand-ins for the stdlib exports the fixtures name. The real stdlib is the SDK's, which core does not depend on. */
const STDLIB: Readonly<Record<string, CodeFunction>> = {
	firstOk: unset("firstOk"),
	pick: unset("pick"),
};

/**
 * Loads a worker reference from `functions` by export name. Else it loads a `test.ts` export as `unset`, a
 * `maestro:stdlib` export from `STDLIB`, and any other module from the golden fixtures directory of ir.
 */
export function loader(
	functions: Readonly<Record<string, CodeFunction | KeyFunction>> = {},
): LoadCode {
	return async (ref) => {
		const own = functions[ref.export];
		if (own) return own;
		if (ref.module === TEST_MODULE) return unset(ref.export);
		const module =
			ref.module === STDLIB_MODULE
				? STDLIB
				: await import(resolve(GOLDEN, ref.module));
		const fn = module[ref.export];
		if (typeof fn !== "function")
			throw new Error(`'${ref.module}' has no export '${ref.export}'`);
		return fn;
	};
}

/** An IR that `parseIr` accepts. */
export function valid(value: unknown): Ir {
	const parsed = parseIr(value);
	if (!parsed.ok)
		throw new Error(parsed.diagnostics.map((d) => d.message).join("\n"));
	return parsed.ir;
}

/** A golden IR fixture of ir, by file name. */
export const golden = async (name: string) =>
	valid(await Bun.file(resolve(GOLDEN, name)).json());

/** The SDK-built IR committed beside this file, by file name. */
export const sdkBuilt = async (name: string) =>
	valid(await Bun.file(resolve(import.meta.dir, name)).json());

/** Composes `ir` with the fake host, the golden loader, no config and no caps, unless `over` says otherwise. */
export const composeWith = (ir: Ir, over: Partial<ComposeInput> = {}) =>
	compose({
		ir,
		params: ir.params.examples[0] ?? {},
		config: {},
		core: {},
		hosts: [fakeHost()],
		loadCode: loader(),
		caps: {},
		scratch: tmpdir(),
		...over,
	});

const STRING = { type: "string" };

export const HASH = `sha256:${"0".repeat(64)}`;

/** A code node whose worker is export `name` of a test module, pure unless `over` says otherwise. */
export const code = (id: string, name: string, over: object = {}) => ({
	id,
	kind: "code",
	worker: {
		runtime: TS_RUNTIME,
		module: TEST_MODULE,
		export: name,
		codeHash: HASH,
	},
	pure: true,
	out: { text: STRING },
	...over,
});

/** An edge carrying `port` of one node to the same port of another. */
export const data = (from: string, to: string, port = "text") => ({
	kind: "data",
	from: { node: from, port },
	to: { node: to, port },
});

/** A valid IR of `nodes` and `edges`, with `over` merged on top and the last node as its result. */
export const irOf = (
	nodes: object[],
	edges: object[] = [],
	over: object = {},
): Ir =>
	valid({
		irVersion: "1.0",
		composition: { id: "test", version: "0.1.0", pack: "test" },
		emitter: { name: "hand", version: "1" },
		params: { schema: { type: "object" }, examples: [{}] },
		scopes: [],
		nodes,
		edges,
		result: { node: (nodes.at(-1) as { id: string }).id },
		...over,
	});
