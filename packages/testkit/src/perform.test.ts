import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Execution, Host, HostInstance } from "@maestro/core/host";
import {
	type InstanceRecord,
	openRecord,
	type PerformOptions,
	perform,
	type RecordStore,
} from "@maestro/core/perform";
import type { CodeFunction, LoadCode } from "@maestro/core/worker";
import {
	type ArtifactRef,
	CORE_TYPES,
	type CodeContext,
	type CodeNode,
	IR_VERSION,
	type Ir,
	type IrEdge,
	type IrNode,
	MAESTRO_TYPE,
	parseIr,
	reject,
	type Settled,
	type WorkerRef,
} from "@maestro/ir";
import { partKey, summarize } from "../../ir/fixtures/guards";
import { isDone } from "../../ir/fixtures/refine";
import { FAKE_TASK, type FakeScript, fakeHost } from "./index";

const FIXTURES = join(import.meta.dir, "../../ir/fixtures");
const STRING = { type: "string" };
const CANCELLED_CONCERT = "the concert was cancelled";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A temporary directory for one test's record store and concert directories. */
async function workspace() {
	const dir = await mkdtemp(join(tmpdir(), "maestro-perform-"));
	const records: RecordStore[] = [];
	cleanups.push(async () => {
		for (const r of records) r.close();
		await rm(dir, { recursive: true, force: true });
	});
	const open = () => {
		const record = openRecord(join(dir, "record.db"));
		records.push(record);
		return record;
	};
	return { dir, open };
}

type Fn = (inputs: never, context: CodeContext) => unknown;

/** Resolves a worker reference by its export name alone. */
const loader =
	(fns: Readonly<Record<string, Fn>>): LoadCode =>
	async (ref) => {
		const fn = fns[ref.export];
		if (!fn) throw new Error(`no fixture function '${ref.export}'`);
		return fn as CodeFunction;
	};

async function play(
	ir: Ir,
	options: {
		script?: FakeScript;
		hosts?: Host[];
		code?: Readonly<Record<string, Fn>>;
		concurrency?: number;
		record?: RecordStore;
		dir?: string;
	} = {},
) {
	const space = options.dir ? undefined : await workspace();
	const record = options.record ?? space?.open();
	const dir = options.dir ?? space?.dir;
	if (!record || !dir) throw new Error("give both record and dir, or neither");
	const performOptions: PerformOptions = {
		ir,
		hosts: options.hosts ?? [fakeHost(options.script)],
		loadCode: loader(options.code ?? {}),
		record,
		dir,
		concurrency: options.concurrency ?? 4,
	};
	const performance = perform(performOptions);
	const result = await performance.done;
	return { ...performance, result, record, dir };
}

const fixture = async (name: string) =>
	checked(await Bun.file(join(FIXTURES, name)).json());

function checked(value: unknown): Ir {
	const parsed = parseIr(value);
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics, null, 2));
	return parsed.ir;
}

const graph = (
	nodes: IrNode[],
	edges: IrEdge[],
	result: string,
	composition = "probe",
): Ir =>
	checked({
		irVersion: IR_VERSION,
		composition: { id: composition, version: "0.1.0", pack: "tests" },
		emitter: { name: "hand", version: "1" },
		params: { schema: { type: "object" }, examples: [{}] },
		scopes: [],
		nodes,
		edges,
		result: { node: result },
	});

const worker = (name: string): WorkerRef => ({
	runtime: "ts",
	module: "fixture.ts",
	export: name,
	codeHash: `sha256:${"0".repeat(64)}`,
});

const task = (
	id: string,
	ports: Pick<IrNode, "in" | "out" | "literals"> = {},
): IrNode => ({ id, kind: FAKE_TASK, ...ports });

const code = (
	id: string,
	name: string,
	ports: Pick<IrNode, "in" | "out" | "literals"> = {},
	pure = false,
): CodeNode => ({ id, kind: "code", worker: worker(name), pure, ...ports });

const data = (from: string, to: string): IrEdge => {
	const [fromNode = "", fromPort = ""] = from.split(".");
	const [toNode = "", toPort = ""] = to.split(".");
	return {
		kind: "data",
		from: { node: fromNode, port: fromPort },
		to: { node: toNode, port: toPort },
	};
};

const settledList = {
	type: "array",
	items: { type: "object", required: ["outcome"] },
};

