import {
	type Cardinality,
	type Diagnostic,
	type Facts,
	type GraphIndex,
	type Ir,
	indexGraph,
	type JsonSchema,
	type Settled,
} from "@maestro/ir";
import { type Bounds, type Host, kindLookup } from "../host";
import type { LoadCode, Outputs } from "../worker";
import { boundsOf, capErrors, type ExpansionOf, unexpanded } from "./bounds";
import { checkConfig, checkParams, checkTypes } from "./checks";
import { messageOf, validator } from "./common";
import { fold } from "./fold";

export { listing, render, summary } from "./text";

export type ComposeInput = {
	/** IR that `parseIr` accepted. */
	ir: Ir;
	params: Readonly<Record<string, unknown>>;
	/** The composed config, by top-level namespace. */
	config: Readonly<Record<string, unknown>>;
	/** The config schemas core owns, by namespace (CFG-01). */
	core: Readonly<Record<string, JsonSchema>>;
	hosts: readonly Host[];
	loadCode: LoadCode;
	/** Caps by name: `instances` caps the node-instance total, any other name the total of a host's count (D-23). */
	caps: Bounds;
	/** An absolute directory, made when a folded node first reads `ctx.scratch`. */
	scratch: string;
};

/** A group instance's iteration keys, or the bound of a region whose iterations compose does not know. */
export type Expansion = { keys: string[] } | { upTo: number };

export type PlanBounds = {
	instances: Cardinality;
	/** Instances per node id. */
	nodes: Record<string, Cardinality>;
	/** Each name a host's `bounds(node)` reports, summed over the node's instances. */
	counts: Record<string, Cardinality>;
};

/** The product of compose, as JSON. `README.md` beside this file is the format's reference. */
export type Plan = {
	ir: Ir;
	/** The param values, defaults applied (D-17). */
	params: Record<string, unknown>;
	/** Group id, then the group instance's expansion path. */
	expansion: Record<string, Record<string, Expansion>>;
	/** Node id, then the instance's expansion path. An `ok` value holds the outputs. */
	folded: Record<string, Record<string, Settled<Outputs>>>;
	bounds: PlanBounds;
	/** Warnings only: any error stops compose before the plan. */
	diagnostics: Diagnostic[];
};

export type ComposeResult =
	| { ok: true; plan: Plan }
	| { ok: false; diagnostics: Diagnostic[] };

const hasError = (diagnostics: readonly Diagnostic[]) =>
	diagnostics.some((d) => d.severity === "error");

const HOST = "HOST";

/** Gives a host's diagnostic the `HOST` prefix (sdk-spec 13.3), unless it has it. */
function stampHost(d: Diagnostic): Diagnostic {
	return d.code === HOST || d.code.startsWith(`${HOST}.`)
		? d
		: { ...d, code: `${HOST}.${d.code}` };
}

/** Calls a host hook, turning a throw or a rejection into a `HOST.<hook>` error that names the host. */
async function hook<T>(
	host: Host,
	name: "environment" | "validate",
	call: () => T | Promise<T>,
): Promise<{ value: T } | { diagnostic: Diagnostic }> {
	try {
		return { value: await call() };
	} catch (e) {
		return {
			diagnostic: {
				code: `${HOST}.${name}`,
				severity: "error",
				message: `host '${host.name}' failed in ${name}(): ${messageOf(e)}`,
				hint: `Check the setup of host '${host.name}', or uninstall it`,
			},
		};
	}
}

async function environments(hosts: readonly Host[]) {
	const env: Record<string, Facts> = {};
	const diagnostics: Diagnostic[] = [];
	for (const host of hosts) {
		const got = await hook(host, "environment", () => host.environment());
		if ("value" in got) env[host.name] = got.value;
		else diagnostics.push(got.diagnostic);
	}
	return { env, diagnostics };
}

async function validations(hosts: readonly Host[], graph: GraphIndex) {
	const results = await Promise.all(
		hosts.map((h) => hook(h, "validate", () => h.validate(graph))),
	);
	return results.flatMap((r) =>
		"value" in r ? r.value.map(stampHost) : [r.diagnostic],
	);
}

/**
 * Pre-flight (architecture 4): checks params, edge types and config, folds and expands what compose knows, calls the
 * hosts' `validate` hooks, and bounds the plan against the caps. It writes only under `scratch` and starts no host
 * node (NFR-02).
 * @throws Error when two hosts register one node kind.
 */
export async function compose(input: ComposeInput): Promise<ComposeResult> {
	const { ir, hosts } = input;
	const graph = indexGraph(ir);
	const lookup = kindLookup(hosts);
	const ajv = validator();
	const params = checkParams(ajv, ir, input.params);
	const checked = [
		...params.diagnostics,
		...checkTypes(ir, graph, lookup),
		...checkConfig(ajv, input, lookup),
	];
	if (hasError(checked)) return { ok: false, diagnostics: checked };
	const { env, diagnostics: broken } = await environments(hosts);
	if (hasError(broken))
		return { ok: false, diagnostics: [...checked, ...broken] };
	const capped = (expansionOf: ExpansionOf, reach?: string) =>
		capErrors(boundsOf(ir, graph, expansionOf, lookup), input.caps, reach);
	const limit = capped(unexpanded).length
		? (sofar: ExpansionOf) => capped(sofar, "may reach at least")
		: undefined;
	const folded = await fold(ir, { graph, input, ajv, env, limit });
	const expansionOf: ExpansionOf = (group, path) =>
		folded.expansion[group.id]?.[path] ?? unexpanded(group, path);
	const diagnostics = [
		...checked,
		...folded.diagnostics,
		...(await validations(hosts, graph)),
	];
	const bounds = boundsOf(ir, graph, expansionOf, lookup);
	if (!hasError(diagnostics))
		diagnostics.push(...capErrors(bounds, input.caps));
	if (hasError(diagnostics)) return { ok: false, diagnostics };
	return {
		ok: true,
		plan: {
			ir,
			params: params.values,
			expansion: folded.expansion,
			folded: folded.folded,
			bounds,
			diagnostics,
		},
	};
}
