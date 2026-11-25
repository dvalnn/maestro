import { expect, test } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { root, scratch } from "../testing/stub";
import { bumpVersions } from "./bump";

const current: string = JSON.parse(
	readFileSync(join(root, "packages/cli/package.json"), "utf8"),
).version;

/** `version` as a whole word, so `0.4.0` is not found inside `0.4.0-rc.2` or `10.4.0`. */
const mentionOf = (version: string) =>
	new RegExp(
		`(?<![\\w.-])v?${version.replaceAll(".", "\\.")}(?![\\w+-]|\\.\\d)`,
	);

/** Files that name a version as history or as an example, never as the version maestro is at. */
const HISTORICAL = new Set([
	".maestro/profiles/release/notes-writer/instructions.md",
	".maestro/release.ts",
	".maestro/release/bump.test.ts",
	".maestro/release/bump.ts",
	"docs/architecture.md",
	"packages/cli/src/loader.test.ts",
	"scripts/factory/index.test.ts",
	"scripts/factory/maestro.test.ts",
	"skills/maestro/packs.md",
]);

/** The tracked and new files of this repository, read under `dir`, that mention `version`, outside `HISTORICAL`. */
function mentioning(dir: string, version: string): string[] {
	const listed = Bun.spawnSync(
		["git", "ls-files", "-co", "--exclude-standard"],
		{ cwd: root },
	);
	const mention = mentionOf(version);
	return listed.stdout
		.toString()
		.trim()
		.split("\n")
		.filter((file) => !HISTORICAL.has(file))
		.filter((file) => {
			try {
				return mention.test(readFileSync(join(dir, file), "utf8"));
			} catch {
				// A file the scratch copy does not hold, or a directory such as a submodule, mentions nothing.
				return false;
			}
		});
}

/** A scratch tree holding `files`, each path with its text. */
function treeOf(files: Record<string, string>): string {
	const dir = mkdtempSync(join(scratch, "bump-"));
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(join(dir, dirname(file)), { recursive: true });
		writeFileSync(join(dir, file), text);
	}
	return dir;
}

test("bumpVersions leaves no file of this repository at the old version, beyond its historical mentions", () => {
	const stale = mentioning(root, current);
	const dir = mkdtempSync(join(scratch, "bump-"));
	for (const file of stale) cpSync(join(root, file), join(dir, file));
	expect(bumpVersions(dir, "9.9.9-rc.1")).toEqual({ from: current });
	expect(mentioning(dir, current)).toEqual([]);
});

/** The version files at 0.4.0, a bun.lock entry at `0.4.0-rc.2` among them, with `install` as INSTALL.md. */
const SMALL = (install = "MAESTRO_VERSION=v0.4.0 sh\n") => ({
	"packages/cli/package.json": '{ "version": "0.4.0" }',
	"packs/classics/package.json": '{ "version": "0.4.0" }',
	"bun.lock":
		'{ "a": { "version": "0.4.0" }, "b": { "version": "0.4.0-rc.2" } }',
	"INSTALL.md": install,
	"skills/maestro/SKILL.md": "Checked against maestro 0.4.0.\n",
});

test("bumpVersions bumps a version only where it stands whole, never inside a longer one", () => {
	const dir = treeOf(SMALL());
	expect(bumpVersions(dir, "0.4.1")).toEqual({ from: "0.4.0" });
	expect(readFileSync(join(dir, "bun.lock"), "utf8")).toBe(
		'{ "a": { "version": "0.4.1" }, "b": { "version": "0.4.0-rc.2" } }',
	);
});

test("bumpVersions returns the problems of a tree, writing nothing: a drifted file, a glob that finds none, no source version", () => {
	const drifted = treeOf(SMALL("MAESTRO_VERSION=v0.0.1 sh\n"));
	rmSync(join(drifted, "bun.lock"));
	expect(bumpVersions(drifted, "0.4.1")).toEqual({
		problems: [
			"no version file matches bun.lock",
			"INSTALL.md does not hold version 0.4.0 as MAESTRO_VERSION=v<version> ",
		],
	});
	expect(readFileSync(join(drifted, "packages/cli/package.json"), "utf8")).toBe(
		'{ "version": "0.4.0" }',
	);
	const unversioned = treeOf({ "packages/cli/package.json": "{}" });
	expect(bumpVersions(unversioned, "0.4.1")).toEqual({
		problems: ["packages/cli/package.json has no version"],
	});
});
