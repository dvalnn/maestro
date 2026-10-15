import {
	CORE_TYPES,
	type Diagnostic,
	type GraphIndex,
	type Ir,
	type IrEdge,
	type IrNode,
	type JsonSchema,
	MAESTRO_TYPE,
	type Ports,
	unreachableMarkers,
} from "@maestro/ir";
import type { HostKind } from "../host";
import { IMPLICIT, isGroup, type Validator, violations } from "./common";
import type { ComposeInput } from "./index";

type Lookup = (kind: string) => HostKind | undefined;

const escapePointer = (s: string) =>
	s.replaceAll("~", "~0").replaceAll("/", "~1");

const paramSubject = (segments: string[]) =>
	segments.length ? `param '${segments.join(".")}'` : "params";

/** The param values with defaults applied (D-17), checked against the IR's param schema. */
export function checkParams(
	ajv: Validator,
	ir: Ir,
	params: Readonly<Record<string, unknown>>,
): { values: Record<string, unknown>; diagnostics: Diagnostic[] } {
	const values = structuredClone(params) as Record<string, unknown>;
	const diagnostics = violations(
		ajv,
		ir.params.schema,
		values,
		paramSubject,
	).map(
		(message): Diagnostic => ({
			code: "CFG.params",
			severity: "error",
			message,
			hint: "Pass param values that match the param schema of the composition",
		}),
	);
	return { values, diagnostics };
}

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
				structuredClone(config[ns] ?? {}),
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
		["/params/schema", ir.params.schema],
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

function kindErrors(ir: Ir, lookup: Lookup): Diagnostic[] {
	return ir.nodes.flatMap((n, i): Diagnostic[] =>
		n.kind.includes(".") && !lookup(n.kind)
			? [
					{
						code: "HOST.kind",
						severity: "error",
						node: n.id,
						path: `/nodes/${i}/kind`,
						message: `no installed host registers node kind '${n.kind}' of node '${n.id}'`,
						hint: `Install the host that registers '${n.kind}', or change the kind of '${n.id}'`,
					},
				]
			: [],
	);
}

const GUARD: JsonSchema = { type: "boolean" };

type SchemaObject = Exclude<JsonSchema, boolean>;
type Mismatch = { at: string; from: SchemaObject; to: SchemaObject };

const isObject = (v: unknown): v is SchemaObject =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const isSchema = (v: unknown): v is JsonSchema =>
	isObject(v) || typeof v === "boolean";

/** The schema of the port an edge leaves: a group's inner port seen from its body, else an output. */
function sourceSchema(e: IrEdge, graph: GraphIndex): JsonSchema | undefined {
	const node = graph.nodes.get(e.from.node);
	if (!node || e.from.port === undefined) return undefined;
	const inner = isGroup(node) && graph.groupsOf(e.to.node).includes(node.id);
	const ports = inner ? node.inner : { ...IMPLICIT, ...node.out };
	return ports[e.from.port];
}

/** What an edge's target expects. A `data` edge into a fan-in input expects the `Settled` value (ADR 0006). */
function targetSchema(e: IrEdge, graph: GraphIndex): JsonSchema | undefined {
	if (e.kind === "control") return GUARD;
	const node: IrNode | undefined = graph.nodes.get(e.to.node);
	const schema = node?.in?.[e.to.port];
	const fanin = e.kind === "data" && node?.kind === "code" && node.fanin;
	if (!fanin) return schema;
	const properties = isObject(schema) ? schema.properties : undefined;
	return isObject(properties) && isSchema(properties.value)
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
	if (!isObject(from) || !isObject(to)) return undefined;
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
	const fromProps = isObject(from.properties) ? from.properties : {};
	const toProps = isObject(to.properties) ? to.properties : {};
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

/** Edge types (CORE-02), markers the artifact walker cannot reach, and host kinds no installed host registers. */
export function checkTypes(
	ir: Ir,
	graph: GraphIndex,
	lookup: Lookup,
): Diagnostic[] {
	return [
		...edgeErrors(ir, graph),
		...markerErrors(ir),
		...kindErrors(ir, lookup),
	];
}
