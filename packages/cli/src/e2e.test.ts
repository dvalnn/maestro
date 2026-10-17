import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanup } from "./fixtures/packs";
import { idOf, json, world } from "./fixtures/world";

afterEach(cleanup);

const ESSAY = join(import.meta.dir, "fixtures/essay.ts");
const TOUR = "release";

test("a journey through the real maestro.ts: compose, perform, fail, resume, list, tour and prune", async () => {
	const w = await world();
	const maestro = async (args: string[]) => {
		const child = w.spawn(args);
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, out: out.trim(), err: err.trim() };
	};

	const graph = await maestro(["compose", ESSAY, "--graph"]);
	expect(graph.code).toBe(0);
	expect(graph.out).toStartWith("flowchart TD");

	const ok = await maestro(["perform", ESSAY]);
	const okId = idOf(ok);
	expect(ok.code).toBe(0);
	expect(ok.err).toContain(`concert ${okId}\n`);
	expect(ok.err).toEndWith(`concert ${okId} ok`);
	expect(ok.out).not.toBe("");

	await Bun.write(join(w.cwd, "dog"), "");
	const broke = await maestro(["perform", ESSAY]);
	const brokeId = idOf(broke);
	expect(broke.code).not.toBe(0);
	expect(broke.err).toMatch(
		new RegExp(`concert ${brokeId} failed at \\S*draft`),
	);

	await rm(join(w.cwd, "dog"));
	expect((await maestro(["perform", "--resume", brokeId])).code).toBe(0);

	const rows = json(await maestro(["ls", "--json"]));
	expect(rows).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: okId, status: "ok" }),
			expect.objectContaining({ id: brokeId, status: "ok" }),
		]),
	);

	expect((await maestro(["tour", TOUR, okId])).code).toBe(0);
	expect((await maestro(["prune", "--tour", TOUR, "--yes"])).code).toBe(0);
	const left = json(await maestro(["ls", "--json"])).map(
		(r: { id: string }) => r.id,
	);
	expect(left).toEqual([brokeId]);
});
