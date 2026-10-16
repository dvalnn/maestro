import { expect, test } from "bun:test";
import {
	type Host,
	type HostContext,
	type HostEvent,
	type HostInstance,
	kindLookup,
} from "@maestro/core/host";
import {
	type Diagnostic,
	type HostNode,
	type Ir,
	indexGraph,
} from "@maestro/ir";
import {
	CANCELLED,
	FAKE_HANDLE,
	FAKE_TASK,
	type FakeScript,
	fakeHost,
} from "./index";

const node: HostNode = {
	id: "loop/step",
	kind: FAKE_TASK,
	in: { prompt: { type: "string" } },
	out: { text: { type: "string" } },
};
const emitted: HostEvent[] = [];
const context: HostContext = {
	concert: "c1",
	clock: 0,
	path: (ref) => `/area/${ref.path}`,
	scratch: "/scratch/c1",
	emit: (event) => emitted.push(event),
};
const at = (expansion: string): HostInstance => ({ node, expansion });

function fakeTask(script: FakeScript) {
	const kind = kindLookup([fakeHost(script)])(FAKE_TASK)?.kind;
	if (!kind) throw new Error(`${FAKE_TASK} is not registered`);
	return kind;
}

test("the fake host satisfies the host interface", () => {
	// The annotation is the check: tsc fails here if the fake drifts from Host.
	const host: Host = fakeHost();
	expect(host.kinds.map((k) => k.name)).toEqual([FAKE_TASK]);
});

test("the fake host parses a handle param, and refuses malformed text", () => {
	const host = fakeHost();
	expect(host.param?.(FAKE_HANDLE, "item#3")).toEqual({
		value: { name: "item", number: 3 },
	});
	expect(host.param?.(FAKE_HANDLE, "item")).toEqual({
		diagnostics: [expect.objectContaining({ code: "HOST.param" })],
	});
});

test("a node's listed steps settle its instances in order, the last repeating", async () => {
	const task = fakeTask({
		steps: {
			[node.id]: [
				{ outcome: "rejected", reason: "not yet" },
				{ outcome: "ok", outputs: { text: "done" } },
			],
		},
	});
	const outcomes = [];
	for (const expansion of ["a", "b", "c"])
		outcomes.push(await task.execute(at(expansion), {}, context));
	expect(outcomes).toEqual([
		{ outcome: "rejected", reason: "not yet" },
		{ outcome: "ok", outputs: { text: "done" } },
		{ outcome: "ok", outputs: { text: "done" } },
	]);
});

test("a step function settles each instance from its instance and inputs, emitting through its context", async () => {
	const task = fakeTask({
		steps: {
			[node.id]: (instance, inputs, { emit }) => {
				emit({ started: instance.expansion });
				return inputs.prompt === "bad"
					? { outcome: "failed", reason: instance.expansion }
					: { outcome: "ok", outputs: { text: String(inputs.prompt) } };
			},
		},
	});
	expect(await task.execute(at("x"), { prompt: "bad" }, context)).toEqual({
		outcome: "failed",
		reason: "x",
	});
	expect(await task.execute(at("y"), { prompt: "hi" }, context)).toEqual({
		outcome: "ok",
		outputs: { text: "hi" },
	});
	expect(emitted).toEqual([{ started: "x" }, { started: "y" }]);
});

test("an unscripted node settles ok with no outputs", async () => {
	expect(await fakeTask({}).execute(at("a"), {}, context)).toEqual({
		outcome: "ok",
		outputs: {},
	});
});

test("cancel settles a pending instance and leaves the others running", async () => {
	const task = fakeTask({ steps: { [node.id]: [new Promise(() => {})] } });
	const first = task.execute(at("a"), {}, context);
	const second = task.execute(at("b"), {}, context);
	await task.cancel(at("a"));
	expect(await first).toEqual(CANCELLED);
	const raced = await Promise.race([
		second,
		Bun.sleep(5).then(() => "pending"),
	]);
	expect(raced).toBe("pending");
	await task.cancel(at("b"));
	expect(await second).toEqual(CANCELLED);
});

test("validate, bounds, release and usage return what the script says, and nothing by default", async () => {
	const ir: Ir = {
		irVersion: "1.0",
		composition: { id: "fake", version: "1", pack: "fake" },
		emitter: { name: "hand", version: "1" },
		scopes: [],
		nodes: [node],
		edges: [],
		result: { node: node.id },
	};
	const graph = indexGraph(ir);
	const diagnostic: Diagnostic = {
		code: "HOST.fake",
		severity: "error",
		message: "scripted",
		hint: "Unscript it",
		node: node.id,
	};
	const released: string[] = [];
	const scripted = fakeHost({
		validate: () => [diagnostic],
		bounds: () => ({ "fake.tasks": 2 }),
		release: (concert) => {
			released.push(concert);
		},
		usage: async (concert) => concert.length,
	});
	expect(await scripted.validate(graph)).toEqual([diagnostic]);
	expect(scripted.bounds(node)).toEqual({ "fake.tasks": 2 });
	expect(await fakeHost().validate(graph)).toEqual([]);
	expect(fakeHost().bounds(node)).toEqual({});
	await scripted.release?.("abc");
	expect(released).toEqual(["abc"]);
	expect(await scripted.usage?.("abc")).toBe(3);
	expect(await fakeHost().release?.("abc")).toBeUndefined();
	expect(await fakeHost().usage?.("abc")).toBe(0);
});
