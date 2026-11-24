import { canonicalJson } from "./canonical-json";
import { IR_VERSION, irError } from "./graph";
import { escapeSegment } from "./maestro-type";
import type {
	Diagnostic,
	Ir,
	IrNode,
	JsonSchema,
	ParseResult,
	Scope,
} from "./types";

/** A port map as a document holds it: each port's schema inline, or the key of its entry in the `schemas` table. */
export type PortMap = Record<string, JsonSchema | string>;

type PortMaps = Partial<Record<"in" | "out" | "inner", PortMap>>;

type Keyed<T> = T extends unknown
	? { [K in keyof T]: K extends keyof PortMaps | "ports" ? PortMap : T[K] }
	: never;

/** IR as a document holds it, before `parseIr` resolves its keys: the `Ir` with ports that may name a table entry. */
export type IrDocument = Omit<Ir, "nodes" | "scopes"> & {
	nodes: Keyed<IrNode>[];
	scopes: Keyed<Scope>[];
	schemas?: Record<string, JsonSchema>;
};

/**
 * IR in the shared form: every port names its schema's key, and the table holds each distinct schema once. It declares
 * the current version, since a reader before 1.3 refuses a table only by its version.
 */
export type SharedIr = IrDocument & {
	irVersion: typeof IR_VERSION;
	schemas: Record<string, JsonSchema>;
};

const PORT_MAPS = ["in", "out", "inner"] as const;

/** `node` with each of its port maps replaced by what `change` gives for it and its name. */
function withPortMaps<N extends PortMaps>(
	node: N,
	change: (ports: PortMap, name: string) => PortMap,
): N {
	const changed = PORT_MAPS.flatMap((name) => {
		const ports = node[name];
		return ports === undefined ? [] : [[name, change(ports, name)]];
	});
	return { ...node, ...Object.fromEntries(changed) };
}

const mapPorts = (
	ports: PortMap,
	change: (schema: JsonSchema | string, port: string) => JsonSchema | string,
) =>
	Object.fromEntries(
		Object.entries(ports).map(([port, schema]) => [port, change(schema, port)]),
	);

/**
 * `ir` in the shared form: each port of a node, of a group's inner ports and of a scope names a key in `schemas`, and
 * schemas with equal canonical JSON share one entry. The same IR gives the same keys. It declares `IR_VERSION`, whatever
 * version `ir` had.
 */
export function shareSchemas(ir: Ir): SharedIr {
	const keys = new Map<string, string>();
	const schemas: Record<string, JsonSchema> = {};
	const keyOf = (schema: JsonSchema | string) => {
		const text = canonicalJson(schema);
		const known = keys.get(text);
		if (known !== undefined) return known;
		const key = `s${keys.size}`;
		keys.set(text, key);
		schemas[key] = schema as JsonSchema;
		return key;
	};
	const nodes = ir.nodes.map((node) =>
		withPortMaps(node, (ports) => mapPorts(ports, keyOf)),
	);
	const scopes = ir.scopes.map((scope) => ({
		...scope,
		ports: mapPorts(scope.ports, keyOf),
	}));
	return { ...ir, irVersion: IR_VERSION, nodes, scopes, schemas } as SharedIr;
}

/**
 * `doc` with each port key replaced by its entry in the `schemas` table, and with no table. Call only with a document
 * whose shape already validates. A key the table does not hold is an `IR.ref` error at its port.
 */
export function resolveSchemas(doc: IrDocument): ParseResult {
	const { schemas = {}, ...rest } = doc;
	const diagnostics: Diagnostic[] = [];
	const resolver = (at: string) => (ports: PortMap) =>
		mapPorts(ports, (schema, port) => {
			if (typeof schema !== "string") return schema;
			if (Object.hasOwn(schemas, schema)) return schemas[schema] as JsonSchema;
			const path = `${at}/${escapeSegment(port)}`;
			diagnostics.push(
				irError(
					doc,
					"IR.ref",
					path,
					`port '${port}' names schema '${schema}', which the schemas table does not hold`,
					`Add '${schema}' to /schemas, or write the port's schema in place of the key`,
				),
			);
			return schema;
		});
	const nodes = rest.nodes.map((node, i) =>
		withPortMaps(node, (ports, name) => resolver(`/nodes/${i}/${name}`)(ports)),
	);
	const scopes = rest.scopes.map((scope, i) => ({
		...scope,
		ports: resolver(`/scopes/${i}/ports`)(scope.ports),
	}));
	return diagnostics.length
		? { ok: false, diagnostics }
		: { ok: true, ir: { ...rest, nodes, scopes } as Ir };
}
