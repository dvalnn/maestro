import {
	type Diagnostic,
	type Ir,
	type IrNode,
	TS_RUNTIME,
	type WorkerRef,
} from "@maestro/ir";
import {
	type BuildContext,
	BuildError,
	build,
	type Composition,
	composition,
	type Types,
	type Values,
} from "../index";
import * as workers from "./workers";

const refs = new Map<unknown, WorkerRef>(
	Object.entries(workers).map(([name, fn]) => [
		fn,
		{
			runtime: TS_RUNTIME,
			module: "workers.ts",
			export: name,
			codeHash: `sha256:${"0".repeat(64)}`,
		},
	]),
);

/** A test resolver: names the exports of `workers.ts`, and nothing else. */
export const context: BuildContext = {
	pack: { id: "fixtures", version: "0.1.0" },
	resolveCode: (fn) => refs.get(fn),
};

/** Builds `root` with the test context. */
export const buildValid = <P extends Types, R>(
	root: Composition<P, Types, R>,
	params: Partial<Values<P>> = {},
) => build(root, params, context);

/** The IR of a one-off composition without params whose build function is `fn`. */
export const buildOf = (fn: () => unknown) =>
	buildValid(composition("t", { examples: [{}] }, fn));

/** The diagnostic of the `BuildError` that `fn` throws. */
export function diagnose(fn: () => unknown): Diagnostic {
	try {
		fn();
	} catch (error) {
		if (error instanceof BuildError) return error.diagnostic;
		throw error;
	}
	throw new Error("expected a BuildError, and none was thrown");
}

/** The IR node with `id`. */
export function nodeOf(ir: Ir, id: string): IrNode {
	const found = ir.nodes.find((n) => n.id === id);
	if (!found)
		throw new Error(
			`no node '${id}' in [${ir.nodes.map((n) => n.id).join(", ")}]`,
		);
	return found;
}
