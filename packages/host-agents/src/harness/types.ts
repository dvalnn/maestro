import type { Bind } from "../sandbox/index";

export type Role = { harness: string; model: string; thinking?: string };

/** Named, additive numbers (GLOSSARY: Metric), e.g. `tokens_in`. */
export type Metrics = Record<string, number>;

/** Where an adapter's sandbox sees `HarnessRequest.outbox`. */
export const OUTBOX = "/out";
/** Where an adapter's sandbox sees `HarnessRequest.session.dir`. */
export const SESSION_DIR = "/session";

export type HarnessRequest = {
	role: Role;
	/** Any size: adapters stage it through stdin or a lane file, never argv. */
	prompt: string;
	/** Host directory of the lane the agent works in. */
	lane: string;
	/** Read-only binds declared by the node. Cannot widen write access. */
	readOnly?: Bind[];
	/** Host directory bound read-write at `OUTBOX`, outside the lane. The agent writes declared outputs there. */
	outbox: string;
	/**
	 * Host directory bound read-write at `SESSION_DIR`, and a UUID. The same dir and id continue the session; a new
	 * id starts one.
	 */
	session: { dir: string; id: string };
};

export type HarnessEvent =
	| { kind: "turn" }
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string }
	/** Usage reported by the harness. The run's metrics are the sum of these. */
	| { kind: "usage"; metrics: Metrics }
	/** The harness finished all its work and will not continue on its own. A run without one is `failed`. */
	| { kind: "settled" }
	/** The harness cannot be trusted to continue: the run is killed and fails with `reason`. */
	| { kind: "fault"; reason: string }
	/** A well-formed harness event the adapter has no model for. */
	| { kind: "raw"; data: unknown };

export type HarnessResult = {
	/** `failed` covers the run not completing, including cancel (reason `cancelled`). */
	outcome: "ok" | "failed";
	reason?: string;
	/** Text of the agent's last assistant message, `""` when there was none. */
	reply: string;
	metrics: Metrics;
};

export interface HarnessRun {
	/** Events as they happen. Buffered, so ignoring it never stalls the agent. */
	readonly events: AsyncIterable<HarnessEvent>;
	readonly result: Promise<HarnessResult>;
	/** Kills the agent's process tree. `result` then resolves `failed`/`cancelled`. */
	cancel(): Promise<void>;
}

/** The seam to a coding-agent runtime (D-20). */
export interface Harness {
	readonly name: string;
	run(req: HarnessRequest): HarnessRun;
}
