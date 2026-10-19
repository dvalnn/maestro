// A bare composition file whose boolean param's `--no-` flag is the negation of a common flag.
import { Bool, composition } from "@maestro/sdk";
import { hostNode } from "@maestro/sdk/host";

export const clashNo = composition(
	"clash-no",
	{ params: { noColor: Bool({ default: false }) }, examples: [{}] },
	({ noColor }) => hostNode("fake.task", { label: "clash", in: { noColor } }),
);
