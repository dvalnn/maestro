import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_TYPES, MAESTRO_TYPE } from "@maestro/ir";
import { collectArtifacts, stage, stagedRef } from "./artifacts";

const producer = { node: "n", expansion: "" };
const ports = {
	tree: { [MAESTRO_TYPE]: CORE_TYPES.dir },
	file: { [MAESTRO_TYPE]: CORE_TYPES.file },
};

let root = "";
afterEach(() => rm(root, { recursive: true, force: true }));

async function tree(at: string, text: string) {
	await mkdir(join(at, "sub"), { recursive: true });
	await writeFile(join(at, "sub", "a.txt"), text);
	await symlink("sub/a.txt", join(at, "link"));
	return at;
}

async function collected(scratch: string, outputs: Record<string, unknown>) {
	const area = join(root, "area");
	await mkdir(area, { recursive: true });
	return collectArtifacts(ports, outputs, scratch, area, producer);
}

test("a directory artifact is moved whole and hashed by its entries' names, kinds and contents", async () => {
	root = await mkdtemp(join(tmpdir(), "maestro-artifacts-"));
	const hashOf = async (name: string, text: string) => {
		const scratch = join(root, name);
		const out = await collected(scratch, {
			tree: await tree(join(scratch, "t"), text),
		});
		expect(existsSync(join(scratch, "t"))).toBe(false);
		return out.artifacts[0]?.contentHash;
	};
	const first = await hashOf("one", "same");
	expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
	expect(await hashOf("two", "same")).toBe(first);
	expect(await hashOf("three", "changed")).not.toBe(first);
});

test("an artifact path must resolve inside scratch to the kind of entry its type names, and none moves unless all do", async () => {
	root = await mkdtemp(join(tmpdir(), "maestro-artifacts-"));
	const scratch = join(root, "scratch");
	await tree(join(scratch, "t"), "x");
	await writeFile(join(root, "outside.txt"), "x");
	await symlink(join(root, "outside.txt"), join(scratch, "outward"));
	const fix = "Write it under ctx.scratch and return its absolute path";
	const outward = join(scratch, "outward");
	await expect(collected(scratch, { file: outward })).rejects.toThrow(
		`output 'file' names '${outward}', outside the instance's scratch directory. ${fix}`,
	);
	await expect(
		collected(scratch, { file: join(scratch, "t") }),
	).rejects.toThrow(
		`output 'file' names '${join(scratch, "t")}', which is not a file, as its type '${CORE_TYPES.file}' needs`,
	);
	await expect(
		collected(scratch, { tree: join(scratch, "t"), file: "t/sub/a.txt" }),
	).rejects.toThrow(
		`output 'file' is 't/sub/a.txt', not an absolute path. ${fix}`,
	);
	expect(existsSync(join(scratch, "t"))).toBe(true);
});

test("staging copies a file under its reference, and refuses one changed or gone since its reference was made", async () => {
	root = await mkdtemp(join(tmpdir(), "maestro-artifacts-"));
	const area = join(root, "area");
	const source = join(root, "spec.md");
	await writeFile(source, "v1");
	const staged = {
		source,
		ref: stagedRef("spec.md", new TextEncoder().encode("v1")),
		from: "--spec",
	};
	await stage(area, [staged]);
	const copy = join(area, staged.ref.path);
	expect(await Bun.file(copy).text()).toBe("v1");

	await writeFile(source, "v2");
	await expect(stage(area, [staged])).rejects.toThrow(
		`--spec names '${source}', which changed since the concert was composed. Perform it again`,
	);
	expect(existsSync(copy)).toBe(false);
	await rm(source);
	await expect(stage(area, [staged])).rejects.toThrow(
		`--spec names '${source}', which is gone since the concert was composed`,
	);
});
