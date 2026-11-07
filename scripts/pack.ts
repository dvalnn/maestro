// Builds the pack in <dir> into <dir>/dist: its bundle with its own SDK copy, its manifest, its README and its profiles
// (ADR 0002).
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	bundlerMessage,
	GLUE_FILE,
	glue,
	SDK_VERSION,
} from "@maestro/sdk/loader";

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const ENTRY = "index.js";
const SOURCE = "src/index.ts";
const README = "README.md";
const PACKAGE = "package.json";
const PROFILES = "profiles";

/** Throws an error that says what went wrong, then the likely fix on its own line. */
function fail(what: string, fix: string): never {
	throw new Error(`${what}\n${fix}`);
}

/**
 * The version of the pack in `root`, once its source, README and package are there.
 * @throws Error naming the first file that is missing or holds no version.
 */
async function versionOf(root: string): Promise<string> {
	if (!existsSync(root) || !statSync(root).isDirectory())
		fail(`${root} is not a directory`, "Pass the pack's source dir");
	for (const file of [SOURCE, README, PACKAGE])
		if (!existsSync(join(root, file)))
			fail(`${file} is missing`, `Create ${join(root, file)}`);
	const pkg = join(root, PACKAGE);
	const { version } = await Bun.file(pkg)
		.json()
		.catch(() => fail(`${PACKAGE} is not JSON`, `Fix ${pkg}`));
	if (typeof version !== "string" || !version)
		fail(`${PACKAGE} has no version`, `Set "version" in ${pkg}`);
	return version;
}

/** The bundle of the pack in `root`. @throws Error with each bundler message at its file, line and column. */
async function bundleOf(root: string): Promise<Blob> {
	const entry = join(root, GLUE_FILE);
	const built = await Bun.build({
		entrypoints: [entry],
		files: { [entry]: glue(`./${SOURCE}`) },
		target: "bun",
		format: "esm",
		// Without whitespace, Bun writes each source path as a comment, and the bundle would follow the checkout's path.
		minify: { whitespace: true },
		throw: false,
	});
	const [bundle] = built.outputs;
	if (built.success && bundle) return bundle;
	const file = built.logs.find((l) => l.position)?.position?.file;
	return fail(
		bundlerMessage(built.logs) || "the bundler wrote nothing",
		`Check ${file ?? join(root, SOURCE)}`,
	);
}

/**
 * Writes the pack whose source is `dir` into `out`: `index.js`, `README.md`, `maestro-pack.json` and a copy of its
 * `profiles` directory when it has one, each link as written, once the whole build has succeeded. The pack id is the
 * directory's name and its version is its package's.
 * @throws Error when a file the pack needs is missing, or the source does not bundle.
 */
export async function pack(dir: string, out = join(dir, "dist")) {
	const root = resolve(dir);
	const version = await versionOf(root);
	const bundle = await bundleOf(root);
	const manifest = {
		id: basename(root),
		version,
		entry: ENTRY,
		sdk: `^${SDK_VERSION}`,
	};
	await mkdir(out, { recursive: true });
	await Bun.write(join(out, ENTRY), bundle);
	await Bun.write(join(out, README), Bun.file(join(root, README)));
	await Bun.write(
		join(out, "maestro-pack.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	await rm(join(out, PROFILES), { recursive: true, force: true });
	if (existsSync(join(root, PROFILES)))
		await cp(join(root, PROFILES), join(out, PROFILES), {
			recursive: true,
			// A relative link stays relative, so a self-contained extras directory stays self-contained.
			verbatimSymlinks: true,
		});
	return out;
}

if (import.meta.main) {
	const [dir, ...rest] = process.argv.slice(2);
	if (dir === undefined || rest.length) {
		console.error("usage: bun scripts/pack.ts <pack dir>");
		process.exit(EXIT_USAGE);
	}
	try {
		console.log(await pack(dir));
	} catch (error) {
		console.error(
			`cannot pack ${dir}: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(EXIT_FAILED);
	}
}
