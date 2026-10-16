import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type AssertNode,
	boundOf,
	type CodeContext,
	type CodeNode,
	type Diagnostic,
	firstDuplicate,
	formatExpansion,
	formatInstance,
	type GraphIndex,
	type GroupNode,
	type Ir,
	type IrEdge,
	type IrNode,
	isGroup,
	itemKey,
	MAESTRO_TYPE,
	type MapNode,
	outputValue,
	type Settled,
	tolerates,
	type WorkerRef,
} from "@maestro/ir";
import { type PortCheck, type Validator, violations } from "../ports";
import { type Loaded, loadFunction, messageOf } from "../shared";
import {
	type Inputs,
	invokeCode,
	type LoadCode,
	type Outputs,
	pureContext,
	type Settlement,
} from "../worker";
import type { ExpansionOf } from "./bounds";
import type { ComposeInput, Expansion, Plan } from "./index";

/**
 * The iterations of a group instance that compose enumerates, with the `item` each delivers. `upTo` marks a region:
 * its iterations past those listed, at most the first, are not known.
 */
type Expanded = { keys: string[]; items: unknown[]; upTo?: number };

type Folded = Settled<Outputs>;

/** A port value compose knows. */
type Known = { value: unknown };

export type Setup = {
	graph: GraphIndex;
	input: ComposeInput;
	ajv: Validator;
	check: PortCheck;
	/** Every function the IR names, by `refKey`. */
	functions: ReadonlyMap<string, Loaded>;
	/** Each host's `environment()`, by host name. */
	env: CodeContext["env"];
	/** The cap errors of the bounds so far, checked after each group instance. Fold stops at the first. */
	limit?: ((expansionOf: ExpansionOf) => Diagnostic[]) | undefined;
};

type Folding = Setup & {
	expansion: Map<string, Map<string, Expanded>>;
	folded: Map<string, Map<string, Folded>>;
	diagnostics: Diagnostic[];
};

/** Nodes after everything they depend on: their edges' sources and their enclosing group. */
function dependencyOrder(ir: Ir, graph: GraphIndex): IrNode[] {
	const after = new Map(ir.nodes.map((n) => [n.id, new Set<string>()]));
	for (const e of ir.edges) after.get(e.to.node)?.add(e.from.node);
	for (const n of ir.nodes) {
		const group = graph.groupsOf(n.id).at(-1);
		if (group) after.get(n.id)?.add(group);
	}
	const done = new Set<string>();
	const ready = (n: IrNode) =>
		!done.has(n.id) && [...(after.get(n.id) ?? [])].every((d) => done.has(d));
	const order: IrNode[] = [];
	for (let n = ir.nodes.find(ready); n; n = ir.nodes.find(ready)) {
		done.add(n.id);
		order.push(n);
	}
	return order;
}

/** The key lists of a node's instances under `groups`, outermost first, through the iterations compose enumerates. */
function enumerate(
	groups: readonly string[],
	expansion: Folding["expansion"],
): string[][] {
	let paths: string[][] = [[]];
	for (const group of groups)
		paths = paths.flatMap((keys) => {
			const e = expansion.get(group)?.get(formatExpansion(keys));
			return (e?.keys ?? []).map((k) => [...keys, k]);
		});
	return paths;
}

const put = <V>(
	m: Map<string, Map<string, V>>,
	id: string,
	keys: string[],
	v: V,
) => {
	const at = m.get(id) ?? new Map<string, V>();
	m.set(id, at.set(formatExpansion(keys), v));
};

const foldedAt = (s: Folding, id: string, keys: string[]) =>
	s.folded.get(id)?.get(formatExpansion(keys));

/** `keys` cut to the instance of `id` they lie in. */
const keysOf = (s: Folding, id: string, keys: string[]) =>
	keys.slice(0, s.graph.groupsOf(id).length);

const instanceName = (s: Folding, id: string, keys: string[]) =>
	formatInstance(
		{ node: id, expansion: formatExpansion(keys) },
		s.graph.groupsOf(id),
	);

