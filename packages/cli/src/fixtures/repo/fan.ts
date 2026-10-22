// A bare composition: a changeset in a scope, and one per item of a parMap.

import { changeset, check, fresh } from "@maestro/host-repo-sdk";
import { composition, iter, use } from "@maestro/sdk";

const inner = composition("inner", { examples: [{}] }, () =>
	changeset(check(fresh(), { run: "echo inner > a.txt" }).out.lane, {
		label: "innerSet",
	}),
);

export const fan = composition("fan", { examples: [{}] }, () => {
	use(inner, {});
	return iter.parMap(
		["x", "y"],
		() =>
			changeset(check(fresh(), { run: "echo set > a.txt" }).out.lane, {
				label: "set",
			}),
		{ onError: "stop" },
	);
});
