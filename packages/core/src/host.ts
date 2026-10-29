import { join } from "node:path";
import type {
	Context,
	Diagnostic,
	Enrichment,
	Facts,
	GraphIndex,
	GroupNode,
	HostEvent,
	HostNode,
	JsonSchema,
	Ports,
} from "@maestro/ir";
import {
	type CommandLine,
	type Composed,
	commandLineOf,
	type KeyPath,
} from "./config";
import type { Inputs, NodeResult } from "./node";

type Awaitable<T> = T | Promise<T>;

/** A host node instance. */
export type HostInstance = {
	node: HostNode;
	/** The instance's expansion path, `''` outside groups. */
	expansion: string;
	/** The instance's id as `ls` shows it, such as `lens[risk]/skeptic`. */
	id: string;
	/** The kind of each group enclosing the instance, outermost first: one per key of `expansion`. */
	groups: readonly GroupNode["kind"][];
	/** The id of the innermost composition holding the instance's node. */
	composition: string;
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

/** The directories, built by the caller, a host may look its own entries up under. Core reads none of them. */
export type Roots = {
	/** The workspace's `.maestro`, when there is a workspace. */
	readonly workspace?: string;
	/** `maestro` in the user's config directory. */
	readonly user: string;
	/** Each installed pack's directory, by pack id. */
	readonly packs: Readonly<Record<string, string>>;
};

/** What core gives a host in every hook that can use it. */
export type HostSetup = {
	/** The values of the namespaces the host declares in `Host.config`, as compose checked them. An unset one is `{}`. */
	readonly config: Readonly<Record<string, unknown>>;
	/** Where each value of `config` came from, at its key path from the namespace down. */
	readonly sources: Composed["sources"];
	/** The layers `config` merged from, lowest first, each cut to the host's namespaces. */
	readonly layers: Composed["layers"];
	/** The part of `config` the preset and `-c` layers set, at its key paths. */
	readonly commandLine: CommandLine;
	/** `<data root>/hosts/<host name>`: the host's own directory. Core never creates it, so the host does on first write. */
	readonly store: string;
	readonly roots: Roots;
};

/**
 * The setup of `host` under `config` and `roots`: its own config namespaces, their sources and layers, the part of them
 * the preset and `-c` layers set, and its store under the config's `dataRoot`, no other's.
 * @throws Error when `config` has no `dataRoot`, which core config always sets.
 */
export function hostSetup(
	host: Host,
	config: Composed,
	roots: Roots,
): HostSetup {
	const { dataRoot } = config.values;
	if (typeof dataRoot !== "string")
		throw new Error("the composed config has no 'dataRoot'");
	const namespaces = Object.keys(host.config).map((ns) => [
		ns,
		Object.hasOwn(config.values, ns) ? config.values[ns] : {},
	]);
	const { values, replaced } = commandLineOf(config);
	const ownedNs = (ns: string) => Object.hasOwn(host.config, ns);
	const owned = ([ns]: KeyPath) => ns !== undefined && ownedNs(ns);
	return {
		config: Object.fromEntries(namespaces),
		sources: config.sources.filter(({ path }) => owned(path)),
		layers: config.layers.map((layer) => ({
			...layer,
			entries: new Map([...layer.entries].filter(([ns]) => ownedNs(ns))),
		})),
		commandLine: {
			values: Object.fromEntries(
				Object.entries(values).filter(([ns]) => ownedNs(ns)),
			),
			replaced: replaced.filter(owned),
		},
		store: join(dataRoot, HOSTS_DIR, host.name),
		roots,
	};
}

export type HostContext = Context & {
	emit(event: HostEvent): void;
	/** The setup of the host running the instance. */
	readonly setup: HostSetup;
	/** The id of the concert this one is an encore of, whose counterparts the host may continue; core reads none of it. */
	readonly encore?: string;
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
	 * The keys of `config` that hold file paths, namespace first, `*` matching any one key. A relative value in a config
	 * file is relative to the directory its config file anchors to: the workspace root for the workspace's files, the
	 * user config directory for the user's.
	 */
	readonly paths?: readonly KeyPath[];
	/**
	 * The keys of `config` whose base the host gives later through `layeredOver`, namespace first, `*` matching any one
	 * key. At or below them, a merge tag that finds nothing beneath stays pending until then.
	 */
	readonly deferred?: readonly KeyPath[];
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

/** Plain text for a host's records; the renderer styles and cuts it. Each member is optional. */
export interface HostText {
	/**
	 * One of the host's progress events as a word for what happened and its detail, each on one line, such as `prepare`
	 * and `1/2: bun install`. Undefined leaves the event's kind as the word and its other fields as the detail.
	 */
	progress?(event: HostEvent): { word: string; detail: string } | undefined;
	/**
	 * Who ran an instance, such as `pi · claude-haiku-5.5 · medium`. Called on a settled instance's enrichment and on each
	 * of the host's progress events, and names an actor only for an event that announces one; undefined otherwise.
	 */
	actor?(enrichment: Enrichment): string | undefined;
	/**
	 * An instance's notes as headed lists of one-line entries, such as `{ Obstacles: [...] }`, each list non-empty.
	 * Called on a settled instance's enrichment; empty when it has none.
	 */
	notes?(enrichment: Enrichment): Record<string, string[]>;
}

/** The disk a host holds for a concert. */
export interface HostResources {
	/** Frees what the host holds for the settled concert `concert`, such as the files it keeps for it. */
	release(concert: string, setup: HostSetup): Awaitable<void>;
	/** The bytes the host holds on disk for `concert`. */
	usage(concert: string, setup: HostSetup): Awaitable<number>;
}