const byInstance = (instances: InstanceRecord[]) =>
	Object.fromEntries(instances.map((i) => [`${i.node}${i.expansion}`, i]));

type MemberValue = { result: { text: string } };

/** The fixture's `merge`, reading member results as records by result name (ADR 0004). */
function merge(ports: { parts: Settled<MemberValue>[]; separator: string }) {
	const texts = ports.parts.flatMap((p) =>
		p.outcome === "ok" && p.value.result.text ? [p.value.result.text] : [],
	);
	return { text: texts.join(ports.separator), nonEmpty: texts.length > 0 };
}

/** A promise that settles once `count` calls to `arrive` have been made. */
function barrier(count: number) {
	const all = Promise.withResolvers<void>();
	let arrived = 0;
	return {
		arrive: () => {
			if (++arrived === count) all.resolve();
		},
		all: all.promise,
	};
}

const pending = () => new Promise<Execution>(() => {});

test("a map fans out, a reducer fans in over its settled members, and a repeat carries state to its bound", async () => {
	const drafts: unknown[] = [];
	const prompts: unknown[] = [];
	const { result, record, concert } = await play(
		await fixture("fanout-fanin-loop.json"),
		{
			script: {
				steps: {
					"topics/draft": (_, inputs) =>
						inputs.prompt === "beta"
							? { outcome: "rejected", reason: "off topic" }
							: { outcome: "ok", outputs: { text: `${inputs.prompt} draft` } },
					"refine/loop/step": (_, inputs) => {
						prompts.push(inputs.prompt);
						return { outcome: "ok", outputs: { text: `${inputs.prompt}+` } };
					},
				},
			},
			code: {
				isDone,
				firstOk: (ports: { drafts: Settled<MemberValue>[] }) => {
					drafts.push(...ports.drafts);
					const first = ports.drafts.find((d) => d.outcome === "ok");
					return first?.outcome === "ok"
						? { text: first.value.result.text }
						: reject("no draft");
				},
			},
		},
	);
	expect(drafts).toEqual([
		{ outcome: "ok", value: { result: { text: "alpha draft" } } },
		{ outcome: "rejected", reason: "off topic" },
		{ outcome: "ok", value: { result: { text: "gamma draft" } } },
	]);
	expect(prompts).toEqual(["alpha draft", "alpha draft+"]);
	expect(result).toEqual({
		node: "refine/loop",
		expansion: "",
		outcome: "ok",
		outputs: { text: "alpha draft++" },
	});
	const instances = byInstance(record.instances(concert));
	expect(Object.keys(instances)).toContain("refine/loop/step[1]");
	expect(Object.keys(instances)).not.toContain("refine/loop/step[2]");
	expect(instances["topics/draft[beta]"]?.status).toBe("rejected");
});

test("a repeat that tolerates rejected carries a rejected iteration into one that is accepted", async () => {
	const { result, record, concert } = await play(
		await fixture("fanout-fanin-loop.json"),
		{
			script: {
				steps: {
					"refine/loop/step": [
						{
							outcome: "rejected",
							reason: "rough",
							outputs: { text: "rough" },
						},
						{ outcome: "ok", outputs: { text: "smooth." } },
					],
				},
			},
			code: {
				isDone,
				firstOk: () => ({ text: "alpha" }),
			},
		},
	);
	expect(result).toMatchObject({
		node: "refine/loop",
		outcome: "ok",
		outputs: { text: "smooth." },
	});
	const steps = record
		.instances(concert)
		.filter((i) => i.node === "refine/loop/step")
		.map((i) => [i.expansion, i.status]);
	expect(steps).toEqual([
		["[0]", "rejected"],
		["[1]", "ok"],
	]);
});

/** A `repeat` fed by `seed`, its step reading the state's `text`. */
const loopGraph = (tolerate: boolean) =>
	graph(
		[
			task("seed", { out: { text: STRING } }),
			{
				id: "loop",
				kind: "repeat",
				cardinality: { upTo: 3 },
				...(tolerate && { tolerate: "rejected" as const }),
				in: { text: STRING },
				inner: { index: { type: "integer" }, text: STRING },
				out: { text: STRING },
				members: { result: "loop/step" },
			},
			task("loop/step", { in: { prompt: STRING }, out: { text: STRING } }),
		],
		[data("seed.text", "loop.text"), data("loop.text", "loop/step.prompt")],
		"loop",
	);