/** The value of `from`, an enclosing group's inner port or another node's output, for an instance at `keys`. */
function valueAt(
	s: Folding,
	node: IrNode,
	from: { node: string; port?: string },
	keys: string[],
): Known | undefined {
	const port = from.port ?? "";
	const depth = s.graph.groupsOf(node.id).indexOf(from.node);
	const group = s.graph.nodes.get(from.node);
	if (depth >= 0 && isGroup(group))
		return innerValue(s, group, port, keys.slice(0, depth + 1));
	const f = foldedAt(s, from.node, keysOf(s, from.node, keys));
	const value = f && outputValue(f, f.value, port);
	return value === undefined ? undefined : { value };
}

/** The value of inner `port` of `group` in the iteration `keys` ends with. */
function innerValue(
	s: Folding,
	group: GroupNode,
	port: string,
	keys: string[],
): Known | undefined {
	const outer = keys.slice(0, -1);
	const e = s.expansion.get(group.id)?.get(formatExpansion(outer));
	const i = e?.keys.indexOf(keys.at(-1) ?? "") ?? -1;
	if (!e || i < 0) return undefined;
	if (port === "index") return { value: i };
	if (port === "item") return { value: e.items[i] };
	// A repeat's state ports hold its own inputs in the first iteration, and outputs compose does not fold after it.
	return group.kind === "repeat" && i === 0
		? inputAt(s, group, port, outer)
		: undefined;
}

function inputAt(
	s: Folding,
	node: IrNode,
	port: string,
	keys: string[],
): Known | undefined {
	if (node.literals && Object.hasOwn(node.literals, port))
		return { value: node.literals[port] };
	const edge = s.graph
		.edgesInto(node.id)
		.find((e) => e.kind === "data" && e.to.port === port);
	return edge ? valueAt(s, node, edge.from, keys) : undefined;
}

function inputsOf(
	s: Folding,
	node: IrNode,
	keys: string[],
): Inputs | undefined {
	const inputs: Record<string, unknown> = {};
	for (const port of Object.keys(node.in ?? {})) {
		const known = inputAt(s, node, port, keys);
		if (!known) return undefined;
		inputs[port] = known.value;
	}
	return structuredClone(inputs);
}

/** Whether `node` still starts after the folded `outcome` of the source of `e` (CORE-04, ADR 0006). */
function admits(
	s: Folding,
	node: IrNode,
	e: IrEdge,
	outcome: Folded["outcome"],
): boolean {
	if (node.kind === "code" && node.fanin && e.kind !== "control") return true;
	return (
		outcome === "rejected" &&
		s.graph
			.edgesInto(node.id)
			.some((c) => c.from.node === e.from.node && tolerates(node, c))
	);
}

/** Why an instance is skipped: an upstream that did not settle `ok`. */
function blocked(s: Folding, node: IrNode, keys: string[]): string | undefined {
	const groups = s.graph.groupsOf(node.id);
	for (const e of s.graph.edgesInto(node.id)) {
		if (groups.includes(e.from.node)) continue;
		const f = foldedAt(s, e.from.node, keysOf(s, e.from.node, keys));
		if (f && f.outcome !== "ok" && !admits(s, node, e, f.outcome))
			return `'${e.from.node}' is ${f.outcome}`;
	}
	return undefined;
}

/** `false` when a guard is known false, `undefined` when one is unknown, else `true` (architecture 7). */
function guardOf(
	s: Folding,
	node: IrNode,
	keys: string[],
): boolean | undefined {
	let known = true;
	for (const e of s.graph.edgesInto(node.id)) {
		if (e.kind !== "control" || e.from.port === undefined) continue;
		const value = valueAt(s, node, e.from, keys);
		if (value?.value === false) return false;
		if (!value) known = false;
	}
	return known || undefined;
}

const hasMarker = (schema: unknown): boolean =>
	typeof schema === "object" &&
	schema !== null &&
	(Object.hasOwn(schema, MAESTRO_TYPE) ||
		Object.values(schema).some(hasMarker));

/** A pure code node folds unless it is a fan-in or has artifact outputs. */
const foldable = (n: CodeNode) =>
	n.pure && !n.fanin && !Object.values(n.out ?? {}).some(hasMarker);

const error = (
	code: string,
	node: string,
	message: string,
	hint: string,
): Diagnostic => ({ code, severity: "error", node, message, hint });

