import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
	ConfigError,
	configDiagnostic,
	type KeyPath,
	sourceOf,
} from "@maestro/core/config";
import type { HostSetup } from "@maestro/core/host";
import {
	boundOf,
	type Diagnostic,
	type GraphIndex,
	type GroupNode,
	type HostNode,
	type IrNode,
	isGroup,
	isPlainObject,
} from "@maestro/ir";
import type { Harness } from "../harness/index";
import {
	PROFILES,
	type Profile,
	resolveProfile,
	untunable,
} from "../profile/index";
import {
	AGENT_IN_PORTS,
	AGENT_KIND,
	type AgentConfig,
	APPLY_KIND,
	type ApplyConfig,
	agentConfig,
	applyConfig,
	CHECK_KIND,
	type CheckConfig,
	type CheckSpec,
	COMMITS_KIND,
	type CommitsConfig,
	checkConfig,
	commitsConfig,
	isLegacyAgent,
	LANE_PORT,
	LEGACY_ROLE,
	listed,
	type RepoSetup,
	ROLES,
	repoSetup,
	useOneOf,
} from "./config";

/** The entry, a directory or a file, that makes a directory a git repository. */
const GIT_ENTRY = ".git";

type Finding = Omit<Diagnostic, "severity">;

/** An agent node and its config. */
type AgentNode = { node: HostNode; kind: "agent"; config: AgentConfig };

/** A repo node and the config of its kind. */
type RepoNode =
	| AgentNode
	| { node: HostNode; kind: "check"; config: CheckConfig }
	| { node: HostNode; kind: "apply"; config: ApplyConfig }
	| { node: HostNode; kind: "commits"; config: CommitsConfig };

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
			if (node.kind === COMMITS_KIND)
				return [{ node, kind: "commits", config: commitsConfig(node.config) }];
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

/** The harness an agent runs on, when its profile resolved. */
type HarnessOf = (config: AgentConfig) => string | undefined;

/** Why `node` cannot extend `source`, a lane ref or a commits node's version, which only a fork or a read can take. */
function unextendable(
	graph: GraphIndex,
	node: HostNode,
	source: LaneSource,
): Finding | undefined {
	const id = node.id;
	if ("literal" in source)
		return {
			code: "HOST.lane",
			node: id,
			message: `'${id}' extends a lane ref of another concert, which only a fork or a read can take`,
			hint: `Fork or read the lane ref in '${id}', or extend a version of this concert`,
		};
	if (graph.nodes.get(source.node)?.kind !== COMMITS_KIND) return undefined;
	return {
		code: "HOST.lane",
		node: id,
		message: `'${id}' extends '${source.node}.${source.port}', a version of target commits, which only a fork or a read can take`,
		hint: `Fork it in '${id}'`,
	};
}

/** The findings of one node extending `source`; `first` maps each extended output to its first extender. */
function extensionFindings(
	graph: GraphIndex,
	node: HostNode,
	source: LaneSource,
	first: Map<string, string>,
): Finding[] {
	const refused = unextendable(graph, node, source);
	if (refused) return [refused];
	if ("literal" in source) return [];
	const from = `${source.node}.${source.port}`;
	// A loop's state port is read inside its body and its output outside it; the two never write together.
	const side = graph.groupsOf(node.id).includes(source.node) ? "inner" : "out";
	const key = `${from}:${side}`;
	const other = first.get(key);
	first.set(key, node.id);
	const found: Finding[] = [];
	if (other !== undefined)
		found.push({
			code: "HOST.lane",
			node: node.id,
			message: `'${node.id}' extends '${from}', which '${other}' extends too; a version is extended at most once`,
			hint: `Fork '${from}' in one of '${other}' and '${node.id}'`,
		});
	const repeated = repeatedGroup(graph, node.id, source.node);
	if (repeated)
		found.push({
			code: "HOST.lane",
			node: node.id,
			message: `'${node.id}' extends '${from}' once per iteration of group '${repeated}'; a version is extended at most once`,
			hint: `Fork '${from}' in '${node.id}', or extend it outside '${repeated}'`,
		});
	return found;
}

/** Lane extensions that would extend one version twice: two nodes extending one output, or one node once per iteration. */
function doubleExtends(
	graph: GraphIndex,
	chained: [RepoNode, LaneSource][],
): Finding[] {
	const first = new Map<string, string>();
	return chained.flatMap(([{ node }, source]) =>
		extensionFindings(graph, node, source, first),
	);
}

