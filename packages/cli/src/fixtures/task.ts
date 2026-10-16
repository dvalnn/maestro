// A bare composition file with one host node.
import { composition, hostNode } from "@maestro/sdk";

export const task = composition("task", { examples: [{}] }, () =>
	hostNode("fake.task", { label: "task" }),
);