test("a repeat stops at a rejected iteration it does not tolerate", async () => {
	const { result, record, concert } = await play(loopGraph(false), {
		script: {
			steps: {
				seed: [{ outcome: "ok", outputs: { text: "seed" } }],
				"loop/step": [{ outcome: "rejected", reason: "stuck" }],
			},
		},
	});
	expect(result).toEqual({
		node: "loop/step",
		expansion: "[0]",
		outcome: "rejected",
		reason: "stuck",
	});
	expect(
		record.instances(concert).filter((i) => i.node === "loop/step"),
	).toHaveLength(1);
});

test("a repeat that tolerates rejected starts from rejected state and carries it to its bound", async () => {
	const prompts: unknown[] = [];
	const { result } = await play(loopGraph(true), {
		script: {
			steps: {
				seed: [
					{ outcome: "rejected", reason: "rough", outputs: { text: "seed" } },
				],
				"loop/step": (_, inputs) => {
					prompts.push(inputs.prompt);
					return prompts.length === 1
						? {
								outcome: "rejected",
								reason: "stuck",
								outputs: { text: "again" },
							}
						: { outcome: "ok", outputs: { text: "done" } };
				},
			},
		},
	});
	expect(prompts).toEqual(["seed", "again", "done"]);
	expect(result).toMatchObject({
		node: "loop",
		outcome: "ok",
		outputs: { text: "done" },
	});
});

test("a seq escalates through its items until one settles ok, after a map keyed by its key function", async () => {
	const sizes: unknown[] = [];
	const { result, record, concert } = await play(
		await fixture("guards-and-escalation.json"),
		{
			script: {
				steps: {
					"each/work": (_, inputs) => ({
						outcome: "ok",
						outputs: { text: `${inputs.prompt}` },
					}),
					"escalate/try": (_, inputs) => {
						sizes.push(inputs.size);
						return inputs.size === "small"
							? { outcome: "rejected", reason: "too small" }
							: {
									outcome: "ok",
									outputs: { text: `${inputs.size}: ${inputs.prompt}` },
								};
					},
				},
			},
			code: {
				plan: () => ({ parts: ["intro", "body"] }),
				partKey: (item: string) => `p-${item}`,
				merge,
				summarize,
			},
		},
	);
	expect(sizes).toEqual(["small", "medium"]);
	expect(result).toEqual({
		node: "summary",
		expansion: "",
		outcome: "ok",
		outputs: { summary: "medium: intro\nbody" },
	});
	const instances = byInstance(record.instances(concert));
	expect(instances["escalate/try[0]"]?.status).toBe("rejected");
	expect(instances.gate?.status).toBe("ok");
	expect(Object.keys(instances)).toContain("each/work[p-intro]");
});

test("propagate cancels the running members of a map as skipped, and the result names the failed member", async () => {
	const others = barrier(2);
	const { result, record, concert } = await play(
		await fixture("guards-and-escalation.json"),
		{
			script: {
				steps: {
					"each/work": (_, inputs) => {
						if (inputs.prompt !== "body") {
							others.arrive();
							return pending();
						}
						return others.all.then(() => ({
							outcome: "failed",
							reason: "broke",
						}));
					},
				},
			},
			code: {
				plan: () => ({ parts: ["intro", "body", "outro"] }),
				partKey,
				merge,
				summarize,
			},
		},
	);
	const instances = byInstance(record.instances(concert));
	for (const key of ["each/work[intro]", "each/work[outro]"]) {
		expect(instances[key]?.startedAt).toBeNumber();
		expect(instances[key]).toMatchObject({
			status: "skipped",
			reason: "cancelled: each[body]/work failed",
		});
	}
	expect(instances.each).toMatchObject({ status: "failed", reason: "broke" });
	expect(instances.summary?.status).toBe("skipped");
	expect(result).toEqual({
		node: "each/work",
		expansion: "[body]",
		outcome: "failed",
		reason: "broke",
	});
});

