// A bare composition: a check in a parMap cuts a fresh lane and seals a marked 64 KiB version per item.

import { check, fresh } from "@maestro/host-repo-sdk";
import { composition, iter } from "@maestro/sdk";

export const mark = composition("mark", { examples: [{}] }, () =>
	iter.parMap(
		["risk"],
		() =>
			check(
				fresh(),
				{
					run: ["echo marked > mark.txt", "head -c 65536 /dev/zero > big.bin"],
				},
				{ label: "skeptic" },
			),
		{ onError: "stop" },
	),
);
