// Verifies that every workspace dependency resolves; it never installs.
// Standalone so it runs before index.ts loads and its static imports can crash.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Miss = { pkg: string; workspace: string };

type Manifest = {
	name?: string;
	workspaces?: string[] | { packages?: string[] };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

const readManifest = (dir: string): Manifest | undefined => {
	const file = join(dir, "package.json");
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
};

const resolves = (pkg: string, from: string): boolean => {
	for (let dir = resolve(from); ; dir = dirname(dir)) {
		if (existsSync(join(dir, "node_modules", pkg, "package.json"))) return true;
		if (dirname(dir) === dir) return false;
	}
};

const workspaceDirs = (root: string, manifest: Manifest): string[] => {
	const patterns = Array.isArray(manifest.workspaces)
		? manifest.workspaces
		: (manifest.workspaces?.packages ?? []);
	const dirs = [root];
	for (const pattern of patterns) {
		for (const match of new Bun.Glob(`${pattern}/package.json`).scanSync({
			cwd: root,
		})) {
			dirs.push(join(root, dirname(match)));
		}
	}
	return dirs;
};

const missesIn = (dir: string): Miss[] => {
	const manifest = readManifest(dir);
	if (!manifest) return [];
	const declared = { ...manifest.dependencies, ...manifest.devDependencies };
	return Object.keys(declared)
		.filter((pkg) => !resolves(pkg, dir))
		.map((pkg) => ({ pkg, workspace: manifest.name ?? dir }));
};

export const missingDependencies = (root: string): Miss[] => {
	const rootManifest = readManifest(root);
	if (!rootManifest) return [];
	return workspaceDirs(root, rootManifest).flatMap(missesIn);
};

if (import.meta.main) {
	const misses = missingDependencies(process.cwd());
	if (misses.length > 0) {
		for (const { pkg, workspace } of misses) {
			console.error(`missing package ${pkg}, needed by workspace ${workspace}`);
		}
		console.error("run: bun install");
		process.exit(1);
	}
}
