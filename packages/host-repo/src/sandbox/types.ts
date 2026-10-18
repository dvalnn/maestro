/** A host path made visible inside the sandbox. `dst` defaults to `src`. */
export type Bind = { src: string; dst?: string };

/**
 * The lane is the only writable place by default (mounted at `LANE_DST`);
 * anything else writable must be named in `writable`, by an adapter, config or a check node, never by an agent node.
 */
export type SandboxSpec = {
	/** Host directory of the lane. Mounted read-write at `LANE_DST`, which is also the working directory. */
	lane: string;
	argv: string[];
	/** Explicit environment. The host environment is never inherited. PATH and HOME default to safe values. */
	env?: Record<string, string>;
	/** Like `env`, but masked in every line and stderr the sandbox returns. */
	secrets?: Record<string, string>;
	/** Written to the process's stdin, then stdin is closed. No argv size limit applies. */
	stdin?: string | Uint8Array;
	/** Read-only binds declared by a node or config. Rejected if they land in the lane's writable area. */
	readOnly?: Bind[];
	/** Extra read-write paths outside the lane, declared by an adapter or a check. Shown as `origin: "adapter"` in the plan. */
	writable?: Bind[];
};

export type Mount = {
	kind: "ro-bind" | "bind" | "tmpfs" | "proc" | "dev";
	src?: string;
	dst: string;
	origin: "system" | "declared" | "adapter" | "lane";
};

export type ExitStatus = {
	code: number | null;
	signal: string | number | null;
	/** Tail of stderr, secrets masked. */
	stderr: string;
};

export interface SandboxedProcess {
	/** Marks every process of the run (its environment carries `MAESTRO_SANDBOX_ID=<id>`). */
	readonly id: string;
	/** Stdout lines, secrets masked. The caller must iterate it, or the process blocks on a full pipe. */
	readonly stdout: AsyncIterable<string>;
	readonly exited: Promise<ExitStatus>;
	/** Kills the whole process tree. Resolves once no process of the run is left, rejects if one survives. */
	kill(): Promise<void>;
}

/** D-25: the sandbox backend is pluggable. Bubblewrap is the only implementation in V1. */
export interface SandboxBackend {
	/** @throws if the spec violates the mount policy. */
	start(spec: SandboxSpec): SandboxedProcess;
}
