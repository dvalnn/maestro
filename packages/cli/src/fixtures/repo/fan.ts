// A bare composition: a changeset in a scope, and one per item of a parMap.

import { changeset, check, fresh } from "@maestro/host-repo-sdk";
import { composition, iter, loop, not, use } from "@maestro/sdk";

const inner = composition("inner", { examples: [{}] }, () =>
	changeset(check(fresh(), { run: "echo inner > a.txt" }).out.lane, {
		label: "innerSet",
	}),
);

export const fan = composition("fan", { examples: [{}] }, () => {
	use(inner, {});
	loop.doWhile((result) => not(result.ok), {
		init: check(fresh(), { run: "true" }, { label: "start" }),
		step: () => {
			iter.parMap(
				["lens", "risk"],
				() =>
					changeset(check(fresh(), { run: "echo nested > a.txt" }).out.lane, {
						label: "nestedSet",
					}),
				{ label: "fan", onError: "stop" },
			);
			return check(fresh(), { run: "true" }, { label: "finish" });
		},
		max: 1,
		label: "rounds",
	});
	return iter.parMap(
		["x", "y"],
		() =>
			changeset(check(fresh(), { run: "echo set > a.txt" }).out.lane, {
				label: "set",
			}),
		{ onError: "stop" },
	);
});
