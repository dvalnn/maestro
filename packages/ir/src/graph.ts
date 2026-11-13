import type { Outcome } from "./outcome";
import type {
	Cardinality,
	Diagnostic,
	FoldNode,
	GroupNode,
	Ir,
	IrEdge,
	IrNode,
	JsonSchema,
	LoopNode,
	MapNode,
	ParMapNode,
	PortRef,
	Ports,
	Scope,
	WorkerRef,
} from "./types";

/** The IR version this package emits and reads. See README.md for the compatibility policy. */
export const IR_VERSION = "1.2";

/** The outputs every node has beside its declared ones. */
export const IMPLICIT_OUT = {
	ok: { type: "boolean" },
	reason: { type: "string" },
} satisfies Ports;

/**
 * The value of output `port` of an instance that settled as `settled` with its declared `outputs`: an implicit output
 * derived from the outcome, else the declared output. `reason` is absent on an `ok` instance.
 */
export function outputValue(
	settled: { outcome: Outcome; reason?: string },
	outputs: Readonly<Record<string, unknown>> | undefined,
	port: string,
): unknown {
	const { outcome, reason } = settled;
	if (port === "ok") return outcome === "ok";
	if (port === "reason") return outcome === "ok" ? undefined : reason;
	return outputs?.[port];
}

const GROUP_KINDS: ReadonlySet<string> = new Set([
	"parMap",
	"map",
	"find",
	"parFind",
	"fold",
	"loop",
] satisfies GroupNode["kind"][]);

export const isGroup = (n: IrNode | undefined): n is GroupNode =>
	n !== undefined && GROUP_KINDS.has(n.kind);

/** A group whose `results` hold each member settled. */
export const collects = <N extends { kind: string }>(
	n: N | undefined,
): n is N & (MapNode | ParMapNode) => n?.kind === "parMap" || n?.kind === "map";

/** The most iterations a group may have. */
export const boundOf = (c: Cardinality) => ("exact" in c ? c.exact : c.upTo);

/**
 * Whether `edges`, every edge from one source into `node`, admit that source `rejected`:
 * - one of them is a tolerating control edge, or state into a tolerating `loop`;
 * - or each reads a status port, an implicit output.
 */
export const tolerates = (node: IrNode, edges: readonly IrEdge[]) =>
	edges.some((e) =>
		e.kind === "control"
			? e.tolerate === "rejected"
			: node.kind === "loop" && node.tolerate === "rejected",
	) || edges.every((e) => Object.hasOwn(IMPLICIT_OUT, e.from.port ?? ""));

/** The module name of every stdlib code reference; its code hash is the SDK version, not a content hash. */
export const STDLIB_MODULE = "maestro:stdlib";

/** The ports a loop's state carries beside its member's outputs: the status ports, and the iteration's index. */
export const LOOP_STATE = ["ok", "reason", "index"] as const;

/** The ports a fold's accumulator carries beside its member's outputs: a loop's, and the item. */
export const FOLD_STATE = [...LOOP_STATE, "item"] as const;

/**
 * `ir` with each worker reference, a code node's `worker` and a group's `key` (ADR 0008), replaced by what `change`
 * gives for it. `change` gets the id of the node naming the reference, once per reference, in node order.
 */
export function mapWorkers(
	ir: Ir,
	change: (ref: WorkerRef, node: string) => WorkerRef,
): Ir {
	const nodes = ir.nodes.map((node): IrNode => {
		if (node.kind === "code")
			return { ...node, worker: change(node.worker, node.id) };
		if ((node.kind === "parMap" || node.kind === "parFind") && node.key)
			return { ...node, key: change(node.key, node.id) };
		return node;
	});
	return { ...ir, nodes };
}

const hasLiteralItems = (g: GroupNode) =>
	g.kind !== "loop" && g.items !== undefined;

const names = (ports: Ports | undefined) => Object.keys(ports ?? {});

const list = (xs: string[]) => `[${xs.toSorted().join(", ")}]`;

