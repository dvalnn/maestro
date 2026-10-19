import type { Bounds, Host } from "@maestro/core/host";
import type { Harness } from "../harness/index";
import { agentKind } from "./agent";
import { applyKind, changesetKind } from "./apply";
import { checkKind } from "./check";
import {
	AGENT_KIND,
	HOST_CONFIG,
	HOST_NAME,
	HOST_PATHS,
	LANE_TYPE,
	repoSetup,
} from "./config";
import { concertUsage, releaseConcert } from "./store";
import { repoText } from "./text";
import { validateRepo } from "./validate";

export {
	AGENT_IN_PORTS,
	AGENT_KIND,
	AGENT_OUT_PORTS,
	CHECK_KIND,
} from "./config";

/** `<concert id>.<node instance id>`: concert ids hold no `.`, and the instance part is not empty. */
const LANE_REF = /^[^.]+\.[^\s]+$/;

export type RepoHostOptions = {
	/** The harnesses a role can name, by their `name`. */
	harnesses: readonly Harness[];
};

/** The repo host (architecture 12): agent and check nodes in lanes cut from a target repository. */
export function repoHost({ harnesses }: RepoHostOptions): Host {
	return {
		name: HOST_NAME,
		kinds: [agentKind(harnesses), checkKind(), changesetKind(), applyKind()],
		types: [LANE_TYPE],
		config: HOST_CONFIG,
		paths: HOST_PATHS,
		validate: (graph, setup) =>
			validateRepo(
				graph,
				repoSetup(setup),
				harnesses.map((h) => h.name),
			),
		bounds: (node): Bounds =>
			node.kind === AGENT_KIND ? { [AGENT_KIND]: 1 } : {},
		environment(setup) {
			const { target } = repoSetup(setup);
			return target ? { target: target.repo, base: target.base ?? null } : {};
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