function failed(
	what: string,
	node: string,
	ref: WorkerRef,
	reason: string,
): Diagnostic {
	return error(
		"PURE.fold",
		node,
		`${what} failed while compose folded it: ${reason}`,
		`Fix '${ref.export}' in '${ref.module}', which fails on these inputs`,
	);
}

/** The key `functions` holds `ref`'s function under. */
const refKey = (ref: WorkerRef) =>
	JSON.stringify([ref.runtime, ref.module, ref.export]);

/** Every worker reference of `ir`: each code node's function and each map's key function, with the node naming it. */
const refsOf = (ir: Ir) =>
	ir.nodes.flatMap((n) => {
		if (n.kind === "code") return [{ node: n.id, ref: n.worker }];
		if (n.kind === "map" && n.key) return [{ node: n.id, ref: n.key }];
		return [];
	});

/** Loads every function `ir` names, each once, or a `SCOPE.export` error for each one that does not load (ADR 0008). */
export async function loadFunctions(ir: Ir, loadCode: LoadCode) {
	const functions = new Map<string, Loaded>();
	const diagnostics: Diagnostic[] = [];
	for (const { node, ref } of refsOf(ir)) {
		if (functions.has(refKey(ref))) continue;
		try {
			functions.set(refKey(ref), await loadFunction(loadCode, ref));
		} catch (e) {
			diagnostics.push(
				error(
					"SCOPE.export",
					node,
					`compose cannot load '${ref.export}' from '${ref.module}' for '${node}': ${messageOf(e)}`,
					`Export '${ref.export}' from '${ref.module}', or fix the worker reference of '${node}'`,
				),
			);
		}
	}
	return { functions, diagnostics };
}

/** The function `ref` names, which `loadFunctions` loaded. */
function functionOf(s: Folding, ref: WorkerRef): Loaded {
	const fn = s.functions.get(refKey(ref));
	if (!fn) throw new Error(`'${ref.export}' in '${ref.module}' was not loaded`);
	return fn;
}

/** The fields a folded node may not use, in the order a hint names them. */
const UNREADABLE = ["concert", "clock", "path"] as const;

/** A scratch directory under `root`, made with its parents on first use. */
function lazyScratch(root: string) {
	let dir: string | undefined;
	return {
		get path() {
			if (dir === undefined) {
				mkdirSync(root, { recursive: true });
				dir = mkdtempSync(join(root, "fold-"));
			}
			return dir;
		},
		remove: () =>
			dir === undefined ? undefined : rm(dir, { recursive: true, force: true }),
	};
}

/** `context` with a lazy `scratch`, noting each read of `concert` or `clock` in `used`. */
function watched(
	context: CodeContext,
	used: Set<string>,
	scratch: { readonly path: string },
): CodeContext {
	return new Proxy(context, {
		get(target, key, receiver) {
			if (key === "scratch") return scratch.path;
			if (key === "concert" || key === "clock") used.add(key);
			return Reflect.get(target, key, receiver);
		},
	});
}

/** A `path` that notes its call in `used` and throws, as a folded node has no artifact area. */
const noPath = (used: Set<string>) => (): never => {
	used.add("path");
	throw new Error("ctx.path is unavailable while compose folds a node");
};

/** A folded node's settlement as compose folds it. A failure is an error, as are outputs off the `out` schemas. */
function settled(
	s: Folding,
	node: CodeNode,
	keys: string[],
	settlement: Settlement,
	used: ReadonlySet<string>,
): Folded | Diagnostic {
	const name = instanceName(s, node.id, keys);
	if (settlement.outcome === "ok")
		return checked(s, node, name, settlement.outputs);
	if (settlement.outcome === "rejected")
		return { outcome: "rejected", reason: settlement.reason };
	const read = UNREADABLE.find((f) => used.has(f));
	if (read === undefined)
		return failed(`node '${name}'`, node.id, node.worker, settlement.reason);
	return error(
		"PURE.ambient",
		node.id,
		`node '${name}' used ctx.${read} while compose folded it`,
		`Mark node '${node.id}' pure: false to use ctx.${read}`,
	);
}

