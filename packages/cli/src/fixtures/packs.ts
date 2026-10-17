import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SDK_VERSION } from "@maestro/sdk/loader";
import { bundled } from "../loader";

export const FIXTURES = import.meta.dir;
export const DEMO = join(FIXTURES, "demo");
const ENTRY = "index.js";

const cleanups: string[] = [];

/** A temporary directory, removed by `cleanup`. */
export async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "maestro-cli-"));
	cleanups.push(dir);
	return dir;
}

export async function cleanup() {
	for (const dir of cleanups.splice(0))
		await rm(dir, { recursive: true, force: true });
}

/** A copy of the `demo` pack's source with `edit` applied to its `index.ts`. */
export async function demoSource(edit: (text: string) => string = (t) => t) {
	const dir = await scratch();
	await cp(DEMO, dir, { recursive: true });
	const index = join(dir, "index.ts");
	await Bun.write(index, edit(await Bun.file(index).text()));
	return dir;
}

/** Builds the pack whose entry source is `source` into `dir`, with a manifest of `over` on the defaults. */
export async function packOf(
	source: string,
	dir: string,
	over: Record<string, unknown> = {},
): Promise<string> {
	await Bun.write(join(dir, ENTRY), await bundled(source));
	const manifest = {
		id: "demo",
		version: "1.0.0",
		entry: ENTRY,
		sdk: `^${SDK_VERSION}`,
		...over,
	};
	await Bun.write(join(dir, "maestro-pack.json"), JSON.stringify(manifest));
	return dir;
}
