import type { ArtifactRef } from "./artifact-ref";
import type { Outcome } from "./outcome";

/** A node id and its expansion path (architecture 7), in ir's format (`formatExpansion`). */
export type NodeInstance = NonNullable<ArtifactRef["producer"]>;

/** Fields core stores opaquely with the instance's events and record, as JSON. */
export type Enrichment = Readonly<Record<string, unknown>>;

/** A progress event a host instance emits, as JSON. Core stores it by node id and expansion path, opaquely. */
export type HostEvent = Readonly<Record<string, unknown>>;

/**
 * What an event says about its instance (CORE-10):
 * - `running`: it started.
 * - `settled`: it settled, with its outcome, reason and host enrichment.
 * - `reused`: a resume kept its `ok` record from before.
 * - `progress`: its host emitted `event`, stored as given.
 * - `log`: its worker wrote `line`, or its cancel hook failed.
 */
export type EventBody =
	| { type: "running" }
	| {
			type: "settled";
			outcome: Outcome;
			reason?: string;
			enrichment?: Enrichment;
	  }
	| { type: "reused" }
	| { type: "progress"; event: HostEvent }
	| { type: "log"; line: string };

/** `seq` orders all events of a store and is the cursor `events` reads after. `at` is epoch milliseconds. */
export type ConcertEvent = NodeInstance & {
	seq: number;
	at: number;
} & EventBody;
