import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { pack } from "./pack";

// Inside the checkout, so the bundler resolves the SDK the glue imports.
const root = mkdtempSync(join(import.meta.dir, ".pack-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the profiles a pack ships keep the text of each link", async () => {
	const dir = join(root, "linked");
	const write = (path: string, text: string) =>
		Bun.write(join(dir, path), text);
	await Promise.all([
		write("src/index.ts", "export {};\n"),
		write("README.md", "# linked\n"),
		write("package.json", '{ "version": "0.1.0" }\n'),
		write("profiles/kit/profile.yaml", "harnessExtras: extras\n"),
		write("profiles/kit/extras/models.json", "{}\n"),
	]);
	mkdirSync(join(dir, "profiles/kit/extras/lib"));
	symlinkSync(
		"../models.json",
		join(dir, "profiles/kit/extras/lib/models.json"),
	);

	const out = await pack(dir, join(root, "dist"));

	expect(readlinkSync(join(out, "profiles/kit/extras/lib/models.json"))).toBe(
		"../models.json",
	);
});
