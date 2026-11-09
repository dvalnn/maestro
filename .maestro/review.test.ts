import { expect, test } from "bun:test";
import { classics, maestro } from "./testing/stub";

/** The plan of `file` composed under --preset risky with the packed classics. */
const planOf = async (file: string, ...args: string[]) =>
	JSON.parse(
		await maestro([
			"compose",
			file,
			"--preset",
			"risky",
			"--request",
			"x",
			...args,
			"--json",
			"-c",
			`packs=[${await classics}]`,
		]),
	).plan;

test("review rules on a commit range through the risky slice's lenses, and its consolidator rules by every ground", async () => {
	const review = await planOf(".maestro/review.ts", "--revs", "HEAD^!");
	const slice = await planOf(".maestro/slice.ts", "--tier", "risky");
	expect(review.expansion.lenses).toEqual(slice.expansion.lenses);
	const consolidator = review.ir.nodes.find(
		(n: { id: string }) => n.id === "consolidator",
	);
	for (const ground of [
		"its subject and closing line",
		"A test must pull weight",
	])
		expect(JSON.stringify(consolidator)).toContain(ground);
});
