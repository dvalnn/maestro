import type { Host } from "@maestro/core/host";
import { claudeHarness } from "@maestro/harness-claude";
import { piHarness } from "@maestro/harness-pi";
import { repoHost } from "@maestro/host-repo";
import { stubHarness } from "@maestro/host-repo/harness";

const STUB_REPLY = JSON.stringify({ report: "stub" });
const STUB_VERDICT = JSON.stringify({ outcome: "ok", report: "stub" });

/** The hosts the CLI ships, their credentials read from `env`. The `stub` harness replies an `ok` envelope and writes nothing. */
export const builtinHosts = (
	env: Record<string, string | undefined>,
): Host[] => [
	repoHost({
		harnesses: [
			piHarness(),
			claudeHarness({ token: env.CLAUDE_CODE_OAUTH_TOKEN }),
			stubHarness((req) => [
				{
					emit: {
						type: "text",
						text: req.verdict ? STUB_VERDICT : STUB_REPLY,
					},
				},
			]),
		],
	}),
];
