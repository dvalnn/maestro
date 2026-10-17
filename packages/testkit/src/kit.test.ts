import { expect, test } from "bun:test";
import { code, composition, hostNode, Text } from "@maestro/sdk";
import { buildIr, composeIr, FAKE_TASK, shapeOf, stubConcert } from "./index";

const shout = (inputs: { text: string }) => ({
	text: inputs.text.toUpperCase(),
});

const pipeline = composition("pipeline", { examples: [{}] }, () => {
	const drafted = hostNode(FAKE_TASK, { out: { text: Text() } });
	return code(shout, { in: { text: drafted.out.text }, out: { text: Text() } });
});

test("buildIr and shapeOf report what a composition builds into", () => {
	const ir = buildIr(pipeline, {}, { shout });
	expect(shapeOf(ir)).toEqual({
		nodes: 2,
		kinds: { [FAKE_TASK]: 1, code: 1 },
		edges: { data: 1 },
	});
	expect(ir.nodes.find((n) => n.kind === "code")).toMatchObject({
		worker: { module: "test.ts", export: "shout" },
	});
});

test("composeIr gives the plan's bounds, or the diagnostics that refused the graph", async () => {
	const ir = buildIr(pipeline, {}, { shout });
	const composed = await composeIr(ir);
	expect(composed.ok && composed.plan.bounds.instances).toEqual({ exact: 2 });
	const refused = await composeIr(ir, { hosts: [] });
	expect(refused.ok).toBe(false);
});

test("stubConcert performs the graph with its host node scripted and its code node stubbed", async () => {
	const ir = buildIr(pipeline, {}, { shout });
	const concert = await stubConcert(ir, {
		script: {
			steps: {
				[ir.nodes[0]?.id ?? ""]: [
					{ outcome: "ok", outputs: { text: "hello" } },
				],
			},
		},
		code: { shout },
	});
	try {
		expect(concert.result).toMatchObject({
			outcome: "ok",
			outputs: { text: "HELLO" },
		});
		expect(concert.record.instances(concert.id)).toHaveLength(2);
	} finally {
		await concert.close();
	}
});
