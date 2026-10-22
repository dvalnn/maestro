// A bare composition: a check's version leaves as a changeset, then a later check rejects the concert.

import { changeset, check, fresh, read } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const reject = composition("reject", { examples: [{}] }, () => {
	const kept = check(fresh(), { run: "echo kept > a.txt" }, { label: "kept" });
	changeset(kept.out.lane, { label: "keptSet" });
	return check(
		read(kept.out.lane),
		{ run: ["sleep 0.5", "false"] },
		{ label: "late" },
	);
});
