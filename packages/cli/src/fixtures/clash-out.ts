// A bare composition file whose param shares its flag with `compose --out`.
import { composition, hostNode, Text } from "@maestro/sdk";

export const clashOut = composition(
	"clash-out",
	{ params: { out: Text({ default: "x" }) }, examples: [{}] },
	({ out }) => hostNode("fake.task", { label: "clash", in: { out } }),
);
