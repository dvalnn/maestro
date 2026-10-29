import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "@maestro/core/compose";
import type {
	Host,
	HostInstance,
	HostNodeResult,
	HostSetup,
} from "@maestro/core/host";
import type { CodeEntry, LoadCode } from "@maestro/core/node";
import {
	type InstanceRecord,
	openRecord,
	type PerformOptions,
	perform,
	type Records,
} from "@maestro/core/perform";
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
	type Ports,
	parseIr,
	reject,
	type Settled,
	TS_RUNTIME,
	type WorkerRef,
} from "@maestro/ir";
import { partKey, summarize } from "@maestro/ir/fixtures/guards";
import { isDone } from "@maestro/ir/fixtures/refine";
import {
	assert,
	Bool,
	composition,
	Int,
	iter,
	JsonFile,
	List,
	loop,
	not,
	readJson,
	Text,
} from "@maestro/sdk";
import { planPanelIr } from "@maestro/sdk/fixtures/examples";
import * as workers from "@maestro/sdk/fixtures/workers";
import { hostNode } from "@maestro/sdk/host";
import * as stdlib from "@maestro/sdk/stdlib";
import {
	buildIr,
	FAKE_TASK,
	type FakeScript,
	fakeHost,
	type StubOptions,
	stubConcert,
} from "./index";

const FIXTURES = join(import.meta.dir, "../../ir/fixtures");
const STRING = { type: "string" };
const CANCELLED_CONCERT = "the concert was cancelled";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A reader of the record store in `dir`, closed when the test ends. */
function readerIn(dir: string): Records {
	const record = openRecord(join(dir, "record.db"));
	cleanups.push(async () => record.close());
	return record;
}

/** The record of concert `id`. */
function recorded(record: Records, id: string) {
	const found = record.find(id);
	if (!found) throw new Error(`no concert '${id}' in the record`);
	return found;
}

