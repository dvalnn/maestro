// A bare composition: an agent of profile writer writes a file in a fresh lane, and a check reads it in that version.

import { check, fresh, read, seat } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

const writer = seat("writer");

export const write = composition("write", { examples: [{}] }, () => {
	const written = writer({
		label: "write",
		task: "Use the write tool to create hello.txt containing hi in the current directory.",
		lane: fresh(),
	});
	return check(
		read(written.out.lane),
		{ run: "grep -q hi hello.txt" },
		{ label: "look" },
	);
});
