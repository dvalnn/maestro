// Structural rules the JSON Schema cannot express. Applies only to IR whose shape is valid.
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

const names = (ports: Ports | undefined) => Object.keys(ports ?? {});

const list = (xs: string[]) => `[${xs.toSorted().join(", ")}]`;

export function checkGraph(ir: Ir): IrDiagnostic[] {
	const diagnostics: IrDiagnostic[] = [];
	const report = (code: string, path: string, message: string) =>
		diagnostics.push({ code, path, message });

	// Nodes and scopes share one id space, and both may sit inside a scope or a group.
	const entries = [
		...ir.nodes.map((n, i) => ({ ...n, path: `/nodes/${i}` })),
		...ir.scopes.map((s, i) => ({ ...s, path: `/scopes/${i}` })),
	];
	const nodes = new Map(ir.nodes.map((n) => [n.id, n]));
	const scopeIds = new Set(ir.scopes.map((s) => s.id));
	const parents = new Map(entries.map((e) => [e.id, e.parent]));

	/** Ancestors, nearest first. Stops at a repeat so a parent cycle cannot hang the walk. */
	const ancestors = (id: string) => {
		const chain: string[] = [];
		for (let p = parents.get(id); p !== undefined; p = parents.get(p)) {
			if (p === id || chain.includes(p)) return { chain, loops: p === id };
			chain.push(p);
		}
		return { chain, loops: false };
	};

	const seen = new Set<string>();
	for (const { id, parent, path } of entries) {
		if (seen.has(id))
			report("SCOPE.duplicate", path, `id '${id}' is used more than once`);
		seen.add(id);
		if (parent === undefined) continue;
		if (!scopeIds.has(parent) && !isGroup(nodes.get(parent))) {
			report(
				"IR.ref",
				path,
				`parent '${parent}' is not a scope or a group node`,
			);
		} else if (ancestors(id).loops) {
			report("IR.graph", path, `the parent chain of '${id}' loops back to it`);
		}
	}

	// Scopes do not affect execution, so only enclosing groups (outermost first) matter for edges.
	const groupsOf = (id: string) =>
		ancestors(id)
			.chain.filter((p) => isGroup(nodes.get(p)))
			.reverse();
	const nearestGroup = (id: string) => groupsOf(id).at(-1);
	const isInside = (id: string, group: string) => groupsOf(id).includes(group);

	/** Output ports of `source` as seen from `consumer`: a group's inner ports from inside its body. */
	const sourcePorts = (source: IrNode, consumer: string) =>
		isGroup(source) && isInside(consumer, source.id)
			? names(source.inner)
			: [...names(source.out), ...IMPLICIT_OUT];

	const feeds = new Map<string, number>();
	const feed = (node: string, port: string) => {
		const key = `${node}\0${port}`;
		feeds.set(key, (feeds.get(key) ?? 0) + 1);
	};
	ir.nodes.forEach((n, i) => {
		for (const port of Object.keys(n.literals ?? {})) {
			if (!names(n.in).includes(port))
				report(
					"IR.ref",
					`/nodes/${i}`,
					`node '${n.id}' has no input port '${port}'`,
				);
			feed(n.id, port);
		}
	});

	const dependencies: [string, string][] = [];
	ir.edges.forEach((e, i) => {
		const path = `/edges/${i}`;
		const from = nodes.get(e.from.node);
		const to = nodes.get(e.to.node);
		for (const id of [e.from.node, e.to.node]) {
			if (!nodes.has(id))
				report(
					"IR.ref",
					path,
					`edge refers to node '${id}', which does not exist`,
				);
		}
		if (!from || !to) return;
		const inner = isGroup(from) && isInside(to.id, from.id);
		const fromPort = e.from.port;
		if (
			fromPort !== undefined &&
			!sourcePorts(from, to.id).includes(fromPort)
		) {
			report(
				"IR.ref",
				path,
				`node '${from.id}' has no ${inner ? "inner" : "output"} port '${fromPort}'`,
			);
		}
		if (e.kind !== "control") {
			if (!names(to.in).includes(e.to.port))
				report(
					"IR.ref",
					path,
					`node '${to.id}' has no input port '${e.to.port}'`,
				);
			feed(to.id, e.to.port);
		}
		checkFanIn(e, from, inner, path, report);
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
			);
		} else if (!inner) {
			// Lift the target to the source's level, so an edge into a body depends on its group.
			dependencies.push([from.id, targetGroups[sourceGroups.length] ?? to.id]);
		}
	});

	ir.nodes.forEach((n, i) => {
		const path = `/nodes/${i}`;
		for (const port of names(n.in)) {
			const count = feeds.get(`${n.id}\0${port}`) ?? 0;
			if (count === 0)
				report(
					"IR.graph",
					path,
					`input port '${port}' of node '${n.id}' is not fed`,
				);
			if (count > 1)
				report(
					"IR.graph",
					path,
					`input port '${port}' of node '${n.id}' is fed more than once`,
				);
		}
		if (isGroup(n)) checkGroup(n, path, nodes, nearestGroup, report);
	});

	if (ir.result.rule === "node") {
		const id = ir.result.node;
		if (!nodes.has(id))
			report("IR.ref", "/result", `node '${id}' does not exist`);
		else if (groupsOf(id).length > 0)
			report(
				"IR.graph",
				"/result",
				`result node '${id}' is inside a group body`,
			);
	}

	const cycle = findCycle(dependencies);
	if (cycle)
		report("IR.graph", "/edges", `edges form a cycle: ${cycle.join(" -> ")}`);
	return diagnostics;
}

