import { expect, test } from "bun:test";
import { resolve } from "node:path";

// CORE-12. This file holds the list, so it is the one file the scan skips.
const DOMAIN_WORD = /^(lane|seat|leg|run|review|build|quality)s?$/;
/** The packages scanned, each with the domain words it may use. The SDK has a build phase; core composes. */
const SCANNED: Readonly<Record<string, readonly string[]>> = {
	core: [],
	testkit: [],
	sdk: ["build"],
};
const packagesDir = resolve(import.meta.dir, "../..");

// Splits at anything not a letter and at a lower-to-upper case change, so `runNode` and `run_node` yield `run`,
// while `runtime` stays one word.
const words = (text: string) =>
	text.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).map((w) => w.toLowerCase());

const files = (pkg: string) =>
	[...new Bun.Glob(`${pkg}/**/*`).scanSync({ cwd: packagesDir, dot: true })]
		.filter((f) => !f.split("/").includes("node_modules"))
		.filter((f) => resolve(packagesDir, f) !== import.meta.path);

const banned = (word: string, allowed: readonly string[]) => {
	const stem = DOMAIN_WORD.exec(word)?.[1];
	return stem !== undefined && !allowed.includes(stem);
};

test("core packages use no domain words, in paths or contents", async () => {
	const found: string[] = [];
	for (const [pkg, allowed] of Object.entries(SCANNED))
		for (const file of files(pkg)) {
			const text = `${file}\n${await Bun.file(resolve(packagesDir, file)).text()}`;
			for (const word of words(text).filter((w) => banned(w, allowed)))
				found.push(`${file}: ${word}`);
		}
	expect(found).toEqual([]);
});
