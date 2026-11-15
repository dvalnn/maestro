import { afterEach, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const checkouts: string[] = [];

afterEach(() => {
	for (const dir of checkouts.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function put(dir: string, path: string, text: string) {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
}

/** A checkout using the project's recipes, lint configuration, domain-word and prompt-import commands, with real installed tools. */
function checkout(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "justfile-"));
	checkouts.push(dir);
	for (const path of [
		"justfile",
		"biome.json",
		"package.json",
		"lint/cp-links.grit",
		"scripts/domain-words.ts",
		"scripts/prompt-imports.ts",
	]) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		copyFileSync(join(root, path), join(dir, path));
	}
	mkdirSync(join(dir, "packages"));
	put(dir, ".gitignore", "node_modules/\n");
	put(
		dir,
		"tsconfig.json",
		'{"compilerOptions":{"target":"ESNext","module":"ESNext","moduleResolution":"bundler","skipLibCheck":true,"noEmit":true,"types":["bun"]},"include":["sample.ts"]}\n',
	);
	symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
	for (const [path, text] of Object.entries(files)) put(dir, path, text);
	return dir;
}

async function run(dir: string, ...args: string[]) {
	const child = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, out, err };
}

const text = (dir: string, path: string) =>
	readFileSync(join(dir, path), "utf8");
const diagnosticPaths = (output: string) =>
	output.split(/\s+/).flatMap((token) => {
		const location = /^(.+):\d+:\d+$/.exec(token);
		return location ? [location[1]] : [];
	});

const unsorted =
	'import { writeFileSync, readFileSync } from "node:fs";\nexport const files = { writeFileSync, readFileSync };\n';
const sorted =
	'import { readFileSync, writeFileSync } from "node:fs";\nexport const files = { writeFileSync, readFileSync };\n';

test("fmt rewrites code and Markdown without sorting imports or fixing lints", async () => {
	const dir = checkout({
		"sample.ts":
			'import { writeFileSync, readFileSync } from "node:fs";\nexport const files={writeFileSync,readFileSync};\nlet value=1;\nexport {value};\n',
		"sample.md": "#   Heading\n\n* item\n",
	});
	expect((await run(dir, "just", "fmt")).code).toBe(0);
	expect(text(dir, "sample.ts")).toBe(
		`${unsorted}let value = 1;\nexport { value };\n`,
	);
	expect(text(dir, "sample.md")).toBe("# Heading\n\n- item\n");
});

test("lint sorts imports and applies safe fixes without formatting code or Markdown", async () => {
	const dir = checkout({
		"sample.ts":
			'import { writeFileSync, readFileSync } from "node:fs";\nexport const files={writeFileSync,readFileSync};\nlet value = 1;\nexport { value };\n',
		"sample.md": "#   Heading\n",
	});
	expect((await run(dir, "just", "lint")).code).toBe(0);
	expect(text(dir, "sample.ts")).toBe(
		'import { readFileSync, writeFileSync } from "node:fs";\nexport const files={writeFileSync,readFileSync};\nconst value = 1;\n\nexport { value };\n',
	);
	expect(text(dir, "sample.md")).toBe("#   Heading\n");
});

test("lint refuses a remaining Biome error and names its path", async () => {
	const dir = checkout({
		"sample.ts": 'import { value } from "@maestro/cli";\nexport { value };\n',
	});
	const result = await run(dir, "just", "lint");
	expect(result.code).not.toBe(0);
	expect(diagnosticPaths(`${result.out}\n${result.err}`)).toContain(
		"sample.ts",
	);
});

test("lint reports a remaining Biome warning but passes", async () => {
	const dir = checkout({ "sample.ts": "export const value: any = 1;\n" });
	const result = await run(dir, "just", "lint");
	expect(result.code).toBe(0);
	expect(diagnosticPaths(`${result.out}\n${result.err}`)).toContain(
		"sample.ts",
	);
	expect(text(dir, "sample.ts")).toBe("export const value: any = 1;\n");
});

