import type { Cardinality, Diagnostic, Ir } from "./types";

/**
 * A group instance's expansion, one of:
 * - `keys`: its iteration keys, in order;
 * - `exact`: its iteration count, when a key function names its iterations at perform;
 * - `upTo`: the bound of a region whose iterations compose does not know.
 */
export type Expansion = { keys: string[] } | Cardinality;

export type PlanBounds = {
	instances: Cardinality;
	/** Instances per node id. */
	nodes: Record<string, Cardinality>;
	/** Each name a host's `bounds(node)` reports, summed over the node's instances. */
	counts: Record<string, Cardinality>;
};

/** The product of compose, as JSON. The ir README's "Plan" section is the format's reference. */
export type Plan = {
	ir: Ir;
	/** Group id, then the group instance's expansion path. */
	expansion: Record<string, Record<string, Expansion>>;
	bounds: PlanBounds;
	/** Warnings only: any error stops compose before the plan. */
	diagnostics: Diagnostic[];
};
