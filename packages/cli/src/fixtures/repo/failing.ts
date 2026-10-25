// A bare composition: one agent that edits its fresh lane, for a harness that then fails.

import { agent, fresh } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const failing = composition("failing", { examples: [{}] }, () =>
	agent({ label: "build", task: "edit", lane: fresh(), role: "smoke" }),
);
