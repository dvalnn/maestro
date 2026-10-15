import type {
	Execution,
	Host,
	HostContext,
	HostInstance,
	NodeKind,
} from "@maestro/core/host";
import type { Inputs } from "@maestro/core/worker";

export const FAKE_TASK = "fake.task";

export const CANCELLED: Execution = { outcome: "failed", reason: "cancelled" };

const UNSCRIPTED: Execution = { outcome: "ok", outputs: {} };

/** A pending promise holds its instance until it settles or the instance is cancelled. */
export type Step = Execution | Promise<Execution>;

/**
 * The steps of one node's instances. A list is taken in order, one step per instance started, and its last step
 * repeats. A function picks the step per instance, and may emit events through `context`.
 */
export type Steps =
	| readonly Step[]
	| ((instance: HostInstance, inputs: Inputs, context: HostContext) => Step);

export type FakeScript = {
	/** Steps by node id. A node without steps settles `ok` with no outputs. */
	steps?: Readonly<Record<string, Steps>>;
	validate?: Host["validate"];
	bounds?: Host["bounds"];
};

/** A host named `fake` with one kind, `fake.task`. Its nodes take any ports, and settle as `script` says. */
export function fakeHost(script: FakeScript = {}): Host {
	return {
		name: "fake",
		kinds: [fakeTask(script.steps ?? {})],
		types: [],
		config: {},
		validate: script.validate ?? (() => []),
		bounds: script.bounds ?? (() => ({})),
		environment: () => ({}),
	};
}

function fakeTask(steps: Readonly<Record<string, Steps>>): NodeKind {
	const started = new Map<string, number>();
	const cancels = new Map<string, () => void>();
	const key = ({ node, expansion }: HostInstance) => `${node.id}\0${expansion}`;

	const step = (
		instance: HostInstance,
		inputs: Inputs,
		context: HostContext,
	): Step => {
		const id = instance.node.id;
		const script = Object.hasOwn(steps, id) ? steps[id] : undefined;
		if (typeof script === "function") return script(instance, inputs, context);
		const n = started.get(id) ?? 0;
		started.set(id, n + 1);
		return script?.[Math.min(n, script.length - 1)] ?? UNSCRIPTED;
	};

	return {
		name: FAKE_TASK,
		config: { type: "object" },
		outcomes: ["ok", "rejected", "failed"],
		cacheable: false,
		ports: (node) => ({ in: node.in ?? {}, out: node.out ?? {} }),
		async execute(instance, inputs, context) {
			const cancelled = new Promise<Execution>((settle) => {
				cancels.set(key(instance), () => settle(CANCELLED));
			});
			try {
				return await Promise.race([step(instance, inputs, context), cancelled]);
			} finally {
				cancels.delete(key(instance));
			}
		},
		async cancel(instance) {
			cancels.get(key(instance))?.();
		},
	};
}
