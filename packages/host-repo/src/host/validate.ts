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
	type HostNode,
	type IrNode,
	isGroup,
	isPlainObject,
	MAESTRO_TYPE,
	type PortRef,
} from "@maestro/ir";
import type { Harness } from "../harness/index";
import {
	PROFILES,
	type Profile,
	resolveProfile,
	untunable,
} from "../profile/index";
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
	COMMITS_KIND,
	type CommitsConfig,
	checkConfig,
	commitsConfig,
	isLegacyAgent,
	LANE_PORT,
	LEGACY_ROLE,
	listed,
	noHint,
	RESERVED_ATTACHMENTS,
	type RepoSetup,
	ROLES,
	repoSetup,
	SESSION_PORT,
	SESSION_TYPE,
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

/** Where a node's input comes from: an edge from a node's port, or a literal, such as a lane ref of another concert. */
type InputSource = { node: string; port: string } | { literal: unknown };

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

/** Where input `port` of `node` comes from, if anywhere. */
function inputSource(
	graph: GraphIndex,
	node: IrNode,
	port: string,
): InputSource | undefined {
	if (node.literals && Object.hasOwn(node.literals, port))
		return { literal: node.literals[port] };
	const edge = graph
		.edgesInto(node.id)
		.find((e) => e.kind === "data" && e.to.port === port);
	return edge?.kind === "data" ? edge.from : undefined;
}

const laneSource = (graph: GraphIndex, node: HostNode) =>
	inputSource(graph, node, LANE_PORT);

/** The harness an agent runs on, when its profile resolved. */
type HarnessOf = (config: AgentConfig) => string | undefined;