test("a fan-in node takes each data input settled, whatever its outcome", async () => {
	const seen: unknown[] = [];
	const { result } = await play(
		graph(
			[
				task("good", { out: { text: STRING } }),
				task("bad", { out: { text: STRING } }),
				{
					...code("pick", "pick", { in: { a: true, b: true } }, true),
					fanin: true,
				},
			],
			[data("good.text", "pick.a"), data("bad.text", "pick.b")],
			"pick",
		),
		{
			script: {
				steps: {
					good: [{ outcome: "ok", outputs: { text: "fine" } }],
					bad: [{ outcome: "rejected", reason: "poor" }],
				},
			},
			code: {
				pick: (ports: unknown) => {
					seen.push(ports);
					return {};
				},
			},
		},
	);
	expect(seen).toEqual([
		{
			a: { outcome: "ok", value: "fine" },
			b: { outcome: "rejected", reason: "poor" },
		},
	]);
	expect(result.outcome).toBe("ok");
});

test("a guard that is not true skips its node, and the result counts that as rejected", async () => {
	const { result } = await play(await fixture("guards-and-escalation.json"), {
		script: {
			steps: { "each/work": [{ outcome: "ok", outputs: { text: "" } }] },
		},
		code: { plan: () => ({ parts: ["intro"] }), partKey, merge, summarize },
	});
	expect(result).toEqual({
		node: "escalate",
		expansion: "",
		outcome: "rejected",
		reason: "the guard 'merge.nonEmpty' is not true",
	});
});

test("a map names duplicate keys and how to fix them", async () => {
	const keyed = await play(await fixture("guards-and-escalation.json"), {
		code: { plan: () => ({ parts: ["a", "a"] }), partKey, merge, summarize },
	});
	const unkeyed = await play(
		graph(
			[
				{
					id: "m",
					kind: "map",
					items: ["a b", "a_b"],
					cardinality: { exact: 2 },
					onError: "settle",
					inner: { item: STRING },
					out: { results: settledList },
					members: { result: "m/t" },
				},
				task("m/t"),
			],
			[],
			"m",
		),
	);
	expect(keyed.result).toMatchObject({
		node: "each",
		outcome: "failed",
		reason:
			"map 'each' has items 0 and 1 keyed 'a'. Make its key function return a unique key per item",
	});
	expect(unkeyed.result).toMatchObject({
		node: "m",
		outcome: "failed",
		reason:
			"map 'm' has items 0 and 1 keyed 'a_b'. Give the map a key function that returns a unique key per item",
	});
});

test("a map over more items than its bound fails", async () => {
	const { result } = await play(await fixture("guards-and-escalation.json"), {
		code: {
			plan: () => ({ parts: ["a", "b", "c", "d", "e"] }),
			partKey,
			merge,
			summarize,
		},
	});
	expect(result).toMatchObject({
		node: "each",
		outcome: "failed",
		reason:
			"map 'each' got 5 items, over its bound of 4. Raise its bound, or pass fewer items",
	});
});

test("cancelling a concert cancels running instances latest first, keeps what they report, and records none left", async () => {
	const started = barrier(3);
	const hang = () => {
		started.arrive();
		return pending();
	};
	const host = fakeHost({ steps: { a: hang, b: hang } });
	const cancelled: string[] = [];
	const [kind] = host.kinds;
	if (!kind) throw new Error("the fake host has no kind");
	const watched: Host = {
		...host,
		kinds: [
			{
				...kind,
				execute: async (instance, inputs, context) => ({
					...(await kind.execute(instance, inputs, context)),
					metrics: { tokens: 2 },
				}),
				cancel: async (instance: HostInstance) => {
					cancelled.push(instance.node.id);
					await kind.cancel(instance);
					if (instance.node.id === "b") throw new Error("hook broke");
				},
			},
		],
	};
	const { dir, open } = await workspace();
	const record = open();
	const performance = perform({
		ir: graph(
			[task("a"), task("b"), task("c"), code("d", "hang")],
			[{ kind: "control", from: { node: "a" }, to: { node: "c" } }],
			"c",
		),
		hosts: [watched],
		loadCode: loader({ hang }),
		record,
		dir,
		concurrency: 4,
	});
	await started.all;
	await performance.cancel();
	const result = await performance.done;
	const startOrder = record
		.events(performance.concert)
		.filter((e) => e.type === "running" && e.node !== "d")
		.map((e) => e.node);
	expect(cancelled).toEqual(startOrder.toReversed());
	const statuses = record
		.instances(performance.concert)
		.map((i) => [i.node, i.status, i.reason]);
	expect(statuses.toSorted()).toEqual([
		["a", "failed", CANCELLED_CONCERT],
		["b", "failed", CANCELLED_CONCERT],
		["d", "failed", CANCELLED_CONCERT],
	]);
	expect(record.metrics(performance.concert)).toEqual({ tokens: 4 });
	expect(
		record.events(performance.concert).filter((e) => e.type === "log"),
	).toMatchObject([{ node: "b", line: "cancel failed: hook broke" }]);
	expect(result).toEqual({ outcome: "failed", reason: CANCELLED_CONCERT });
	expect(record.concerts({ status: "failed" }).map((c) => c.id)).toEqual([
		performance.concert,
	]);
});

