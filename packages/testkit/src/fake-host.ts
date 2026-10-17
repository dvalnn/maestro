import type {
	Host,
	HostContext,
	HostInstance,
	HostNodeResult,
	HostResources,
	NodeKind,
} from "@maestro/core/host";
import type { Inputs } from "@maestro/core/node";

export const FAKE_TASK = "fake.task";

/** The fake host's one type: a handle written `<name>#<number>`, whose value is `{ name, number }`. */
export const FAKE_HANDLE = "fake.handle";

const HANDLE = /^([a-z]+)#(\d+)$/;

export const CANCELLED: HostNodeResult = {
	outcome: "failed",
	reason: "cancelled",
};

const UNSCRIPTED: HostNodeResult = { outcome: "ok", outputs: {} };

/** A pending promise holds its instance until it settles or the instance is cancelled. */
export type Step = HostNodeResult | Promise<HostNodeResult>;

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
	/** Called with the concert and the host's setup when the host is asked to release it. Releases nothing by default. */
	release?: HostResources["release"];
	/** The bytes the host reports holding for a concert. 0 by default. */
	usage?: HostResources["usage"];
};

/**
 * A host named `fake` with one kind, `fake.task`, and one type, `fake.handle`. Its nodes take any ports, and settle as
 * `script` says.
 */
export function fakeHost(script: FakeScript = {}): Host {
	return {
		name: "fake",
		kinds: [fakeTask(script.steps ?? {})],
		types: [FAKE_HANDLE],
		config: {},
		validate: script.validate ?? (() => []),
		bounds: script.bounds ?? (() => ({})),
		environment: () => ({}),
		resources: {
			release: script.release ?? (() => {}),
			usage: script.usage ?? (() => 0),
		},
		param: (type, text) => {
			const match = type === FAKE_HANDLE ? HANDLE.exec(text) : null;
			if (match) return { value: { name: match[1], number: Number(match[2]) } };
			return {
				diagnostics: [
					{
						code: "HOST.param",
						severity: "error",
						message: `'${text}' is not a ${type}`,
						hint: "Write a handle as <name>#<number>, for example 'item#3'",
					},
				],
			};
		},
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
		ports: (node) => ({ in: node.in ?? {}, out: node.out ?? {} }),
		async execute(instance, inputs, context) {
			const cancelled = new Promise<HostNodeResult>((settle) => {
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
