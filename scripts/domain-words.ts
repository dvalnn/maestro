import { resolve } from "node:path";

const EXIT_FOUND = 1;
const DOMAIN_WORD = /^(lane|seat|leg|run|review|build|quality)s?$/;
/**
 * The paths scanned, relative to `packages/`, each with the domain words it may use. ir is scanned by its source alone.
 * The SDK has a build phase. `cli` runs and builds; its host modules, tests and fixtures are exempt (R-10).
 */
const SCANNED: Readonly<Record<string, readonly string[]>> = {
	"ir/src": ["build"],
	core: [],
	"render-text": [],
	testkit: ["build"],
	sdk: ["build"],
	"cli/src": ["run", "build"],
};
/** The `cli` modules, relative to `packages/`, that wire or command a host and so speak its words (R-10). */
const HOST_MODULES = new Set([
	"cli/src/hosts.ts",
	"cli/src/agent.ts",
	"cli/src/changeset.ts",
]);
/** Host modules, and `cli`'s own tests and fixtures, which use a host's words to drive it. */
const exempt = (file: string) =>
	HOST_MODULES.has(file) ||
	(file.startsWith("cli/src/") &&
		(file.endsWith(".test.ts") || file.includes("/fixtures/")));

// Splits at anything not a letter and at a lower-to-upper case change, so `runNode` and `run_node` yield `run`,
// while `runtime` stays one word.
const words = (text: string) =>
	text.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).map((w) => w.toLowerCase());

const files = (pkg: string, packagesDir: string) =>
	[
		...new Bun.Glob(`${pkg}/**/*`).scanSync({ cwd: packagesDir, dot: true }),
	].filter((f) => !f.split("/").includes("node_modules") && !exempt(f));

const banned = (word: string, allowed: readonly string[]) => {
	const stem = DOMAIN_WORD.exec(word)?.[1];
	return stem !== undefined && !allowed.includes(stem);
};

/** The domain words found under `packagesDir`, each as `packages/<file>: <word>`. */
export async function scan(packagesDir: string): Promise<string[]> {
	const found: string[] = [];
	for (const [pkg, allowed] of Object.entries(SCANNED))
		for (const file of files(pkg, packagesDir)) {
			const text = `${file}\n${await Bun.file(resolve(packagesDir, file)).text()}`;
			for (const word of words(text).filter((w) => banned(w, allowed)))
				found.push(`packages/${file}: ${word}`);
		}
	return found;
}

if (import.meta.main) {
	const found = await scan(resolve(import.meta.dir, "../packages"));
	if (found.length) {
		console.error(
			`domain words in domain-free packages:\n${found.map((f) => `  ${f}`).join("\n")}\n` +
				"Rename them, or allow the word for its package in scripts/domain-words.ts",
		);
		process.exit(EXIT_FOUND);
	}
}
