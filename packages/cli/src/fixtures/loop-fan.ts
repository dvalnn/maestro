import { composition, firstOk, iter, loop, not, Text } from "@maestro/sdk";
import { hostNode } from "@maestro/sdk/host";

const task = (label: string, text?: unknown) =>
	hostNode("fake.task", {
		label,
		in: text === undefined ? {} : { text },
		out: { text: Text() },
	});

export const loopFan = composition("loop_fan", { examples: [{}] }, () =>
	loop.doWhile((result) => not(result.ok), {
		init: task("init"),
		step: () => {
			const members = iter.parMap(
				["lens", "risk"],
				(item) => task("worker", item),
				{
					label: "fan",
					onError: "continue",
				},
			);
			return task("finish", firstOk(members).out.value.get("text"));
		},
		max: 2,
		label: "rounds",
	}),
);
