// TypeScript view of ir.schema.json. The schema is the contract; keep these in step with it.

import type { Outcome } from "./outcome";

export type Severity = "error" | "warning";

/**
 * A finding about a graph (CORE-17), from ir, the SDK or core. `code` is stable, with a prefix from sdk-spec 13.3, and
 * any `error` stops compose. `hint` is the next step. Without `node`, `scope`, `source` and `path` it is about the
 * whole IR.
 */
export type Diagnostic = {
	code: string;
	severity: Severity;
	message: string;
	hint: string;
	node?: string;
	scope?: string;
	source?: SourceLocation;
	/** A JSON Pointer into the IR. */
	path?: string;
};

/** A JSON Schema (draft 2020-12) document. Opaque to the IR. */
export type JsonSchema = { [key: string]: unknown } | boolean;

export type Ports = Record<string, JsonSchema>;

export type PortRef = { node: string; port: string };

export type WorkerRef = {
	runtime: string;
	module: string;
	export: string;
	codeHash: string;
};

export type SourceLocation = { file: string; line: number; column?: number };

export type Cardinality = { exact: number } | { upTo: number };

export type Tolerate = "rejected";

type NodeBase = {
	/** A path: each proper prefix is a declared scope or group, and the last segment is the node's name. */
	id: string;
	source?: SourceLocation;
	in?: Ports;
	out?: Ports;
	literals?: Record<string, unknown>;
};

export type CodeNode = NodeBase & {
	kind: "code";
	worker: WorkerRef;
	fanin?: boolean;
	/** Milliseconds the node may take before it settles `failed`. None when absent. */
	timeout?: number;
};

export type AssertNode = NodeBase & {
	kind: "assert";
	message: string;
	onFail: Extract<Outcome, "rejected" | "failed">;
};

type GroupBase = NodeBase & {
	inner: Ports;
	/**
	 * Result name to body node id. A group with one member delivers that member's outputs, with several a record by
	 * result name. `parMap` and `map` may have several, `fold` exactly `first` and `step`, and the others exactly one.
	 */
	members: Record<string, string>;
	cardinality: Cardinality;
};

/** At a non-`ok` member, `stop` halts the group and `continue` goes on through every item (ADR 0006). */
export type OnError = "stop" | "continue";

type ItemsGroup = GroupBase & { items?: unknown[] };

/** An optional worker naming each item, in place of `itemKey` (D-18, ADR 0008). */
type Keyed = ItemsGroup & { key?: WorkerRef };

export type ParMapNode = Keyed & { kind: "parMap"; onError: OnError };

export type MapNode = ItemsGroup & { kind: "map"; onError: OnError };

/** `cond` is a Bool port of a body node, read on each member as it settles; the first that holds is the result. */
export type FindNode = ItemsGroup & { kind: "find"; cond: PortRef };

export type ParFindNode = Keyed & { kind: "parFind"; cond: PortRef };

/**
 * Members `first`, made from the first item, and `step`, made from each later item and the accumulator, the previous
 * iteration's member. `first` lists the body nodes performed on the first item in place of the rest of the body.
 */
export type FoldNode = ItemsGroup & {
	kind: "fold";
	members: { first: string; step: string };
	first: string[];
	tolerate?: Tolerate;
};

/**
 * A Bool port of a loop's body node, read before each step at `start` or after each step at `end`. The loop goes on
 * while it is true. At `start` the node reads only the loop state.
 */
export type LoopTest = { at: "start" | "end"; port: PortRef };

export type LoopNode = GroupBase & {
	kind: "loop";
	test: LoopTest;
	tolerate?: Tolerate;
};

export type GroupNode =
	| ParMapNode
	| MapNode
	| FindNode
	| ParFindNode
	| FoldNode
	| LoopNode;

/** A node whose kind a host registers, namespaced as `<host>.<kind>`. */
export type HostNode = NodeBase & {
	kind: `${string}.${string}`;
	config?: Record<string, unknown>;
};

export type IrNode = CodeNode | AssertNode | GroupNode | HostNode;

export type DataEdge = { kind: "data"; from: PortRef; to: PortRef };

export type CollectEdge = { kind: "collect"; from: PortRef; to: PortRef };

/** With `from.port` it is a guard. Without it, an ordering edge that may tolerate `rejected`. */
export type ControlEdge = {
	kind: "control";
	from: { node: string; port?: string };
	to: { node: string };
	tolerate?: Tolerate;
};

export type IrEdge = DataEdge | CollectEdge | ControlEdge;

export type Scope = {
	id: string;
	composition: string;
	ports: Ports;
};

export type Ir = {
	irVersion: string;
	composition: { id: string; version: string; pack: string; doc?: string };
	emitter: { name: string; version: string; sourceHash?: string };
	scopes: Scope[];
	nodes: IrNode[];
	edges: IrEdge[];
	result: { node: string };
};
