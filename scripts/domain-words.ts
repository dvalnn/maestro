import { resolve } from "node:path";

const EXIT_FOUND = 1;
const DOMAIN_WORD = /^(lane|seat|leg|run|review|build|quality)s?$/;
/**
 * The paths scanned, relative to `packages/`, each with the domain words it may use. ir is scanned by its source alone.
 * The SDK has a build phase, which the CLI drives.
 */
const SCANNED: Readonly<Record<string, readonly string[]>> = {
	"ir/src": ["build"],
	core: [],
	"render-text": [],
	testkit: [],
	sdk: ["build"],
	cli: ["build"],
};
const packagesDir = resolve(import.meta.dir, "../packages");

// Splits at anything not a letter and at a lower-to-upper case change, so `runNode` and `run_node` yield `run`,
// while `runtime` stays one word.
const words = (text: string) =>
	text.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).map((w) => w.toLowerCase());

const files = (pkg: string) =>
	[
		...new Bun.Glob(`${pkg}/**/*`).scanSync({ cwd: packagesDir, dot: true }),
	].filter((f) => !f.split("/").includes("node_modules"));

const banned = (word: string, allowed: readonly string[]) => {
	const stem = DOMAIN_WORD.exec(word)?.[1];
	return stem !== undefined && !allowed.includes(stem);
};

const found: string[] = [];
for (const [pkg, allowed] of Object.entries(SCANNED))
	for (const file of files(pkg)) {
		const text = `${file}\n${await Bun.file(resolve(packagesDir, file)).text()}`;
		for (const word of words(text).filter((w) => banned(w, allowed)))
			found.push(`packages/${file}: ${word}`);
	}

if (found.length) {
	console.error(
		`domain words in domain-free packages:\n${found.map((f) => `  ${f}`).join("\n")}\n` +
			"Rename them, or allow the word for its package in scripts/domain-words.ts",
	);
	process.exit(EXIT_FOUND);
}