test("a cancelled host instance whose execute never settles is abandoned, and the concert settles", async () => {
	const started = Promise.withResolvers<void>();
	const host = fakeHost();
	const [kind] = host.kinds;
	if (!kind) throw new Error("the fake host has no kind");
	const stuck: Host = {
		...host,
		kinds: [
			{
				...kind,
				execute: () => {
					started.resolve();
					return pending();
				},
				cancel: async () => {},
			},
		],
	};
	const { dir, open } = await workspace();
	const record = open();
	const performance = perform({
		ir: graph([task("t")], [], "t"),
		hosts: [stuck],
		loadCode: loader({}),
		record,
		dir,
		concurrency: 1,
	});
	await started.promise;
	await performance.cancel();
	expect(await performance.done).toEqual({
		outcome: "failed",
		reason: CANCELLED_CONCERT,
	});
	expect(record.instances(performance.concert)).toMatchObject([
		{ node: "t", status: "failed", reason: CANCELLED_CONCERT },
	]);
});

/**
 * A `map` over `x` and `y` that propagates, whose members' `m/t` reads the item, `m/slow` goes beside it and
 * `m/after` follows it.
 */
const propagating = graph(
	[
		{
			id: "m",
			kind: "map",
			items: ["x", "y"],
			cardinality: { exact: 2 },
			onError: "propagate",
			inner: { item: STRING },
			out: { results: settledList },
			members: { result: "m/t" },
		},
		task("m/t", { in: { prompt: STRING } }),
		task("m/slow"),
		task("m/after"),
	],
	[
		data("m.item", "m/t.prompt"),
		{ kind: "control", from: { node: "m/t" }, to: { node: "m/after" } },
	],
	"m",
);

test("a node after a member cancelled by propagate settles with the halt's reason", async () => {
	const xStarted = Promise.withResolvers<void>();
	const { record, concert } = await play(propagating, {
		script: {
			steps: {
				"m/t": (_, inputs) => {
					if (inputs.prompt !== "x")
						return xStarted.promise.then(() => ({
							outcome: "failed",
							reason: "broke",
						}));
					xStarted.resolve();
					return pending();
				},
			},
		},
	});
	expect(byInstance(record.instances(concert))["m/after[x]"]).toMatchObject({
		status: "skipped",
		reason: "cancelled: m[y]/t failed",
	});
});

test("propagate halts the other members before the failing member's frame settles, and a later concert cancel outranks it", async () => {
	const xStarted = Promise.withResolvers<void>();
	const cancelling = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const host = fakeHost({
		steps: {
			"m/t": (_, inputs) => {
				if (inputs.prompt === "x") {
					xStarted.resolve();
					return pending();
				}
				return xStarted.promise.then(() => ({
					outcome: "failed",
					reason: "broke",
				}));
			},
			"m/slow": (instance) =>
				instance.expansion === "[y]"
					? cancelling.promise.then(() => ({ outcome: "ok", outputs: {} }))
					: { outcome: "ok", outputs: {} },
		},
	});
	const [kind] = host.kinds;
	if (!kind) throw new Error("the fake host has no kind");
	const blocking: Host = {
		...host,
		kinds: [
			{
				...kind,
				cancel: async (instance: HostInstance) => {
					cancelling.resolve();
					await gate.promise;
					await kind.cancel(instance);
				},
			},
		],
	};
	const { dir, open } = await workspace();
	const record = open();
	const performance = perform({
		ir: propagating,
		hosts: [blocking],
		loadCode: loader({}),
		record,
		dir,
		concurrency: 4,
	});
	await cancelling.promise;
	const cancel = performance.cancel();
	gate.resolve();
	await cancel;
	expect(await performance.done).toEqual({
		outcome: "failed",
		reason: CANCELLED_CONCERT,
	});
	const instances = byInstance(record.instances(performance.concert));
	expect(instances["m/t[x]"]).toMatchObject({
		status: "failed",
		reason: CANCELLED_CONCERT,
	});
});

