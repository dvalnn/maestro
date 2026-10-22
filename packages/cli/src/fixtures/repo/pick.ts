// A bare composition: three changesets, the result's settling first, a later one, and an empty one.

import { changeset, check, fresh } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const pick = composition("pick", { examples: [{}] }, () => {
	const later = check(
		fresh(),
		{ run: ["sleep 0.5", "echo later > a.txt"] },
		{ label: "later" },
	);
	changeset(later.out.lane, { label: "laterSet" });
	const none = check(fresh(), { run: "true" }, { label: "none" });
	changeset(none.out.lane, { label: "emptySet" });
	const kept = check(fresh(), { run: "echo kept > a.txt" }, { label: "kept" });
	return changeset(kept.out.lane, { label: "keptSet" });
});
