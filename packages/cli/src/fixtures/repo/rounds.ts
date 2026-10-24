// A loop of verdict agents: the loop goes on while the latest one rejects, up to three steps.

import { agent, fresh, MarkdownOut } from "@maestro/host-repo-sdk";
import { composition, loop, not } from "@maestro/sdk";

const review = () =>
	agent({
		label: "review",
		task: "rule",
		lane: fresh(),
		role: "smoke",
		verdict: true,
		out: { notes: MarkdownOut("notes.md") },
	});

export const rounds = composition("rounds", { examples: [{}] }, () =>
	loop.while((s) => not(s.ok), {
		init: review(),
		step: () => review(),
		max: 3,
		tolerate: "rejected",
		label: "rounds",
	}),
);