test("only a tolerating edge admits a rejected upstream, and the result follows untolerated inputs to the node that threw", async () => {
	const ir = graph(
		[
			code("boom", "boom", { out: { text: STRING } }),
			task("after", { in: { prompt: STRING }, out: { text: STRING } }),
			code("check", "check"),
			task("end", { in: { prompt: STRING } }),
			task("tidy"),
			task("strict"),
		],
		[
			data("boom.text", "after.prompt"),
			data("after.text", "end.prompt"),
			{
				kind: "control",
				from: { node: "check" },
				to: { node: "end" },
				tolerate: "rejected",
			},
			{
				kind: "control",
				from: { node: "check" },
				to: { node: "tidy" },
				tolerate: "rejected",
			},
			{ kind: "control", from: { node: "check" }, to: { node: "strict" } },
		],
		"end",
	);
	const { result, record, concert } = await play(ir, {
		code: {
			boom: () => {
				throw new Error("exploded");
			},
			check: () => reject("not needed"),
		},
	});
	expect(result).toEqual({
		node: "boom",
		expansion: "",
		outcome: "failed",
		reason: "exploded",
	});
	const logs = record
		.events(concert)
		.filter((e) => e.type === "log" && e.node === "boom");
	expect(logs[0]).toMatchObject({ type: "log", line: "Error: exploded" });
	const instances = byInstance(record.instances(concert));
	expect(instances.end?.reason).toBe("'after' settled skipped");
	expect(instances.tidy?.status).toBe("ok");
	expect(instances.strict?.reason).toBe("'check' settled rejected");
});

test("a code node sees a fixed clock, its scratch directory and frozen host facts; a pure one cannot read the clock", async () => {
	const seen: { clock?: number; scratch?: boolean; env?: unknown }[] = [];
	const host: Host = { ...fakeHost(), environment: () => ({ target: "main" }) };
	const { record, concert } = await play(
		graph(
			[
				code("look", "look"),
				code("pure", "look", {}, true),
				code("meddle", "meddle"),
			],
			[],
			"look",
		),
		{
			hosts: [host],
			code: {
				meddle: (_: never, ctx: CodeContext) => {
					Object.assign(ctx.env.fake ?? {}, { target: "other" });
					return {};
				},
				look: (_: never, ctx: CodeContext) => {
					seen.push({
						clock: ctx.clock,
						scratch: existsSync(ctx.scratch),
						env: ctx.env,
					});
					return {};
				},
			},
		},
	);
	const instances = byInstance(record.instances(concert));
	expect(seen).toEqual([
		{
			clock: instances.look?.startedAt,
			scratch: true,
			env: { fake: { target: "main" } },
		},
	]);
	expect(instances.pure).toMatchObject({
		status: "failed",
		reason:
			"a pure node cannot read ctx.clock. Mark the node pure: false to read it",
	});
	expect(instances.meddle?.status).toBe("failed");
});

test("a concert that cannot start settles failed with the reason", async () => {
	const host: Host = {
		...fakeHost(),
		environment: () => {
			throw new Error("no target checked out");
		},
	};
	const { result, record, concert } = await play(graph([task("t")], [], "t"), {
		hosts: [host],
	});
	expect(result).toEqual({
		outcome: "failed",
		reason: "no target checked out",
	});
	expect(await record.wait(concert, 0)).toMatchObject({ status: "failed" });
});

test("a throw while performing halts the running instances and records them settled before the concert", async () => {
	const started = Promise.withResolvers<void>();
	const { dir, open } = await workspace();
	const record = open();
	const broken: RecordStore = {
		...record,
		settle: (concert, instance, settling, at) => {
			if (instance.node === "a") throw new Error("disk full");
			record.settle(concert, instance, settling, at);
		},
	};
	const { result, concert } = await play(
		graph([code("a", "quick"), task("b")], [], "b"),
		{
			script: {
				steps: {
					b: () => {
						started.resolve();
						return pending();
					},
				},
			},
			code: { quick: () => started.promise.then(() => ({})) },
			record: broken,
			dir,
		},
	);
	expect(result).toEqual({ outcome: "failed", reason: "disk full" });
	const b = byInstance(record.instances(concert)).b;
	expect(b).toMatchObject({ status: "failed", reason: "disk full" });
	expect(b?.settledAt).toBeLessThanOrEqual(
		record.concert(concert).settledAt ?? 0,
	);
});