/**
 * Lookups over a graph. `parent` and `ancestors` read the id alone; the others give `undefined` or an empty list for
 * an id that resolves to nothing.
 */
export type GraphIndex = {
	nodes: ReadonlyMap<string, IrNode>;
	scopes: ReadonlyMap<string, Scope>;
	/** The id minus its last segment, or `undefined` for a top-level id. */
	parent(id: string): string | undefined;
	/** Enclosing scopes and groups: the id's proper prefixes, nearest first. */
	ancestors(id: string): string[];
	/** Enclosing groups, outermost first. Scopes do not affect execution, so they are left out. */
	groupsOf(id: string): string[];
	/** The id of the innermost composition holding `id`: its nearest enclosing scope's, else the root's. */
	compositionOf(id: string): string;
	/** The pack of the root composition, which every node of the graph takes, a subcomposition's too. */
	pack: string;
	/** The nodes whose nearest enclosing group is `group`, in IR order. */
	body(group: string): readonly IrNode[];
	edgesInto(node: string): readonly IrEdge[];
	edgesFrom(node: string): readonly IrEdge[];
};

const parentOf = (id: string) => {
	const cut = id.lastIndexOf("/");
	return cut < 0 ? undefined : id.slice(0, cut);
};

/** Indexes `ir`. Safe on IR whose references do not resolve. */
export function indexGraph(ir: Ir): GraphIndex {
	const nodes = new Map(ir.nodes.map((n) => [n.id, n]));
	const scopes = new Map(ir.scopes.map((s) => [s.id, s]));
	const ancestors = (id: string) => {
		const chain: string[] = [];
		for (let p = parentOf(id); p !== undefined; p = parentOf(p)) chain.push(p);
		return chain;
	};
	const groupsOf = (id: string) =>
		ancestors(id)
			.filter((p) => isGroup(nodes.get(p)))
			.reverse();
	const bodies = Map.groupBy(ir.nodes, (n) => groupsOf(n.id).at(-1));
	const into = Map.groupBy(ir.edges, (e) => e.to.node);
	const from = Map.groupBy(ir.edges, (e) => e.from.node);
	return {
		nodes,
		scopes,
		parent: parentOf,
		ancestors,
		groupsOf,
		compositionOf: (id) =>
			ancestors(id).flatMap((a) => scopes.get(a)?.composition ?? [])[0] ??
			ir.composition.id,
		pack: ir.composition.pack,
		body: (group) => bodies.get(group) ?? [],
		edgesInto: (node) => into.get(node) ?? [],
		edgesFrom: (node) => from.get(node) ?? [],
	};
}

/**
 * `node` of the body of `group` and the body nodes it reads, transitively, a group reading what its descendants read:
 * a loop's test at `start`, performed apart from the rest of the body.
 */
export function upstreamIn(
	index: Pick<GraphIndex, "nodes" | "body" | "edgesInto">,
	group: string,
	node: string,
): ReadonlySet<string> {
	const body = new Set(index.body(group).map((n) => n.id));
	const found = new Set<string>();
	const visit = (id: string) => {
		if (!body.has(id) || found.has(id)) return;
		found.add(id);
		const within = [...index.nodes.keys()].filter((k) =>
			k.startsWith(`${id}/`),
		);
		for (const n of [id, ...within])
			for (const e of index.edgesInto(n)) visit(e.from.node);
	};
	visit(node);
	return found;
}

const NODE_PATH = /^\/nodes\/(\d+)(?:\/|$)/;

/** The id of the node `path` points into, when `ir`, valid IR or not, has a string id there. */
function nodeAt(ir: unknown, path: string): string | undefined {
	const index = NODE_PATH.exec(path)?.[1];
	if (index === undefined) return undefined;
	const nodes =
		typeof ir === "object" && ir !== null && "nodes" in ir ? ir.nodes : [];
	const node: unknown = Array.isArray(nodes) ? nodes[Number(index)] : undefined;
	return typeof node === "object" &&
		node !== null &&
		"id" in node &&
		typeof node.id === "string"
		? node.id
		: undefined;
}

