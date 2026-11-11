import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_LISTED_ENTRIES, taskOf } from "./task";
import { cleanup, tmp } from "./test-support";

afterEach(cleanup);

test("a task lists its attachments as a sized tree under a must-read lead, a directory one level deep and capped", () => {
	const dir = tmp("task");
	writeFileSync(join(dir, "spec"), "one\ntwo\nthree\n");
	const patches = join(dir, "patches");
	mkdirSync(join(patches, "old"), { recursive: true });
	writeFileSync(join(patches, "old", "a.diff"), "x\n");
	for (let i = 0; i < MAX_LISTED_ENTRIES + 1; i++)
		writeFileSync(
			join(patches, `p${String(i).padStart(2, "0")}.diff`),
			"-\n+\n",
		);
	symlinkSync(patches, join(dir, "linked"));

	expect(
		taskOf(
			"Fix it.",
			[],
			[
				{
					name: "spec",
					hint: "first, for the requirements",
					format: "markdown",
					source: join(dir, "spec"),
				},
				{
					name: "linked",
					hint: "the fix's patches",
					source: join(dir, "linked"),
				},
			],
		),
	).toBe(`Fix it.

Read-only files your task needs. Read a file whole; browse and grep a directory.

/in/
├── spec      markdown, 3 lines, 14 B: first, for the requirements
└── linked/   14 files, 54 B: the fix's patches
    ├── old/       1 file, 2 B
    ├── p00.diff   diff, 2 lines, 4 B
    ├── p01.diff   diff, 2 lines, 4 B
    ├── p02.diff   diff, 2 lines, 4 B
    ├── p03.diff   diff, 2 lines, 4 B
    ├── p04.diff   diff, 2 lines, 4 B
    ├── p05.diff   diff, 2 lines, 4 B
    ├── p06.diff   diff, 2 lines, 4 B
    ├── p07.diff   diff, 2 lines, 4 B
    ├── p08.diff   diff, 2 lines, 4 B
    ├── p09.diff   diff, 2 lines, 4 B
    ├── p10.diff   diff, 2 lines, 4 B
    └── … 2 more entries`);
});

test("a task with no attachment is its text alone", () => {
	expect(taskOf("Fix it.", [], [])).toBe("Fix it.");
});
