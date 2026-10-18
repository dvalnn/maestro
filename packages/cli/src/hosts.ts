import type { Host } from "@maestro/core/host";
import { claudeHarness } from "@maestro/harness-claude";
import { piHarness } from "@maestro/harness-pi";
import { repoHost } from "@maestro/host-repo";

/** The hosts the CLI ships, their credentials read from `env`. */
export const builtinHosts = (
	env: Record<string, string | undefined>,
): Host[] => [
	repoHost({
		harnesses: [
			piHarness(),
			claudeHarness({ token: env.CLAUDE_CODE_OAUTH_TOKEN }),
		],
	}),
];
