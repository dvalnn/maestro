import {
	CORE_TYPES,
	type Diagnostic,
	type GraphIndex,
	type HostNode,
	IMPLICIT_OUT,
	type Ir,
	type IrEdge,
	type IrNode,
	isGroup,
	type JsonSchema,
	MAESTRO_TYPE,
	type Ports,
	schemaMarkers,
	unreachableMarkers,
} from "@maestro/ir";
import type { Host, HostKind, NodeKind } from "../host";
import { type Validator, violations } from "../ports";
import { isRecord, messageOf } from "../shared";
import type { ComposeInput } from "./index";

type Lookup = (kind: string) => HostKind | undefined;

const escapePointer = (s: string) =>
	s.replaceAll("~", "~0").replaceAll("/", "~1");

/** A did-you-mean hint allows one edit per this many characters of the typed key, and at most `MAX_TYPOS`. */
const CHARS_PER_TYPO = 3;
const MAX_TYPOS = 2;

function distance(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (const [i, ca] of [...a].entries()) {
		const next = [i + 1];
		for (const [j, cb] of [...b].entries())
			next.push(
				Math.min(
					(row[j + 1] ?? 0) + 1,
					(next[j] ?? 0) + 1,
					(row[j] ?? 0) + (ca === cb ? 0 : 1),
				),
			);
		row = next;
	}
	return row.at(-1) ?? 0;
}

function closest(word: string, candidates: readonly string[]) {
	const allowed = Math.min(MAX_TYPOS, Math.floor(word.length / CHARS_PER_TYPO));
	const ranked = candidates
		.map((c) => ({ c, d: distance(word, c) }))
		.filter(({ d }) => d <= allowed)
		.toSorted((x, y) => x.d - y.d || x.c.localeCompare(y.c));
	return ranked[0]?.c;
}

function unclaimed(key: string, claimed: readonly string[]): Diagnostic {
	const near = closest(key, claimed);
	return {
		code: "CFG.unclaimed",
		severity: "error",
		message: `config key '${key}' is claimed by no installed host, pack or core`,
		hint: near
			? `Did you mean '${near}'? Rename '${key}' to '${near}'`
			: `Remove '${key}' from the config, or install what claims it`,
	};
}

/**
 * Hands each config namespace to its owners' schemas (CFG-02): core's, the IR's and those of the hosts whose kinds the
 * graph uses. A key nothing installed claims is an error; one only an unused host claims is ignored (D-24).
 */
export function checkConfig(
	ajv: Validator,
	{ ir, core, hosts, config }: ComposeInput,
	lookup: Lookup,
): Diagnostic[] {
	const used = new Set(ir.nodes.map((n) => lookup(n.kind)?.host));
	const owners = [core, ir.config ?? {}];
	const claimed = [...owners, ...hosts.map((h) => h.config)].flatMap((o) =>
		Object.keys(o),
	);
	const checked = [
		...owners,
		...hosts.filter((h) => used.has(h)).map((h) => h.config),
	].flatMap((o) => Object.entries(o));
	return [
		...Object.keys(config)
			.filter((key) => !claimed.includes(key))
			.map((key) => unclaimed(key, claimed)),
		...checked.flatMap(([ns, schema]) =>
			violations(
				ajv,
				schema,
				config[ns] ?? {},
				(segments) => `config '${[ns, ...segments].join(".")}'`,
			).map(
				(message): Diagnostic => ({
					code: "CFG.schema",
					severity: "error",
					message,
					hint: `Change '${ns}' in the config to match the schema of its owner`,
				}),
			),
		),
	];
}

/** Every schema in the IR, with its JSON Pointer. */
function schemasOf(ir: Ir): [string, JsonSchema][] {
	const ports = (at: string, p: Ports | undefined): [string, JsonSchema][] =>
		Object.entries(p ?? {}).map(([name, s]) => [
			`${at}/${escapePointer(name)}`,
			s,
		]);
	return [
		...ports("/config", ir.config),
		...ir.scopes.flatMap((s, i) => ports(`/scopes/${i}/ports`, s.ports)),
		...ir.nodes.flatMap((n, i) => [
			...ports(`/nodes/${i}/in`, n.in),
			...ports(`/nodes/${i}/out`, n.out),
			...ports(`/nodes/${i}/inner`, isGroup(n) ? n.inner : undefined),
		]),
	];
}

function markerErrors(ir: Ir): Diagnostic[] {
	return schemasOf(ir).flatMap(([at, schema]) =>
		unreachableMarkers(schema).map(
			(pointer): Diagnostic => ({
				code: "TYPE.marker",
				severity: "error",
				path: at + pointer,
				message: `the ${MAESTRO_TYPE} at ${at + pointer} is out of reach of the artifact walker`,
				hint: "Move the marker under properties, additionalProperties, items or prefixItems, out of combinators such as anyOf",
			}),
		),
	);
}

