// A bare composition: edit.ts, rewriting only a.txt's first line, so its patch ends on a blank context line.

import { changeset, check, fresh } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const blank = composition("blank", { examples: [{}] }, () =>
	changeset(
		check(fresh(), { run: "printf 'edited\\n\\n' > a.txt" }, { label: "edit" })
			.out.lane,
	),
);
