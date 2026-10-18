import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import {
	boundOf,
	type Diagnostic,
	type GraphIndex,
	type HostNode,
	type IrNode,
	isGroup,
} from "@maestro/ir";
import {
	AGENT_KIND,
	type AgentConfig,
	APPLY_KIND,
	type ApplyConfig,
	agentConfig,
	applyConfig,
	CHECK_KIND,
	type CheckConfig,
	type CheckSpec,
	checkConfig,
	LANE_PORT,
	type LaneInput,
	listed,
	type RepoSetup,
	useOneOf,
} from "./config";

type Finding = Omit<Diagnostic, "severity">;

/** A repo node and the config of its kind. */
type RepoNode =
	| { node: HostNode; kind: "agent"; config: AgentConfig }
	| { node: HostNode; kind: "check"; config: CheckConfig }
	| { node: HostNode; kind: "apply"; config: ApplyConfig };

/** Where a node's lane input comes from: an edge from a node's port, or a literal, a lane ref of another concert. */
type LaneSource = { node: string; port: string } | { literal: unknown };

const error = (f: Finding): Diagnostic => ({ ...f, severity: "error" });

const isHostNode = (n: IrNode): n is HostNode => n.kind.includes(".");

function repoNodes(graph: GraphIndex): RepoNode[] {
	return [...graph.nodes.values()]
		.filter(isHostNode)
		.flatMap((node): RepoNode[] => {
			if (node.kind === AGENT_KIND)
				return [{ node, kind: "agent", config: agentConfig(node.config) }];
			if (node.kind === CHECK_KIND)
				return [{ node, kind: "check", config: checkConfig(node.config) }];
			if (node.kind === APPLY_KIND)
				return [{ node, kind: "apply", config: applyConfig(node.config) }];
			return [];
		});
}

function laneSource(graph: GraphIndex, node: HostNode): LaneSource | undefined {
	if (node.literals && Object.hasOwn(node.literals, LANE_PORT))
		return { literal: node.literals[LANE_PORT] };
	const edge = graph
		.edgesInto(node.id)
		.find((e) => e.kind === "data" && e.to.port === LANE_PORT);
	return edge?.kind === "data" ? edge.from : undefined;
}

/** The harness the role of an agent node runs on, when config has that role. */
const harnessOf = (r: RepoNode, setup: RepoSetup) =>
	r.kind === "agent"
		? (r.config.role.harness ?? setup.roles[r.config.role.name]?.harness)
		: undefined;

/** Joins that would join one version twice: two nodes joining one output, or a node joining once per iteration. */
function doubleJoins(
	graph: GraphIndex,
	joins: [RepoNode, LaneSource][],
): Finding[] {
	const found: Finding[] = [];
	const first = new Map<string, string>();
	for (const [{ node }, source] of joins) {
		if ("literal" in source) {
			found.push({
				code: "HOST.lane",
				node: node.id,
				message: `'${node.id}' joins a lane ref of another concert, which only a fork or a read can take`,
				hint: `Fork or read the lane ref in '${node.id}', or join a version of this concert`,
			});
			continue;
		}
		const from = `${source.node}.${source.port}`;
		const other = first.get(from);
		if (other !== undefined)
			found.push({
				code: "HOST.lane",
				node: node.id,
				message: `'${node.id}' joins '${from}', which '${other}' joins too; a version is joined at most once`,
				hint: `Fork '${from}' in one of '${other}' and '${node.id}'`,
			});
		first.set(from, node.id);
		const repeated = graph
			.groupsOf(node.id)
			.find(
				(g) =>
					!(source.node === g || source.node.startsWith(`${g}/`)) &&
					repeats(graph, g),
			);
		if (repeated)
			found.push({
				code: "HOST.lane",
				node: node.id,
				message: `'${node.id}' joins '${from}' once per iteration of group '${repeated}'; a version is joined at most once`,
				hint: `Fork '${from}' in '${node.id}', or join it outside '${repeated}'`,
			});
	}
	return found;
}

function repeats(graph: GraphIndex, id: string): boolean {
	const group = graph.nodes.get(id);
	return isGroup(group) && boundOf(group.cardinality) > 1;
}

