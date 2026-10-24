import { type Composed, sourceOf } from "@maestro/core/config";
import { type Bounds, type Host, hostSetup } from "@maestro/core/host";
import type { IrNode } from "@maestro/ir";
import type { Harness, Role } from "../harness/index";
import { agentKind } from "./agent";
import { applyKind, changesetKind, commitsKind } from "./apply";
import { checkKind } from "./check";
import {
	AGENT_KIND,
	agentConfig,
	HOST_CONFIG,
	HOST_NAME,
	HOST_PATHS,
	LANE_TYPE,
	type RoleTier,
	repoSetup,
	roleOrigins,
} from "./config";
import { concertUsage, releaseConcert } from "./store";
import { repoText } from "./text";
import { needsRepo, validateRepo } from "./validate";

export { BASE_FILE, patchFiles } from "./apply";
export {
	AGENT_IN_PORTS,
	AGENT_KIND,
	AGENT_OUT_PORTS,
	CHANGESET_PORT,
	CHECK_KIND,
	HOST_NAME,
} from "./config";

/** `<concert id>.<node instance id>`: concert ids hold no `.`, and the instance part is not empty. */
const LANE_REF = /^[^.]+\.[^\s]+$/;

export type RepoHostOptions = {
	/** The harnesses a role can name, by their `name`. */
	harnesses: readonly Harness[];
};

/** A role field's value, and the config layer, or `composition`, that set it. */
type Resolved = { value: string; layer: string };

/**
 * The layer of a role field: `composition` for an inline one, else the layer of the config source that set it.
 * @throws Error when the config has no source for a field it set.
 */
function layerOf(
	config: Composed,
	role: string,
	field: string,
	tier: RoleTier,
): string {
	if (tier === "composition") return tier;
	const source = sourceOf(config, ["roles", role, field]);
	if (!source) throw new Error(`config 'roles.${role}.${field}' has no source`);
	return source.layer;
}

/** The agent nodes among `nodes`, each with its role's name and the fields it resolves to under `config`, with layers. */
export function agentRoles(
	nodes: readonly IrNode[],
	config: Composed,
	host: Host,
): ({ node: string; role: string } & Partial<Record<keyof Role, Resolved>>)[] {
	const repo = repoSetup(hostSetup(host, config));
	return nodes.flatMap((n) => {
		if (n.kind !== AGENT_KIND) return [];
		const { role } = agentConfig(n.config);
		const fields = Object.entries(roleOrigins(role, repo)).map(
			([field, { value, tier }]) =>
				[
					field,
					{ value, layer: layerOf(config, role.name, field, tier) },
				] as const,
		);
		return [{ node: n.id, role: role.name, ...Object.fromEntries(fields) }];
	});
}

/** The repo host (architecture 12): agent and check nodes in lanes cut from a target repository. */
export function repoHost({ harnesses }: RepoHostOptions): Host {
	return {
		name: HOST_NAME,
		kinds: [
			agentKind(harnesses),
			checkKind(),
			changesetKind(),
			commitsKind(),
			applyKind(),
		],
		types: [LANE_TYPE],
		config: HOST_CONFIG,
		paths: HOST_PATHS,
		validate: (graph, setup) =>
			validateRepo(
				graph,
				repoSetup(setup),
				harnesses.map((h) => h.name),
			),
		needs: needsRepo,
		bounds: (node): Bounds =>
			node.kind === AGENT_KIND ? { [AGENT_KIND]: 1 } : {},
		environment(setup) {
			const { target } = repoSetup(setup);
			return target
				? {
						target: target.repo,
						base: target.base ?? null,
						sparse: target.sparse ?? null,
					}
				: {};
		},
		param(type, text) {
			if (type === LANE_TYPE && LANE_REF.test(text)) return { value: text };
			return {
				diagnostics: [
					{
						code: "HOST.param",
						severity: "error",
						message: `'${text}' is not a ${type}`,
						hint: "Write a lane ref as <concert id>.<node instance id>",
					},
				],
			};
		},
		text: repoText,
		resources: {
			release: (concert, setup) => releaseConcert(setup.store, concert),
			usage: (concert, setup) => concertUsage(setup.store, concert),
		},
	};
}
