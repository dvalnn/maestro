import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scan } from "./domain-words";

/** A packages directory holding `files`, by path relative to it. */
function packages(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "domain-words-"));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

test("a domain word in a cli module that is not a host module fails", async () => {
	const dir = packages({ "cli/src/prune.ts": "// lane\n" });
	expect(await scan(dir)).toEqual(["packages/cli/src/prune.ts: lane"]);
});

test("cli may say run and build, and its host modules and tests may say any domain word", async () => {
	const dir = packages({
		"cli/src/prune.ts": "// run build\n",
		"cli/src/hosts.ts": "// lane seat\n",
		"cli/src/agent.ts": "// seat\n",
		"cli/src/changeset.ts": "// review\n",
		"cli/src/repo.test.ts": "// lane\n",
		"cli/src/fixtures/repo/edit.ts": "// seat\n",
	});
	expect(await scan(dir)).toEqual([]);
});

test("a test in a core package still fails", async () => {
	const dir = packages({ "core/src/graph.test.ts": "// lane\n" });
	expect(await scan(dir)).toEqual(["packages/core/src/graph.test.ts: lane"]);
});