test("lint also refuses domain words and names their path", async () => {
	const dir = checkout({ "packages/core/src/sample.ts": "// lane\n" });
	const result = await run(dir, "just", "lint");
	expect(result.code).not.toBe(0);
	expect(
		result.err.split("\n").map((line) => line.trim().split(":")[0]),
	).toContain("packages/core/src/sample.ts");
});

test("check formats and fixes lints before types, then runs both test suites", async () => {
	const dir = checkout({
		"sample.ts": `${unsorted}let value=1;\nexport {value};\n`,
		"sample.md": "#   Heading\n",
		"sample.test.ts":
			'import { expect, test } from "bun:test";\nimport { readFileSync, writeFileSync } from "node:fs";\ntest("rewritten inputs reach tests", () => {\nexpect(readFileSync("sample.md", "utf8")).toBe("# Heading\\n");\nexpect(readFileSync("sample.ts", "utf8")).toBe(\'import { readFileSync, writeFileSync } from "node:fs";\\nexport const files = { writeFileSync, readFileSync };\\nconst value = 1;\\n\\nexport { value };\\n\');\nwriteFileSync("tested", "yes");\n});\n',
		".maestro/sample.test.ts":
			'import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("hidden suite", () => { writeFileSync("hidden-tested", "yes"); });\n',
	});
	expect((await run(dir, "just", "check")).code).toBe(0);
	expect(text(dir, "tested")).toBe("yes");
	expect(text(dir, "hidden-tested")).toBe("yes");
});

test("check stops at a type failure after formatting and lint fixes, before tests", async () => {
	const dir = checkout({
		"sample.ts": `${unsorted}let value: string=1;\nexport {value};\n`,
		"sample.md": "# Heading\n",
		"sample.test.ts":
			'import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("must not run", () => { writeFileSync("tested", "yes"); });\n',
	});
	const result = await run(dir, "just", "check");
	expect(result.code).not.toBe(0);
	expect(text(dir, "sample.ts")).toBe(
		`${sorted}const value: string = 1;\n\nexport { value };\n`,
	);
	expect(`${result.out}\n${result.err}`.split(/\s+/)).toContain("TS2322:");
	expect(existsSync(join(dir, "tested"))).toBe(false);
});

test("check stops at a lint error after formatting, before types and tests", async () => {
	const dir = checkout({
		"sample.ts":
			'import { value } from "@maestro/cli";\nexport {value};\nexport const broken: string = 1;\n',
		"sample.md": "# Heading\n",
		"sample.test.ts":
			'import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("must not run", () => { writeFileSync("tested", "yes"); });\n',
	});
	const result = await run(dir, "just", "check");
	expect(result.code).not.toBe(0);
	expect(text(dir, "sample.ts")).toBe(
		'import { value } from "@maestro/cli";\n\nexport { value };\nexport const broken: string = 1;\n',
	);
	expect(diagnosticPaths(`${result.out}\n${result.err}`)).toContain(
		"sample.ts",
	);
	expect(`${result.out}\n${result.err}`.split(/\s+/)).not.toContain("TS2322:");
	expect(existsSync(join(dir, "tested"))).toBe(false);
});

