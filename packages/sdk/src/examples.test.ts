import { describe, expect, test } from "bun:test";
import { buildValid, nodeOf } from "./fixtures/context";
import { escalate, fanout, planPanel } from "./fixtures/examples";

// sdk-spec 14, with the fake host kind standing in for host nodes.
describe("worked examples", () => {
	test("escalate is a seq over models that stops at the first green", () => {
		const ir = buildValid(escalate);
		expect(nodeOf(ir, "seq")).toMatchObject({
			cardinality: { upTo: 2 },
			members: { result: "seq/fix_until_green/repeat" },
			until: { node: "seq/fix_until_green/repeat", port: "ok" },
		});
		expect(nodeOf(ir, "seq/fix_until_green/repeat")).toMatchObject({
			cardinality: { upTo: 2 },
			tolerate: "rejected",
			until: { node: "seq/fix_until_green/repeat/check", port: "ok" },
		});
		expect(ir.result).toEqual({ rule: "default" });
	});

	test("fan-out maps over models and keeps the first green", () => {
		const ir = buildValid(fanout, { models: ["a", "b", "c"] });
		expect(nodeOf(ir, "map")).toMatchObject({ cardinality: { exact: 3 } });
		expect(ir.result).toEqual({ rule: "node", node: "firstOk" });
	});

	test("plan-panel falls back from the synthesis to the first good plan", () => {
		const ir = buildValid(planPanel);
		expect(ir.edges).toContainEqual({
			kind: "control",
			from: { node: "renderOk", port: "nonEmpty" },
			to: { node: "synthesis" },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "synthesis", port: "text" },
			to: { node: "answer", port: "in0" },
		});
		expect(ir.edges).toContainEqual({
			kind: "data",
			from: { node: "firstOk_result_text", port: "value" },
			to: { node: "answer", port: "in1" },
		});
		expect(ir.result).toEqual({ rule: "node", node: "answer" });
	});
});
