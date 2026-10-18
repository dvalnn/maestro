// A bare composition: a check in a map cuts a fresh lane and seals a marked 64 KiB version per item.
import { composition, hostNode, map } from "@maestro/sdk";
import { Lane, Logs } from "./lane";

export const mark = composition("mark", { examples: [{}] }, () =>
	map(
		["risk"],
		() =>
			hostNode("repo.check", {
				label: "skeptic",
				config: {
					lane: { mode: "fresh" },
					check: {
						run: [
							"echo marked > mark.txt",
							"head -c 65536 /dev/zero > big.bin",
						],
					},
				},
				out: { logs: Logs, lane: Lane },
			}),
		{ label: "lens", onError: "propagate" },
	),
);