/** An error at `path` in `ir`, naming the node the path points into. */
export function irError(
	ir: unknown,
	code: string,
	path: string,
	message: string,
	hint: string,
): Diagnostic {
	const node = nodeAt(ir, path);
	return {
		code,
		severity: "error",
		path,
		message,
		hint,
		...(node !== undefined && { node }),
	};
}

type Report = (
	code: string,
	path: string,
	message: string,
	hint: string,
) => void;

type Graph = ReturnType<typeof checkerOf>;

/** Checks the structural rules the JSON Schema cannot express. Call only with IR whose shape already validates. */
export function checkGraph(ir: Ir): Diagnostic[] {
	const graph = checkerOf(ir);
	checkIds(ir, graph);
	ir.nodes.forEach((n, i) => {
		checkLiterals(n, `/nodes/${i}`, graph);
	});
	const dependencies = ir.edges.flatMap((e, i) =>
		checkEdge(e, `/edges/${i}`, graph),
	);
	ir.nodes.forEach((n, i) => {
		checkFeeds(n, `/nodes/${i}`, graph);
		if (isGroup(n)) checkGroup(n, `/nodes/${i}`, graph);
	});
	checkResult(ir.result, graph);
	const cycle = findCycle(dependencies);
	if (cycle)
		graph.report(
			"IR.graph",
			"/edges",
			`edges form a cycle: ${cycle.join(" -> ")}`,
			"Remove one of the edges in the cycle",
		);
	return graph.diagnostics;
}

function checkerOf(ir: Ir) {
	const diagnostics: Diagnostic[] = [];
	const feeds = new Map<string, number>();
	const report: Report = (code, path, message, hint) => {
		diagnostics.push(irError(ir, code, path, message, hint));
	};
	return {
		...indexGraph(ir),
		diagnostics,
		feeds,
		report,
		feed: (node: string, port: string) => {
			const key = `${node}\0${port}`;
			feeds.set(key, (feeds.get(key) ?? 0) + 1);
		},
	};
}

/** Whether `id` is a phase of a fold, `<fold>/first` or `<fold>/step`, under which the fold's body nodes may sit. */
function isFoldPhase(id: string, nodes: ReadonlyMap<string, IrNode>) {
	const fold = parentOf(id);
	const phase = id.slice((fold?.length ?? -1) + 1);
	return (
		nodes.get(fold ?? "")?.kind === "fold" &&
		(phase === "first" || phase === "step")
	);
}

// Nodes and scopes share one id space, and both may sit inside a scope, a group or a fold's phase.
function checkIds(ir: Ir, { nodes, scopes, report }: Graph) {
	const entries = [
		...ir.nodes.map((n, i) => ({ id: n.id, path: `/nodes/${i}` })),
		...ir.scopes.map((s, i) => ({ id: s.id, path: `/scopes/${i}` })),
	];
	const seen = new Set<string>();
	for (const { id, path } of entries) {
		if (seen.has(id))
			report(
				"SCOPE.duplicate",
				path,
				`id '${id}' is used more than once`,
				`Rename one of the entries with id '${id}' so each node and scope id is unique`,
			);
		seen.add(id);
		const parent = parentOf(id);
		if (
			parent !== undefined &&
			!scopes.has(parent) &&
			!isGroup(nodes.get(parent)) &&
			!isFoldPhase(parent, nodes)
		)
			report(
				"IR.graph",
				path,
				`id '${id}' sits under '${parent}', which is not a scope or a group node`,
				`Declare '${parent}' as a scope or a group node, or move '${id}' out of it`,
			);
	}
}

function checkLiterals(n: IrNode, path: string, { feed, report }: Graph) {
	for (const port of Object.keys(n.literals ?? {})) {
		if (!names(n.in).includes(port))
			report(
				"IR.ref",
				path,
				`node '${n.id}' has no input port '${port}'`,
				`Declare '${port}' in in of node '${n.id}', or remove its literal`,
			);
		feed(n.id, port);
	}
}

