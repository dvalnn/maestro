import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const preflight = join(import.meta.dir, "preflight.ts");

const writePackage = (dir: string, manifest: object) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
};

const withWorkspace = (run: (root: string) => void) => {
	const root = mkdtempSync(join(tmpdir(), "factory-preflight-"));
	try {
		writePackage(root, { private: true, workspaces: ["packages/*"] });
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};

const runPreflight = (root: string) => {
	const result = Bun.spawnSync([process.execPath, preflight], { cwd: root });
	return {
		status: result.exitCode,
		output: result.stdout.toString() + result.stderr.toString(),
		stderr: result.stderr.toString(),
	};
};

test("a missing dependency names the package and the workspace that needs it", () => {
	withWorkspace((root) => {
		writePackage(join(root, "packages", "needs-yaml"), {
			name: "needs-yaml",
			dependencies: { "missing-factory-dependency": "1.0.0" },
		});
		const result = runPreflight(root);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("missing-factory-dependency");
		expect(result.output).toContain("needs-yaml");
	});
});

test("the fix for a missing dependency is bun install, without a Bun stack", () => {
	withWorkspace((root) => {
		writePackage(join(root, "packages", "needs-dependency"), {
			name: "needs-dependency",
			dependencies: { "missing-factory-dependency": "1.0.0" },
		});
		const result = runPreflight(root);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("bun install");
		expect(result.output).not.toMatch(/^[ \t]+at /m);
	});
});

test("resolved dependencies in each workspace pass without stderr", () => {
	withWorkspace((root) => {
		writePackage(join(root, "packages", "first"), {
			name: "first",
			dependencies: { "hoisted-dependency": "1.0.0" },
		});
		writePackage(join(root, "packages", "second"), {
			name: "second",
			dependencies: { "local-dependency": "1.0.0" },
		});
		writePackage(join(root, "node_modules", "hoisted-dependency"), {
			name: "hoisted-dependency",
			version: "1.0.0",
			main: "index.js",
		});
		writeFileSync(
			join(root, "node_modules", "hoisted-dependency", "index.js"),
			"",
		);
		writePackage(
			join(root, "packages", "second", "node_modules", "local-dependency"),
			{
				name: "local-dependency",
				version: "1.0.0",
				main: "index.js",
			},
		);
		writeFileSync(
			join(
				root,
				"packages",
				"second",
				"node_modules",
				"local-dependency",
				"index.js",
			),
			"",
		);
		const result = runPreflight(root);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
});

test("a missing dependency declared by the workspace root is refused with the root named", () => {
	const root = mkdtempSync(join(tmpdir(), "factory-preflight-"));
	try {
		writePackage(root, {
			name: "the-root",
			private: true,
			workspaces: ["packages/*"],
			devDependencies: { "missing-root-dependency": "1.0.0" },
		});
		const result = runPreflight(root);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("missing-root-dependency");
		expect(result.output).toContain("the-root");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
