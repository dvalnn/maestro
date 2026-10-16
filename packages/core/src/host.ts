import type {
	Context,
	Diagnostic,
	Facts,
	GraphIndex,
	HostNode,
	JsonSchema,
	Ports,
} from "@maestro/ir";
import type { Inputs, Settlement } from "./worker";

type Awaitable<T> = T | Promise<T>;

/** A host node and the expansion path of one of its instances. */
export type HostInstance = { node: HostNode; expansion: string };

/** Named additive numbers an instance reports (CORE-19). Core sums each name per concert and gives it no meaning. */
export type Metrics = Readonly<Record<string, number>>;

/** Named counts that bound one instance (D-23). Core sums each name over the plan and caps it by name. */
export type Bounds = Readonly<Record<string, number>>;

/** Fields core stores opaquely with the instance's events and record, as JSON. */
export type Enrichment = Readonly<Record<string, unknown>>;

export type Execution = Settlement & {
	metrics?: Metrics;
	enrichment?: Enrichment;
};

/** A progress event a host instance emits, as JSON. Core stores it by node id and expansion path, opaquely. */
export type HostEvent = Readonly<Record<string, unknown>>;

export type HostContext = Context & { emit(event: HostEvent): void };

/** A node kind a host registers (architecture 6). */
export interface NodeKind {
	/** `<host>.<kind>`, as a node's `kind` in the IR. */
	readonly name: string;
	/** The schema a node's `config` matches. */
	readonly config: JsonSchema;
	/**
	 * The ports a node of this kind has, which may depend on its `config`: its `in` and `out` in the IR, and the shape of
	 * the outputs it settles with. Artifact ports carry a type marker.
	 */
	ports(node: HostNode): { in: Ports; out: Ports };
	execute(
		instance: HostInstance,
		inputs: Inputs,
		context: HostContext,
	): Promise<Execution>;
	/** Stops a running instance and releases what it holds. Its pending `execute` then settles promptly. */
	cancel(instance: HostInstance): Promise<void>;
}

// TODO: reassess this interface as a whole before a second host widens it, so it does not grow into unrelated
// optional members: .scratch/backlog/issues/17-reassess-host-interface.md
/** A plugin that gives core node kinds beyond its own (CORE-13). Core calls its hooks and never inspects its types. */
export interface Host {
	/** The namespace of the host's kind and type names. Also keys its facts in `CodeContext.env`. */
	readonly name: string;
	readonly kinds: readonly NodeKind[];
	/** The `x-maestro-type` names the host owns, qualified like its kinds (ADR 0007). */
	readonly types: readonly string[];
	/** By config namespace. */
	readonly config: Readonly<Record<string, JsonSchema>>;
	/** Compose-time rules over the whole graph. */
	validate(graph: GraphIndex): Awaitable<Diagnostic[]>;
	/** Bounds one instance of `node`, a node of one of the host's kinds. */
	bounds(node: HostNode): Bounds;
	environment(): Awaitable<Facts>;
	/**
	 * Parses `text`, a param value given as a flag or in YAML, into a value of `type`, one of the host's `types`. It
	 * parses only: whether what the value names exists is `validate`'s to check.
	 */
	param?(
		type: string,
		text: string,
	): { value: unknown } | { diagnostics: Diagnostic[] };
	/** Frees what the host holds for the settled concert `concert`, such as the files it keeps for it. */
	release?(concert: string): Awaitable<void>;
	/** The bytes the host holds on disk for `concert`. */
	usage?(concert: string): Awaitable<number>;
}

export type HostKind = { host: Host; kind: NodeKind };

/**
 * Indexes the kinds of `hosts` by name, so a node's `kind` resolves to its host and kind.
 * @throws Error when two hosts register one kind name.
 */
export function kindLookup(
	hosts: readonly Host[],
): (name: string) => HostKind | undefined {
	const kinds = new Map<string, HostKind>();
	for (const host of hosts)
		for (const kind of host.kinds) {
			const other = kinds.get(kind.name)?.host.name;
			if (other !== undefined)
				throw new Error(
					`node kind '${kind.name}' is registered twice, by host '${other}' and by host '${host.name}'\nLoad only one host that registers '${kind.name}'`,
				);
			kinds.set(kind.name, { host, kind });
		}
	return (name) => kinds.get(name);
}