/** A temporary directory for one test's record store and concert directories. */
async function workspace() {
	const dir = await mkdtemp(join(tmpdir(), "maestro-perform-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return { dir, open: () => readerIn(dir) };
}

type Fn = (inputs: never, context: CodeContext) => unknown;

/** Resolves a worker reference by its export name alone. */
const loader =
	(fns: Readonly<Record<string, Fn>>): LoadCode =>
	async (ref) => {
		const fn = fns[ref.export];
		if (!fn) throw new Error(`no fixture function '${ref.export}'`);
		return fn as CodeEntry;
	};

/** The `codeHash` of the code a worker reference names as it is now. */
type CodeHash = (ref: WorkerRef) => string;

/** The directory `options` names, or a new workspace's. */
const storage = async (options: { dir?: string }) =>
	options.dir ?? (await workspace()).dir;

/** `perform` under no config, with the data root and record store in `options.dir`. */
const start = (
	options: Omit<PerformOptions, "config" | "recordPath" | "roots"> & {
		dir: string;
		config?: PerformOptions["config"];
	},
) =>
	perform({
		config: { values: { dataRoot: options.dir }, sources: [], layers: [] },
		roots: { user: join(options.dir, "roots"), packs: {} },
		recordPath: join(options.dir, "record.db"),
		...options,
	});

/** Performs `source`, an IR or the id of a concert to resume, with its code hashed by `options.codeHash`. */
async function play(source: Ir | string, options: StubOptions = {}) {
	const dir = await storage(options);
	const concert = await stubConcert(source, {
		...options,
		dir,
	});
	cleanups.push(concert.close);
	return { ...concert, concert: concert.id };
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
		scopes: [],
		nodes,
		edges,
		result: { node: result },
	});

const worker = (name: string): WorkerRef => ({
	runtime: TS_RUNTIME,
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
): CodeNode => ({ id, kind: "code", worker: worker(name), ...ports });

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

type MemberValue = { text: string };

/** The fixture's `merge`, reading each member's outputs (ADR 0004). */
function merge(ports: { parts: Settled<MemberValue>[]; separator: string }) {
	const texts = ports.parts.flatMap((p) =>
		p.outcome === "ok" && p.value.text ? [p.value.text] : [],
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

const pending = () => new Promise<HostNodeResult>(() => {});

test("a parMap fans out, a reducer fans in over its settled members, a rejection's outputs included, and a loop carries state until its test is false", async () => {
	const drafts: unknown[] = [];
	const prompts: unknown[] = [];
	const { result, record, concert } = await play(
		await fixture("fanout-fanin-loop.json"),
		{
			script: {
				steps: {
					"topics/draft": (_, inputs) => {
						if (inputs.prompt === "beta")
							return { outcome: "rejected", reason: "off topic" };
						const outputs = { text: `${inputs.prompt} draft` };
						return inputs.prompt === "gamma"
							? { outcome: "rejected", reason: "rough", outputs }
							: { outcome: "ok", outputs };
					},
					"refine/loop/step": (_, inputs) => {
						prompts.push(inputs.prompt);
						return { outcome: "ok", outputs: { text: `${inputs.prompt}+` } };
					},
				},
			},
			code: {
				isDone,
				not: stdlib.not,
				get: stdlib.get,
				firstOk: (ports: { results: Settled<MemberValue>[] }) => {
					drafts.push(...ports.results);
					return stdlib.firstOk(ports);
				},
			},
		},
	);
	expect(drafts).toEqual([
		{ outcome: "ok", value: { text: "alpha draft" } },
		{ outcome: "rejected", reason: "off topic" },
		{
			outcome: "rejected",
			reason: "rough",
			value: { text: "gamma draft" },
		},
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
	expect(instances["topics/draft[beta]"]?.inputs).toEqual({ prompt: "beta" });
	expect(instances["refine/loop/step[1]"]?.inputs).toEqual({
		prompt: "alpha draft+",
	});
	expect(instances.best?.inputs).toEqual({ results: drafts });
	expect(instances.topics).not.toHaveProperty("inputs");
});

test("a literal port is left out of an instance's recorded inputs, and a wired one is kept", async () => {
	const { record, concert } = await play(
		graph(
			[
				code("src", "src", { out: { text: STRING } }),
				code("use", "use", {
					in: { text: STRING, tag: STRING },
					literals: { tag: "fixed" },
				}),
			],
			[data("src.text", "use.text")],
			"use",
		),
		{ code: { src: () => ({ text: "hi" }), use: () => ({}) } },
	);
	const instances = byInstance(record.instances(concert));
	expect(instances.use?.inputs).toEqual({ text: "hi" });
});

test("a loop that tolerates rejected carries a rejected iteration into one that is accepted", async () => {
	const { result, record, concert } = await play(
		await fixture("fanout-fanin-loop.json"),
		{
			script: {
				steps: {
					"topics/draft": (_, inputs) => ({
						outcome: "ok",
						outputs: { text: `${inputs.prompt}` },
					}),
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
				not: stdlib.not,
				firstOk: stdlib.firstOk,
				get: stdlib.get,
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

const BOOL = { type: "boolean" };
const LOOP_INNER = { ok: BOOL, reason: STRING, index: { type: "integer" } };

/** A body node `<loop>/more`, true while `<loop>/<member>` is not `ok`. */
const notOk = (loop: string, member: string) => ({
	node: code(`${loop}/more`, "not", {
		in: { value: BOOL },
		out: { value: BOOL },
	}),
	edge: data(`${loop}/${member}.ok`, `${loop}/more.value`),
	test: { at: "end" as const, port: { node: `${loop}/more`, port: "value" } },
});

/** A loop fed by `seed` that goes on while its step is not `ok`, the step reading the state's `text`. */
const loopGraph = (tolerate: boolean) => {
	const more = notOk("loop", "step");
	return graph(
		[
			task("seed", { out: { text: STRING } }),
			{
				id: "loop",
				kind: "loop",
				cardinality: { upTo: 3 },
				...(tolerate && { tolerate: "rejected" as const }),
				in: { text: STRING },
				inner: { ...LOOP_INNER, text: STRING },
				out: { text: STRING },
				members: { result: "loop/step" },
				test: more.test,
			},
			task("loop/step", { in: { prompt: STRING }, out: { text: STRING } }),
			more.node,
		],
		[
			data("seed.text", "loop.text"),
			data("loop.text", "loop/step.prompt"),
			more.edge,
		],
		"loop",
	);
};

test("a loop stops at a rejected iteration it does not tolerate", async () => {
	const { result, record, concert } = await play(loopGraph(false), {
		code: { not: stdlib.not },
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

const FINDINGS = { type: "array", items: STRING };

const lintMore = notOk("loop", "lint");

/** A tolerant loop, going on while its code member `lint` rejects, that reads the last state's findings as `seen`. */
const lintLoop = graph(
	[
		{
			id: "loop",
			kind: "loop",
			cardinality: { upTo: 3 },
			tolerate: "rejected",
			in: { findings: FINDINGS },
			literals: { findings: [] },
			inner: { ...LOOP_INNER, findings: FINDINGS },
			out: { findings: FINDINGS },
			members: { result: "loop/lint" },
			test: lintMore.test,
		},
		code("loop/lint", "lint", {
			in: { seen: FINDINGS },
			out: { findings: FINDINGS },
		}),
		lintMore.node,
	],
	[data("loop.findings", "loop/lint.seen"), lintMore.edge],
	"loop",
);

test("a code node in a tolerant loop hands the findings it rejected with to the next iteration", async () => {
	const seen: unknown[] = [];
	const { result } = await play(lintLoop, {
		code: {
			not: stdlib.not,
			lint: ({ seen: last }: { seen: string[] }) => {
				seen.push(last);
				const findings = [...last, "x"];
				return last.length < 2 ? reject("dirty", { findings }) : { findings };
			},
		},
	});
	expect(seen).toEqual([[], ["x"], ["x", "x"]]);
	expect(result).toMatchObject({
		node: "loop",
		outcome: "ok",
		outputs: { findings: ["x", "x", "x"] },
	});
});

test("a tolerant reader of a declared output of a rejection without outputs is skipped before it starts, and a loop test reading one does not hold", async () => {
	const after = (from: string, to: string): IrEdge => ({
		kind: "control",
		from: { node: from },
		to: { node: to },
		tolerate: "rejected",
	});
	const { record, concert, result } = await play(
		graph(
			[
				code("check", "refuse", { out: { findings: FINDINGS } }),
				task("inspect", { out: { findings: FINDINGS } }),
				code("fix", "fix", { in: { findings: FINDINGS } }),
				task("redo", { in: { findings: FINDINGS } }),
				code("note", "fix", { in: { reason: STRING } }),
			],
			[
				data("check.findings", "fix.findings"),
				data("inspect.findings", "redo.findings"),
				data("check.reason", "note.reason"),
				after("check", "fix"),
				after("inspect", "redo"),
				after("check", "note"),
			],
			"fix",
		),
		{
			script: { steps: { inspect: [{ outcome: "rejected", reason: "poor" }] } },
			code: { refuse: () => reject("dirty"), fix: () => ({}) },
		},
	);
	const instances = byInstance(record.instances(concert));
	expect(instances.fix).toMatchObject({
		status: "skipped",
		reason: "'check' rejected without its 'findings'",
	});
	expect(instances.fix?.startedAt).toBeUndefined();
	expect(instances.redo).toMatchObject({
		status: "skipped",
		reason: "'inspect' rejected without its 'findings'",
	});
	expect(instances.note?.status).toBe("ok");
	expect(result).toMatchObject({
		node: "check",
		outcome: "rejected",
		reason: "dirty",
	});
	const loop = await play(lintLoop, {
		code: { not: stdlib.not, lint: () => reject("dirty") },
	});
	expect(loop.result).toMatchObject({
		node: "loop/lint",
		expansion: "[0]",
		outcome: "rejected",
		reason: "dirty",
	});
	const testLoop = graph(
		[
			{
				id: "loop",
				kind: "loop",
				cardinality: { upTo: 3 },
				tolerate: "rejected",
				in: { more: BOOL },
				literals: { more: true },
				inner: { ...LOOP_INNER, more: BOOL },
				out: { more: BOOL },
				members: { result: "loop/lint" },
				test: { at: "end", port: { node: "loop/lint", port: "more" } },
			},
			code("loop/lint", "lint", { out: { more: BOOL } }),
		],
		[],
		"loop",
	);
	const testRead = await play(testLoop, {
		code: { lint: () => reject("dirty") },
	});
	expect(testRead.result).toMatchObject({
		node: "loop/lint",
		expansion: "[0]",
		outcome: "rejected",
		reason: "dirty",
	});
});

test("a reader of a rejected node's status ports alone starts untolerated, and one that also reads a declared output is skipped", async () => {
	const { record, concert } = await play(
		graph(
			[
				task("x", { out: { text: STRING } }),
				task("both", { in: { ok: BOOL, text: STRING } }),
				task("status", { in: { ok: BOOL, reason: STRING } }),
			],
			[
				data("x.ok", "both.ok"),
				data("x.text", "both.text"),
				data("x.ok", "status.ok"),
				data("x.reason", "status.reason"),
			],
			"status",
		),
		{
			script: {
				steps: {
					x: [{ outcome: "rejected", reason: "red", outputs: { text: "t" } }],
				},
			},
		},
	);
	const instances = byInstance(record.instances(concert));
	expect(instances.both).toMatchObject({
		status: "skipped",
		reason: "'x' settled rejected",
	});
	expect(instances.status?.status).toBe("ok");
});

test("a find's item is read from the find, not from a previous member that rejected without outputs", async () => {
	const { result } = await play(
		graph(
			[
				{
					id: "each",
					kind: "find",
					items: ["a", "b"],
					cardinality: { upTo: 2 },
					inner: { item: STRING },
					out: { item: STRING },
					members: { result: "each/step" },
					cond: { node: "each/step", port: "ok" },
				},
				code("each/step", "step", {
					in: { item: STRING },
					out: { item: STRING },
				}),
			],
			[data("each.item", "each/step.item")],
			"each",
		),
		{
			code: {
				step: ({ item }: { item: string }) =>
					item === "a" ? reject("first") : { item },
			},
		},
	);
	expect(result).toMatchObject({
		node: "each",
		outcome: "ok",
		outputs: { item: "b" },
	});
});

test("a loop that tolerates rejected starts from rejected state and goes on while its step rejects", async () => {
	const prompts: unknown[] = [];
	const { result } = await play(loopGraph(true), {
		code: { not: stdlib.not },
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
	expect(prompts).toEqual(["seed", "again"]);
	expect(result).toMatchObject({
		node: "loop",
		outcome: "ok",
		outputs: { text: "done" },
	});
});

const COUNT = { n: Int(), done: Bool() };

/**
 * A loop of `kind` from an `init` node to `step` nodes, at most 2, that goes on while its state, or a doWhile's step:
 * - is not `done`, by default;
 * - is `ok`, given `"ok"`.
 */
const counting = (
	kind: "while" | "doWhile",
	cond: "notDone" | "ok" = "notDone",
) =>
	buildIr(
		composition("counting", { examples: [{}] }, () =>
			loop[kind]((state) => (cond === "ok" ? state.ok : not(state.out.done)), {
				init: hostNode(FAKE_TASK, { label: "init", out: COUNT }),
				step: (state) =>
					hostNode(FAKE_TASK, {
						label: "step",
						in: { n: state.out.n },
						out: COUNT,
					}),
				max: 2,
				tolerate: "rejected",
			}),
		),
	);

/** Performs `ir` with `init` settling as given and each step adding one to `n`, settling as `step` gives for it. */
async function countFrom(
	ir: Ir,
	init: HostNodeResult,
	step: (n: number) => HostNodeResult,
) {
	const concert = await play(ir, {
		script: {
			steps: {
				init: [init],
				"loop/step": (_, inputs) => step(Number(inputs.n) + 1),
			},
		},
		code: { not: stdlib.not },
	});
	const steps = concert.record
		.instances(concert.concert)
		.filter((i) => i.node === "loop/step");
	return { result: concert.result, steps: steps.length };
}

const doneAt =
	(last: number) =>
	(n: number): HostNodeResult => ({
		outcome: "ok",
		outputs: { n, done: n >= last },
	});

const rough = (n: number, done: boolean): HostNodeResult => ({
	outcome: "rejected",
	reason: `rough ${n}`,
	outputs: { n, done },
});

test.each([
	["while", "false on init ends ok on init's outputs with no step", 0, 0],
	["while", "true once takes one step", 1, 1],
	["doWhile", "takes a step even when init is done", 0, 1],
] as const)(
	"loop.%s whose condition is %s",
	async (kind, _title, last, steps) => {
		const ran = await countFrom(
			counting(kind),
			{ outcome: "ok", outputs: { n: 0, done: last === 0 } },
			doneAt(last),
		);
		expect(ran.steps).toBe(steps);
		expect(ran.result).toMatchObject({
			node: "loop",
			outcome: "ok",
			outputs: { n: steps, done: true },
		});
	},
);

test.each([
	["while", "a step", 0, 1],
	["doWhile", "a step", 0, 1],
	["while", "init, taking no step", 1, 0],
] as const)(
	"a loop.%s whose condition is false on a tolerated rejected state ends rejected on %s",
	async (kind, _title, initDone, steps) => {
		const ran = await countFrom(
			counting(kind),
			initDone ? rough(0, true) : doneAt(1)(0),
			(n) => rough(n, true),
		);
		expect(ran.steps).toBe(steps);
		expect(ran.result).toMatchObject({
			outcome: "rejected",
			reason: `rough ${steps}`,
			outputs: { n: steps, done: true },
		});
	},
);

test.each(["while", "doWhile"] as const)(
	"a loop.%s on ok that tolerates a step that rejects ends rejected with its reason",
	async (kind) => {
		const ran = await countFrom(counting(kind, "ok"), doneAt(1)(0), (n) =>
			rough(n, false),
		);
		expect(ran.steps).toBe(1);
		expect(ran.result).toMatchObject({
			outcome: "rejected",
			reason: "rough 1",
		});
	},
);

test("a loop.doWhile on not(r.ok) goes on past a rejected step it tolerates", async () => {
	const ir = buildIr(
		composition("retry", { examples: [{}] }, () =>
			loop.doWhile((r) => not(r.ok), {
				init: hostNode(FAKE_TASK, { label: "init", out: COUNT }),
				step: (state) =>
					hostNode(FAKE_TASK, {
						label: "step",
						in: { n: state.out.n },
						out: COUNT,
					}),
				max: 3,
				tolerate: "rejected",
			}),
		),
	);
	const ran = await countFrom(ir, doneAt(1)(0), (n) =>
		n === 1 ? rough(n, false) : doneAt(n)(n),
	);
	expect(ran.steps).toBe(2);
	expect(ran.result).toMatchObject({
		node: "loop",
		outcome: "ok",
		outputs: { n: 2, done: true },
	});
});

test("a loop that reaches max with its condition still true ends on its last state's outcome", async () => {
	const ran = await countFrom(counting("while"), doneAt(1)(0), (n) => ({
		outcome: "rejected",
		reason: `still ${n}`,
		outputs: { n, done: false },
	}));
	expect(ran.steps).toBe(2);
	expect(ran.result).toMatchObject({ outcome: "rejected", reason: "still 2" });
});

test("a find escalates through its items until one settles ok, after a parMap keyed by its key function", async () => {
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

test("stop cancels the running members of a parMap as skipped, and the result names the failed member", async () => {
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
				task("flawed", { out: { text: STRING } }),
				{
					...code("gather", "gather", { in: { a: true, b: true, c: true } }),
					fanin: true,
				},
			],
			[
				data("good.text", "gather.a"),
				data("bad.text", "gather.b"),
				data("flawed.text", "gather.c"),
			],
			"gather",
		),
		{
			script: {
				steps: {
					good: [{ outcome: "ok", outputs: { text: "fine" } }],
					bad: [{ outcome: "rejected", reason: "poor" }],
					flawed: [
						{ outcome: "rejected", reason: "rough", outputs: { text: "kept" } },
					],
				},
			},
			code: {
				gather: (ports: unknown) => {
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
			c: { outcome: "rejected", value: "kept", reason: "rough" },
		},
	]);
	expect(result.outcome).toBe("ok");
});

/** A loop fed by `seed`, tested `at` on `loop/done.ok`, `done` reading the state beside the step. */
const doneOkLoop = (at: "start" | "end") =>
	graph(
		[
			task("seed", { out: { text: STRING } }),
			{
				id: "loop",
				kind: "loop",
				cardinality: { upTo: 2 },
				in: { text: STRING },
				inner: { ...LOOP_INNER, text: STRING },
				out: { text: STRING },
				members: { result: "loop/step" },
				test: { at, port: { node: "loop/done", port: "ok" } },
			},
			task("loop/step", { in: { prompt: STRING }, out: { text: STRING } }),
			task("loop/done", { in: { text: STRING } }),
		],
		[
			data("seed.text", "loop.text"),
			data("loop.text", "loop/step.prompt"),
			data("loop.text", "loop/done.text"),
		],
		"loop",
	);

const performDoneOk = (at: "start" | "end", done: HostNodeResult) =>
	play(doneOkLoop(at), {
		script: {
			steps: {
				seed: [{ outcome: "ok", outputs: { text: "seed" } }],
				"loop/step": [{ outcome: "ok", outputs: { text: "step" } }],
				"loop/done": [done],
			},
		},
	});

test.each([
	["start", "seed"],
	["end", "step"],
] as const)(
	"a loop tested at %s on the ok of a test node that rejects ends on its state",
	async (at, text) => {
		const { result } = await performDoneOk(at, {
			outcome: "rejected",
			reason: "not yet",
		});
		expect(result).toMatchObject({ outcome: "ok", outputs: { text } });
	},
);

test.each(["start", "end"] as const)(
	"a loop tested at %s on a test node that fails fails",
	async (at) => {
		const { result } = await performDoneOk(at, {
			outcome: "failed",
			reason: "broke",
		});
		expect(result).toMatchObject({ outcome: "failed", reason: "broke" });
	},
);

test("a node skipped by a guard on the ok of a rejected node names that node as the result", async () => {
	const { result } = await play(
		graph(
			[task("x"), task("y")],
			[
				{
					kind: "control",
					from: { node: "x", port: "ok" },
					to: { node: "y" },
				},
			],
			"y",
		),
		{ script: { steps: { x: [{ outcome: "rejected", reason: "no x" }] } } },
	);
	expect(result).toEqual({
		node: "x",
		expansion: "",
		outcome: "rejected",
		reason: "no x",
	});
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

test("a parMap or parFind names duplicate keys and how to fix them, a key function's over a literal list only at perform", async () => {
	const keyed = await play(await fixture("guards-and-escalation.json"), {
		code: { plan: () => ({ parts: ["a", "a"] }), partKey, merge, summarize },
	});
	const over = (items: string[], key?: WorkerRef) =>
		graph(
			[
				{
					id: "m",
					kind: "parMap",
					items,
					...(key && { key }),
					cardinality: { exact: 2 },
					onError: "continue",
					inner: { item: STRING },
					out: { results: settledList },
					members: { result: "m/t" },
				},
				task("m/t"),
			],
			[],
			"m",
		);
	const unkeyed = await play(over(["a b", "a_b"]));
	const listed = over(["ab", "ac"], worker("firstChar"));
	const firstChar = (item: string) => item[0];
	const composed = await compose({
		ir: listed,
		config: { values: { dataRoot: "/data" }, sources: [], layers: [] },
		roots: { user: "/nonexistent", packs: {} },
		core: { dataRoot: { type: "string" } },
		packs: {},
		hosts: [fakeHost()],
		loadCode: loader({ firstChar }),
		caps: {},
	});
	expect(composed.ok).toBe(true);
	expect((await play(listed, { code: { firstChar } })).result).toMatchObject({
		node: "m",
		outcome: "failed",
		reason:
			"parMap 'm' has items 0 and 1 keyed 'a'. Make its key function return a unique key per item",
	});
	expect(keyed.result).toMatchObject({
		node: "each",
		outcome: "failed",
		reason:
			"parMap 'each' has items 0 and 1 keyed 'a'. Make its key function return a unique key per item",
	});
	const parFind = await play(
		overItems({
			...PAR_FIND,
			items: ["ab", "ac"],
			cardinality: { upTo: 2 },
			key: worker("firstChar"),
		}),
		{ code: { firstChar } },
	);
	expect(parFind.result).toMatchObject({
		node: "g",
		outcome: "failed",
		reason:
			"parFind 'g' has items 0 and 1 keyed 'a'. Make its key function return a unique key per item",
	});
	expect(unkeyed.result).toMatchObject({
		node: "m",
		outcome: "failed",
		reason:
			"parMap 'm' has items 0 and 1 keyed 'a_b'. Give the parMap a key function that returns a unique key per item",
	});
});

test("a parMap over more items than its bound fails", async () => {
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
			"parMap 'each' got 5 items, over its bound of 4. Raise its bound, or pass fewer items",
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
	const playing = await start({
		ir: graph(
			[task("a"), task("b"), task("c"), code("d", "hang")],
			[{ kind: "control", from: { node: "a" }, to: { node: "c" } }],
			"c",
		),
		hosts: [watched],
		loadCode: loader({ hang }),
		dir,
		concurrency: 4,
	});
	await started.all;
	await playing.cancel();
	const result = await playing.done;
	const startOrder = record
		.events(playing.id)
		.filter((e) => e.type === "running" && e.node !== "d")
		.map((e) => e.node);
	expect(cancelled).toEqual(startOrder.toReversed());
	const statuses = record
		.instances(playing.id)
		.map((i) => [i.node, i.status, i.reason]);
	expect(statuses.toSorted()).toEqual([
		["a", "failed", CANCELLED_CONCERT],
		["b", "failed", CANCELLED_CONCERT],
		["d", "failed", CANCELLED_CONCERT],
	]);
	expect(record.metrics(playing.id)).toEqual({ tokens: 4 });
	expect(
		record
			.events(playing.id)
			.filter((e) => e.type === "log")
			.toSorted((x, y) => x.node.localeCompare(y.node)),
	).toMatchObject([
		{ node: "b", line: "cancel failed: hook broke" },
		{ node: "d", line: expect.stringContaining("scratch kept at") },
	]);
	expect(result).toEqual({ outcome: "failed", reason: CANCELLED_CONCERT });
	expect(record.concerts({ status: "failed" }).map((c) => c.id)).toEqual([
		playing.id,
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
	const playing = await start({
		ir: graph([task("t")], [], "t"),
		hosts: [stuck],
		loadCode: loader({}),
		dir,
		concurrency: 1,
	});
	await started.promise;
	await playing.cancel();
	expect(await playing.done).toEqual({
		outcome: "failed",
		reason: CANCELLED_CONCERT,
	});
	expect(record.instances(playing.id)).toMatchObject([
		{ node: "t", status: "failed", reason: CANCELLED_CONCERT },
	]);
});

/**
 * A `parMap` over `x` and `y` that stops, whose members' `m/t` reads the item, `m/slow` goes beside it and
 * `m/after` follows it.
 */
const stopping = graph(
	[
		{
			id: "m",
			kind: "parMap",
			items: ["x", "y"],
			cardinality: { exact: 2 },
			onError: "stop",
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

test("a node after a member cancelled by stop settles with the halt's reason", async () => {
	const xStarted = Promise.withResolvers<void>();
	const { record, concert } = await play(stopping, {
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

test("stop halts the other members before the failing member's frame settles, and a later concert cancel outranks it", async () => {
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
	const playing = await start({
		ir: stopping,
		hosts: [blocking],
		loadCode: loader({}),
		dir,
		concurrency: 4,
	});
	await cancelling.promise;
	const cancel = playing.cancel();
	gate.resolve();
	await cancel;
	expect(await playing.done).toEqual({
		outcome: "failed",
		reason: CANCELLED_CONCERT,
	});
	const instances = byInstance(record.instances(playing.id));
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

test("a code node sees a fixed clock, its scratch directory and frozen host facts", async () => {
	const seen: { clock?: number; scratch?: boolean; env?: unknown }[] = [];
	const host: Host = { ...fakeHost(), environment: () => ({ target: "main" }) };
	const { record, concert } = await play(
		graph([code("look", "look"), code("meddle", "meddle")], [], "look"),
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
					ctx.log("looked");
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
	expect(instances.meddle?.status).toBe("failed");
	const logOf = (node: string) =>
		record
			.events(concert)
			.flatMap((e) => (e.node === node && e.type === "log" ? [e.line] : []));
	expect(logOf("look")).toEqual(["looked"]);
	expect(logOf("meddle")[0]).toStartWith("TypeError: ");
});

test("a code node past its timeout settles failed naming the node and the limit; one within it or without one settles ok", async () => {
	const { record, concert } = await play(
		graph(
			[
				{ ...code("slow", "hang"), timeout: 20 },
				{ ...code("quick", "late"), timeout: 1000 },
				code("unbounded", "late"),
			],
			[],
			"slow",
		),
		{
			code: {
				hang: () => new Promise(() => {}),
				late: () => Bun.sleep(40).then(() => ({})),
			},
		},
	);
	const instances = byInstance(record.instances(concert));
	expect(instances.slow).toMatchObject({
		status: "failed",
		reason: "node 'slow' ran past its timeout of 20 ms",
	});
	expect(instances.quick?.status).toBe("ok");
	expect(instances.unbounded?.status).toBe("ok");
});

test("a code node's signal aborts when the concert is cancelled and when the node times out", async () => {
	const aborted: string[] = [];
	const started = barrier(2);
	const watch = (name: string) => (_: never, ctx: CodeContext) => {
		ctx.signal.addEventListener("abort", () => aborted.push(name));
		started.arrive();
		return new Promise(() => {});
	};
	const code_ = { cancelled: watch("cancelled"), slow: watch("slow") };
	const { dir } = await workspace();
	const timed = await play(
		graph([{ ...code("slow", "slow"), timeout: 20 }], [], "slow"),
		{ code: code_ },
	);
	expect(aborted).toEqual(["slow"]);
	expect(timed.record.instances(timed.concert)[0]?.status).toBe("failed");
	const playing = await start({
		ir: graph([code("cancelled", "cancelled")], [], "cancelled"),
		hosts: [],
		loadCode: loader(code_),
		dir,
		concurrency: 1,
	});
	await started.all;
	expect(aborted).toEqual(["slow"]);
	await playing.cancel();
	await playing.done;
	expect(aborted).toEqual(["slow", "cancelled"]);
});

test("a failed code node keeps its scratch and logs where, an ok or rejected one does not, and the concert's scratch goes only when empty", async () => {
	const scratches: Record<string, string> = {};
	const note =
		(name: string, fail: boolean) => async (_: never, ctx: CodeContext) => {
			scratches[name] = ctx.scratch;
			await writeFile(join(ctx.scratch, "evidence.log"), "why");
			if (fail) throw new Error("cannot judge");
			return {};
		};
	const { record, concert, dir } = await play(
		graph([code("bad", "bad"), code("good", "good")], [], "good"),
		{ code: { bad: note("bad", true), good: note("good", false) } },
	);
	const bad = scratches.bad ?? "";
	expect(readFileSync(join(bad, "evidence.log"), "utf8")).toBe("why");
	expect(existsSync(scratches.good ?? "")).toBe(false);
	expect(
		record
			.events(concert)
			.flatMap((e) => (e.node === "bad" && e.type === "log" ? [e.line] : [])),
	).toContain(`scratch kept at ${bad}`);
	expect(existsSync(join(dir, concert, "scratch"))).toBe(true);

	const clean = await play(
		graph([code("no", "no"), code("yes", "yes")], [], "yes"),
		{
			code: {
				no: async (_: never, ctx: CodeContext) => {
					scratches.no = ctx.scratch;
					return reject("nope");
				},
				yes: note("yes", false),
			},
		},
	);
	expect(existsSync(scratches.no ?? "")).toBe(false);
	expect(existsSync(scratches.yes ?? "")).toBe(false);
	expect(existsSync(join(clean.dir, clean.concert, "scratch"))).toBe(false);
});

const MISMATCHED = { in: { n: { type: "integer" } }, literals: { n: "one" } };

test("a line logged after the instance settled is dropped, never thrown", async () => {
	const { record, concert } = await play(
		graph(
			[{ ...code("abandoned", "hang"), timeout: 10 }, code("returned", "done")],
			[],
			"returned",
		),
		{
			code: {
				hang: (_: never, ctx: CodeContext) => {
					setTimeout(() => ctx.log("late"), 30);
					return new Promise(() => {});
				},
				done: (_: never, ctx: CodeContext) => {
					setTimeout(() => ctx.log("late"), 30);
					return {};
				},
			},
		},
	);
	await Bun.sleep(60);
	expect(
		record
			.events(concert)
			.filter((e) => e.type === "log" && !e.line.startsWith("scratch kept")),
	).toEqual([]);
});

const BESIDE =
	"the function returned 'outcome' or 'reason' beside its outputs. Return reject(reason, outputs) to reject";

test.each<[string, Fn, string, Pick<IrNode, "in" | "literals">?]>([
	[
		"returns nothing",
		() => undefined,
		"the function returned undefined, not outputs. Return an object keyed by output port",
	],
	["returns extra", () => ({ text: "a", reason: "r" }), BESIDE],
	[
		"returns rejected",
		() => ({ outcome: "rejected", reason: "no", text: "a" }),
		BESIDE,
	],
	[
		"rejects with a list",
		() => reject("no", ["a"]),
		"the function rejected with a list as outputs. Pass reject(reason, outputs) an object keyed by output port",
	],
	["throws", () => Promise.reject(new Error("broke")), "broke"],
	[
		"takes a mismatched input",
		() => ({ text: "a" }),
		"input 'n' must be integer",
		MISMATCHED,
	],
])(
	"a function that %s settles failed, saying why",
	async (_, fn, why, ports = {}) => {
		const ir = graph(
			[code("a", "fn", { ...ports, out: { text: STRING } })],
			[],
			"a",
		);
		const { result } = await play(ir, { code: { fn } });
		expect(result).toMatchObject({ node: "a", outcome: "failed" });
		expect(result.outcome === "failed" ? result.reason : "").toContain(why);
	},
);

/** A group `g` over `a`, `b` and `c`, with `fields`, whose member `g/t` takes the item as its prompt and has `out`. */
const overItems = (
	fields: Record<string, unknown>,
	out: Ports = { text: STRING },
) =>
	graph(
		[
			{
				id: "g",
				items: ["a", "b", "c"],
				cardinality: { upTo: 3 },
				inner: { item: STRING },
				members: { result: "g/t" },
				...fields,
			} as never,
			task("g/t", { in: { prompt: STRING }, out }),
		],
		[data("g.item", "g/t.prompt")],
		"g",
	);

test.each([
	["stop starts no item after", "stop", ["a", "b"], "rejected"],
	[
		"continue goes on through every item past",
		"continue",
		["a", "b", "c"],
		"ok",
	],
] as const)(
	"a map with %s a rejected member",
	async (_, onError, prompts, outcome) => {
		const seen: unknown[] = [];
		const { result } = await play(
			overItems({ kind: "map", onError, out: { results: settledList } }),
			{
				script: {
					steps: {
						"g/t": (_, inputs) => {
							seen.push(inputs.prompt);
							return inputs.prompt === "b"
								? { outcome: "rejected", reason: "no" }
								: { outcome: "ok", outputs: { text: inputs.prompt } };
						},
					},
				},
			},
		);
		expect(seen).toEqual([...prompts]);
		expect(result.outcome).toBe(outcome);
	},
);

const PAR_FIND = {
	kind: "parFind",
	cond: { node: "g/t", port: "ok" },
	out: { text: STRING },
};

test("a parFind ends on the first member to meet its condition and cancels the others as skipped", async () => {
	const started = barrier(2);
	const { result, record, concert } = await play(overItems(PAR_FIND), {
		script: {
			steps: {
				"g/t": (_, inputs) => {
					if (inputs.prompt === "c")
						return started.all.then(() => ({
							outcome: "ok",
							outputs: { text: "c" },
						}));
					started.arrive();
					return inputs.prompt === "a"
						? pending()
						: { outcome: "rejected", reason: "no" };
				},
			},
		},
	});
	expect(result).toMatchObject({
		node: "g",
		outcome: "ok",
		outputs: { text: "c" },
	});
	const instances = byInstance(record.instances(concert));
	expect(instances["g/t[a]"]).toMatchObject({
		status: "skipped",
		reason: "cancelled: g[c]/t met the condition",
	});
	expect(instances["g/t[b]"]?.status).toBe("rejected");
});

test("a parFind whose condition reads an output a rejected member did not produce goes on to the next", async () => {
	const { result } = await play(
		overItems(
			{
				...PAR_FIND,
				cond: { node: "g/t", port: "done" },
				out: { done: BOOL },
			},
			{ done: BOOL },
		),
		{
			script: {
				steps: {
					"g/t": async (_, inputs) => {
						if (inputs.prompt === "a")
							return { outcome: "rejected", reason: "no" };
						await Bun.sleep(inputs.prompt === "b" ? 1 : 5);
						return { outcome: "ok", outputs: { done: inputs.prompt === "c" } };
					},
				},
			},
		},
	);
	expect(result).toMatchObject({
		node: "g",
		outcome: "ok",
		outputs: { done: true },
	});
});

test.each(["find", "parFind"])(
	"a %s fails at a member that failed",
	async (kind) => {
		const { result } = await play(overItems({ ...PAR_FIND, kind }), {
			script: {
				steps: {
					"g/t": (_, inputs) =>
						inputs.prompt === "a"
							? { outcome: "failed", reason: "broke" }
							: pending(),
				},
			},
		});
		expect(result).toMatchObject({ outcome: "failed", reason: "broke" });
	},
);

test("a parFind none of whose members meets its condition ends on the last to settle", async () => {
	const { result } = await play(overItems(PAR_FIND), {
		script: {
			steps: {
				"g/t": async (_, inputs) => {
					if (inputs.prompt === "b") await Bun.sleep(5);
					return { outcome: "rejected", reason: `${inputs.prompt}` };
				},
			},
		},
	});
	expect(result).toMatchObject({ outcome: "rejected", reason: "b" });
});

test.each([
	[
		"seeds from its first item, performing its first phase on it alone, and steps over the rest",
		["a", "b", "c"],
		{ outcome: "ok", outputs: { text: "ab1c2" } },
		["g/first/check[0]"],
	],
	[
		"over no items is skipped, which the result counts as rejected",
		[],
		{ outcome: "rejected", reason: "fold 'g' has no items" },
		[],
	],
])("a fold %s", async (_, items, ending, checks) => {
	const LIST = { type: "array", items: STRING };
	const ir = graph(
		[
			code("src", "src", { out: { items: LIST } }),
			{
				id: "g",
				kind: "fold",
				cardinality: { upTo: 3 },
				in: { items: LIST },
				inner: { item: STRING, text: STRING, ...LOOP_INNER },
				out: { text: STRING },
				members: { first: "g/first/seed", step: "g/step/add" },
				first: ["g/first/seed", "g/first/check"],
			},
			code("g/first/seed", "first", {
				in: { item: STRING },
				out: { text: STRING },
			}),
			{
				id: "g/first/check",
				kind: "assert",
				message: "the seed failed",
				onFail: "rejected",
				in: { cond: BOOL },
			},
			code("g/step/add", "step", {
				in: { text: STRING, item: STRING, index: { type: "integer" } },
				out: { text: STRING },
			}),
		],
		[
			data("src.items", "g.items"),
			data("g.item", "g/first/seed.item"),
			data("g/first/seed.ok", "g/first/check.cond"),
			data("g.text", "g/step/add.text"),
			data("g.item", "g/step/add.item"),
			data("g.index", "g/step/add.index"),
		],
		"g",
	);
	const { result, record, concert } = await play(ir, {
		code: {
			src: () => ({ items }),
			first: ({ item }: { item: string }) => ({ text: item }),
			step: (p: { text: string; item: string; index: number }) => ({
				text: `${p.text}${p.item}${p.index}`,
			}),
		},
	});
	expect(result).toMatchObject({ node: "g", ...ending });
	const performed = Object.keys(byInstance(record.instances(concert)));
	expect(performed.filter((k) => k.includes("check"))).toEqual(checks);
});

test("SDK-emitted IR and the SDK's stdlib settle through compose and perform", async () => {
	const modules: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
		"maestro:stdlib": stdlib,
		"workers.ts": workers,
	};
	const loadCode: LoadCode = async (ref) =>
		modules[ref.module]?.[ref.export] as CodeEntry;
	const ir = checked(JSON.parse(JSON.stringify(planPanelIr())));
	const script: FakeScript = {
		steps: {
			scout: [{ outcome: "ok", outputs: { text: "scouted" } }],
			"parMap/plan": (_, inputs) =>
				inputs.prompt === "risk"
					? { outcome: "rejected", reason: "too risky" }
					: { outcome: "ok", outputs: { text: `${inputs.prompt} plan` } },
			synthesis: [{ outcome: "rejected", reason: "unclear" }],
		},
	};
	const composed = await compose({
		ir,
		config: { values: { dataRoot: "/data" }, sources: [], layers: [] },
		roots: { user: "/nonexistent", packs: {} },
		core: { dataRoot: { type: "string" } },
		packs: {},
		hosts: [fakeHost(script)],
		loadCode,
		caps: {},
	});
	expect(
		composed.ok ? composed.plan.diagnostics : composed.diagnostics,
	).toEqual([]);
	const { result, record, concert } = await play(ir, {
		script,
		loadCode,
	});
	expect(result).toEqual({
		node: "answer",
		expansion: "",
		outcome: "ok",
		outputs: { value: "cost plan" },
	});
	expect(byInstance(record.instances(concert)).firstOk_text).toMatchObject({
		status: "ok",
		outputs: { value: "cost plan" },
	});
});

test("an assert node that rejects is the concert's cause, through a node that waits on it", async () => {
	const ir = buildIr(
		composition("asserted", { examples: [{}] }, () => {
			const t = hostNode(FAKE_TASK, { label: "t", out: { done: Bool() } });
			const holds = assert(t.out.done, "t is done", { onFail: "rejected" });
			return hostNode(FAKE_TASK, { label: "after", when: holds.ok });
		}),
	);
	const { result } = await play(ir, {
		script: { steps: { t: [{ outcome: "ok", outputs: { done: false } }] } },
	});
	expect(result).toMatchObject({ node: "assert", outcome: "rejected" });
});

test.each([
	["rejected", { outcome: "ok", outputs: { value: "none" } }],
	["failed", { outcome: "failed", reason: "or: its input failed: crashed" }],
] as const)(
	"or over a %s input settles as its own result",
	async (outcome, ending) => {
		const ir = buildIr(
			composition("fallback", { examples: [{}] }, () =>
				hostNode(FAKE_TASK, { label: "t", out: { text: Text() } }).out.text.or(
					"none",
				),
			),
		);
		const { result } = await play(ir, {
			script: { steps: { t: [{ outcome, reason: "crashed" }] } },
			code: { or: stdlib.or },
		});
		expect(result).toMatchObject({ node: "t_or", ...ending });
	},
);

describe("readJson over a planner's file", () => {
	const planned = buildIr(
		composition("planned", { examples: [{}] }, () => {
			const planner = hostNode(FAKE_TASK, {
				label: "planner",
				out: { plan: JsonFile(List(Text())) },
			});
			return iter.parMap(
				readJson(planner.out.plan),
				(step) =>
					hostNode(FAKE_TASK, {
						label: "do",
						in: { step },
						out: { done: Text() },
					}),
				{ max: 4, onError: "continue" },
			);
		}),
	);

	/** Performs `planned` with the planner writing `content` to its file. */
	const perform = (content: string) =>
		play(planned, {
			script: {
				steps: {
					planner: async (_, __, context) => {
						const plan = join(context.scratch, "plan.json");
						await writeFile(plan, content);
						return { outcome: "ok", outputs: { plan } };
					},
					"parMap/do": (_, inputs) => ({
						outcome: "ok",
						outputs: { done: `${inputs.step} done` },
					}),
				},
			},
			code: { readJson: stdlib.readJson },
		});

	test("feeds a parMap its items, with no code node of the author's", async () => {
		const exports = planned.nodes.flatMap((n) =>
			n.kind === "code" ? [n.worker.module, n.worker.export] : [],
		);
		expect(exports).toEqual(["maestro:stdlib", "readJson"]);
		const { result } = await perform('["a","b"]');
		expect(result).toMatchObject({
			node: "parMap",
			outcome: "ok",
			outputs: {
				results: [
					{ outcome: "ok", value: { done: "a done" } },
					{ outcome: "ok", value: { done: "b done" } },
				],
			},
		});
	});

	test("rejects a file that misses the schema, naming it as the cause", async () => {
		const { result } = await perform('["a",2]');
		expect(result).toMatchObject({
			node: "planner_plan_json",
			outcome: "rejected",
			reason: expect.stringContaining("'1' must be string"),
		});
	});
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
	const db = new Database(join(dir, "record.db"));
	db.exec(`CREATE TRIGGER disk_full BEFORE UPDATE ON instances
		WHEN NEW.node = 'a' AND NEW.status = 'ok' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
	db.close();
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
			dir,
		},
	);
	expect(result).toEqual({ outcome: "failed", reason: "disk full" });
	const b = byInstance(record.instances(concert)).b;
	expect(b).toMatchObject({ status: "failed", reason: "disk full" });
	expect(b?.settledAt).toBeLessThanOrEqual(
		recorded(record, concert).settledAt ?? 0,
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
				code("rejects-off", "refuseOff", { out: { n: { type: "integer" } } }),
				task("host-off", { out: { n: { type: "integer" } } }),
				task("odd"),
				inherited,
			],
			[],
			"wrong-out",
		),
		{
			script: {
				steps: {
					odd: () => ({ outcome: "maybe" }) as unknown as HostNodeResult,
					"host-off": [{ outcome: "ok", outputs: { n: "one" } }],
				},
			},
			code: {
				count: () => ({ n: "one" }),
				refuse: () => reject("no count"),
				refuseOff: () => reject("no count", { n: "one" }),
			},
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
	for (const off of ["rejects-off", "host-off"])
		expect(instances[off]).toMatchObject({
			status: "failed",
			reason: "output 'n' must be integer",
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

test("perform checks ports without defaults, so a default under anyOf compiles", async () => {
	const v = {
		type: "object",
		anyOf: [
			{ properties: { a: { type: "integer", default: 1 } } },
			{ required: ["b"] },
		],
	};
	const { result } = await play(
		graph(
			[code("a", "seen", { in: { v }, literals: { v: { b: 2 } }, out: { v } })],
			[],
			"a",
		),
		{ code: { seen: (inputs: { v: unknown }) => ({ v: inputs.v }) } },
	);
	expect(result).toMatchObject({ outcome: "ok", outputs: { v: { b: 2 } } });
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
	expect(instances.write?.inputs).toEqual({});
	expect(instances.read?.inputs).toEqual({ file: ref });
	expect(readFileSync(join(dir, concert, "artifacts", ref.path), "utf8")).toBe(
		"hello",
	);
	expect(scratches).toHaveLength(1);
	expect(kept).toEqual([]);
	expect(
		readdirSync(join(dir, concert, "scratch")).filter((n) => n.startsWith("i")),
	).toHaveLength(1);
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
					kind: "parMap",
					items: ["x", "y"],
					cardinality: { exact: 2 },
					onError: "continue",
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
	const step = async (): Promise<HostNodeResult> => {
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
	const first = await start({
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
		dir,
		concurrency: 1,
	});
	const reader = open();
	const second = await play(quick, {
		script: { steps: { t: [{ outcome: "rejected", reason: "nope" }] } },
		dir,
	});
	expect(await reader.wait(first.id, 1)).toBeUndefined();
	expect(reader.result(first.id)).toBeUndefined();
	expect(reader.concerts({ status: "running" }).map((c) => c.id)).toEqual([
		first.id,
	]);
	gate.resolve();
	expect(await reader.wait(first.id)).toMatchObject({
		status: "ok",
		composition: "slow",
		ir: slow,
	});
	expect(reader.result(first.id)).toEqual({
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
		first.id,
	]);
	expect(reader.concerts({ composition: "quick" }).map((c) => c.id)).toEqual([
		second.concert,
	]);
	expect(reader.instances(first.id)).toMatchObject([
		{ node: "t", status: "ok", outputs: { v: 1 } },
	]);
	await first.done;
	const unknown = "no concert 'nope' in the record. Check the concert id";
	await expect(reader.wait("nope")).rejects.toThrow(unknown);
	expect(() => reader.instances("nope")).toThrow(unknown);
});

const CHANGED = `sha256:${"1".repeat(64)}`;
const UNCHANGED = worker("").codeHash;
const INTEGER = { type: "integer" };

/** The current hashes of a loader that finds `changed` exports altered. */
const hashes =
	(...changed: string[]): CodeHash =>
	(ref) =>
		changed.includes(ref.export) ? CHANGED : ref.codeHash;

const executed = (calls: string[], names: string[]) =>
	Object.fromEntries(
		names.map((n) => [n, calls.filter((c) => c === n).length]),
	);

/** The first line a child process writes to `stream`. */
async function firstLine(stream: ReadableStream<Uint8Array>) {
	const { value } = await stream.getReader().read();
	return new TextDecoder().decode(value).trim();
}

test("a killed concert resumes without repeating an ok host node, and the record keeps the events of both attempts", async () => {
	const { dir, open } = await workspace();
	const ir = graph(
		[
			task("a", { out: { text: STRING } }),
			task("b", { in: { text: STRING }, out: { text: STRING } }),
			task("c", { in: { text: STRING } }),
		],
		[data("a.text", "b.text"), data("b.text", "c.text")],
		"c",
	);
	const irFile = join(dir, "ir.json");
	const script = join(dir, "killed.ts");
	await writeFile(irFile, JSON.stringify(ir));
	await writeFile(
		script,
		`import { perform } from ${JSON.stringify(join(import.meta.dir, "../../core/src/perform/index.ts"))};
		import { fakeHost } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
		await perform({
			ir: await Bun.file(${JSON.stringify(irFile)}).json(),
			config: { values: { dataRoot: ${JSON.stringify(dir)} }, sources: [], layers: [] },
			hosts: [fakeHost({ steps: {
				a: [{ outcome: "ok", outputs: { text: "A" } }],
				b: (_, __, context) => { console.log(context.concert); return new Promise(() => {}); },
			} })],
			loadCode: async () => { throw new Error("no code nodes"); },
			recordPath: ${JSON.stringify(join(dir, "record.db"))},
			dir: ${JSON.stringify(dir)},
			concurrency: 2,
		});`,
	);
	const child = Bun.spawn([process.execPath, script], { stdout: "pipe" });
	const concert = await firstLine(child.stdout);
	child.kill("SIGKILL");
	await child.exited;

	const calls: string[] = [];
	const step = (id: string) => (): HostNodeResult => {
		calls.push(id);
		return { outcome: "ok", outputs: { text: id } };
	};
	const record = open();
	const { result } = await play(concert, {
		dir,
		script: { steps: { a: step("a"), b: step("b"), c: step("c") } },
	});
	expect(calls).toEqual(["b", "c"]);
	expect(result).toMatchObject({ node: "c", outcome: "ok" });
	const a = byInstance(record.instances(concert)).a;
	expect(a?.key).toMatch(/^[0-9a-f]{64}$/);
	const history = (node: string) =>
		record
			.events(concert)
			.filter((e) => e.node === node)
			.map((e) => (e.type === "settled" ? e.reason : e.type));
	expect(history("a")).toEqual(["running", undefined, "reused"]);
	expect(history("b")).toEqual([
		"running",
		"process exited",
		"running",
		undefined,
	]);
});

test("a resume keeps the wired inputs of an instance it reuses", async () => {
	const { dir } = await workspace();
	const ir = graph(
		[
			task("a", { out: { text: STRING } }),
			task("b", { in: { text: STRING }, out: { text: STRING } }),
			task("c", { in: { text: STRING } }),
		],
		[data("a.text", "b.text"), data("b.text", "c.text")],
		"c",
	);
	const first = await play(ir, {
		dir,
		script: {
			steps: {
				a: [{ outcome: "ok", outputs: { text: "A" } }],
				b: [{ outcome: "ok", outputs: { text: "B" } }],
				c: [{ outcome: "failed", reason: "boom" }],
			},
		},
	});
	const before = byInstance(first.record.instances(first.concert)).b;
	expect(before?.inputs).toEqual({ text: "A" });
	const again = await play(first.concert, {
		dir,
		script: { steps: { c: [{ outcome: "ok", outputs: {} }] } },
	});
	const after = byInstance(again.record.instances(first.concert));
	expect(
		again.record
			.events(first.concert)
			.filter((e) => e.node === "b")
			.map((e) => e.type),
	).toContain("reused");
	expect(after.b?.inputs).toEqual({ text: "A" });
	expect(after.a?.inputs).toEqual({});
});

test.each([
	["an output that changes", 2, { seed: 2, mid: 2, leaf: 2, solo: 1 }],
	["an output that stays", 1, { seed: 2, mid: 1, leaf: 1, solo: 1 }],
])(
	"a changed code hash reruns its node, and its dependents only with %s, and the stored IR takes the hash",
	async (_, again, expected) => {
		const calls: string[] = [];
		let value = 1;
		let broken = true;
		const ir = graph(
			[
				code("seed", "seed", { out: { v: INTEGER } }),
				code("mid", "mid", { in: { v: INTEGER }, out: { v: INTEGER } }),
				code("leaf", "leaf", { in: { v: INTEGER }, out: { v: INTEGER } }),
				code("solo", "solo", { out: { v: INTEGER } }),
				code("boom", "boom"),
			],
			[data("seed.v", "mid.v"), data("mid.v", "leaf.v")],
			"boom",
		);
		const through = (name: string) => (ports: { v: number }) => {
			calls.push(name);
			return { v: ports.v };
		};
		const fns = {
			seed: () => {
				calls.push("seed");
				return { v: value };
			},
			mid: through("mid"),
			leaf: through("leaf"),
			solo: () => {
				calls.push("solo");
				return { v: 0 };
			},
			boom: () => {
				if (broken) throw new Error("broken");
				return {};
			},
		};
		const first = await play(ir, { code: fns });
		expect(first.result).toMatchObject({ node: "boom", outcome: "failed" });
		value = again;
		broken = false;
		const { result, record, concert } = await play(first.concert, {
			code: fns,
			codeHash: hashes("seed"),
			dir: first.dir,
		});
		expect(result).toMatchObject({ node: "boom", outcome: "ok" });
		expect(executed(calls, ["seed", "mid", "leaf", "solo"])).toEqual(expected);
		const stored = recorded(record, concert).ir.nodes.flatMap((n) =>
			n.kind === "code" ? [[n.id, n.worker.codeHash]] : [],
		);
		expect(Object.fromEntries(stored)).toEqual({
			seed: CHANGED,
			mid: UNCHANGED,
			leaf: UNCHANGED,
			solo: UNCHANGED,
			boom: UNCHANGED,
		});
	},
);

test("an input artifact counts by its content hash, not its path, so a rewritten identical file leaves its reader reused", async () => {
	const file = { [MAESTRO_TYPE]: CORE_TYPES.file };
	const calls: string[] = [];
	let broken = true;
	const fns = {
		write: async (_: never, ctx: CodeContext) => {
			calls.push("write");
			const path = join(ctx.scratch, "note.txt");
			await writeFile(path, "hello");
			return { file: path };
		},
		read: (ports: { file: ArtifactRef }, ctx: CodeContext) => {
			calls.push("read");
			return { text: readFileSync(ctx.path(ports.file), "utf8") };
		},
		boom: () => {
			if (broken) throw new Error("broken");
			return {};
		},
	};
	const ir = graph(
		[
			code("write", "write", { out: { file } }),
			code("read", "read", { in: { file }, out: { text: STRING } }),
			code("boom", "boom"),
		],
		[data("write.file", "read.file")],
		"boom",
	);
	const first = await play(ir, { code: fns });
	const before = byInstance(first.record.instances(first.concert)).write;
	broken = false;
	const { record, concert } = await play(first.concert, {
		code: fns,
		codeHash: hashes("write"),
		dir: first.dir,
	});
	expect(calls).toEqual(["write", "read", "write"]);
	const after = byInstance(record.instances(concert)).write;
	expect(after?.artifacts).toHaveLength(1);
	expect(after?.artifacts[0]?.contentHash).toBe(
		before?.artifacts[0]?.contentHash,
	);
	expect(after?.artifacts[0]?.path).not.toBe(before?.artifacts[0]?.path);
});

test("of identical parMap instances a resume reruns only the one that did not settle ok", async () => {
	const calls: string[] = [];
	let fixed = false;
	const ir = graph(
		[
			{
				id: "m",
				kind: "parMap",
				items: ["x", "y", "z"],
				cardinality: { exact: 3 },
				onError: "continue",
				inner: { item: STRING },
				out: { results: settledList },
				members: { result: "m/t" },
			},
			task("m/t"),
			task("done", { in: { results: settledList } }),
		],
		[
			{
				kind: "collect",
				from: { node: "m", port: "results" },
				to: { node: "done", port: "results" },
			},
		],
		"done",
	);
	const script: FakeScript = {
		steps: {
			"m/t": ({ expansion }): HostNodeResult => {
				calls.push(expansion);
				return expansion === "[y]" && !fixed
					? { outcome: "failed", reason: "flaked" }
					: { outcome: "ok", outputs: {} };
			},
			done: (_, inputs): HostNodeResult => {
				calls.push("done");
				const results = inputs.results as Settled<unknown>[];
				return results.every((r) => r.outcome === "ok")
					? { outcome: "ok", outputs: {} }
					: { outcome: "failed", reason: "a member failed" };
			},
		},
	};
	const first = await play(ir, { script });
	expect(first.result).toMatchObject({ node: "done", outcome: "failed" });
	calls.length = 0;
	fixed = true;
	const { result } = await play(first.concert, {
		script,
		dir: first.dir,
	});
	expect(result).toMatchObject({ node: "done", outcome: "ok" });
	expect(calls).toEqual(["[y]", "done"]);
});

test("a host that rejects then accepts resumes to completion, the spend of both attempts kept", async () => {
	let aCalls = 0;
	const ir = graph(
		[
			task("a", { out: { text: STRING } }),
			task("v", { in: { text: STRING }, out: { text: STRING } }),
			task("c", { in: { text: STRING } }),
		],
		[data("a.text", "v.text"), data("v.text", "c.text")],
		"c",
	);
	const hosts = [
		fakeHost({
			steps: {
				a: (): HostNodeResult => {
					aCalls++;
					return { outcome: "ok", outputs: { text: "A" } };
				},
				v: [
					{ outcome: "rejected", reason: "not yet", metrics: { tokens: 5 } },
					{ outcome: "ok", outputs: { text: "V" }, metrics: { tokens: 7 } },
				],
			},
		}),
	];
	const first = await play(ir, { hosts });
	expect(first.result).toMatchObject({ node: "v", outcome: "rejected" });
	const { result, record, concert } = await play(first.concert, {
		hosts,
		dir: first.dir,
	});
	expect(result).toMatchObject({ node: "c", outcome: "ok" });
	expect(aCalls).toBe(1);
	expect(record.metrics(concert)).toEqual({ tokens: 12 });
	expect(record.instances(concert).map((i) => [i.node, i.status])).toEqual([
		["a", "ok"],
		["v", "ok"],
		["c", "ok"],
	]);
});

test("each host gets its own config namespaces and store in environment and execute, and no other host's", async () => {
	const { dir } = await workspace();
	const seen: Record<string, HostSetup> = {};
	const watching =
		(name: string): Host["environment"] =>
		(setup) => {
			seen[name] = setup;
			return {};
		};
	const first = fakeHost({
		steps: {
			t: (_, __, context) => {
				seen.execute = context.setup;
				return { outcome: "ok", outputs: {} };
			},
		},
	});
	const hosts: Host[] = [
		{
			...first,
			config: { fake: { type: "object" } },
			environment: watching("fake"),
		},
		{
			...fakeHost(),
			name: "other",
			kinds: [],
			config: { other: { type: "object" } },
			environment: watching("other"),
		},
	];
	const concert = await start({
		ir: graph([task("t")], [], "t"),
		hosts,
		loadCode: loader({}),
		config: {
			values: {
				fake: { retries: 2 },
				other: { depth: 1 },
				dataRoot: dir,
			},
			sources: [],
			layers: [],
		},
		dir,
		concurrency: 1,
	});
	await concert.done;
	const fake = {
		config: { fake: { retries: 2 } },
		sources: [],
		layers: [],
		commandLine: { values: {}, replaced: [] },
		store: join(dir, "hosts/fake"),
		roots: { user: join(dir, "roots"), packs: {} },
	};
	expect(seen).toEqual({
		fake,
		execute: fake,
		other: {
			config: { other: { depth: 1 } },
			sources: [],
			layers: [],
			commandLine: { values: {}, replaced: [] },
			store: join(dir, "hosts/other"),
			roots: { user: join(dir, "roots"), packs: {} },
		},
	});
});

test("two hosts registering one node kind are refused, and nothing is recorded", async () => {
	const { dir, open } = await workspace();
	await expect(
		start({
			ir: graph([task("t")], [], "t"),
			hosts: [fakeHost(), { ...fakeHost(), name: "other" }],
			loadCode: loader({}),
			dir,
			concurrency: 1,
		}),
	).rejects.toThrow(
		"node kind 'fake.task' is registered twice, by host 'fake' and by host 'other'\nLoad only one host that registers 'fake.task'",
	);
	expect(open().concerts()).toEqual([]);
});

test("a concert whose process is alive is not resumed, and the refusal names its process", async () => {
	const { dir } = await workspace();
	const started = Promise.withResolvers<void>();
	const options = {
		hosts: [
			fakeHost({
				steps: {
					t: () => {
						started.resolve();
						return pending();
					},
				},
			}),
		],
		loadCode: loader({}),
		dir,
		concurrency: 1,
	};
	const ir = graph([task("t")], [], "t");
	const live = await start({ ...options, ir });
	await started.promise;
	let refused: Promise<unknown> | undefined;
	expect(() => {
		refused = start({ ...options, ir, resume: live.id });
	}).not.toThrow();
	await expect(refused).rejects.toThrow(
		`concert '${live.id}' is still running in process ${process.pid}\nWait for it to settle, or kill it, then resume it`,
	);
	await live.cancel();
	await live.done;
});

test("a concert that finished ok is not resumed", async () => {
	const first = await play(graph([task("t")], [], "t"));
	await expect(play(first.concert, { dir: first.dir })).rejects.toThrow(
		`concert '${first.concert}' finished ok, so it has nothing to resume\nPerform its composition as a new concert`,
	);
});

describe("an encore", () => {
	const looped = graph(
		[
			{
				id: "m",
				kind: "parMap",
				items: ["x"],
				cardinality: { exact: 1 },
				onError: "stop",
				inner: { item: STRING },
				out: { results: settledList },
				members: { result: "m/l" },
			},
			{
				id: "m/l",
				kind: "loop",
				cardinality: { upTo: 2 },
				in: { more: BOOL },
				literals: { more: true },
				inner: { ...LOOP_INNER, more: BOOL },
				out: { more: BOOL },
				members: { result: "m/l/t" },
				test: { at: "end", port: { node: "m/l/t", port: "more" } },
			},
			task("m/l/t", { out: { more: BOOL } }),
		],
		[],
		"m",
	);
	const options = async (
		steps: FakeScript["steps"],
		facts: Record<string, unknown> = {},
	) => ({
		hosts: [{ ...fakeHost({ steps }), environment: () => facts }],
		loadCode: loader({}),
		dir: (await workspace()).dir,
		concurrency: 1,
	});

	test("is linked to its concert, which its hosts are told with each instance's group kinds, a resume of it too", async () => {
		const seen: unknown[] = [];
		let fail = false;
		const base = await options({
			"m/l/t": ({ groups, expansion }, _, { encore }) => {
				seen.push([encore, groups, expansion]);
				return fail
					? { outcome: "failed", reason: "flaked" }
					: { outcome: "ok", outputs: { more: expansion.endsWith("[0]") } };
			},
		});
		const first = await start({ ...base, ir: looped });
		await first.done;
		fail = true;
		const config = {
			values: { dataRoot: base.dir, round: 2 },
			sources: [],
			layers: [],
		};
		const encore = await start({
			...base,
			config,
			ir: looped,
			encore: first.id,
		});
		expect(await encore.done).toMatchObject({ outcome: "failed" });
		fail = false;
		const resumed = await start({
			...base,
			config,
			ir: looped,
			resume: encore.id,
		});
		expect(await resumed.done).toMatchObject({ outcome: "ok" });
		const record = readerIn(base.dir);
		expect(record.find(encore.id)?.encoreOf).toBe(first.id);
		expect(record.find(first.id)).not.toHaveProperty("encoreOf");
		const nested = ["parMap", "loop"];
		expect(seen).toEqual([
			[undefined, nested, "[x][0]"],
			[undefined, nested, "[x][1]"],
			[first.id, nested, "[x][0]"],
			[first.id, nested, "[x][0]"],
			[first.id, nested, "[x][1]"],
		]);
	});

	test("is refused while its concert is live, or when IR, config and host facts all match it, and records nothing; another IR alone is not", async () => {
		const started = Promise.withResolvers<void>();
		const base = await options(
			{
				"m/l/t": () => {
					started.resolve();
					return pending();
				},
			},
			{ revision: "a" },
		);
		const live = await start({ ...base, ir: looped });
		await started.promise;
		await expect(
			start({ ...base, ir: looped, encore: live.id }),
		).rejects.toThrow(
			`concert '${live.id}' is still running in process ${process.pid}\nWait for it to settle, or kill it, then perform its encore`,
		);
		await live.cancel();
		await live.done;
		await expect(
			start({ ...base, ir: looped, encore: live.id }),
		).rejects.toThrow(
			`concert '${live.id}' was performed from the same IR, config and host facts\nChange one of them, or resume it`,
		);
		expect(readerIn(base.dir).ids()).toEqual([live.id]);
		const done = { outcome: "ok" as const, outputs: { more: false } };
		const moved = {
			...base,
			hosts: [
				{
					...fakeHost({ steps: { "m/l/t": () => done, t: () => done } }),
					environment: () => ({ revision: "b" }),
				},
			],
		};
		const encore = await start({ ...moved, ir: looped, encore: live.id });
		expect(await encore.done).toMatchObject({ outcome: "ok" });
		await expect(
			start({ ...moved, ir: looped, encore: encore.id }),
		).rejects.toMatchObject({
			message: `concert '${encore.id}' was performed from the same IR, config and host facts\nChange one of them`,
		});
		const other = graph([task("t")], [], "t");
		const reshaped = await start({ ...moved, ir: other, encore: encore.id });
		expect(await reshaped.done).toMatchObject({ outcome: "ok" });
	});
});

test("a resume marks the records it has not revisited stale, and keeps their spend", async () => {
	const hosts = [
		fakeHost({
			steps: {
				a: [{ outcome: "ok", outputs: { text: "A" }, metrics: { tokens: 3 } }],
				b: [{ outcome: "failed", reason: "flaked" }],
			},
		}),
	];
	const ir = graph(
		[task("a", { out: { text: STRING } }), task("b", { in: { text: STRING } })],
		[data("a.text", "b.text")],
		"b",
	);
	const first = await play(ir, { hosts });
	const stale = () =>
		first.record.instances(first.concert).map((i) => [i.node, i.stale]);
	expect(stale()).toEqual([
		["a", false],
		["b", false],
	]);
	const cancelled = await start({
		ir,
		resume: first.concert,
		hosts,
		loadCode: loader({}),
		dir: first.dir,
		concurrency: 1,
	});
	await cancelled.cancel();
	await cancelled.done;
	expect(stale()).toEqual([
		["a", true],
		["b", true],
	]);
	expect(first.record.metrics(first.concert)).toEqual({ tokens: 3 });
	await play(first.concert, { hosts, dir: first.dir });
	expect(stale().every(([, s]) => s === false)).toBe(true);
	expect(first.record.metrics(first.concert)).toEqual({ tokens: 3 });
});
