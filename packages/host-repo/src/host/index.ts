import type { Composed } from "@maestro/core/config";
import {
	type Bounds,
	type Host,
	type HostSetup,
	hostSetup,
	type Roots,
} from "@maestro/core/host";
import { type Ir, indexGraph } from "@maestro/ir";
import type { Harness, Runtime } from "../harness/index";
import { revisionOf } from "../lane/index";
import {
	type Binding,
	type Profile,
	profilesDigest,
	resolveProfile,
	seatBinding,
} from "../profile/index";
import { agentKind, agentPrompt } from "./agent";
import { applyKind, changesetKind, commitsKind } from "./apply";
import { checkKind } from "./check";
import {
	AGENT_KIND,
	agentConfig,
	HOST_CONFIG,
	HOST_DEFERRED,
	HOST_NAME,
	HOST_PATHS,
	isLegacyAgent,
	LANE_TYPE,
	repoSetup,
	SESSION_TYPE,
} from "./config";
import { baseOf } from "./lane-input";
import { concertUsage, releaseConcert } from "./store";
import { repoText } from "./text";
import { needsRepo, validateRepo } from "./validate";

export {
	type Binding,
	findProfile,
	heldNames,
	type Inspection,
	inspectProfile,
	type Profile,
	type ProfileRoot,
	profileRoot,
	readablePath,
	resolveProfile,
	sourceWords,
	unsetMessage,
	type ValueSource,
} from "../profile/index";
export { SandboxUnavailable } from "../sandbox/index";
export { BASE_FILE, MESSAGE_FILE, patchFiles } from "./apply";
export {
	AGENT_IN_PORTS,
	AGENT_KIND,
	AGENT_OUT_PORTS,
	CHANGESET_PORT,
	CHECK_KIND,
	HOST_NAME,
} from "./config";
export { REPORT } from "./frame";
export { type Probed, probe, probeRequest } from "./probe";
export { keepWindow, windowOf } from "./windows";

/** `<concert id>.<node instance id>`: concert ids hold no `.`, and the instance part is not empty. */
const LANE_REF = /^[^.]+\.[^\s]+$/;

export type RepoHostOptions = {
	/** The harnesses a profile can name, by their `name`. */
	harnesses: readonly Harness[];
};

/** What an agent node runs: its profile, and the runtime the profile resolves to. */
export type AgentRuntime = { node: string; profile: string } & Runtime;

/** An agent node seated in a composition: where it sits, the profile it is bound to, and the prompt a profile gives it. */
export type SeatedAgent = {
	node: string;
	/** `<composition id>/<seat>`, the key `seats` rebinds the seat by. */
	key: string;
	binding: Binding;
	prompt: (profile: Profile) => string;
};

/** The agent nodes of `ir`, each with the profile its seat runs under `setup`. */
export function seatedAgents(ir: Ir, setup: HostSetup): SeatedAgent[] {
	const graph = indexGraph(ir);
	return ir.nodes.flatMap((n): SeatedAgent[] => {
		if (n.kind !== AGENT_KIND || isLegacyAgent(n.config)) return [];
		const config = agentConfig(n.config);
		const composition = graph.compositionOf(n.id);
		return [
			{
				node: n.id,
				key: `${composition}/${config.seat}`,
				binding: seatBinding(setup, composition, config),
				prompt: (profile) => agentPrompt(config, profile, setup),
			},
		];
	});
}

/** The agent nodes of `ir`, each with the profile its seat runs under `config` and the runtime that resolves to. */
export async function agentRuntimes(
	ir: Ir,
	config: Composed,
	host: Host,
	roots: Roots,
): Promise<AgentRuntime[]> {
	const setup = hostSetup(host, config, roots);
	return Promise.all(
		seatedAgents(ir, setup).map(async ({ node, binding }) => ({
			node,
			profile: binding.profile,
			...(await resolveProfile(binding.profile, setup)).fields.runtime,
		})),
	);
}

/** The repo host (see `packages/host-repo/README.md`): agent and check nodes in lanes cut from a target repository. */
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
		types: [LANE_TYPE, SESSION_TYPE],
		config: HOST_CONFIG,
		paths: HOST_PATHS,
		deferred: HOST_DEFERRED,
		validate: (graph, setup) => validateRepo(graph, setup, harnesses),
		needs: needsRepo,
		bounds: (node): Bounds =>
			node.kind === AGENT_KIND ? { [AGENT_KIND]: 1 } : {},
		async environment(setup) {
			const repo = repoSetup(setup);
			const { target } = repo;
			return target
				? {
						target: target.repo,
						base: target.base ?? null,
						sparse: target.sparse ?? null,
						revision: await revisionOf(target.repo, baseOf(repo)),
						profiles: await profilesDigest(setup.roots),
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
