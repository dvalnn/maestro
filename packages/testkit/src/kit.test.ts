import { expect, test } from "bun:test";
import { code, composition, Text } from "@maestro/sdk";
import { hostNode } from "@maestro/sdk/host";
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
	const limited = await composeIr(ir, {
		config: {
			values: {
				concurrency: 2,
				caps: {},
				dataRoot: "/data",
				workspace: "",
			},
			sources: [],
		},
	});
	expect(limited.ok).toBe(true);
});

test("buildIr refuses a composition that keeps state between builds", () => {
	let calls = 0;
	const drifting = composition("drift", { examples: [{}] }, () => {
		calls++;
		return hostNode(FAKE_TASK, { out: { n: Text() }, config: { calls } });
	});
	expect(() => buildIr(drifting)).toThrow(/two builds/);
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

test("stubConcert takes a script or hosts, and code or a loader, never both", async () => {
	const ir = buildIr(pipeline, {}, { shout });
	await expect(
		// @ts-expect-error a script scripts the fake host, which given hosts replace.
		stubConcert(ir, { script: {}, hosts: [] }),
	).rejects.toThrow("stubConcert takes script or hosts, not both");
	await expect(
		// @ts-expect-error code stubs load by export name, which a loader replaces.
		stubConcert(ir, { code: {}, loadCode: async () => () => ({}) }),
	).rejects.toThrow("stubConcert takes code or loadCode, not both");
});