test("inputs, code outputs and host returns are checked, and a runtime is looked up by name only", async () => {
	const inherited = { ...code("inherited", "count"), worker: worker("count") };
	inherited.worker.runtime = "constructor";
	const { record, concert } = await play(
		graph(
			[
				task("wrong-in", {
					in: { n: { type: "integer" } },
					literals: { n: "one" },
				}),
				code("wrong-out", "count", { out: { n: { type: "integer" } } }),
				code("rejects", "refuse", { out: { n: { type: "integer" } } }),
				task("odd"),
				inherited,
			],
			[],
			"wrong-out",
		),
		{
			script: {
				steps: { odd: () => ({ outcome: "maybe" }) as unknown as Execution },
			},
			code: { count: () => ({ n: "one" }), refuse: () => reject("no count") },
		},
	);
	const instances = byInstance(record.instances(concert));
	expect(instances["wrong-in"]).toMatchObject({
		status: "failed",
		reason: "input 'n' must be integer",
	});
	expect(instances["wrong-in"]?.startedAt).toBeUndefined();
	expect(
		record
			.events(concert)
			.some((e) => e.node === "wrong-in" && e.type === "running"),
	).toBe(false);
	expect(instances["wrong-out"]).toMatchObject({
		status: "failed",
		reason: "output 'n' must be integer",
	});
	expect(instances.rejects).toMatchObject({
		status: "rejected",
		reason: "no count",
	});
	expect(instances.odd).toMatchObject({
		status: "failed",
		reason: `node kind '${FAKE_TASK}' returned the outcome "maybe", not one of: ok, rejected, failed. Report this to its author`,
	});
	expect(instances.inherited).toMatchObject({
		status: "failed",
		reason: "no worker serves runtime 'constructor'. Use one of: ts",
	});
});

test("a written file is moved into the artifact area, hashed, and its scratch directory deleted", async () => {
	const file = { [MAESTRO_TYPE]: CORE_TYPES.file };
	const scratches: string[] = [];
	const kept: string[] = [];
	const { result, record, concert, dir } = await play(
		graph(
			[
				code("write", "write", { out: { file } }),
				code("read", "read", { in: { file }, out: { text: STRING } }),
				code("stray", "stray", { out: { file } }),
			],
			[data("write.file", "read.file")],
			"read",
		),
		{
			code: {
				write: async (_: never, ctx: CodeContext) => {
					scratches.push(ctx.scratch);
					const path = join(ctx.scratch, "note.txt");
					await writeFile(path, "hello");
					return { file: path };
				},
				read: (ports: { file: ArtifactRef }, ctx: CodeContext) => {
					kept.push(...scratches.filter(existsSync));
					return { text: readFileSync(ctx.path(ports.file), "utf8") };
				},
				stray: async (_: never, ctx: CodeContext) => {
					const path = join(ctx.scratch, "..", "stray.txt");
					await writeFile(path, "out of bounds");
					return { file: path };
				},
			},
		},
	);
	expect(result).toMatchObject({ outcome: "ok", outputs: { text: "hello" } });
	const instances = byInstance(record.instances(concert));
	const ref = instances.write?.outputs?.file as ArtifactRef;
	expect(ref).toEqual({
		path: expect.stringMatching(/^a\w+\/note\.txt$/),
		contentHash: `sha256:${new Bun.CryptoHasher("sha256").update("hello").digest("hex")}`,
		producer: { node: "write", expansion: "" },
	});
	expect(instances.write?.artifacts).toEqual([ref]);
	expect(readFileSync(join(dir, concert, "artifacts", ref.path), "utf8")).toBe(
		"hello",
	);
	expect(scratches).toHaveLength(1);
	expect(kept).toEqual([]);
	expect(existsSync(join(dir, concert, "scratch"))).toBe(false);
	expect(instances.stray?.status).toBe("failed");
	expect(instances.stray?.reason).toContain(
		"outside the instance's scratch directory",
	);
});

