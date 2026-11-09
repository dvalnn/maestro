import { join } from "node:path";
import {
	type AssertNode,
	artifactsAsRefs,
	type CodeNode,
	type Facts,
	type HostNode,
	type JsonSchema,
	messageOf,
	type NodeInstance,
	type Ports,
	type Validator,
} from "@maestro/ir";
import type { ValidateFunction } from "ajv/dist/2020";
import type {
	Host,
	HostContext,
	HostInstance,
	HostNodeResult,
	HostSetup,
	Metrics,
} from "../host";
import type { Inputs, NodeResult } from "../node";
import { type HostKind, isOutputs, isRecord } from "../shared";
import { type ConcertDirs, collectArtifacts } from "./artifacts";
import type { RecordWriter, Settling } from "./record";
import type { Invocation, Worker } from "./ts-worker";

/** What executing a concert's leaf instances needs. */
export type Kit = {
	concert: string;
	/** The concert this one is an encore of. */
	encore?: string;
	record: RecordWriter;
	dirs: ConcertDirs;
	/** Each host's facts, by host name. */
	env: Readonly<Record<string, Facts>>;
	kinds: (name: string) => HostKind | undefined;
	setup: (host: Host) => HostSetup;
	/** By runtime name. */
	workers: ReadonlyMap<string, Worker>;
	check: PortCheck;
};

/**
 * One leaf instance's executor, and the hook that cancels it. Neither throws: `invoke` settles `failed` on a throw or
 * a malformed return, and a failed cancel goes to the instance's log.
 */
type Call = {
	invoke(): Promise<HostNodeResult>;
	cancel(): Promise<void>;
};

/** An `assert` settles `ok` on a true `cond`, else with its `onFail` outcome and its message. */
export const asserted = (node: AssertNode, inputs: Inputs): Settling =>
	inputs.cond === true
		? { outcome: "ok", outputs: {} }
		: { outcome: node.onFail, reason: node.message };

/** Where an instance executes, and how a host sees it. */
type Placed = Pick<HostInstance, "id" | "groups" | "composition" | "pack"> & {
	scratch: string;
	clock: number;
};

