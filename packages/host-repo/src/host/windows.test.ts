import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepWindow, windowOf } from "./windows";

const stores: string[] = [];
const store = () => {
	const dir = mkdtempSync(join(tmpdir(), "windows-"));
	stores.push(dir);
	return dir;
};
afterEach(() => {
	for (const d of stores.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = (harness: string, model: string) => ({ harness, model });

test("a window is read back by harness and model, and no inherited or malformed entry is one", () => {
	const dir = store();
	keepWindow(dir, at("pi", "m"), 200_000);
	expect(windowOf(dir, at("pi", "m"))).toBe(200_000);
	expect(windowOf(dir, at("pi", "constructor"))).toBeUndefined();
	expect(windowOf(dir, at("constructor", "name"))).toBeUndefined();
	expect(windowOf(dir, at("pi", "__proto__"))).toBeUndefined();

	for (const text of [
		"{not json",
		"[1]",
		'{"pi":[1]}',
		'{"pi":{"m":-1}}',
		'{"pi":{"m":1.5}}',
		'{"pi":{"m":"9"}}',
	]) {
		writeFileSync(join(dir, "windows.json"), text);
		expect(windowOf(dir, at("pi", "m"))).toBeUndefined();
	}
});
