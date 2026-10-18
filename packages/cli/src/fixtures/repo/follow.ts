// A bare composition: a check reads the lane ref it is given and finds the mark there.
import { composition, hostNode } from "@maestro/sdk";
import { Lane, Logs } from "./lane";

export const follow = composition(
	"follow",
	{ params: { from: Lane }, examples: [{ from: "c.lens[risk]/skeptic" }] },
	({ from }) =>
		hostNode("repo.check", {
			label: "look",
			in: { lane: from },
			config: {
				lane: { mode: "read" },
				check: { run: "grep -q marked mark.txt" },
			},
			out: { logs: Logs },
		}),
);