/** The call of a code instance through its runtime's worker, or of a host instance through its kind. */
export function callOf(
	kit: Kit,
	node: CodeNode | HostNode,
	instance: NodeInstance,
	inputs: Inputs,
	context: Placed,
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
		in: node.in,
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
	{ scratch, clock, id, groups, composition, pack }: Placed,
): Call {
	const found = kit.kinds(node.kind);
	if (!found)
		return refused(
			`no loaded host registers node kind '${node.kind}'. Load the host that registers it`,
		);
	const hostInstance = {
		node,
		expansion: instance.expansion,
		id,
		groups,
		composition,
		pack,
	};
	const context: HostContext = {
		concert: kit.concert,
		...(kit.encore !== undefined && { encore: kit.encore }),
		clock,
		scratch,
		path: (ref) => join(kit.dirs.artifacts, ref.path),
		setup: kit.setup(found.host),
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

/** What `call` returned, parsed, or `failed` with why it could not be: a throw, or a value that is no `HostNodeResult`. */
async function guarded(
	call: () => Promise<unknown>,
	who: string,
): Promise<HostNodeResult> {
	let returned: unknown;
	try {
		returned = await call();
	} catch (error) {
		return { outcome: "failed", reason: messageOf(error) };
	}
	const result = hostResultOf(returned);
	if (typeof result !== "string") return result;
	return {
		outcome: "failed",
		reason: `${who} returned ${result}. Report this to its author`,
	};
}

/** `value` as a `HostNodeResult`, or what is wrong with it. */
function hostResultOf(value: unknown): HostNodeResult | string {
	if (!isRecord(value)) return "a value that is not an object";
	const node = nodeResultIn(value);
	if (typeof node === "string") return node;
	const { metrics, enrichment } = value;
	if (metrics !== undefined && !isMetrics(metrics))
		return "metrics that are not numbers by name";
	if (enrichment !== undefined && !isRecord(enrichment))
		return "enrichment that is not an object";
	return {
		...node,
		...(metrics !== undefined && { metrics }),
		...(enrichment !== undefined && { enrichment }),
	};
}

function nodeResultIn(value: Record<string, unknown>): NodeResult | string {
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
 * `result` with its written artifacts moved into the area (ADR 0007), and its outputs checked against the node's
 * `out` ports when it settled `ok` or `rejected` (sdk-spec: Code nodes, ADR 0008). A failed move or check settles
 * `failed`.
 */
export async function finish(
	kit: Kit,
	node: CodeNode | HostNode,
	instance: NodeInstance,
	scratch: string,
	result: HostNodeResult,
): Promise<Settling> {
	if (result.outputs === undefined) return result;
	const { metrics, enrichment } = result;
	try {
		const { outputs, artifacts } = await collectArtifacts(
			node.out,
			result.outputs,
			scratch,
			kit.dirs.artifacts,
			instance,
		);
		const mismatch =
			result.outcome === "failed"
				? undefined
				: kit.check(node.out, outputs, "output");
		if (mismatch)
			return {
				outcome: "failed",
				reason: mismatch,
				metrics,
				enrichment,
				artifacts,
			};
		return { ...result, outputs, artifacts };
	} catch (error) {
		return { outcome: "failed", reason: messageOf(error), metrics, enrichment };
	}
}

/**
 * `work`, or what `late` gives once `limit.timeout` milliseconds pass first, with the reason naming `limit.name` and
 * the timeout. Work past its timeout is abandoned, as an in-process function cannot be stopped. No `timeout` is no
 * limit.
 */
export async function timed<T>(
	work: Promise<T>,
	limit: { name: string; timeout: number | undefined },
	late: (reason: string) => T | Promise<T>,
): Promise<T> {
	const { name, timeout } = limit;
	if (timeout === undefined) return work;
	const reason = `node '${name}' ran past its timeout of ${timeout} ms`;
	let timer: Timer | undefined;
	const expired = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(late(reason)), timeout);
	});
	try {
		return await Promise.race([work, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** Checks values by port name against `ports`. Returns the first mismatch as a sentence, or `undefined`. */
export type PortCheck = (
	ports: Ports | undefined,
	values: Readonly<Record<string, unknown>>,
	side: "input" | "output",
) => string | undefined;

/**
 * A `PortCheck` over `ajv` that checks a copy of each value, so no default is written into it. An artifact is checked
 * as its `ArtifactRef`, not its content (ADR 0007).
 */
export function portCheck(ajv: Validator): PortCheck {
	const compiled = new Map<JsonSchema, ValidateFunction>();
	const compile = (schema: JsonSchema) => {
		const known = compiled.get(schema);
		if (known) return known;
		const validate = ajv.compile(artifactsAsRefs(schema));
		compiled.set(schema, validate);
		return validate;
	};
	return (ports, values, side) => {
		for (const [port, schema] of Object.entries(ports ?? {})) {
			const where = `${side} '${port}'`;
			const mismatch = checkValue(compile, schema, values[port], where);
			if (mismatch) return mismatch;
		}
	};
}

function checkValue(
	compile: (schema: JsonSchema) => ValidateFunction,
	schema: JsonSchema,
	value: unknown,
	where: string,
): string | undefined {
	if (value === undefined) return `${where} has no value`;
	let validate: ValidateFunction;
	try {
		validate = compile(schema);
	} catch (error) {
		return `${where} has a schema that does not compile: ${messageOf(error)}`;
	}
	if (validate(structuredClone(value))) return undefined;
	const error = validate.errors?.[0];
	const at = error?.instancePath ? ` at ${error.instancePath}` : "";
	return `${where}${at} ${error?.message ?? "does not match its schema"}`;
}
