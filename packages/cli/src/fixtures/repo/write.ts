// A bare composition: an agent with an identity writes a file in a fresh lane, and a check reads it in that version.
import { composition, Dir, hostNode, Text } from "@maestro/sdk";
import { Lane, Logs } from "./lane";

export const write = composition("write", { examples: [{}] }, () => {
	const agent = hostNode("repo.agent", {
		label: "write",
		in: {
			prompt:
				"Use the write tool to create hello.txt containing hi in the current directory.",
			identity:
				"You sign every report you give with the word kumquat at its end.",
		},
		config: { role: { name: "writer" }, lane: { mode: "fresh" } },
		out: { report: Text(), staged: Dir(), lane: Lane },
	});
	return hostNode("repo.check", {
		label: "look",
		in: { lane: agent.out.lane },
		config: { lane: { mode: "read" }, check: { run: "grep -q hi hello.txt" } },
		out: { logs: Logs },
	});
});