/** The group around `id`, other than one holding `source`, that runs it more than once. */
function repeatedGroup(graph: GraphIndex, id: string, source: string) {
	return graph
		.groupsOf(id)
		.find(
			(g) => !(source === g || source.startsWith(`${g}/`)) && repeats(graph, g),
		);
}

function repeats(graph: GraphIndex, id: string): boolean {
	const group = graph.nodes.get(id);
	return isGroup(group) && boundOf(group.cardinality) > 1;
}

/** What writes a version: an agent node, or a description of the node that is not one. */
type Writer = HostNode | string;

/**
 * The writers of the version at `port` of node `id`, followed through extending checks and loop state:
 * - an agent is its own writer, and an extending check has the writers of the version it extended
 * - a loop's state has the writers of its initial state and of its step's result
 * - any other node is described by a string, and one not known at compose has no writer listed
 */
function sessionWriters(
	graph: GraphIndex,
	id: string,
	port: string,
	seen = new Set<string>(),
): Writer[] {
	const key = `${id}.${port}`;
	const node = graph.nodes.get(id);
	if (!node || seen.has(key)) return [];
	seen.add(key);
	if (node.kind === "loop") return loopWriters(graph, node, port, seen);
	if (!isHostNode(node)) return [];
	if (node.kind === AGENT_KIND) return [node];
	if (node.kind !== CHECK_KIND) return [`'${id}', a '${node.kind}' node`];
	const { lane } = checkConfig(node.config);
	if (lane.mode !== "extend")
		return [`'${id}', a check on a '${lane.mode}' lane`];
	const from = laneSource(graph, node);
	return from && "node" in from
		? sessionWriters(graph, from.node, from.port, seen)
		: [];
}

function loopWriters(
	graph: GraphIndex,
	loop: GroupNode,
	port: string,
	seen: Set<string>,
): Writer[] {
	const initial = graph
		.edgesInto(loop.id)
		.find((e) => e.kind === "data" && e.to.port === port);
	return [
		...(initial?.kind === "data"
			? sessionWriters(graph, initial.from.node, initial.from.port, seen)
			: []),
		...Object.values(loop.members).flatMap((step) =>
			sessionWriters(graph, step, port, seen),
		),
	];
}

/** Why `r` cannot resume the session of the version it extends from `source`, when that is known at compose. */
function resumeProblem(
	graph: GraphIndex,
	harnessOf: HarnessOf,
	r: AgentNode,
	source: LaneSource | undefined,
): string | undefined {
	if (!source) return undefined;
	if ("literal" in source)
		return `'${r.node.id}' resumes a version of another concert`;
	const own = harnessOf(r.config);
	for (const writer of sessionWriters(graph, source.node, source.port)) {
		if (typeof writer === "string")
			return `'${r.node.id}' resumes '${source.node}', which carries ${writer} and no agent session`;
		const wrote = harnessOf(agentConfig(writer.config));
		if (wrote && own && wrote !== own)
			return `'${r.node.id}' runs on harness '${own}' and resumes '${source.node}', written on harness '${wrote}'`;
	}
	return undefined;
}

