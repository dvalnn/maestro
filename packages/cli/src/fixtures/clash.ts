// A bare composition file whose param shares its flag with a command's.
import { composition, Text } from "@maestro/sdk";
import { hostNode } from "@maestro/sdk/host";

export const clash = composition(
	"clash",
	{ params: { tour: Text({ default: "x" }) }, examples: [{}] },
	({ tour }) => hostNode("fake.task", { label: "clash", in: { tour } }),
);
