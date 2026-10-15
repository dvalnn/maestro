import type { ArtifactRef } from "./artifact-ref";

/** What core gives every node instance it starts. */
export type Context = {
	/** The concert id. */
	concert: string;
	/** Milliseconds since the Unix epoch, fixed when the instance starts. A node reads time only from here. */
	clock: number;
	/** The absolute path of an artifact in the concert's artifact area. */
	path(ref: ArtifactRef): string;
	/** The absolute path of the instance's own scratch directory, which core deletes once it has moved the outputs. */
	scratch: string;
};

/** Facts a host offers code nodes, as JSON. */
export type Facts = Readonly<Record<string, unknown>>;

/** A code function's context: core's, plus each host's facts keyed by host name. */
export type CodeContext = Context & { env: Readonly<Record<string, Facts>> };

/** A code function's negative verdict, as `reject` builds it. Outputs never carry `outcome` or `reason` (ADR 0008). */
export type Rejection = { outcome: "rejected"; reason: string };

export const reject = (reason: string): Rejection => ({
	outcome: "rejected",
	reason,
});
