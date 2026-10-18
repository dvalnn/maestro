import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import {
	collects,
	type Ir,
	type JsonSchema,
	type Outcome,
	settledSchema,
	worstOutcome,
} from "./index";

const WORST_FIRST: Outcome[] = ["failed", "rejected", "skipped", "ok"];

test("worstOutcome of an empty input is ok", () => {
	expect(worstOutcome([])).toBe("ok");
});

test.each(
	WORST_FIRST.flatMap((a, i) =>
		WORST_FIRST.map((b, j): [Outcome, Outcome, Outcome] => [
			a,
			b,
			WORST_FIRST[Math.min(i, j)] as Outcome,
		]),
	),
)("worstOutcome of %s and %s is %s", (a, b, worst) => {
	expect(worstOutcome([a, b])).toBe(worst);
});

const validate = new Ajv2020({ strict: true }).compile(
	settledSchema({ type: "integer" }),
);

test.each<[string, unknown, boolean]>([
	["ok with a value", { outcome: "ok", value: 1 }, true],
	["rejected with a reason", { outcome: "rejected", reason: "r" }, true],
	[
		"failed with a reason and a value",
		{ outcome: "failed", value: 1, reason: "r" },
		true,
	],
	["skipped with neither", { outcome: "skipped" }, true],
	["ok without a value", { outcome: "ok" }, false],
	["ok with a reason", { outcome: "ok", value: 1, reason: "r" }, false],
	["rejected without a reason", { outcome: "rejected", value: 1 }, false],
	["failed without a reason", { outcome: "failed" }, false],
	["an unknown outcome", { outcome: "lost", value: 1 }, false],
	["an unknown property", { outcome: "ok", value: 1, extra: 1 }, false],
	[
		"a value that violates the value schema",
		{ outcome: "ok", value: "1" },
		false,
	],
])("settledSchema: %s -> %p", (_, settled, valid) => {
	expect(validate(settled)).toBe(valid);
});

const fixturesDir = `${import.meta.dir}/../fixtures`;

/** Map `results` ports and the inputs `collect` edges feed: each holds a list of Settled. */
function settledLists(ir: Ir): JsonSchema[] {
	const results = ir.nodes.flatMap((n) =>
		collects(n) && n.out?.results ? [n.out.results] : [],
	);
	const collected = ir.edges.flatMap((e) => {
		const port =
			e.kind === "collect"
				? ir.nodes.find((n) => n.id === e.to.node)?.in?.[e.to.port]
				: undefined;
		return port === undefined ? [] : [port];
	});
	return [...results, ...collected];
}

test.each(readdirSync(fixturesDir).filter((f) => f.endsWith(".json")))(
	"golden fixture %s declares Settled as settledSchema returns it",
	async (file) => {
		const ir: Ir = await Bun.file(`${fixturesDir}/${file}`).json();
		const lists = settledLists(ir);
		// The fixtures' member result is a record, so T is { type: "object" } (README, Outcomes).
		const settledList = {
			type: "array",
			items: settledSchema({ type: "object" }),
		};
		for (const schema of lists) expect(schema).toEqual(settledList);
		expect(lists.length > 0).toBe(ir.nodes.some(collects));
	},
);
