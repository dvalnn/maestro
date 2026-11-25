import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The package whose `version` is maestro's version. */
const SOURCE = "packages/cli/package.json";

type Holding = (version: string) => string;

/**
 * The files that carry maestro's version, as globs from the repository root, each with the text that holds the version
 * there. The text bounds the version, so `0.4.0` never matches inside `0.4.0-rc.2`, nor a dependency's version.
 */
const CARRIERS: [glob: string, holding: Holding][] = [
	["packages/*/package.json", (v) => `"version": "${v}"`],
	["packs/classics/package.json", (v) => `"version": "${v}"`],
	["bun.lock", (v) => `"version": "${v}"`],
	["INSTALL.md", (v) => `MAESTRO_VERSION=v${v} `],
	["skills/maestro/SKILL.md", (v) => `Checked against maestro ${v}.`],
];

/** A bump: the version it moved from, or the problems of the tree that stopped it, each naming its file or glob. */
export type Bumped = { from: string } | { problems: string[] };

type Edit = { path: string; text: string } | { problem: string };

/** The edit of version file `file` under `root` from `from` to `to`, or its problem when it does not hold `from`. */
function editOf(
	root: string,
	file: string,
	holding: Holding,
	from: string,
	to: string,
): Edit {
	const path = join(root, file);
	const text = readFileSync(path, "utf8");
	if (!text.includes(holding(from)))
		return {
			problem: `${file} does not hold version ${from} as ${holding("<version>")}`,
		};
	return { path, text: text.replaceAll(holding(from), holding(to)) };
}

/** The edits of every version file under `root`, and a problem for a glob that finds none. */
const editsOf = (root: string, from: string, to: string): Edit[] =>
	CARRIERS.flatMap(([glob, holding]) => {
		const files = [...new Bun.Glob(glob).scanSync(root)];
		if (!files.length) return [{ problem: `no version file matches ${glob}` }];
		return files.map((file) => editOf(root, file, holding, from, to));
	});

/**
 * Bumps every version file of the repository at `root` from its current version to `version`, or, when one does not
 * hold the current version or a glob finds none, writes nothing and returns the problems, so no file is left behind.
 */
export function bumpVersions(root: string, version: string): Bumped {
	const from: unknown = JSON.parse(
		readFileSync(join(root, SOURCE), "utf8"),
	).version;
	if (typeof from !== "string")
		return { problems: [`${SOURCE} has no version`] };
	const edits = editsOf(root, from, version);
	const problems = edits.flatMap((e) => ("problem" in e ? [e.problem] : []));
	if (problems.length) return { problems };
	for (const e of edits) if ("path" in e) writeFileSync(e.path, e.text);
	return { from };
}