/** Why `node` cannot extend `source`, a lane ref or a commits node's version, which only a fork or a read can take. */
function unextendable(
	graph: GraphIndex,
	node: HostNode,
	source: InputSource,
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

/**
 * The node that took `source` before `id` did, as `first` records each source port by the side of it read. A loop's
 * state port is read inside its body and its output outside it, and the two never run together.
 */
function takenBy(
	graph: GraphIndex,
	id: string,
	source: PortRef,
	first: Map<string, string>,
): string | undefined {
	const side = graph.groupsOf(id).includes(source.node) ? "inner" : "out";
	const key = `${source.node}.${source.port}:${side}`;
	const other = first.get(key);
	first.set(key, id);
	return other;
}

/** The findings of one node extending `source`; `first` maps each extended output to its first extender. */
function extensionFindings(
	graph: GraphIndex,
	node: HostNode,
	source: InputSource,
	first: Map<string, string>,
): Finding[] {
	const refused = unextendable(graph, node, source);
	if (refused) return [refused];
	if ("literal" in source) return [];
	const from = `${source.node}.${source.port}`;
	const other = takenBy(graph, node.id, source, first);
	const found: Finding[] = [];
	if (other !== undefined)
		found.push({
			code: "HOST.lane",
			node: node.id,
			message: `'${node.id}' extends '${from}', which '${other}' extends too; a version is extended at most once`,
			hint: `Fork '${from}' in one of '${other}' and '${node.id}'`,
		});
	const repeated = enclosing(graph, node.id, source.node).find((g) =>
		repeats(graph, g),
	);
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
	chained: [RepoNode, InputSource][],
): Finding[] {
	const first = new Map<string, string>();
	return chained.flatMap(([{ node }, source]) =>
		extensionFindings(graph, node, source, first),
	);
}

/** The groups around `id` that do not hold `source`, so run `id` once per iteration over one value of it. */
const enclosing = (graph: GraphIndex, id: string, source: string) =>
	graph
		.groupsOf(id)
		.filter((g) => !(source === g || source.startsWith(`${g}/`)));

function repeats(graph: GraphIndex, id: string): boolean {
	const group = graph.nodes.get(id);
	return isGroup(group) && boundOf(group.cardinality) > 1;
}

/** The group kinds that run their body's iterations side by side. */
const PARALLEL = ["parMap", "parFind"];

const isSession = (schema: unknown) =>
	isPlainObject(schema) && schema[MAESTRO_TYPE] === SESSION_TYPE;

const inside = (id: string, group: string) => id.startsWith(`${group}/`);

/**
 * The agents whose `out.session` reaches port `port` of node `id`. A group's port carries what feeds it and what its
 * members leave at that port. A code node's session output carries its session input of the same name, else every
 * session input it has.
 */
function sessionProducers(
	graph: GraphIndex,
	id: string,
	port: string,
	seen = new Set<string>(),
): HostNode[] {
	const key = `${id}.${port}`;
	const node = graph.nodes.get(id);
	if (!node || seen.has(key)) return [];
	seen.add(key);
	if (node.kind === AGENT_KIND && isHostNode(node)) return [node];
	const fed = (p: string) => {
		const source = inputSource(graph, node, p);
		return source && "node" in source
			? sessionProducers(graph, source.node, source.port, seen)
			: [];
	};
	if (isGroup(node))
		return [
			...fed(port),
			...Object.values(node.members).flatMap((m) =>
				sessionProducers(graph, m, port, seen),
			),
		];
	if (isHostNode(node) || !isSession(node.out?.[port])) return [];
	const inputs = Object.keys(node.in ?? {}).filter((p) =>
		isSession(node.in?.[p]),
	);
	return (inputs.includes(port) ? [port] : inputs).flatMap(fed);
}

/** The nodes that run after `n` finishes: those its edges reach outside it, and the groups that hold it. */
const nextOf = (graph: GraphIndex, n: string) => [
	...graph.groupsOf(n),
	...graph
		.edgesFrom(n)
		.map((e) => e.to.node)
		.filter((to) => !inside(to, n)),
];

/** Whether `b` runs after `a`: downstream of it by edges, or inside a group entered downstream of it. */
function runsAfter(graph: GraphIndex, a: string, b: string): boolean {
	const seen = new Set<string>();
	const queue = [a];
	for (let n = queue.pop(); n !== undefined; n = queue.pop()) {
		if (n === b || (inside(b, n) && !inside(a, n))) return true;
		if (!seen.has(n)) queue.push(...nextOf(graph, n));
		seen.add(n);
	}
	return false;
}

/** A finding of `r` by the session rule its `message` breaks. */
const sessionFinding = (r: AgentNode, message: string, hint: string) => ({
	code: "HOST.session",
	node: r.node.id,
	message,
	hint,
});

/** The producers of the session `r` continues that its profile runs on another harness. */
function harnessClashes(
	harnessOf: HarnessOf,
	r: AgentNode,
	producers: HostNode[],
): Finding[] {
	const own = harnessOf(r.config);
	const id = r.node.id;
	return producers.flatMap((maker) => {
		const config = agentConfig(maker.config);
		const theirs = harnessOf(config);
		if (!own || !theirs || own === theirs) return [];
		return [
			sessionFinding(
				r,
				`'${id}' runs profile ${r.config.profile} on harness '${own}' and continues the session of '${maker.id}', profile ${config.profile} on harness '${theirs}'; a session runs on one harness`,
				`Give '${id}' a profile on harness '${theirs}', or drop its session`,
			),
		];
	});
}

/**
 * The agents that continue a session of `producers` too, and that neither run after `r` nor before it. `consumers`
 * maps each producer to its continuers so far, `r` added.
 */
function rivals(
	graph: GraphIndex,
	r: AgentNode,
	producers: HostNode[],
	consumers: Map<string, string[]>,
): Finding[] {
	const id = r.node.id;
	const found = new Map<string, string>();
	for (const maker of producers) {
		const earlier = consumers.get(maker.id) ?? [];
		for (const other of earlier)
			if (!runsAfter(graph, other, id) && !runsAfter(graph, id, other))
				found.set(other, maker.id);
		consumers.set(maker.id, [...earlier, id]);
	}
	return [...found].map(([other, maker]) =>
		sessionFinding(
			r,
			`'${id}' continues the session of '${maker}', which '${other}' continues too, neither after the other; a session has one runner at a time`,
			`Continue it in one of '${other}' and '${id}', or chain them through '${other}.session'`,
		),
	);
}

/** The producer of the session `r` continues from outside a group around `r` whose iterations run side by side. */
function parallelTakes(
	graph: GraphIndex,
	r: AgentNode,
	producers: HostNode[],
): Finding[] {
	const id = r.node.id;
	for (const maker of producers) {
		const parallel = enclosing(graph, id, maker.id).find((g) =>
			PARALLEL.includes(graph.nodes.get(g)?.kind ?? ""),
		);
		if (parallel !== undefined)
			return [
				sessionFinding(
					r,
					`'${id}' continues the session of '${maker.id}' from outside group '${parallel}', whose iterations run side by side; a session has one runner at a time`,
					`Start the session inside '${parallel}', or continue it after '${parallel}'`,
				),
			];
	}
	return [];
}

/**
 * The session rules over the agents that continue a session from another node: one runner at a time, and one
 * harness per session.
 */
function sessionRules(
	graph: GraphIndex,
	harnessOf: HarnessOf,
	agents: AgentNode[],
): Finding[] {
	const consumers = new Map<string, string[]>();
	return agents.flatMap((r) => {
		const source = inputSource(graph, r.node, SESSION_PORT);
		if (!source || !("node" in source)) return [];
		const producers = sessionProducers(graph, source.node, source.port).filter(
			(p) => p.id !== r.node.id,
		);
		return [
			...rivals(graph, r, producers, consumers),
			...parallelTakes(graph, r, producers),
			...harnessClashes(harnessOf, r, producers),
		];
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

/** Each check config has that the agent `id` may run, but without the hint an agent reads it by. */
function hintless(setup: RepoSetup, id: string, named: string[]): Finding[] {
	const checks = setup.target?.checks ?? {};
	return named
		.filter((name) => Object.hasOwn(checks, name) && !checks[name]?.hint)
		.map((name) => {
			const { message, hint } = noHint(name);
			return {
				code: "HOST.check",
				node: id,
				message: `${id}: ${message}`,
				hint,
			};
		});
}

/** A check a node names that config does not have, or that an agent may run but has no hint. */
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
		: [
				...checkNames(
					setup,
					id,
					checksNamed(r),
					"may run",
					"Add it under 'target.checks'",
				),
				...hintless(setup, id, checksNamed(r)),
			];
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
	const { runtime, context } = fields;
	const key = (field: string) => `${PROFILES}.${name}.${field}`;
	const at = (field: string) => sourceOf(profile, field.split("."));
	const harness = harnesses.find((h) => h.name === runtime.harness);
	if (!harness)
		return [
			configDiagnostic(
				"HOST.harness",
				at("runtime.harness"),
				`profile ${name} runs on harness '${runtime.harness}', which is not loaded`,
				`Set '${key("runtime.harness")}' to one of: ${listed(harnesses.map((h) => h.name))}`,
			),
		];
	return [
		...(harness.runtimeProblems?.(runtime, context) ?? []).map((p) =>
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

/** Each attachment of `profile` whose name the agent `r` reserves or takes from the graph already. */
function attachmentClashes(r: AgentNode, profile: Profile): Finding[] {
	const id = r.node.id;
	const graph = Object.keys(r.config.attachments ?? {});
	return Object.keys(profile.fields.attachments).flatMap((name) => {
		const own = RESERVED_ATTACHMENTS.includes(name);
		if (!own && !graph.includes(name)) return [];
		return [
			{
				code: "HOST.attachment",
				node: id,
				message: `profile ${profile.name} attaches '${name}', which '${id}' ${own ? "reserves" : "takes from the graph"}`,
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
 * The host's compose-time rules: agents built before profiles, the profiles agents run, the lane rules (HOST-02), the
 * session rules, names config must have, binds (HOST-11) and the target. A graph without repo nodes has none to break.
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
	const chained = nodes.flatMap((r): [RepoNode, InputSource][] => {
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
			...sessionRules(graph, profiled.harnessOf, agents),
		].map(error),
	];
}
