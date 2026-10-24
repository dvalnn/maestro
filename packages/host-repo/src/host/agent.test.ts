import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StubStep } from "../harness/index";
import {
	cleanup,
	configOf,
	irOf,
	OK,
	performed,
	start,
	stubHost,
	toyTarget,
} from "./test-support";

afterEach(cleanup);

const realSetTimeout = globalThis.setTimeout;
const waits: number[] = [];
/** The retry waits kept to run by hand, while holding; else each runs at once. */
let held: (() => void)[] | undefined;
beforeEach(() => {
	waits.length = 0;
	held = undefined;
	globalThis.setTimeout = ((f: () => void, ms?: number) => {
		if (ms === 30_000) {
			waits.push(ms);
			held?.push(f);
			return realSetTimeout(held ? () => {} : f, 0);
		}
		return realSetTimeout(f, ms);
	}) as typeof setTimeout;
});
afterEach(() => {
	globalThis.setTimeout = realSetTimeout;
});

const usage = (tokens_in: number): StubStep => ({
	emit: { type: "usage", tokens_in, tokens_out: 1 },
});
const fault = (transient: boolean): StubStep => ({
	emit: { type: "fault", reason: "529 overloaded", transient },
});

const lone = (host: Parameters<typeof irOf>[0]) =>
	irOf(
		host,
		[
			{
				id: "x",
				kind: "agent",
				config: { role: { name: "builder" }, lane: { mode: "fresh" } },
				literals: { prompt: "go" },
			},
		],
		"x",
	);

async function run(steps: (n: number) => StubStep[]) {
	const { host, requests } = stubHost(() => steps(requests.length));
	const { result, instances } = await performed(
		host,
		lone(host),
		configOf(toyTarget()),
	);
	return { result, metrics: instances[0]?.metrics, requests };
}

describe("agent retry", () => {
	test("a transient failure then success ends ok with every attempt's metrics", async () => {
		const { result, metrics, requests } = await run((n) =>
			n === 1 ? [usage(10), fault(true)] : [usage(5), OK],
		);
		expect(result).toMatchObject({ outcome: "ok" });
		expect(metrics).toEqual({ tokens_in: 15, tokens_out: 2 });
		expect(requests).toHaveLength(2);
		expect(requests[1]?.prompt).toContain("cut off");
		expect(requests[1]?.session).toEqual(requests[0]?.session);
		expect(waits).toHaveLength(1);
	});

	test("transient failures past MAX_RETRIES fail with the attempt count", async () => {
		const { result, metrics, requests } = await run(() => [
			usage(1),
			fault(true),
		]);
		expect(requests).toHaveLength(3);
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "529 overloaded (after 3 attempts)",
		});
		expect(metrics).toMatchObject({ tokens_in: 3 });
	});

	test("a non-transient failure is not retried", async () => {
		const { result, requests } = await run(() => [fault(false)]);
		expect(requests).toHaveLength(1);
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "529 overloaded",
		});
	});

	test("a cancel during the wait ends the node with no retry", async () => {
		held = [];
		const { host, requests } = stubHost(() => [fault(true)]);
		const { concert } = await start(host, lone(host), configOf(toyTarget()));
		while (!waits.length) await Bun.sleep(20);
		await concert.cancel();
		for (const f of held) f();
		expect(await concert.done).toMatchObject({ outcome: "failed" });
		await Bun.sleep(50);
		expect(requests).toHaveLength(1);
	});
});
