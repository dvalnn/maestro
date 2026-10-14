import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { parseIr, type WorkerRef } from "./index";

const fixturesDir = `${import.meta.dir}/../fixtures`;
const STDLIB_MODULE = "maestro:stdlib";

async function workerRefs(file: string): Promise<[string, WorkerRef][]> {
	const parsed = parseIr(await Bun.file(`${fixturesDir}/${file}`).json());
	if (!parsed.ok) throw new Error(`${file} is not valid IR`);
	return parsed.ir.nodes.flatMap((node): [string, WorkerRef][] => {
		if (node.kind === "code") return [[`${file} ${node.id}`, node.worker]];
		if (node.kind === "map" && node.key)
			return [[`${file} ${node.id} key`, node.key]];
		return [];
	});
}

const refs = (
	await Promise.all(
		readdirSync(fixturesDir)
			.filter((f) => f.endsWith(".json"))
			.map(workerRefs),
	)
)
	.flat()
	.filter(([, ref]) => ref.module !== STDLIB_MODULE);

test.each(refs)(
	"%s names a module whose hash is its codeHash",
	async (_name, ref) => {
		const bytes = await Bun.file(`${fixturesDir}/${ref.module}`).bytes();
		const hash = createHash("sha256").update(bytes).digest("hex");
		expect(ref.codeHash).toBe(`sha256:${hash}`);

		const exports = await import(`${fixturesDir}/${ref.module}`);
		expect(exports[ref.export]).toBeFunction();
	},
);
