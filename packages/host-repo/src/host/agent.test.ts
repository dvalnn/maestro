import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { StubStep } from "../harness/index";
import { concertUsage, releaseConcert } from "./store";
import {
	cleanup,
	configOf,
	irOf,
	type NodeSpec,
	OK,
	performed,
	reply,
	sandboxed,
	setupOf,
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

describe("agent session directory", () => {
	const agent = (
		id: string,
		config: Record<string, unknown>,
		lane?: string,
	): NodeSpec => ({
		id,
		kind: "agent",
		config: { role: { name: "builder" }, lane: config },
		literals: { prompt: "go" },
		...(lane && { lane }),
	});

	test("the enrichment names the host directory of a minted session and of a resumed one", async () => {
		const { host, requests } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				agent("w", { mode: "fresh" }),
				agent("r", { mode: "extend", resume: true }, "w"),
			],
			"r",
		);
		const { instances } = await performed(host, ir, configOf(toyTarget()));
		const dirOf = (node: string) =>
			instances.find((i) => i.node === node)?.enrichment?.sessionDir;
		const minted = requests[0]?.session;
		expect(requests[1]?.session.id).toBe(minted?.id);
		expect(dirOf("w")).toBe(minted?.dir);
		expect(dirOf("r")).toBe(minted?.dir);
		expect(minted?.dir).toEndWith(`sessions/${minted?.id}/home`);
		expect(isAbsolute(minted?.dir ?? "")).toBe(true);
	});
});

describe("agent partial work", () => {
	const edit = (content: string): StubStep => ({
		write: "a.txt",
		content,
	});

	/** Runs the lone agent on `steps`, resuming concert `resume` when given. */
	async function attempt(
		steps: (n: number) => StubStep[],
		config: ReturnType<typeof configOf>,
		resume?: string,
	) {
		const { host, requests } = stubHost(() => steps(requests.length));
		const done = await performed(host, lone(host), config, resume);
		return { ...done, requests };
	}

	const partialOf = (instances: { enrichment?: Record<string, unknown> }[]) =>
		instances[0]?.enrichment?.partial;

	const patchesOf = (dir: unknown) =>
		readdirSync(String(dir))
			.filter((f) => f.endsWith(".patch"))
			.map((f) => readFileSync(join(String(dir), f), "utf8"))
			.join("");

	test.each([
		["a harness failure", [edit("lost\n"), fault(false)]],
		[
			"a blocked reply",
			[edit("lost\n"), reply({ blocked: "no", report: "x" })],
		],
	])(
		"%s keeps the lane's changes as a changeset outside the lane chain",
		async (_, steps) => {
			const config = configOf(toyTarget());
			const { result, instances, id } = await attempt(() => steps, config);
			expect(result).toMatchObject({ outcome: "failed" });
			const partial = partialOf(instances);
			expect(isAbsolute(String(partial))).toBe(true);
			expect(String(partial)).toContain(setupOf(config).store);
			expect(readFileSync(join(String(partial), "base"), "utf8")).toMatch(
				/^[0-9a-f]{40}\n$/,
			);
			expect(existsSync(join(String(partial), "message"))).toBe(false);
			expect(patchesOf(partial)).toContain("+lost");
			expect(instances[0]?.outputs?.lane).toBeUndefined();
			const store = setupOf(config).store;
			const used = await concertUsage(store, id);
			rmSync(String(partial), { recursive: true });
			expect(await concertUsage(store, id)).toBeLessThan(used);
		},
	);

	test("a cancel keeps the changes made so far", async () => {
		const config = configOf(toyTarget());
		const { host, requests } = stubHost(() => [edit("lost\n"), { hang: true }]);
		const { concert, recordPath } = await start(host, lone(host), config);
		const { openRecord } = await import("@maestro/core/perform");
		const partial = () => {
			const record = openRecord(recordPath);
			const found = record.instances(concert.id)[0]?.enrichment?.partial;
			record.close();
			return found;
		};
		while (!requests.length) await Bun.sleep(20);
		while (!sandboxed().length) await Bun.sleep(20);
		await Bun.sleep(300);
		await concert.cancel();
		expect(await concert.done).toMatchObject({ outcome: "failed" });
		expect(patchesOf(partial())).toContain("+lost");
	});

	test("an unchanged lane keeps nothing, and neither does an ok agent", async () => {
		const config = configOf(toyTarget());
		const failed = await attempt(() => [fault(false)], config);
		expect(partialOf(failed.instances)).toBeUndefined();
		const ok = await attempt(() => [edit("kept\n"), OK], configOf(toyTarget()));
		expect(ok.result).toMatchObject({ outcome: "ok" });
		expect(partialOf(ok.instances)).toBeUndefined();
	});

	test("a re-run starts from its input and leaves the partial, a later failed run replaces it, and prune removes it", async () => {
		const config = configOf(toyTarget());
		const first = await attempt(() => [edit("first\n"), fault(false)], config);
		const partial = String(partialOf(first.instances));
		const again = await attempt(
			(n) =>
				n === 1
					? [
							{ sh: "! grep -q first /lane/a.txt || touch /lane/leaked" },
							fault(false),
						]
					: [OK],
			config,
			first.id,
		);
		expect(again.result).toMatchObject({ outcome: "failed" });
		expect(patchesOf(partial)).toContain("+first");
		expect(patchesOf(partial)).not.toContain("leaked");
		const second = await attempt(
			() => [edit("second\n"), fault(false)],
			config,
			first.id,
		);
		expect(partialOf(second.instances)).toBe(partial);
		expect(patchesOf(partial)).toContain("+second");
		expect(patchesOf(partial)).not.toContain("+first");
		await releaseConcert(setupOf(config).store, first.id);
		expect(existsSync(partial)).toBe(false);
	});
});
