import { afterEach, expect, test } from "bun:test";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mapWorkers } from "@maestro/ir";
import { STDLIB_MODULE } from "@maestro/sdk/loader";
import { cleanup, FIXTURES, scratch } from "./fixtures/packs";
import { codeHashOf, moduleLoader, openFile } from "./loader";
import { type Prepared, persist } from "./prepare";

afterEach(cleanup);

test("persist writes the text its IR's codeHash names, though the file changed after loading", async () => {
	const src = await scratch();
	await cp(FIXTURES, src, { recursive: true, verbatimSymlinks: true });
	const file = join(src, "hello.ts");
	const bundle = await openFile(file);
	const loaded = bundle.text ?? "";
	const built = bundle.build("hello", {});
	if (!built.ok) throw new Error("hello does not build");
	await writeFile(
		file,
		`${await readFile(file, "utf8")}\nexport const drift = 1;\n`,
	);
	const out = await scratch();
	const prepared = {
		ir: built.ir,
		loader: moduleLoader(src),
		moduleDir: src,
		file,
		text: bundle.text,
	} as Prepared;
	const saved = await persist(prepared, out, "hello.bundle.js");
	const written = await readFile(join(out, "hello.bundle.js"), "utf8");
	expect(written).toBe(loaded);
	const hashes: string[] = [];
	mapWorkers(saved.ir, (ref) => {
		if (ref.module !== STDLIB_MODULE) hashes.push(ref.codeHash);
		return ref;
	});
	expect(hashes.length).toBeGreaterThan(0);
	for (const hash of hashes) expect(hash).toBe(codeHashOf(written));
});