function ownerErrors(ir: Ir, hosts: readonly Host[]): Diagnostic[] {
	const owned = new Set<string>([
		...Object.values(CORE_TYPES),
		...hosts.flatMap((h) => h.types),
	]);
	return schemasOf(ir)
		.flatMap(([at, schema]) =>
			schemaMarkers(schema).map((m) => ({ ...m, path: at + m.pointer })),
		)
		.filter(({ type }) => !owned.has(type))
		.map(
			({ path, type }): Diagnostic => ({
				code: "TYPE.owner",
				severity: "error",
				path,
				message: `the ${MAESTRO_TYPE} '${type}' at ${path} is owned by neither core nor an installed host`,
				hint: `Install the host that owns '${type}', or name a type core or an installed host owns`,
			}),
		);
}

const GUARD: JsonSchema = { type: "boolean" };

type SchemaObject = Exclude<JsonSchema, boolean>;
type Mismatch = { at: string; from: SchemaObject; to: SchemaObject };

const isSchema = (v: unknown): v is JsonSchema =>
	isRecord(v) || typeof v === "boolean";

/** The schema of the port an edge leaves: a group's inner port seen from its body, else an output. */
function sourceSchema(e: IrEdge, graph: GraphIndex): JsonSchema | undefined {
	const node = graph.nodes.get(e.from.node);
	if (!node || e.from.port === undefined) return undefined;
	const inner = isGroup(node) && graph.groupsOf(e.to.node).includes(node.id);
	const ports: Ports = inner ? node.inner : { ...IMPLICIT_OUT, ...node.out };
	return ports[e.from.port];
}

/** What an edge's target expects. A `data` edge into a fan-in input expects the `Settled` value (ADR 0006). */
function targetSchema(e: IrEdge, graph: GraphIndex): JsonSchema | undefined {
	if (e.kind === "control") return GUARD;
	const node: IrNode | undefined = graph.nodes.get(e.to.node);
	const schema = node?.in?.[e.to.port];
	const fanin = e.kind === "data" && node?.kind === "code" && node.fanin;
	if (!fanin) return schema;
	const properties = isRecord(schema) ? schema.properties : undefined;
	return isRecord(properties) && isSchema(properties.value)
		? properties.value
		: undefined;
}

const declares = (s: SchemaObject) =>
	s.type !== undefined || s[MAESTRO_TYPE] !== undefined;

const typesOf = (s: SchemaObject) => [s.type].flat().map(String);

function typesFit(from: SchemaObject, to: SchemaObject): boolean {
	if (from.type === undefined || to.type === undefined) return true;
	const target = typesOf(to);
	return typesOf(from).every(
		(t) => target.includes(t) || (t === "integer" && target.includes("number")),
	);
}

/**
 * The first place where both schemas declare structure that disagrees, compared in this order:
 * - the `x-maestro-type` names (ADR 0007);
 * - the JSON `type`, an `integer` fitting a `number`;
 * - `items` and shared `properties`.
 *
 * Enums, `required`, extra properties and annotations are not compared. A marked subschema describes content, which
 * only a `core.json-file` compares.
 */
function mismatch(
	from: JsonSchema,
	to: JsonSchema,
	at: string,
): Mismatch | undefined {
	if (!isRecord(from) || !isRecord(to)) return undefined;
	const marker = from[MAESTRO_TYPE];
	if (marker !== to[MAESTRO_TYPE])
		return declares(from) && declares(to) ? { at, from, to } : undefined;
	if (marker !== undefined && marker !== CORE_TYPES.jsonFile) return undefined;
	if (!typesFit(from, to)) return { at, from, to };
	return childMismatch(from, to, at);
}

function childMismatch(
	from: SchemaObject,
	to: SchemaObject,
	at: string,
): Mismatch | undefined {
	const items =
		isSchema(from.items) && isSchema(to.items)
			? mismatch(from.items, to.items, `${at}/items`)
			: undefined;
	return items ?? propertyMismatch(from, to, at);
}

function propertyMismatch(
	from: SchemaObject,
	to: SchemaObject,
	at: string,
): Mismatch | undefined {
	const fromProps = isRecord(from.properties) ? from.properties : {};
	const toProps = isRecord(to.properties) ? to.properties : {};
	for (const [key, sub] of Object.entries(fromProps)) {
		const other = toProps[key];
		if (!isSchema(sub) || !isSchema(other)) continue;
		const found = mismatch(
			sub,
			other,
			`${at}/properties/${escapePointer(key)}`,
		);
		if (found) return found;
	}
	return undefined;
}

const describe = (s: SchemaObject) =>
	String(s[MAESTRO_TYPE] ?? typesOf(s).join(" or "));

function edgeError(e: IrEdge, path: string, m: Mismatch): Diagnostic {
	const from = `${e.from.node}.${e.from.port}`;
	const to =
		e.kind === "control"
			? `the guard of ${e.to.node}`
			: `${e.to.node}.${e.to.port}`;
	const where = m.at ? ` at ${m.at}` : "";
	return {
		code: "TYPE.edge",
		severity: "error",
		node: e.to.node,
		path,
		message: `edge from '${from}' to '${to}' carries ${describe(m.from)} where ${describe(m.to)} is expected${where}`,
		hint: `Make the schemas of '${from}' and '${to}' agree, or convert the value in a code node between them`,
	};
}