function checked(
	s: Folding,
	node: CodeNode,
	name: string,
	outputs: Outputs,
): Folded | Diagnostic {
	const messages = Object.entries(node.out ?? {}).flatMap(([port, schema]) =>
		violations(
			s.ajv,
			schema,
			structuredClone(outputs[port]),
			(segments) =>
				`output '${[port, ...segments].join(".")}' of node '${name}'`,
		),
	);
	if (!messages.length) return { outcome: "ok", value: outputs };
	return error(
		"TYPE.output",
		node.id,
		messages.join("; "),
		`Make '${node.worker.export}' in '${node.worker.module}' return outputs that match the out schemas of '${node.id}'`,
	);
}

/**
 * Settles a code node through `invokeCode`, as a worker would, with a pure context whose `path` throws. Its log lines
 * go nowhere, as compose keeps no record. Inputs off its `in` schemas are a `PURE.fold` error whose hint points at what
 * feeds the node.
 */
async function invoke(
	s: Folding,
	node: CodeNode,
	keys: string[],
	inputs: Inputs,
): Promise<Folded | Diagnostic> {
	const mismatch = s.check(node.in, inputs, "input");
	if (mismatch)
		return error(
			"PURE.fold",
			node.id,
			`node '${instanceName(s, node.id, keys)}' failed while compose folded it: ${mismatch}`,
			`Feed '${node.id}' values that match its in schemas: fix the edges, params or literals that feed it`,
		);
	const used = new Set<string>();
	const scratch = lazyScratch(s.input.scratch);
	const context = pureContext({
		concert: "",
		clock: 0,
		path: noPath(used),
		scratch: "",
		env: s.env,
		log: () => {},
	});
	try {
		const settlement = await invokeCode(
			functionOf(s, node.worker),
			{ in: node.in, inputs, context: watched(context, used, scratch) },
			s.check,
		);
		return settled(s, node, keys, settlement, used);
	} finally {
		await scratch.remove();
	}
}

function report(
	s: Folding,
	node: IrNode,
	keys: string[],
	result: Folded | Diagnostic,
) {
	if ("code" in result) s.diagnostics.push(result);
	else put(s.folded, node.id, keys, result);
}

function settleAssert(s: Folding, node: AssertNode, keys: string[]) {
	const inputs = inputsOf(s, node, keys);
	if (!inputs) return;
	if (Object.values(inputs).every((v) => v === true))
		return put(s.folded, node.id, keys, { outcome: "ok", value: {} });
	s.diagnostics.push(
		error(
			"ASSERT.failed",
			node.id,
			`assert '${instanceName(s, node.id, keys)}' failed: ${node.message}`,
			"Change the params or config that break it",
		),
	);
}

/**
 * Folds what compose can of one node instance: a skip, a pure code node or an assert. Returns whether the instance
 * is known to start: no guard is false or unknown and no upstream stops it.
 */
async function settle(s: Folding, node: IrNode, keys: string[]) {
	const guard = guardOf(s, node, keys);
	const skipped =
		blocked(s, node, keys) ??
		(guard === false ? "its guard is false" : undefined);
	if (skipped !== undefined) {
		put(s.folded, node.id, keys, { outcome: "skipped", reason: skipped });
		return false;
	}
	if (!guard) return false;
	if (node.kind === "assert") settleAssert(s, node, keys);
	const inputs =
		node.kind === "code" && foldable(node) && inputsOf(s, node, keys);
	if (inputs) report(s, node, keys, await invoke(s, node, keys, inputs));
	return true;
}

/** A map's item keys (D-18), through its key function when it has one, or a diagnostic. */
async function mapKeys(
	s: Folding,
	group: MapNode,
	name: string,
	items: unknown[],
): Promise<string[] | Diagnostic> {
	let keys = items.map(itemKey);
	if (group.key) {
		const key = functionOf(s, group.key);
		try {
			keys = await Promise.all(
				items.map(async (item, i) => itemKey(await key(item), i)),
			);
		} catch (e) {
			return failed(
				`the key function of map '${name}'`,
				group.id,
				group.key,
				messageOf(e),
			);
		}
	}
	const dup = firstDuplicate(keys);
	if (!dup) return keys;
	const { key, first, second } = dup;
	return error(
		"SCOPE.key",
		group.id,
		`map '${name}' gives items ${first} and ${second} the same key '${key}'`,
		group.key
			? `Make '${group.key.export}' return a distinct key for each item`
			: `Give map '${group.id}' a key function, or make its items distinct`,
	);
}