/** Why `r` cannot resume the session of the version it joins from `source`, when that is known at compose. */
function resumeProblem(
	graph: GraphIndex,
	setup: RepoSetup,
	r: RepoNode,
	lane: LaneInput,
	source: LaneSource | undefined,
): string | undefined {
	if (lane.mode !== "join")
		return `'${r.node.id}' resumes, but its lane mode is '${lane.mode}'; only a join continues a session`;
	if (!source) return undefined;
	if ("literal" in source)
		return `'${r.node.id}' resumes a version of another concert`;
	const writer = graph.nodes.get(source.node);
	if (writer?.kind === CHECK_KIND)
		return `'${r.node.id}' resumes '${source.node}', a check, which no agent session wrote`;
	if (!writer || !isHostNode(writer) || writer.kind !== AGENT_KIND)
		return undefined;
	const wrote = harnessOf(
		{ node: writer, kind: "agent", config: agentConfig(writer.config) },
		setup,
	);
	const own = harnessOf(r, setup);
	if (wrote && own && wrote !== own)
		return `'${r.node.id}' runs on harness '${own}' and resumes '${source.node}', written on harness '${wrote}'`;
	return undefined;
}

function resumes(
	graph: GraphIndex,
	setup: RepoSetup,
	nodes: RepoNode[],
): Finding[] {
	return nodes.flatMap((r) => {
		if (r.kind !== "agent" || !r.config.resume) return [];
		const message = resumeProblem(
			graph,
			setup,
			r,
			r.config.lane,
			laneSource(graph, r.node),
		);
		return message
			? [
					{
						code: "HOST.resume",
						node: r.node.id,
						message,
						hint: `Drop resume from '${r.node.id}'`,
					},
				]
			: [];
	});
}

/** The checks `named` that config does not have, which `id` runs or lets its agent run. */
function checkNames(
	setup: RepoSetup,
	id: string,
	named: string[],
	verb: string,
	add: string,
): Finding[] {
	const checks = Object.keys(setup.target?.checks ?? {});
	return named
		.filter((name) => !checks.includes(name))
		.map((name) => ({
			code: "HOST.check",
			node: id,
			message: `'${id}' ${verb} check '${name}', which config 'target.checks' does not have`,
			hint: useOneOf(checks, add),
		}));
}

/** A role or harness an agent node names that config or the loaded harnesses do not have. */
function roleNames(
	setup: RepoSetup,
	harnesses: readonly string[],
	r: RepoNode & { kind: "agent" },
): Finding[] {
	const id = r.node.id;
	const { name } = r.config.role;
	if (!Object.hasOwn(setup.roles, name))
		return [
			{
				code: "HOST.role",
				node: id,
				message: `'${id}' takes role '${name}', which config 'roles' does not have`,
				hint: useOneOf(
					Object.keys(setup.roles),
					`Add role '${name}' under 'roles'`,
				),
			},
		];
	const harness = harnessOf(r, setup) ?? "";
	if (harnesses.includes(harness)) return [];
	return [
		{
			code: "HOST.harness",
			node: id,
			message: `'${id}' runs on harness '${harness}', which is not loaded`,
			hint: `Use one of: ${listed(harnesses)}`,
		},
	];
}

/** A role, harness or check a node names that config or the loaded harnesses do not have. */
function names(
	setup: RepoSetup,
	harnesses: readonly string[],
	r: RepoNode,
): Finding[] {
	const id = r.node.id;
	if (r.kind === "apply") return [];
	if (r.kind === "check") {
		const { check } = r.config;
		return checkNames(
			setup,
			id,
			typeof check === "string" ? [check] : [],
			"runs",
			"Add it under 'target.checks', or give the node an inline check",
		);
	}
	return [
		...roleNames(setup, harnesses, r),
		...checkNames(
			setup,
			id,
			r.config.checks ?? [],
			"may run",
			"Add it under 'target.checks'",
		),
	];
}

const within = (inner: string, outer: string) =>
	inner === outer || inner.startsWith(outer + sep);

/** The realpath of `path` when it exists, else its absolute spelling. */
const realOrResolved = (path: string) =>
	existsSync(path) ? realpathSync(path) : resolve(path);

