import type {
	GroupNode,
	Ir,
	IrDiagnostic,
	IrEdge,
	IrNode,
	Ports,
} from "./types";

const IMPLICIT_OUT = ["outcome", "ok", "reason"];

const isGroup = (n: IrNode | undefined): n is GroupNode =>
	n?.kind === "map" || n?.kind === "seq" || n?.kind === "repeat";

const hasLiteralItems = (g: GroupNode) =>
	g.kind !== "repeat" && g.items !== undefined;

const names = (ports: Ports | undefined) => Object.keys(ports ?? {});

const list = (xs: string[]) => `[${xs.toSorted().join(", ")}]`;

type Report = (
	code: string,
	path: string,
	message: string,
	hint: string,
) => void;

type Graph = ReturnType<typeof graphOf>;

/** Checks the structural rules the JSON Schema cannot express. Call only with IR whose shape already validates. */
export function checkGraph(ir: Ir): IrDiagnostic[] {
	const graph = graphOf(ir);
	checkParents(ir, graph);
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

function graphOf(ir: Ir) {
	const diagnostics: IrDiagnostic[] = [];
	const feeds = new Map<string, number>();
	const nodes = new Map(ir.nodes.map((n) => [n.id, n]));
	const parents = new Map(
		[...ir.nodes, ...ir.scopes].map((e) => [e.id, e.parent]),
	);

	// Nearest first. Stops at a revisited id so a parent cycle cannot hang the walk.
	const ancestors = (id: string) => {
		const chain: string[] = [];
		for (let p = parents.get(id); p !== undefined; p = parents.get(p)) {
			if (p === id || chain.includes(p)) return { chain, loops: p === id };
			chain.push(p);
		}
		return { chain, loops: false };
	};

	const report: Report = (code, path, message, hint) => {
		diagnostics.push({ code, path, message, hint });
	};
	return {
		diagnostics,
		feeds,
		nodes,
		scopeIds: new Set(ir.scopes.map((s) => s.id)),
		ancestors,
		// Scopes do not affect execution, so only enclosing groups (outermost first) matter for edges.
		groupsOf: (id: string) =>
			ancestors(id)
				.chain.filter((p) => isGroup(nodes.get(p)))
				.reverse(),
		report,
		feed: (node: string, port: string) => {
			const key = `${node}\0${port}`;
			feeds.set(key, (feeds.get(key) ?? 0) + 1);
		},
	};
}

// Nodes and scopes share one id space, and both may sit inside a scope or a group.
function checkParents(ir: Ir, { nodes, scopeIds, ancestors, report }: Graph) {
	const entries = [
		...ir.nodes.map((n, i) => ({ ...n, path: `/nodes/${i}` })),
		...ir.scopes.map((s, i) => ({ ...s, path: `/scopes/${i}` })),
	];
	const seen = new Set<string>();
	for (const { id, parent, path } of entries) {
		if (seen.has(id))
			report(
				"SCOPE.duplicate",
				path,
				`id '${id}' is used more than once`,
				`Rename one of the entries with id '${id}' so each node and scope id is unique`,
			);
		seen.add(id);
		if (parent === undefined) continue;
		if (!scopeIds.has(parent) && !isGroup(nodes.get(parent))) {
			report(
				"IR.ref",
				path,
				`parent '${parent}' is not a scope or a group node`,
				`Declare '${parent}' as a scope or as a map, seq or repeat node, or fix parent of '${id}'`,
			);
		} else if (ancestors(id).loops) {
			report(
				"IR.graph",
				path,
				`the parent chain of '${id}' loops back to it`,
				`Remove or change parent on one id in the chain of '${id}'`,
			);
		}
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
			: [...names(from.out), ...IMPLICIT_OUT];
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

/** Fan-in is explicit: a map's results leave it only through collect edges, and collect edges only carry them. */
function checkFanIn(
	e: IrEdge,
	from: IrNode,
	inner: boolean,
	path: string,
	report: Report,
) {
	const isResults = from.kind === "map" && !inner && e.from.port === "results";
	if (e.kind === "collect" && !isResults) {
		report(
			"IR.graph",
			path,
			`collect edge from '${from.id}' must start at a map node's 'results' port`,
			`Start the edge at the 'results' port of a map node, or make it a data edge`,
		);
	}
	if (e.kind !== "collect" && isResults) {
		report(
			"IR.graph",
			path,
			`results of map '${from.id}' must leave it through a collect edge`,
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
	if (result.rule !== "node") return;
	const id = result.node;
	if (!nodes.has(id))
		report(
			"IR.ref",
			"/result",
			`node '${id}' does not exist`,
			`Set result.node to a node declared in nodes, or use { "rule": "default" }`,
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

/** Checks that members and `until` sit in the group's own body. Returns the member when there is exactly one. */
function checkBody(g: GroupNode, path: string, graph: Graph) {
	const members = Object.values(g.members).map((id) =>
		bodyNode(g, id, "member", path, graph),
	);
	// A seq or repeat mirrors its member's ports, which needs exactly one member. A map's
	// member results are records keyed by result name, so it may have several.
	if (g.kind !== "map" && members.length !== 1) {
		graph.report(
			"IR.graph",
			path,
			`${g.kind} '${g.id}' must have exactly one member in IR 1.0, got ${members.length}`,
			`Keep exactly one entry in members of '${g.id}'`,
		);
	}
	if (g.kind !== "map" && g.until) {
		const until = bodyNode(g, g.until.node, "until", path, graph);
		if (
			until &&
			![...names(until.out), ...IMPLICIT_OUT].includes(g.until.port)
		) {
			graph.report(
				"IR.ref",
				path,
				`node '${until.id}' has no output port '${g.until.port}'`,
				`Declare '${g.until.port}' in out of node '${until.id}', or fix until of group '${g.id}'`,
			);
		}
	}
	return members.length === 1 ? members[0] : undefined;
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
			`Set parent of '${id}' to '${g.id}', or fix the ${role} of the group`,
		);
	return n;
}

/** `state` is the member's out ports, which a seq or repeat mirrors. */
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
	if (g.kind === "repeat") {
		expect("in", names(g.in), state);
		expect("inner", names(g.inner), [...state, "index"]);
		expect("out", names(g.out), state);
	} else {
		expect("in", names(g.in), hasLiteralItems(g) ? [] : ["items"]);
		expect("inner", names(g.inner), ["item"]);
		expect("out", names(g.out), g.kind === "map" ? ["results"] : state);
	}
}

// Only a map over literal items has an exact size. Every other group may stop early or
// depends on a result, so it declares an upper bound, equal to the item count when known.
function checkCardinality(g: GroupNode, path: string, report: Report) {
	const c = g.cardinality;
	const literal = hasLiteralItems(g);
	const count = g.kind === "repeat" ? undefined : g.items?.length;
	const exact = g.kind === "map" && literal;
	const valid = exact
		? "exact" in c && c.exact === count
		: "upTo" in c && (!literal || c.upTo === count);
	if (valid) return;
	const wanted = exact
		? `{ exact: ${count} }`
		: `{ upTo: ${literal ? count : "N"} }`;
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