function edgeErrors(ir: Ir, graph: GraphIndex): Diagnostic[] {
	return ir.edges.flatMap((e, i) => {
		const from = sourceSchema(e, graph);
		const to = targetSchema(e, graph);
		const found = from && to ? mismatch(from, to, "") : undefined;
		return found ? [edgeError(e, `/edges/${i}`, found)] : [];
	});
}

/** Edge types (CORE-02), markers the artifact walker cannot reach, and type names no one installed owns. */
export function checkTypes(
	ir: Ir,
	graph: GraphIndex,
	hosts: readonly Host[],
): Diagnostic[] {
	return [
		...edgeErrors(ir, graph),
		...markerErrors(ir),
		...ownerErrors(ir, hosts),
	];
}

const isHostNode = (n: IrNode): n is HostNode => n.kind.includes(".");

/**
 * Each host node against its kind (architecture 6): a kind no installed host registers, a `config` off the kind's
 * schema, and, for a node whose config holds, `in` or `out` ports that differ from the kind's by name or by the edge
 * rule (`mismatch`).
 */
export function checkHosts(
	ajv: Validator,
	ir: Ir,
	lookup: Lookup,
): Diagnostic[] {
	return ir.nodes.flatMap((n, i) => {
		if (!isHostNode(n)) return [];
		const found = lookup(n.kind);
		if (!found) return [kindError(n, i)];
		const config = configErrors(ajv, n, i, found.kind);
		return config.length ? config : portErrors(n, i, found);
	});
}

function kindError(node: HostNode, i: number): Diagnostic {
	return {
		code: "HOST.kind",
		severity: "error",
		node: node.id,
		path: `/nodes/${i}/kind`,
		message: `no installed host registers node kind '${node.kind}' of node '${node.id}'`,
		hint: `Install the host that registers '${node.kind}', or change the kind of '${node.id}'`,
	};
}

function configErrors(
	ajv: Validator,
	node: HostNode,
	i: number,
	kind: NodeKind,
): Diagnostic[] {
	const subject = (segments: string[]) =>
		`config${segments.length ? ` '${segments.join(".")}'` : ""} of node '${node.id}'`;
	return violations(ajv, kind.config, node.config ?? {}, subject).map(
		(message): Diagnostic => ({
			code: "HOST.config",
			severity: "error",
			node: node.id,
			path: `/nodes/${i}/config`,
			message,
			hint: `Change the config of '${node.id}' to match the config schema of kind '${node.kind}'`,
		}),
	);
}

const SIDES = ["in", "out"] as const;

type Side = (typeof SIDES)[number];

function portErrors(
	node: HostNode,
	i: number,
	{ host, kind }: HostKind,
): Diagnostic[] {
	let ports: { in: Ports; out: Ports };
	try {
		ports = kind.ports(node);
	} catch (e) {
		return [
			{
				code: "HOST.ports",
				severity: "error",
				node: node.id,
				path: `/nodes/${i}`,
				message: `host '${host.name}' failed in ports() of node '${node.id}': ${messageOf(e)}`,
				hint: `Check the setup of host '${host.name}', or uninstall it`,
			},
		];
	}
	return SIDES.flatMap((side) =>
		Object.keys({ ...node[side], ...ports[side] }).flatMap((port) => {
			const message = portProblem(node, side, port, ports[side]);
			return message
				? [portError(node, `/nodes/${i}/${side}`, side, message)]
				: [];
		}),
	);
}

/** How `port` on `side` of `node` in the IR differs from `declared`, the kind's ports on that side. */
function portProblem(
	node: HostNode,
	side: Side,
	port: string,
	declared: Ports,
): string | undefined {
	const ir = node[side]?.[port];
	const own = declared[port];
	const kind = `kind '${node.kind}'`;
	if (ir === undefined)
		return `node '${node.id}' lacks ${side} port '${port}', which ${kind} gives it`;
	if (own === undefined)
		return `node '${node.id}' has ${side} port '${port}', which ${kind} does not give it`;
	// Values flow from the IR's inputs into the kind, and from the kind's outputs into the IR.
	const found = side === "in" ? mismatch(ir, own, "") : mismatch(own, ir, "");
	if (!found) return undefined;
	const [inIr, inKind] =
		side === "in" ? [found.from, found.to] : [found.to, found.from];
	const where = found.at ? ` at ${found.at}` : "";
	return `${side} port '${port}' of node '${node.id}' is ${describe(inIr)} where ${kind} gives ${describe(inKind)}${where}`;
}

function portError(
	node: HostNode,
	path: string,
	side: Side,
	message: string,
): Diagnostic {
	return {
		code: "HOST.ports",
		severity: "error",
		node: node.id,
		path,
		message,
		hint: `Declare the ${side} ports of '${node.id}' as kind '${node.kind}' gives them for its config, or rebuild the IR`,
	};
}
