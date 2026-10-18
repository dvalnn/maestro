// A bare composition: a check in a map cuts a fresh lane and seals a marked 64 KiB version per item.

import { check, fresh } from "@maestro/host-repo-sdk";
import { composition, map } from "@maestro/sdk";

export const mark = composition("mark", { examples: [{}] }, () =>
	map(
		["risk"],
		() =>
			check(
				fresh(),
				{
					run: ["echo marked > mark.txt", "head -c 65536 /dev/zero > big.bin"],
				},
				{ label: "skeptic" },
			),
		{ label: "lens", onError: "propagate" },
	),
);
