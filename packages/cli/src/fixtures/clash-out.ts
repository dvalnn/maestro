// A bare composition file whose param shares its flag with `compose --out`.
import { composition, Text } from "@maestro/sdk";
import { hostNode } from "@maestro/sdk/host";

export const clashOut = composition(
	"clash-out",
	{ params: { out: Text({ default: "x" }) }, examples: [{}] },
	({ out }) => hostNode("fake.task", { label: "clash", in: { out } }),
);
