// TypeScript view of ir.schema.json. The schema is the contract; keep these in step with it.

/** `code` is IR.version, IR.schema, IR.ref, IR.graph or SCOPE.duplicate. `path` is a JSON Pointer. */
export type IrDiagnostic = {
	code: string;
	path: string;
	message: string;
	hint?: string;
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
	id: string;
	label: string;
	/** A human label used in records. Not an identity. */
	tag?: string;
	parent?: string;
	source?: SourceLocation;
	in?: Ports;
	out?: Ports;
	literals?: Record<string, unknown>;
};

export type CodeNode = NodeBase & {
	kind: "code";
	worker: WorkerRef;
	pure: boolean;
	reads?: string[];
	writes?: string[];
	fanin?: boolean;
};

export type AssertNode = NodeBase & {
	kind: "assert";
	message: string;
	onFail: "rejected" | "failed";
};

type GroupBase = NodeBase & {
	inner: Ports;
	/** Result name to body node id. `seq` and `repeat` take exactly one in IR 1.0. */
	members: Record<string, string>;
	cardinality: Cardinality;
};

export type MapNode = GroupBase & {
	kind: "map";
	items?: unknown[];
	key?: WorkerRef;
	onError: "settle" | "propagate";
};

export type SeqNode = GroupBase & {
	kind: "seq";
	items?: unknown[];
	until?: PortRef;
};

export type RepeatNode = GroupBase & {
	kind: "repeat";
	until?: PortRef;
	tolerate?: Tolerate;
};

export type GroupNode = MapNode | SeqNode | RepeatNode;

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
	parent?: string;
	ports: Ports;
};

export type Ir = {
	irVersion: string;
	composition: { id: string; version: string; pack: string; doc?: string };
	emitter: { name: string; version: string; sourceHash?: string };
	params: { schema: JsonSchema; examples: Record<string, unknown>[] };
	config?: Record<string, JsonSchema>;
	scopes: Scope[];
	nodes: IrNode[];
	edges: IrEdge[];
	result: { rule: "default" } | { rule: "node"; node: string };
};
