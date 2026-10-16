// A bare composition file whose param shares its flag with a command's.
import { composition, hostNode, Text } from "@maestro/sdk";

export const clash = composition(
	"clash",
	{ params: { tour: Text({ default: "x" }) }, examples: [{}] },
	({ tour }) => hostNode("fake.task", { label: "clash", in: { tour } }),
);
