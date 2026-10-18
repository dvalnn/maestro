import {
	type Diagnostic,
	type GraphIndex,
	type Ir,
	indexGraph,
	type JsonSchema,
	messageOf,
	type Plan,
	validator,
} from "@maestro/ir";
import type { Composed } from "../config";
import { type Bounds, type Host, hostSetup } from "../host";
import type { LoadCode } from "../node";
import { kindLookup } from "../shared";
import { boundsOf, capErrors, type ExpansionOf, unexpanded } from "./bounds";
import { checkConfig, checkHosts, checkTypes, checkWorkers } from "./checks";
import { expand } from "./expand";

export type ComposeInput = {
	/** IR that `parseIr` accepted. */
	ir: Ir;
	/** The layered config. */
	config: Composed;
	/** The config schemas the engine owns, by top-level key (CFG-01). */
	core: Readonly<Record<string, JsonSchema>>;
	/** Each installed pack's claims: its id, then its compositions' ids, then each one's param names (D-17). */
	packs: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
	hosts: readonly Host[];
	loadCode: LoadCode;
	/** Caps by name: `instances` caps the node-instance total, any other name the total of a host's count (D-23). */
	caps: Bounds;
};

export type ComposeResult =
	| { ok: true; plan: Plan }
	| { ok: false; diagnostics: Diagnostic[] };

const hasError = (diagnostics: readonly Diagnostic[]) =>
	diagnostics.some((d) => d.severity === "error");

const HOST = "HOST";

/** Gives a host's diagnostic the `HOST` prefix (sdk-spec 13.3), unless it has it. */
export function stampHost(d: Diagnostic): Diagnostic {
	return d.code === HOST || d.code.startsWith(`${HOST}.`)
		? d
		: { ...d, code: `${HOST}.${d.code}` };
}

/** Each host's `validate` findings, a throw or a rejection being a `HOST.validate` error that names the host. */
async function validations({ hosts, config }: ComposeInput, graph: GraphIndex) {
	const results = await Promise.all(
		hosts.map(async (host): Promise<Diagnostic[]> => {
			try {
				return (await host.validate(graph, hostSetup(host, config))).map(
					stampHost,
				);
			} catch (e) {
				return [
					{
						code: `${HOST}.validate`,
						severity: "error",
						message: `host '${host.name}' failed in validate(): ${messageOf(e)}`,
						hint: `Check the setup of host '${host.name}', or uninstall it`,
					},
				];
			}
		}),
	);
	return results.flat();
}

/**
 * Pre-flight (architecture 4): checks types, config and host nodes, loads every function the IR names, expands the
 * groups whose items are plain values, calls the hosts' `validate` hooks, and bounds the plan against the caps. It
 * calls no author code, writes nothing and starts no host node (NFR-02, ADR 0009).
 * @throws Error when two hosts register one node kind, as `perform` does.
 */
export async function compose(input: ComposeInput): Promise<ComposeResult> {
	const { ir, hosts } = input;
	const graph = indexGraph(ir);
	const lookup = kindLookup(hosts);
	const ajv = validator();
	const checked = [
		...checkTypes(ir, graph, hosts),
		...checkConfig(ajv, input, lookup),
		...checkHosts(ajv, ir, lookup),
	];
	if (hasError(checked)) return { ok: false, diagnostics: checked };
	const unloaded = await checkWorkers(ir, input.loadCode);
	if (hasError(unloaded))
		return { ok: false, diagnostics: [...checked, ...unloaded] };
	const capped = (expansionOf: ExpansionOf, reach?: string) =>
		capErrors(boundsOf(ir, graph, expansionOf, lookup), input.caps, reach);
	const limit = capped(unexpanded).length
		? (sofar: ExpansionOf) => capped(sofar, "may reach at least")
		: undefined;
	const expanded = expand(ir, graph, limit);
	const expansionOf: ExpansionOf = (group, path) =>
		expanded.expansion[group.id]?.[path] ?? unexpanded(group, path);
	const diagnostics = [
		...checked,
		...expanded.diagnostics,
		...(await validations(input, graph)),
	];
	const bounds = boundsOf(ir, graph, expansionOf, lookup);
	if (!hasError(diagnostics))
		diagnostics.push(...capErrors(bounds, input.caps));
	if (hasError(diagnostics)) return { ok: false, diagnostics };
	return {
		ok: true,
		plan: { ir, expansion: expanded.expansion, bounds, diagnostics },
	};
}
