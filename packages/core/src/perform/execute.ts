import { join } from "node:path";
import type { AssertNode, CodeNode, Facts, HostNode } from "@maestro/ir";
import type { Execution, HostContext, HostKind, Metrics } from "../host";
import type {
	Inputs,
	Invocation,
	NodeInstance,
	Settlement,
	Worker,
} from "../worker";
import { type ConcertDirs, collectArtifacts } from "./artifacts";
import type { PortCheck } from "./ports";
import type { RecordStore, Settling } from "./record";
import { isOutputs, isRecord, messageOf } from "./ts-worker";

/** What executing a concert's leaf instances needs. */
export type Kit = {
	concert: string;
	record: RecordStore;
	dirs: ConcertDirs;
	/** Each host's facts, by host name, frozen. */
	env: Readonly<Record<string, Facts>>;
	kinds: (name: string) => HostKind | undefined;
	/** By runtime name. */
	workers: ReadonlyMap<string, Worker>;
	check: PortCheck;
};

/**
 * One leaf instance's executor, and the hook that cancels it. Neither throws: `invoke` settles `failed` on a throw or
 * a malformed return, and a failed cancel goes to the instance's log.
 */
type Call = {
	invoke(): Promise<Execution>;
	cancel(): Promise<void>;
};

/** An `assert` settles `ok` on a true `cond`, else with its `onFail` outcome and its message. */
export const asserted = (node: AssertNode, inputs: Inputs): Settling =>
	inputs.cond === true
		? { outcome: "ok", outputs: {} }
		: { outcome: node.onFail, reason: node.message };

/** The call of a code instance through its runtime's worker, or of a host instance through its kind. */
export function callOf(
	kit: Kit,
	node: CodeNode | HostNode,
	instance: NodeInstance,
	inputs: Inputs,
	context: { scratch: string; clock: number },
): Call {
	return node.kind === "code"
		? codeCall(kit, node, instance, inputs, context)
		: hostCall(kit, node, instance, inputs, context);
}

function codeCall(
	kit: Kit,
	node: CodeNode,
	instance: NodeInstance,
	inputs: Inputs,
	{ scratch, clock }: { scratch: string; clock: number },
): Call {
	const { runtime } = node.worker;
	const worker = kit.workers.get(runtime);
	if (!worker)
		return refused(
			`no worker serves runtime '${runtime}'. Use one of: ${[...kit.workers.keys()].join(", ")}`,
		);
	const invocation: Invocation = {
		instance,
		worker: node.worker,
		inputs,
		context: {
			concert: kit.concert,
			clock,
			scratch,
			env: kit.env,
			artifacts: kit.dirs.artifacts,
		},
	};
	const log = logOf(kit, instance);
	return {
		invoke: () =>
			guarded(() => worker.invoke(invocation, log), `worker '${runtime}'`),
		cancel: logged(() => worker.cancel(instance), log),
	};
}

function hostCall(
	kit: Kit,
	node: HostNode,
	instance: NodeInstance,
	inputs: Inputs,
	{ scratch, clock }: { scratch: string; clock: number },
): Call {
	const found = kit.kinds(node.kind);
	if (!found)
		return refused(
			`no loaded host registers node kind '${node.kind}'. Load the host that registers it`,
		);
	const hostInstance = { node, expansion: instance.expansion };
	const context: HostContext = {
		concert: kit.concert,
		clock,
		scratch,
		path: (ref) => join(kit.dirs.artifacts, ref.path),
		emit: (event) =>
			kit.record.note(
				kit.concert,
				instance,
				{ type: "progress", event },
				Date.now(),
			),
	};
	return {
		invoke: () =>
			guarded(
				() => found.kind.execute(hostInstance, inputs, context),
				`node kind '${node.kind}'`,
			),
		cancel: logged(() => found.kind.cancel(hostInstance), logOf(kit, instance)),
	};
}

const logOf = (kit: Kit, instance: NodeInstance) => (line: string) =>
	kit.record.note(kit.concert, instance, { type: "log", line }, Date.now());

const logged =
	(cancel: () => Promise<void>, log: (line: string) => void) => async () => {
		try {
			await cancel();
		} catch (error) {
			log(`cancel failed: ${messageOf(error)}`);
		}
	};

const refused = (reason: string): Call => ({
	invoke: async () => ({ outcome: "failed", reason }),
	cancel: async () => {},
});

/** What `call` returned, parsed, or `failed` with why it could not be: a throw, or a value that is no `Execution`. */
async function guarded(
	call: () => Promise<unknown>,
	who: string,
): Promise<Execution> {
	let returned: unknown;
	try {
		returned = await call();
	} catch (error) {
		return { outcome: "failed", reason: messageOf(error) };
	}
	const execution = executionOf(returned);
	if (typeof execution !== "string") return execution;
	return {
		outcome: "failed",
		reason: `${who} returned ${execution}. Report this to its author`,
	};
}

/** `value` as an `Execution`, or what is wrong with it. */
function executionOf(value: unknown): Execution | string {
	if (!isRecord(value)) return "a value that is not an object";
	const settlement = settlementIn(value);
	if (typeof settlement === "string") return settlement;
	const { metrics, enrichment } = value;
	if (metrics !== undefined && !isMetrics(metrics))
		return "metrics that are not numbers by name";
	if (enrichment !== undefined && !isRecord(enrichment))
		return "enrichment that is not an object";
	return {
		...settlement,
		...(metrics !== undefined && { metrics }),
		...(enrichment !== undefined && { enrichment }),
	};
}

function settlementIn(value: Record<string, unknown>): Settlement | string {
	const { outcome, reason, outputs } = value;
	if (outcome === "ok")
		return isOutputs(outputs)
			? { outcome, outputs }
			: "outcome 'ok' without outputs by port name";
	if (outcome !== "rejected" && outcome !== "failed")
		return `the outcome ${JSON.stringify(outcome)}, not one of: ok, rejected, failed`;
	if (typeof reason !== "string")
		return `outcome '${outcome}' without a reason`;
	if (outputs !== undefined && !isOutputs(outputs))
		return "outputs that are not values by port name";
	return { outcome, reason, ...(outputs !== undefined && { outputs }) };
}

const isMetrics = (value: unknown): value is Metrics =>
	isRecord(value) &&
	Object.values(value).every(
		(n) => typeof n === "number" && Number.isFinite(n),
	);

/**
 * `execution` with its written artifacts moved into the area (ADR 0007), and a code node's `ok` outputs checked
 * against its `out` ports (sdk-spec 7). A failed move or check settles `failed`.
 */
export async function finish(
	kit: Kit,
	node: CodeNode | HostNode,
	instance: NodeInstance,
	scratch: string,
	execution: Execution,
): Promise<Settling> {
	if (execution.outputs === undefined) return execution;
	const { metrics, enrichment } = execution;
	try {
		const { outputs, artifacts } = await collectArtifacts(
			node.out,
			execution.outputs,
			scratch,
			kit.dirs.artifacts,
			instance,
		);
		const checked = node.kind === "code" && execution.outcome === "ok";
		const mismatch = checked
			? kit.check(node.out, outputs, "output")
			: undefined;
		if (mismatch)
			return {
				outcome: "failed",
				reason: mismatch,
				metrics,
				enrichment,
				artifacts,
			};
		return { ...execution, outputs, artifacts };
	} catch (error) {
		return { outcome: "failed", reason: messageOf(error), metrics, enrichment };
	}
}
