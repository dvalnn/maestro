import { join } from "node:path";
import type {
	Context,
	Diagnostic,
	Enrichment,
	Facts,
	GraphIndex,
	HostEvent,
	HostNode,
	JsonSchema,
	Ports,
} from "@maestro/ir";
import type { Composed, KeyPath } from "./config";
import type { Inputs, NodeResult } from "./node";

type Awaitable<T> = T | Promise<T>;

/** A host node instance. */
export type HostInstance = {
	node: HostNode;
	/** The instance's expansion path, `''` outside groups. */
	expansion: string;
	/** The instance's id as `ls` shows it, such as `lens[risk]/skeptic`. */
	id: string;
};

/** Named additive numbers an instance reports (CORE-19). Core sums each name per concert and gives it no meaning. */
export type Metrics = Readonly<Record<string, number>>;

/** Named counts that bound one instance (D-23). Core sums each name over the plan and caps it by name. */
export type Bounds = Readonly<Record<string, number>>;

/** How a host node instance ended, with the metrics and enrichment it reports beside its outcome. */
export type HostNodeResult = NodeResult & {
	metrics?: Metrics;
	enrichment?: Enrichment;
};

/** The directory of host stores under the data root. */
const HOSTS_DIR = "hosts";

/** What core gives a host in every hook that can use it. */
export type HostSetup = {
	/** The values of the namespaces the host declares in `Host.config`, as compose checked them. An unset one is `{}`. */
	readonly config: Readonly<Record<string, unknown>>;
	/** `<data root>/hosts/<host name>`: the host's own directory. Core never creates it, so the host does on first write. */
	readonly store: string;
};

/**
 * The setup of `host` under `config`: its own config namespaces and its store under the config's `dataRoot`, no other's.
 * @throws Error when `config` has no `dataRoot`, which core config always sets.
 */
export function hostSetup(host: Host, config: Composed): HostSetup {
	const { dataRoot } = config.values;
	if (typeof dataRoot !== "string")
		throw new Error("the composed config has no 'dataRoot'");
	const namespaces = Object.keys(host.config).map((ns) => [
		ns,
		Object.hasOwn(config.values, ns) ? config.values[ns] : {},
	]);
	return {
		config: Object.fromEntries(namespaces),
		store: join(dataRoot, HOSTS_DIR, host.name),
	};
}

export type HostContext = Context & {
	emit(event: HostEvent): void;
	/** The setup of the host running the instance. */
	readonly setup: HostSetup;
};

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
	): Promise<HostNodeResult>;
	/** Stops a running instance and releases what it holds. Its pending `execute` then settles promptly. */
	cancel(instance: HostInstance): Promise<void>;
}

/** A plugin that gives core node kinds beyond its own (CORE-13). Core calls its hooks and never inspects its types. */
export interface Host {
	/** The namespace of the host's kind and type names. Also keys its facts in `CodeContext.env`. */
	readonly name: string;
	readonly kinds: readonly NodeKind[];
	/** The `x-maestro-type` names the host owns, qualified like its kinds (ADR 0007). */
	readonly types: readonly string[];
	/** By config namespace. */
	readonly config: Readonly<Record<string, JsonSchema>>;
	/**
	 * The keys of `config` that hold file paths, namespace first. A relative value in a config file is relative to that
	 * file's directory, or to the workspace root for a workspace or profile file.
	 */
	readonly paths?: readonly KeyPath[];
	/** Compose-time rules over the whole graph. */
	validate(graph: GraphIndex, setup: HostSetup): Awaitable<Diagnostic[]>;
	/** The config entries the graph's host nodes read by name. */
	needs?(graph: GraphIndex): KeyPath[];
	/** Bounds one instance of `node`, a node of one of the host's kinds. */
	bounds(node: HostNode): Bounds;
	environment(setup: HostSetup): Awaitable<Facts>;
	/**
	 * Parses `text`, a param value given as a flag or in YAML, into a value of `type`, one of the host's `types`. It
	 * parses only: whether what the value names exists is `validate`'s to check.
	 */
	param?(
		type: string,
		text: string,
	): { value: unknown } | { diagnostics: Diagnostic[] };
	/** What the host holds for a concert, for hosts that hold any. */
	readonly resources?: HostResources;
	/** How the host's records read as text, for hosts that say more than the generic line. */
	readonly text?: HostText;
}

/** Plain one-line text for a host's records; the renderer styles and cuts it. Each member is optional. */
export interface HostText {
	/** For one of the host's progress events, such as `prepare 1/2: bun install`. Undefined leaves the generic line. */
	progress?(event: HostEvent): string | undefined;
	/**
	 * Who ran an instance, such as `pi · claude-haiku-5.5 · medium`. Called on a settled instance's enrichment and on each
	 * of the host's progress events, and names an actor only for an event that announces one; undefined otherwise.
	 */
	actor?(enrichment: Enrichment): string | undefined;
}

/** The disk a host holds for a concert. */
export interface HostResources {
	/** Frees what the host holds for the settled concert `concert`, such as the files it keeps for it. */
	release(concert: string, setup: HostSetup): Awaitable<void>;
	/** The bytes the host holds on disk for `concert`. */
	usage(concert: string, setup: HostSetup): Awaitable<number>;
}