/** Returns the dependency the edge adds between nodes at one level, if any. */
function checkEdge(e: IrEdge, path: string, graph: Graph): [string, string][] {
	for (const id of [e.from.node, e.to.node]) {
		if (!graph.nodes.has(id))
			graph.report(
				"IR.ref",
				path,
				`edge refers to node '${id}', which does not exist`,
				`Declare node '${id}' in nodes, or fix the edge`,
			);
	}
	const from = graph.nodes.get(e.from.node);
	const to = graph.nodes.get(e.to.node);
	if (!from || !to) return [];
	const inner = isGroup(from) && graph.groupsOf(to.id).includes(from.id);
	checkEdgePorts(e, from, to, inner, path, graph);
	checkFanIn(e, from, inner, path, graph.report);
	return checkBoundary(from, to, inner, path, graph);
}

function checkEdgePorts(
	e: IrEdge,
	from: IrNode,
	to: IrNode,
	inner: boolean,
	path: string,
	{ feed, report }: Graph,
) {
	// A group's inner ports are visible only from inside its body.
	const ports =
		inner && isGroup(from)
			? names(from.inner)
			: [...names(from.out), ...names(IMPLICIT_OUT)];
	const fromPort = e.from.port;
	if (fromPort !== undefined && !ports.includes(fromPort)) {
		report(
			"IR.ref",
			path,
			`node '${from.id}' has no ${inner ? "inner" : "output"} port '${fromPort}'`,
			`Declare '${fromPort}' in ${inner ? "inner" : "out"} of node '${from.id}', or fix the edge`,
		);
	}
	if (e.kind === "control") return;
	if (!names(to.in).includes(e.to.port))
		report(
			"IR.ref",
			path,
			`node '${to.id}' has no input port '${e.to.port}'`,
			`Declare '${e.to.port}' in in of node '${to.id}', or fix the edge`,
		);
	feed(to.id, e.to.port);
}

/** Fan-in is explicit: a group's results leave it only through collect edges, and collect edges only carry them. */
function checkFanIn(
	e: IrEdge,
	from: IrNode,
	inner: boolean,
	path: string,
	report: Report,
) {
	const isResults = collects(from) && !inner && e.from.port === "results";
	if (e.kind === "collect" && !isResults) {
		report(
			"IR.graph",
			path,
			`collect edge from '${from.id}' must start at a parMap or map node's 'results' port`,
			`Start the edge at the 'results' port of a parMap or map node, or make it a data edge`,
		);
	}
	if (e.kind !== "collect" && isResults) {
		report(
			"IR.graph",
			path,
			`results of ${from.kind} '${from.id}' must leave it through a collect edge`,
			`Set the edge kind to "collect"`,
		);
	}
}

/** Rejects an edge that leaves a group body. Returns the dependency the edge adds, if any. */
function checkBoundary(
	from: IrNode,
	to: IrNode,
	inner: boolean,
	path: string,
	{ groupsOf, report }: Graph,
): [string, string][] {
	const sourceGroups = inner
		? [...groupsOf(from.id), from.id]
		: groupsOf(from.id);
	const targetGroups = groupsOf(to.id);
	const left = sourceGroups.find((g, k) => targetGroups[k] !== g);
	if (left) {
		report(
			"IR.graph",
			path,
			`edge from '${from.id}' leaves the body of group '${left}'`,
			`Pass the value out through an out port of group '${left}'`,
		);
		return [];
	}
	if (inner) return [];
	// Lift the target to the source's level, so an edge into a body depends on its group.
	return [[from.id, targetGroups[sourceGroups.length] ?? to.id]];
}

