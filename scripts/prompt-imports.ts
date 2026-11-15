import { dirname, join, relative, resolve } from "node:path";

const EXIT_FOUND = 1;
const SHARED_PROMPTS = ".maestro/prompts/";
/** A relative import or re-export of a Markdown file, static or dynamic. */
const MARKDOWN_IMPORT =
	/\b(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']*\.md)["']/g;

const sources = (root: string, under: string) =>
	[
		...new Bun.Glob(`${under}/**/*.{ts,tsx,mts,js,mjs}`).scanSync({
			cwd: root,
			dot: true,
		}),
	].filter((file) => {
		const parts = file.split("/");
		return !parts.includes("node_modules") && !parts.includes("dist");
	});

/**
 * The prompt directories, relative to the root and ending in `/`, that `file` may import from. A `.maestro/` file belongs
 * to the composition its first segment names (`triage.ts`, `triage.test.ts`, `triage/ears.ts`), which owns
 * `.maestro/<id>/prompts/`; a file outside every composition, such as `shared.ts`, owns no directory that exists. A pack
 * file may import only its pack's `src/prompts/`.
 */
function allowed(file: string): string[] {
	const [top, owner] = file.split("/");
	if (top === "packs") return [`packs/${owner}/src/prompts/`];
	return [SHARED_PROMPTS, `.maestro/${owner?.split(".")[0]}/prompts/`];
}

function foreign(root: string, file: string, source: string): string[] {
	const permitted = allowed(file);
	return [...source.matchAll(MARKDOWN_IMPORT)]
		.map((match) => relative(root, join(root, dirname(file), match[1] ?? "")))
		.filter((target) => !permitted.some((dir) => target.startsWith(dir)));
}

/**
 * The foreign prompt imports under `root`'s `.maestro/` and `packs/*`, each as `<file>: imports <prompt>`, both
 * relative to `root`. A composition imports only its own prompts and `.maestro/prompts/`; a pack only its `src/prompts/`.
 */
export async function scan(root: string): Promise<string[]> {
	const found: string[] = [];
	for (const file of [
		...sources(root, ".maestro"),
		...sources(root, "packs"),
	]) {
		const source = await Bun.file(join(root, file)).text();
		for (const target of foreign(root, file, source))
			found.push(`${file}: imports ${target}`);
	}
	return found;
}

if (import.meta.main) {
	const found = await scan(
		resolve(process.argv[2] ?? resolve(import.meta.dir, "..")),
	);
	if (found.length) {
		console.error(
			`prompt imports from outside their owner:\n${found.map((f) => `  ${f}`).join("\n")}\n` +
				"Import a composition's own prompts or .maestro/prompts/, a pack's own src/prompts/; move shared text to .maestro/prompts/",
		);
		process.exit(EXIT_FOUND);
	}
}
