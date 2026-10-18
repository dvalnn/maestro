// A bare composition: a check reads the lane ref it is given and finds the mark there.
import { check, Lane, read } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const follow = composition(
	"follow",
	{ params: { from: Lane }, examples: [{ from: "c.lens[risk]/skeptic" }] },
	({ from }) =>
		check(read(from), { run: "grep -q marked mark.txt" }, { label: "look" }),
);