test("check refuses a shared module's composition-owned prompt import and names both files", async () => {
	const dir = checkout({
		"sample.ts": "export const value = 1;\n",
		".maestro/shared.ts":
			'import grounds from "./slice/prompts/_grounds.md" with { type: "text" };\nexport { grounds };\n',
		".maestro/slice.ts": "export const slice = {};\n",
		".maestro/slice/prompts/_grounds.md": "Fixture grounds.\n",
		"sample.test.ts":
			'import { test } from "bun:test";\n\ntest("passes", () => {});\n',
		".maestro/sample.test.ts":
			'import { test } from "bun:test";\n\ntest("passes", () => {});\n',
	});
	const result = await run(dir, "just", "check");
	expect(result.code).not.toBe(0);
	const paths = `${result.out}\n${result.err}`.split(/[\s`"'():,]+/);
	expect(paths).toContain(".maestro/shared.ts");
	expect(paths).toContain(".maestro/slice/prompts/_grounds.md");
});

test("check stops at a formatter failure, before lint fixes", async () => {
	const dir = checkout({
		"sample.ts": `${unsorted}let value = 1;\nexport { value };\n`,
		"broken.ts": "export const = ;\n",
		"sample.md": "# Heading\n",
	});
	const result = await run(dir, "just", "check");
	expect(result.code).not.toBe(0);
	expect(text(dir, "sample.ts")).toBe(
		`${unsorted}let value = 1;\nexport { value };\n`,
	);
});

test("check stops at a failing first test suite, before the .maestro suite", async () => {
	const dir = checkout({
		"sample.ts": "export const value = 1;\n",
		"sample.md": "# Heading\n",
		"sample.test.ts":
			'import { expect, test } from "bun:test";\n\ntest("fails", () => {\n\texpect(1).toBe(2);\n});\n',
		".maestro/sample.test.ts":
			'import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\n\ntest("hidden suite", () => {\n\twriteFileSync("hidden-tested", "yes");\n});\n',
	});
	const result = await run(dir, "just", "check");
	expect(result.code).not.toBe(0);
	expect(existsSync(join(dir, "hidden-tested"))).toBe(false);
});

test("the check-only format command is not offered", async () => {
	const dir = checkout({});
	expect(
		(await run(dir, "just", "--summary")).out.trim().split(/\s+/),
	).not.toContain("format");
	expect((await run(dir, "just", "format")).code).not.toBe(0);
});

async function committed(dir: string) {
	for (const args of [
		["init", "-q"],
		["add", "."],
		[
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.org",
			"commit",
			"-qm",
			"fixture",
		],
	])
		expect((await run(dir, "git", ...args)).code).toBe(0);
}

test("ci passes an unchanged checkout and refuses tracked rewrites and new files, naming each path", async () => {
	const dir = checkout({
		"sample.ts": "export const value = 1;\n",
		"sample.md": "# Heading\n",
		"sample.test.ts":
			'import { test } from "bun:test";\n\ntest("passes", () => {});\n',
		".maestro/sample.test.ts":
			'import { test } from "bun:test";\n\ntest("passes", () => {});\n',
	});
	expect((await run(dir, "just", "fmt")).code).toBe(0);
	const checked = await run(dir, "just", "check");
	expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
	await committed(dir);
	expect((await run(dir, "just", "ci")).code).toBe(0);
	put(dir, "sample.md", "#   Heading\n");
	await committed(dir);
	const rewritten = await run(dir, "just", "ci");
	expect(rewritten.code).not.toBe(0);
	expect(`${rewritten.out}\n${rewritten.err}`.split(/\s+/)).toContain(
		"sample.md",
	);
	expect(text(dir, "sample.md")).toBe("# Heading\n");
	put(
		dir,
		"sample.test.ts",
		'import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\n\ntest("adds a file", () => { writeFileSync("new-file.txt", "new\\n"); });\n',
	);
	expect((await run(dir, "just", "fmt")).code).toBe(0);
	await committed(dir);
	expect((await run(dir, "git", "status", "--porcelain")).out).toBe("");
	const added = await run(dir, "just", "ci");
	expect(added.code).not.toBe(0);
	expect(`${added.out}\n${added.err}`.split(/\s+/)).toContain("new-file.txt");
});

test("the Forgejo and GitHub workflows both run the ci recipe and define no tree gate of their own", () => {
	for (const workflow of [
		".forgejo/workflows/check.yml",
		".github/workflows/check.yml",
	]) {
		const steps = (
			Bun.YAML.parse(text(root, workflow)) as {
				jobs: { check: { steps: { run?: string }[] } };
			}
		).jobs.check.steps.flatMap((step) => (step.run ? [step.run] : []));
		expect(
			steps.filter((run) => /(^|\s)just ci$/.test(run.trim())),
			workflow,
		).toHaveLength(1);
		expect(
			steps.filter((run) => /\bjust check\b|\bgit (status|diff)\b/.test(run)),
			workflow,
		).toEqual([]);
	}
});