function checkFeeds(n: IrNode, path: string, { feeds, report }: Graph) {
	for (const port of names(n.in)) {
		const count = feeds.get(`${n.id}\0${port}`) ?? 0;
		if (count === 0)
			report(
				"IR.graph",
				path,
				`input port '${port}' of node '${n.id}' is not fed`,
				`Feed port '${port}' of node '${n.id}' with an edge or a literal`,
			);
		if (count > 1)
			report(
				"IR.graph",
				path,
				`input port '${port}' of node '${n.id}' is fed more than once`,
				`Feed port '${port}' of node '${n.id}' with one edge or one literal, not several`,
			);
	}
}

function checkResult(result: Ir["result"], { nodes, groupsOf, report }: Graph) {
	const id = result.node;
	if (!nodes.has(id))
		report(
			"IR.ref",
			"/result",
			`node '${id}' does not exist`,
			"Set result.node to a node declared in nodes",
		);
	else if (groupsOf(id).length > 0)
		report(
			"IR.graph",
			"/result",
			`result node '${id}' is inside a group body`,
			`Point result.node at a node outside every group body, such as its group '${groupsOf(id)[0]}'`,
		);
}

function checkGroup(g: GroupNode, path: string, graph: Graph) {
	const member = checkBody(g, path, graph);
	checkGroupPorts(g, names(member?.out), path, graph.report);
	checkCardinality(g, path, graph.report);
}

/**
 * Checks that members, `cond` and `test` sit in the group's own body. Returns the member whose outputs the group
 * mirrors, when there is one.
 */
function checkBody(g: GroupNode, path: string, graph: Graph) {
	const members = Object.values(g.members).map((id) =>
		bodyNode(g, id, "member", path, graph),
	);
	if (g.kind === "fold") return checkFold(g, path, graph);
	// A group that mirrors its member's ports needs exactly one member. A collecting group's member results are
	// records keyed by result name, so it may have several.
	if (!collects(g) && members.length !== 1) {
		graph.report(
			"IR.graph",
			path,
			`${g.kind} '${g.id}' must have exactly one member in IR ${IR_VERSION}, got ${members.length}`,
			`Keep exactly one entry in members of '${g.id}'`,
		);
	}
	if (g.kind === "find" || g.kind === "parFind")
		boolPort(g, g.cond, "cond", path, graph);
	const member = members.length === 1 ? members[0] : undefined;
	if (g.kind === "loop") checkTest(g, member, path, graph);
	return member;
}

/**
 * Checks the two phases of fold `g`: its `first` nodes, made from the first item, and the rest of its body, made from
 * each later item and the accumulator. Returns `step`, whose outputs the fold mirrors.
 */
function checkFold(g: FoldNode, path: string, graph: Graph) {
	const once = g.first.map((id) => bodyNode(g, id, "first", path, graph));
	const first = graph.nodes.get(g.members.first);
	const step = graph.nodes.get(g.members.step);
	if (!first || !step || once.includes(undefined)) return undefined;
	const inFirst = (id: string) =>
		g.first.some((f) => id === f || id.startsWith(`${f}/`));
	if (!g.first.includes(first.id) || inFirst(step.id))
		graph.report(
			"IR.graph",
			path,
			`first of fold '${g.id}' must list its member '${first.id}' and not its member '${step.id}'`,
			`List in first of '${g.id}' the body nodes made from the first item`,
		);
	const crossing = g.first
		.flatMap((id) => graph.edgesFrom(id))
		.find((e) => e.to.node.startsWith(`${g.id}/`) && !inFirst(e.to.node));
	if (crossing)
		graph.report(
			"IR.graph",
			path,
			`'${crossing.to.node}' of fold '${g.id}' reads '${crossing.from.node}' of its first phase, which takes a different item`,
			`Build the step of '${g.id}' from the accumulator and the item alone`,
		);
	checkFirstReads(g, inFirst, path, graph);
	if (list(names(first.out)) !== list(names(step.out)))
		graph.report(
			"IR.graph",
			path,
			`members of fold '${g.id}' must declare the same out ports, got first ${list(names(first.out))} and step ${list(names(step.out))}`,
			`Give '${first.id}' and '${step.id}' the same out ports`,
		);
	return step;
}

