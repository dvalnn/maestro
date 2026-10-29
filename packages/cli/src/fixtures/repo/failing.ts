// A bare composition: one agent that edits its fresh lane, for a harness that then fails.

import { fresh, seat } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

const smoke = seat("smoke");

export const failing = composition("failing", { examples: [{}] }, () =>
	smoke({ label: "build", task: "edit", lane: fresh() }),
);