type Report = (code: string, path: string, message: string) => void;

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
		);
	}
	if (e.kind !== "collect" && isResults) {
		report(
			"IR.graph",
			path,
			`results of map '${from.id}' must leave it through a collect edge`,
		);
	}
}

function checkGroup(
	g: GroupNode,
	path: string,
	nodes: Map<string, IrNode>,
	nearestGroup: (id: string) => string | undefined,
	report: Report,
) {
	const bodyNode = (id: string, role: string) => {
		const n = nodes.get(id);
		if (!n)
			report(
				"IR.ref",
				path,
				`${role} '${id}' of group '${g.id}' does not exist`,
			);
		else if (nearestGroup(id) !== g.id)
			report(
				"IR.graph",
				path,
				`${role} '${id}' is not in the body of group '${g.id}'`,
			);
		return n;
	};
	const members = Object.values(g.members).map((id) => bodyNode(id, "member"));
	// A seq or repeat mirrors its member's ports, which needs exactly one member. A map's
	// member results are records keyed by result name, so it may have several.
	if (g.kind !== "map" && members.length !== 1) {
		report(
			"IR.graph",
			path,
			`${g.kind} '${g.id}' must have exactly one member in IR 1.0, got ${members.length}`,
		);
	}
	const member = members.length === 1 ? members[0] : undefined;
	if (g.kind !== "map" && g.until) {
		const until = bodyNode(g.until.node, "until");
		if (
			until &&
			![...names(until.out), ...IMPLICIT_OUT].includes(g.until.port)
		) {
			report(
				"IR.ref",
				path,
				`node '${until.id}' has no output port '${g.until.port}'`,
			);
		}
	}

	const state = names(member?.out);
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
			);
		}
	};
	const literal = g.kind !== "repeat" && g.items !== undefined;
	if (g.kind === "repeat") {
		expect("in", names(g.in), state);
		expect("inner", names(g.inner), [...state, "index"]);
		expect("out", names(g.out), state);
	} else {
		expect("in", names(g.in), literal ? [] : ["items"]);
		expect("inner", names(g.inner), ["item"]);
		expect("out", names(g.out), g.kind === "map" ? ["results"] : state);
	}

	// Only a map over literal items has an exact size. Every other group may stop early or
	// depends on a result, so it declares an upper bound, equal to the item count when known.
	const c = g.cardinality;
	const count = literal ? g.items?.length : undefined;
	const exact = g.kind === "map" && literal;
	const valid = exact
		? "exact" in c && c.exact === count
		: "upTo" in c && (!literal || c.upTo === count);
	if (!valid) {
		const wanted = exact
			? `{ exact: ${count} }`
			: `{ upTo: ${literal ? count : "N"} }`;
		report(
			"IR.graph",
			path,
			`${g.kind} '${g.id}' must declare cardinality ${wanted}`,
		);
	}
}

/** Returns one cycle as a closed path of node ids, or undefined. */
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