/** Checks that the `first` phase of fold `g` reads only the item and the index, as no accumulator exists yet. */
function checkFirstReads(
	g: FoldNode,
	inFirst: (id: string) => boolean,
	path: string,
	graph: Graph,
) {
	const read = graph
		.edgesFrom(g.id)
		.find(
			(e) =>
				!["item", "index"].includes(e.from.port ?? "") && inFirst(e.to.node),
		);
	if (read)
		graph.report(
			"IR.graph",
			path,
			`'${read.to.node}' reads '${g.id}.${read.from.port}', but the first phase of fold '${g.id}' has no accumulator`,
			`Feed '${read.to.node}' from the item, or move it to the step of '${g.id}'`,
		);
}

/**
 * Checks the test of `g`:
 * - at `start`, a Bool state port of `g`, or a Bool port of a body node that does not read `member`;
 * - at `end`, a Bool port of a body node.
 */
function checkTest(
	g: LoopNode,
	member: IrNode | undefined,
	path: string,
	graph: Graph,
) {
	const { at, port } = g.test;
	if (port.node === g.id && at === "start")
		statePort(g, port.port, path, graph);
	else if (port.node === g.id)
		graph.report(
			"IR.graph",
			path,
			`test '${g.id}.${port.port}' of loop '${g.id}' reads the loop state, but a test at end reads a body node`,
			`Point test of '${g.id}' at a body node, or set test.at to "start"`,
		);
	else {
		const test = boolPort(g, port, "test", path, graph);
		if (test && member && at === "start")
			checkStartTest(g, test, member, path, graph);
	}
}

/** Checks that `port` is a Bool state port of `g`. */
function statePort(g: LoopNode, port: string, path: string, graph: Graph) {
	const schema =
		g.inner && Object.hasOwn(g.inner, port) ? g.inner[port] : undefined;
	if (schema === undefined)
		graph.report(
			"IR.ref",
			path,
			`loop '${g.id}' has no state port '${port}'`,
			`Declare '${port}' in inner of '${g.id}', or fix test of group '${g.id}'`,
		);
	else checkBool(g, `${g.id}.${port}`, schema, "test", path, graph);
}

/** Checks that `ref`, the `role` of `g`, is a Bool port of a node in its body. Returns that node. */
function boolPort(
	g: GroupNode,
	ref: PortRef,
	role: string,
	path: string,
	graph: Graph,
) {
	const n = bodyNode(g, ref.node, role, path, graph);
	if (!n) return undefined;
	const schema = Object.hasOwn(IMPLICIT_OUT, ref.port)
		? IMPLICIT_OUT[ref.port as keyof typeof IMPLICIT_OUT]
		: n.out && Object.hasOwn(n.out, ref.port)
			? n.out[ref.port]
			: undefined;
	if (schema === undefined)
		graph.report(
			"IR.ref",
			path,
			`node '${n.id}' has no output port '${ref.port}'`,
			`Declare '${ref.port}' in out of node '${n.id}', or fix ${role} of group '${g.id}'`,
		);
	else checkBool(g, `${n.id}.${ref.port}`, schema, role, path, graph);
	return n;
}

/** Checks that `schema`, of port `name`, the `role` of `g`, has type boolean. */
function checkBool(
	g: GroupNode,
	name: string,
	schema: JsonSchema,
	role: string,
	path: string,
	graph: Graph,
) {
	if (typeof schema !== "object" || schema.type !== "boolean")
		graph.report(
			"IR.graph",
			path,
			`${role} '${name}' of group '${g.id}' is not a boolean port`,
			`Point ${role} of '${g.id}' at a port whose schema has type boolean`,
		);
}

/** A test read before the step reads only the loop state: neither it nor a body node it reads depends on the member. */
function checkStartTest(
	g: LoopNode,
	test: IrNode,
	member: IrNode,
	path: string,
	graph: Graph,
) {
	if (upstreamIn(graph, g.id, g.test.port.node).has(member.id))
		graph.report(
			"IR.graph",
			path,
			`test '${test.id}' of loop '${g.id}' reads its member '${member.id}', but a test at start reads only the loop state`,
			`Feed '${test.id}' from the inner ports of '${g.id}', or set test.at to "end"`,
		);
}

