import { join } from "node:path";
import { type CodeContext, IR_VERSION, TS_RUNTIME } from "@maestro/ir";
import type { PortCheck } from "../ports";
import { instanceKey, loadFunction, messageOf } from "../shared";
import {
	type Invocation,
	invokeCode,
	type LoadCode,
	type Settlement,
	type Worker,
} from "../worker";

const CANCELLED: Settlement = { outcome: "failed", reason: "cancelled" };

/**
 * The in-process worker of the `ts` runtime (CORE-14). It settles each invocation through `invokeCode`, with the
 * function `loadCode` resolves (ADR 0008). `cancel` settles the invocation `failed` at once and abandons the function,
 * which an in-process worker cannot stop. A line the function logs once its invocation has settled is dropped.
 */
export function tsWorker(loadCode: LoadCode, check: PortCheck): Worker {
	const cancels = new Map<string, () => void>();
	return {
		handshake: {
			runtime: TS_RUNTIME,
			version: Bun.version,
			irVersion: IR_VERSION,
		},
		async invoke(invocation, log) {
			const id = instanceKey(invocation.instance);
			const cancelled = new Promise<Settlement>((settle) => {
				cancels.set(id, () => settle(CANCELLED));
			});
			let settled = false;
			const live = (line: string) => {
				if (!settled) log(line);
			};
			try {
				return await Promise.race([
					call(loadCode, check, invocation, live),
					cancelled,
				]);
			} catch (error) {
				return { outcome: "failed", reason: messageOf(error) };
			} finally {
				settled = true;
				cancels.delete(id);
			}
		},
		async cancel(instance) {
			cancels.get(instanceKey(instance))?.();
		},
	};
}

async function call(
	loadCode: LoadCode,
	check: PortCheck,
	{ worker, in: ports, inputs, context }: Invocation,
	log: (line: string) => void,
): Promise<Settlement> {
	const fn = await loadFunction(loadCode, worker);
	const { artifacts, ...rest } = context;
	const ctx: CodeContext = {
		...rest,
		path: (ref) => join(artifacts, ref.path),
		log,
	};
	return invokeCode(fn, { in: ports, inputs, context: ctx }, check);
}
