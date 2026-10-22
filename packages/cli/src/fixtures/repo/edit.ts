// A bare composition: a check rewrites a.txt in a fresh lane, and the version it seals leaves as a changeset.

import { changeset, check, fresh } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const edit = composition("edit", { examples: [{}] }, () =>
	changeset(
		check(fresh(), { run: "echo edited > a.txt" }, { label: "edit" }).out.lane,
	),
);