function resumes(
	graph: GraphIndex,
	harnessOf: HarnessOf,
	agents: AgentNode[],
): Finding[] {
	return agents.flatMap((r) => {
		const { lane } = r.config;
		if (lane.mode !== "extend" || !lane.resume) return [];
		const message = resumeProblem(
			graph,
			harnessOf,
			r,
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

/** The checks a node runs or lets its agent run. */
function checksNamed(r: RepoNode): string[] {
	if (r.kind === "agent") return r.config.checks ?? [];
	if (r.kind === "check")
		return typeof r.config.check === "string" ? [r.config.check] : [];
	return [];
}

/** A check a node names that config does not have. */
function names(setup: RepoSetup, r: RepoNode): Finding[] {
	const id = r.node.id;
	if (r.kind === "apply" || r.kind === "commits") return [];
	return r.kind === "check"
		? checkNames(
				setup,
				id,
				checksNamed(r),
				"runs",
				"Add it under 'target.checks', or give the node an inline check",
			)
		: checkNames(
				setup,
				id,
				checksNamed(r),
				"may run",
				"Add it under 'target.checks'",
			);
}

/** The config entries the graph's repo nodes read by name: each check a node names. A profile needs no entry. */
export function needsRepo(graph: GraphIndex): KeyPath[] {
	if (legacyAgents(graph).length) return [];
	return repoNodes(graph).flatMap((r) =>
		checksNamed(r).map((name) => ["target", "checks", name]),
	);
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

/** The binds of `label`, a check or the target's prepare, read-only then writable. */
const checkBinds = (
	setup: RepoSetup,
	label: string,
	spec: CheckSpec,
	node?: string,
) => [
	...bindProblems(setup, spec.readOnly, `${label} read-only bind`, node),
	...bindProblems(setup, spec.writable, `${label} writable bind`, node, true),
];

/** The binds of a check node's inline check. */
function nodeBinds(setup: RepoSetup, r: RepoNode): Finding[] {
	return r.kind === "check" && typeof r.config.check === "object"
		? checkBinds(setup, "inline check", r.config.check, r.node.id)
		: [];
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
	if (!existsSync(repo))
		return [
			{
				code: "HOST.target",
				message: `target repository '${repo}' does not exist`,
				hint: "Set 'target.repo' relative to the file's workspace root, or the user config's directory",
			},
		];
	if (!existsSync(join(repo, GIT_ENTRY)))
		return [
			{
				code: "HOST.target",
				message: `target repository '${repo}' is not a git repository`,
				hint: "Point 'target.repo' at a git repository",
			},
		];
	return [];
}

/** The `target.sparse` entries that are absolute or step out through `..`. */
function sparseProblems(setup: RepoSetup): Finding[] {
	const sparse = setup.target?.sparse;
	return (Array.isArray(sparse) ? sparse : []).flatMap((entry) => {
		const how = isAbsolute(entry)
			? "is absolute"
			: entry.split("/").includes("..")
				? "has a '..' segment"
				: undefined;
		return how
			? [
					{
						code: "HOST.target",
						message: `target.sparse entry '${entry}' ${how}`,
						hint: "List directories relative to the repo root",
					},
				]
			: [];
	});
}

/** The agent nodes of `graph` built before profiles, each refused by name. */
function legacyAgents(graph: GraphIndex): Finding[] {
	return [...graph.nodes.values()].flatMap((n) =>
		n.kind === AGENT_KIND && isLegacyAgent(n.config)
			? [
					{
						code: "HOST.legacy",
						node: n.id,
						message: `agent node '${n.id}' names a ${LEGACY_ROLE}: it was built before profiles replaced roles`,
						hint: "Perform its composition anew with this maestro",
					},
				]
			: [],
	);
}

/** An error when config still sets `roles`, which profiles replace. */
function rolesProblems(setup: HostSetup): Diagnostic[] {
	const { roles } = setup.config;
	const unset =
		roles === undefined || (isPlainObject(roles) && !Object.keys(roles).length);
	if (unset) return [];
	return [
		configDiagnostic(
			"HOST.roles",
			sourceOf(setup, [ROLES]),
			`config '${ROLES}' is no longer read: profiles replace roles`,
			`Move each role's fields under '${PROFILES}.<profile>.runtime', and drop '${ROLES}'`,
		),
	];
}

/** The profiles `names` resolve to under `setup`, and the errors of those that do not. */
async function resolveAll(
	names: readonly string[],
	setup: HostSetup,
): Promise<{ profiles: Map<string, Profile>; errors: Diagnostic[] }> {
	const profiles = new Map<string, Profile>();
	const errors: Diagnostic[] = [];
	for (const name of new Set(names))
		try {
			profiles.set(name, await resolveProfile(name, setup));
		} catch (e) {
			if (!(e instanceof ConfigError)) throw e;
			errors.push(...e.diagnostics);
		}
	return { profiles, errors };
}

/**
 * What `profile` asks that the loaded `harnesses` cannot give, and its read-only binds and attachments that
 * `bindProblems` refuses.
 */
function profileProblems(
	profile: Profile,
	harnesses: readonly Harness[],
	setup: RepoSetup,
): Diagnostic[] {
	const { name, fields } = profile;
	const { runtime } = fields;
	const key = (field: string) => `${PROFILES}.${name}.runtime.${field}`;
	const at = (field: string) => sourceOf(profile, ["runtime", field]);
	const harness = harnesses.find((h) => h.name === runtime.harness);
	if (!harness)
		return [
			configDiagnostic(
				"HOST.harness",
				at("harness"),
				`profile ${name} runs on harness '${runtime.harness}', which is not loaded`,
				`Set '${key("harness")}' to one of: ${listed(harnesses.map((h) => h.name))}`,
			),
		];
	return [
		...(harness.runtimeProblems?.(runtime) ?? []).map((p) =>
			configDiagnostic(
				"HOST.runtime",
				at(p.field),
				`${key(p.field)}: ${p.reason}`,
				p.fix,
			),
		),
		...bindProblems(
			setup,
			fields.readOnly,
			`profile ${name} read-only bind`,
		).map(error),
		...Object.entries(fields.attachments).flatMap(([key, a]) =>
			bindProblems(
				setup,
				[a.path],
				`${PROFILES}.${name}.attachments.${key}.path`,
			).map(error),
		),
	];
}

/** Each attachment of `profile` whose name the agent `r` takes already, for a port of its own or from the graph. */
function attachmentClashes(r: AgentNode, profile: Profile): Finding[] {
	const id = r.node.id;
	const graph = Object.keys(r.config.attachments ?? {});
	return Object.keys(profile.fields.attachments).flatMap((name) => {
		const own = AGENT_IN_PORTS.includes(name);
		if (!own && !graph.includes(name)) return [];
		return [
			{
				code: "HOST.attachment",
				node: id,
				message: `profile ${profile.name} attaches '${name}', which '${id}' takes ${own ? "as its own port" : "from the graph"}`,
				hint: `Rename attachment '${name}' in profile ${profile.name}${own ? "" : ", or the graph's"}`,
			},
		];
	});
}

/** An agent in a seat whose name an earlier agent's seat of another profile or verdict holds. */
function seatClashes(agents: readonly AgentNode[]): Finding[] {
	const first = new Map<string, AgentNode>();
	return agents.flatMap(({ node, config }) => {
		const other = first.get(config.seat);
		if (!other) first.set(config.seat, { node, kind: "agent", config });
		const same =
			!other ||
			(other.config.profile === config.profile &&
				Boolean(other.config.verdict) === Boolean(config.verdict));
		return same
			? []
			: [
					{
						code: "HOST.seat",
						node: node.id,
						message: `'${other.node.id}' and '${node.id}' sit in two seats named '${config.seat}'`,
						hint: "Give one of the two seats another name",
					},
				];
	});
}

/**
 * The profile rules: each seated profile resolves (ADR 0013) and its harness can run it, config tunes no profile that no
 * root holds, profile attachments take no name the agent has, and a seat name means one seat.
 */
async function profileFindings(
	agents: AgentNode[],
	setup: HostSetup,
	harnesses: readonly Harness[],
): Promise<{ diagnostics: Diagnostic[]; harnessOf: HarnessOf }> {
	const repo = repoSetup(setup);
	const { profiles, errors } = await resolveAll(
		agents.map((a) => a.config.profile),
		setup,
	);
	const clashes = agents.flatMap((a) => {
		const profile = profiles.get(a.config.profile);
		return profile ? attachmentClashes(a, profile) : [];
	});
	return {
		diagnostics: [
			...errors,
			...(await untunable(setup)),
			...[...profiles.values()].flatMap((p) =>
				profileProblems(p, harnesses, repo),
			),
			...[...clashes, ...seatClashes(agents)].map(error),
		],
		harnessOf: (config) => profiles.get(config.profile)?.fields.runtime.harness,
	};
}

/**
 * The host's compose-time rules: agents built before profiles, the profiles agents run, the lane rules (HOST-02),
 * resume, names config must have, binds (HOST-11) and the target. A graph without repo nodes has none to break.
 */
export async function validateRepo(
	graph: GraphIndex,
	hostSetup: HostSetup,
	harnesses: readonly Harness[],
): Promise<Diagnostic[]> {
	const legacy = legacyAgents(graph);
	if (legacy.length) return legacy.map(error);
	const nodes = repoNodes(graph);
	if (!nodes.length) return [];
	const setup = repoSetup(hostSetup);
	const agents = nodes.filter((r): r is AgentNode => r.kind === "agent");
	const profiled = await profileFindings(agents, hostSetup, harnesses);
	const chained = nodes.flatMap((r): [RepoNode, LaneSource][] => {
		const source = laneSource(graph, r.node);
		const extending = r.kind !== "commits" && r.config.lane.mode === "extend";
		return extending && source ? [[r, source]] : [];
	});
	return [
		...rolesProblems(hostSetup),
		...profiled.diagnostics,
		...[
			...targetProblems(setup),
			...sparseProblems(setup),
			...bindProblems(setup, setup.sandbox.readOnly, "read-only bind"),
			...bindProblems(setup, setup.sandbox.path, "sandbox.path directory"),
			...Object.entries(setup.target?.checks ?? {}).flatMap(([name, spec]) =>
				checkBinds(setup, `check '${name}'`, spec),
			),
			...(setup.target?.prepare
				? checkBinds(setup, "target.prepare", setup.target.prepare)
				: []),
			...nodes.flatMap((r) => [...names(setup, r), ...nodeBinds(setup, r)]),
			...doubleExtends(graph, chained),
			...resumes(graph, profiled.harnessOf, agents),
		].map(error),
	];
}