test("events carry node id and expansion path, progress included, and read from a cursor", async () => {
	const { record, concert } = await play(
		graph(
			[
				{
					id: "m",
					kind: "map",
					items: ["x", "y"],
					cardinality: { exact: 2 },
					onError: "settle",
					inner: { item: STRING },
					out: { results: settledList },
					members: { result: "m/t" },
				},
				task("m/t", { in: { prompt: STRING } }),
			],
			[data("m.item", "m/t.prompt")],
			"m",
		),
		{
			script: {
				steps: {
					"m/t": (_, inputs, context) => {
						context.emit({ said: inputs.prompt });
						return {
							outcome: "ok",
							outputs: {},
							metrics: { tokens: 3, calls: 1 },
							enrichment: { by: "fake" },
						};
					},
				},
			},
		},
	);
	const events = record.events(concert);
	const of = (expansion: string) =>
		events
			.filter((e) => e.node === "m/t" && e.expansion === expansion)
			.map((e) => e.type);
	expect(of("[x]")).toEqual(["running", "progress", "settled"]);
	expect(of("[y]")).toEqual(["running", "progress", "settled"]);
	expect(
		events.find((e) => e.type === "progress" && e.expansion === "[y]"),
	).toMatchObject({
		event: { said: "y" },
	});
	expect(
		events.find((e) => e.type === "settled" && e.node === "m/t"),
	).toMatchObject({
		outcome: "ok",
		enrichment: { by: "fake" },
	});
	const cursor = events[2]?.seq ?? 0;
	expect(record.events(concert, cursor)).toEqual(events.slice(3));
	expect(record.metrics(concert)).toEqual({ calls: 2, tokens: 6 });
	expect(byInstance(record.instances(concert))["m/t[x]"]?.metrics).toEqual({
		calls: 1,
		tokens: 3,
	});
});

test("no more instances execute at once than the concurrency cap", async () => {
	let now = 0;
	let most = 0;
	const step = async (): Promise<Execution> => {
		most = Math.max(most, ++now);
		await Bun.sleep(5);
		now--;
		return { outcome: "ok", outputs: {} };
	};
	await play(graph([task("a"), task("b"), task("c")], [], "a"), {
		script: { steps: { a: step, b: step, c: step } },
		concurrency: 2,
	});
	expect(most).toBe(2);
});

test("two concerts share one record store at once, and the record answers the CLI queries", async () => {
	const { dir, open } = await workspace();
	const gate = Promise.withResolvers<void>();
	const slow = graph([task("t")], [], "t", "slow");
	const quick = graph([task("t")], [], "t", "quick");
	const first = perform({
		ir: slow,
		hosts: [
			fakeHost({
				steps: {
					t: () =>
						gate.promise.then(() => ({ outcome: "ok", outputs: { v: 1 } })),
				},
			}),
		],
		loadCode: loader({}),
		record: open(),
		dir,
		concurrency: 1,
	});
	const reader = open();
	const second = await play(quick, {
		script: { steps: { t: [{ outcome: "rejected", reason: "nope" }] } },
		record: open(),
		dir,
	});
	expect(await reader.wait(first.concert, 1)).toBeUndefined();
	expect(reader.result(first.concert)).toBeUndefined();
	expect(reader.concerts({ status: "running" }).map((c) => c.id)).toEqual([
		first.concert,
	]);
	gate.resolve();
	expect(await reader.wait(first.concert)).toMatchObject({
		status: "ok",
		composition: "slow",
		ir: slow,
	});
	expect(reader.result(first.concert)).toEqual({
		node: "t",
		expansion: "",
		outcome: "ok",
		outputs: { v: 1 },
	});
	expect(reader.result(second.concert)).toEqual({
		node: "t",
		expansion: "",
		outcome: "rejected",
		reason: "nope",
	});
	expect(reader.concerts().map((c) => c.id)).toEqual([
		second.concert,
		first.concert,
	]);
	expect(reader.concerts({ composition: "quick" }).map((c) => c.id)).toEqual([
		second.concert,
	]);
	expect(reader.instances(first.concert)).toMatchObject([
		{ node: "t", status: "ok", outputs: { v: 1 } },
	]);
	await first.done;
	const unknown = "no concert 'nope' in the record. Check the concert id";
	await expect(reader.wait("nope")).rejects.toThrow(unknown);
	expect(() => reader.instances("nope")).toThrow(unknown);
});
