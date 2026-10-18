// A bare composition: an agent with an identity writes a file in a fresh lane, and a check reads it in that version.

import { agent, check, fresh, read } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const write = composition("write", { examples: [{}] }, () => {
	const writer = agent({
		label: "write",
		task: "Use the write tool to create hello.txt containing hi in the current directory.",
		identity:
			"You sign every report you give with the word kumquat at its end.",
		lane: fresh(),
		role: "writer",
	});
	return check(
		read(writer.out.lane),
		{ run: "grep -q hi hello.txt" },
		{ label: "look" },
	);
});