function bodyNode(
	g: GroupNode,
	id: string,
	role: string,
	path: string,
	{ nodes, groupsOf, report }: Graph,
) {
	const n = nodes.get(id);
	if (!n)
		report(
			"IR.ref",
			path,
			`${role} '${id}' of group '${g.id}' does not exist`,
			`Declare node '${id}' in nodes, or fix the ${role} of group '${g.id}'`,
		);
	else if (groupsOf(id).at(-1) !== g.id)
		report(
			"IR.graph",
			path,
			`${role} '${id}' is not in the body of group '${g.id}'`,
			`Give '${id}' an id directly under '${g.id}/', or fix the ${role} of the group`,
		);
	return n;
}

/** The ports `g` must declare, given `state`, the out ports of the member it mirrors. */
function wantedPorts(g: GroupNode, state: string[]) {
	if (g.kind === "loop")
		return { in: state, inner: [...state, ...LOOP_STATE], out: state };
	const items = hasLiteralItems(g) ? [] : ["items"];
	if (g.kind === "fold")
		return { in: items, inner: [...state, ...FOLD_STATE], out: state };
	return { in: items, inner: ["item"], out: collects(g) ? ["results"] : state };
}

/** `state` is the out ports of the member a group mirrors. */
function checkGroupPorts(
	g: GroupNode,
	state: string[],
	path: string,
	report: Report,
) {
	const expect = (
		side: "in" | "inner" | "out",
		actual: string[],
		wanted: string[],
	) => {
		if (list(actual) !== list(wanted)) {
			report(
				"IR.graph",
				path,
				`${g.kind} '${g.id}' must declare ${side} ports ${list(wanted)}, got ${list(actual)}`,
				`Declare exactly the ${side} ports ${list(wanted)} on '${g.id}'`,
			);
		}
	};
	const wanted = wantedPorts(g, state);
	expect("in", names(g.in), wanted.in);
	expect("inner", names(g.inner), wanted.inner);
	expect("out", names(g.out), wanted.out);
}

// Only a parMap over literal items, or a group over an empty literal list, has an exact size. Every other group may
// stop early or depends on a result, so it declares an upper bound, equal to the item count when known.
const literalSize = (kind: string, count: number): Cardinality =>
	kind === "parMap" || count === 0 ? { exact: count } : { upTo: count };

function checkCardinality(g: GroupNode, path: string, report: Report) {
	const c = g.cardinality;
	const count = g.kind === "loop" ? undefined : g.items?.length;
	const want = count === undefined ? undefined : literalSize(g.kind, count);
	if (want ? JSON.stringify(c) === JSON.stringify(want) : "upTo" in c) return;
	const wanted = want ? `{ ${Object.keys(want)[0]}: ${count} }` : "{ upTo: N }";
	report(
		"IR.graph",
		path,
		`${g.kind} '${g.id}' must declare cardinality ${wanted}`,
		`Set cardinality of '${g.id}' to ${wanted}`,
	);
}

/** One cycle as a closed path of node ids (first id repeated last), or undefined. */
function findCycle(edges: [string, string][]): string[] | undefined {
	const next = new Map<string, string[]>();
	for (const [a, b] of edges) next.set(a, [...(next.get(a) ?? []), b]);
	const done = new Set<string>();
	const stack: string[] = [];
	const visit = (id: string): string[] | undefined => {
		if (stack.includes(id)) return [...stack.slice(stack.indexOf(id)), id];
		if (done.has(id)) return;
		stack.push(id);
		for (const n of next.get(id) ?? []) {
			const cycle = visit(n);
			if (cycle) return cycle;
		}
		stack.pop();
		done.add(id);
	};
	for (const id of next.keys()) {
		const cycle = visit(id);
		if (cycle) return cycle;
	}
}