function itemsOf(s: Folding, group: GroupNode, keys: string[]) {
	if (group.kind === "repeat") return [0];
	const items = group.items ?? inputAt(s, group, "items", keys)?.value;
	return Array.isArray(items) ? items : undefined;
}

/** Records a group instance as a region of up to its bound, whose first iteration delivers `first` when known. */
function region(
	s: Folding,
	group: GroupNode,
	keys: string[],
	first: unknown[],
) {
	put(s.expansion, group.id, keys, {
		keys: first.length ? ["0"] : [],
		items: first.slice(0, 1),
		upTo: boundOf(group.cardinality),
	});
}

/**
 * Expands a group instance whose iterations are known: a map's items (D-18), or a seq's without `until`. A `repeat`, a
 * seq with `until` and a group of unknown items stay regions, with only the first iteration, which always starts,
 * enumerated when its item is known.
 */
async function expand(s: Folding, group: GroupNode, keys: string[]) {
	const bound = boundOf(group.cardinality);
	const items = itemsOf(s, group, keys);
	const name = instanceName(s, group.id, keys);
	if (!items) return region(s, group, keys, []);
	if (items.length > bound) {
		s.diagnostics.push(
			error(
				"BOUND.items",
				group.id,
				`${group.kind} '${name}' has ${items.length} items, over its bound of ${bound}`,
				`Raise the bound of '${group.id}' to ${items.length} or more`,
			),
		);
		return region(s, group, keys, []);
	}
	if (group.kind !== "map" && (group.kind === "repeat" || group.until))
		return region(s, group, keys, items);
	const named =
		group.kind === "map"
			? await mapKeys(s, group, name, items)
			: items.map((_, i) => String(i));
	if (Array.isArray(named))
		return put(s.expansion, group.id, keys, { keys: named, items });
	s.diagnostics.push(named);
	region(s, group, keys, []);
}

const shown = (e: Expanded): Expansion =>
	e.upTo === undefined ? { keys: e.keys } : { upTo: e.upTo };

/** The cap errors of the bounds so far: a group instance fold has not reached has no iterations yet. */
function overCap(s: Folding): Diagnostic[] {
	const sofar: ExpansionOf = (group, path) => {
		const e = s.expansion.get(group.id)?.get(path);
		return e ? shown(e) : { keys: [] };
	};
	return s.limit?.(sofar) ?? [];
}

/** Folds and expands one node instance. Returns `false` when a cap is passed and fold must stop. */
async function visit(s: Folding, node: IrNode, keys: string[]) {
	const starts = await settle(s, node, keys);
	if (!isGroup(node)) return true;
	if (starts) await expand(s, node, keys);
	else region(s, node, keys, []);
	const over = overCap(s);
	s.diagnostics.push(...over);
	return over.length === 0;
}

async function walk(s: Folding, ir: Ir) {
	for (const node of dependencyOrder(ir, s.graph))
		for (const keys of enumerate(s.graph.groupsOf(node.id), s.expansion))
			if (!(await visit(s, node, keys))) return;
}

const toRecord = <V, W>(
	m: ReadonlyMap<string, ReadonlyMap<string, V>>,
	f: (v: V) => W,
): Record<string, Record<string, W>> =>
	Object.fromEntries(
		[...m].map(([id, at]) => [
			id,
			Object.fromEntries([...at].map(([path, v]) => [path, f(v)])),
		]),
	);

/**
 * Folds pure code nodes and asserts whose inputs compose knows, skips what follows a non-`ok` folded outcome or a
 * false guard (CORE-04), and expands each group instance known to start whose items are known (CORE-07,
 * architecture 7 and 9).
 */
export async function fold(
	ir: Ir,
	setup: Setup,
): Promise<Pick<Plan, "expansion" | "folded" | "diagnostics">> {
	const s: Folding = {
		...setup,
		expansion: new Map(),
		folded: new Map(),
		diagnostics: [],
	};
	await walk(s, ir);
	return {
		expansion: toRecord(s.expansion, shown),
		folded: toRecord(s.folded, (f) => f),
		diagnostics: s.diagnostics,
	};
}
