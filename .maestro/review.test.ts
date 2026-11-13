import { expect, test } from "bun:test";
import { JUDGED } from "./shared";
import { classics, maestro } from "./testing/stub";

type Node = { id: string; literals?: { floor?: string } };

/** The plan of `.maestro/review.ts` composed under `--preset high` with the packed classics. */
const planOf = async () =>
	JSON.parse(
		await maestro([
			"compose",
			".maestro/review.ts",
			"--preset",
			"high",
			"--request",
			"x",
			"--revs",
			"HEAD^!",
			"--json",
			"-c",
			`packs=[${await classics}]`,
		]),
	).plan;

test("review composes tiered_review at floor large under --preset high, its consolidator ruling by every ground", async () => {
	const { nodes }: { nodes: Node[] } = (await planOf()).ir;
	const byId = (id: string) => nodes.find((n) => n.id === id);
	expect(byId("tiered_review/tieredOf")?.literals?.floor).toBe("large");
	expect(JSON.stringify(byId("tiered_review/consolidator"))).toContain(
		JSON.stringify(JUDGED).slice(1, -1),
	);
});
