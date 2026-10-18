// A bare composition file with one host node.
import { composition } from "@maestro/sdk";
import { hostNode } from "@maestro/sdk/host";

export const task = composition("task", { examples: [{}] }, () =>
	hostNode("fake.task", { label: "task" }),
);
