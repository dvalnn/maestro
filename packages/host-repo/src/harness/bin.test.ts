import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBin } from "./bin";

test("an explicit bin resolves through its links, and a name nowhere on PATH is refused naming it", () => {
	const dir = mkdtempSync(join(tmpdir(), "bin-"));
	writeFileSync(join(dir, "real"), "", { mode: 0o755 });
	symlinkSync(join(dir, "real"), join(dir, "link"));
	expect(resolveBin("tool", join(dir, "link"))).toBe(
		realpathSync(join(dir, "real")),
	);
	expect(() => resolveBin("no-such-tool-4711")).toThrow(
		"no-such-tool-4711 is not on PATH. Install no-such-tool-4711 or pass its path as `bin`",
	);
});
