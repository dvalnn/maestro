// A bare composition: edit.ts, its changeset carrying a commit message.

import { changeset, check, fresh } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const message = composition("message", { examples: [{}] }, () =>
	changeset(
		check(fresh(), { run: "echo edited > a.txt" }, { label: "edit" }).out.lane,
		{ message: "Edit a.txt\n\nIt now says edited." },
	),
);