/**
 * How the bind of `real` reaches what a bind must not: the lanes, and for a writable one also the target repository.
 * A writable bind may not contain or lie inside either, or an agent could write them.
 */
function reach(
	setup: RepoSetup,
	real: string,
	writable: boolean,
): string | undefined {
	const store = realOrResolved(setup.store);
	if (within(real, store)) return "is inside a lane";
	if (!writable) return undefined;
	const repo = setup.target && realOrResolved(setup.target.repo);
	if (within(store, real)) return "contains the lanes";
	if (repo === undefined) return undefined;
	if (within(repo, real)) return "contains the target repository";
	return within(real, repo) ? "is inside the target repository" : undefined;
}

/**
 * A bind of `paths`, described by `what`, that is relative or missing, or reaches the lanes or, when `writable`, the
 * target repository.
 */
function bindProblems(
	setup: RepoSetup,
	paths: string[],
	what: string,
	node?: string,
	writable = false,
): Finding[] {
	return paths.flatMap((path) => {
		const found = (message: string, hint: string): Finding[] => [
			{
				code: "HOST.bind",
				node,
				message: `${what} '${path}' ${message}`,
				hint,
			},
		];
		if (!isAbsolute(path))
			return found("is not an absolute path", "Give an absolute path");
		if (!existsSync(path))
			return found("does not exist", "Create it, or drop the bind");
		const how = reach(setup, realpathSync(path), writable);
		return how
			? found(
					how,
					writable
						? "Bind a path outside the lanes and the target repository"
						: "Bind a path outside the lanes",
				)
			: [];
	});
}

/** The binds of check `label`, read-only then writable. */
const checkBinds = (
	setup: RepoSetup,
	label: string,
	spec: CheckSpec,
	node?: string,
) => [
	...bindProblems(setup, spec.readOnly, `${label} read-only bind`, node),
	...bindProblems(setup, spec.writable, `${label} writable bind`, node, true),
];

/** The binds `r` declares: an agent's read-only paths, or the binds of a check node's inline check. */
function nodeBinds(setup: RepoSetup, r: RepoNode): Finding[] {
	const id = r.node.id;
	if (r.kind === "agent")
		return bindProblems(setup, r.config.readOnly ?? [], "read-only bind", id);
	if (r.kind === "check" && typeof r.config.check === "object")
		return checkBinds(setup, "inline check", r.config.check, id);
	return [];
}

function targetProblems(setup: RepoSetup): Finding[] {
	const repo = setup.target?.repo;
	if (repo === undefined)
		return [
			{
				code: "HOST.target",
				message:
					"config 'target.repo' is not set, and the graph has repo nodes",
				hint: "Set 'target.repo' to the repository lanes are cut from",
			},
		];
	if (!existsSync(resolve(repo)))
		return [
			{
				code: "HOST.target",
				message: `target repository '${repo}' does not exist`,
				hint: "Set 'target.repo' to an existing repository",
			},
		];
	return [];
}

/**
 * The host's compose-time rules: the lane rules (HOST-02), resume, names config must have, binds (HOST-11)
 * and the target. A graph without repo nodes has none to break.
 */
export function validateRepo(
	graph: GraphIndex,
	setup: RepoSetup,
	harnesses: readonly string[],
): Diagnostic[] {
	const nodes = repoNodes(graph);
	if (!nodes.length) return [];
	const joins = nodes.flatMap((r): [RepoNode, LaneSource][] => {
		const source = laneSource(graph, r.node);
		return r.config.lane.mode === "join" && source ? [[r, source]] : [];
	});
	return [
		...targetProblems(setup),
		...bindProblems(setup, setup.readOnly, "read-only bind"),
		...Object.entries(setup.target?.checks ?? {}).flatMap(([name, spec]) =>
			checkBinds(setup, `check '${name}'`, spec),
		),
		...nodes.flatMap((r) => [
			...names(setup, harnesses, r),
			...nodeBinds(setup, r),
		]),
		...doubleJoins(graph, joins),
		...resumes(graph, setup, nodes),
	].map(error);
}
