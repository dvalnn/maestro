import { type ArtifactRef, type JsonSchema, MAESTRO_TYPE } from "@maestro/ir";
import {
	BuildError,
	type Common,
	Dir,
	File,
	type JsonArtifact,
	JsonFile,
	literal,
	Markdown,
	type Ref,
	type Result,
	Text,
	type Type,
	type Types,
} from "@maestro/sdk";
import { hostNode, timeoutMs } from "@maestro/sdk/host";

/** A lane version, `<concert id>.<node instance id>`. As a param, it is a lane ref to a version of an earlier concert. */
export const Lane: Type<string> = {
	schema: { type: "string", [MAESTRO_TYPE]: "repo.lane" },
};

type LaneMode = "fresh" | "fork" | "extend" | "read";

/** Where a node's lane comes from, as `fresh`, `fork`, `extend` and `read` make it. */
export type LaneInput<M extends LaneMode = LaneMode> = {
	readonly mode: M;
	readonly base?: string;
	readonly version?: Ref<string>;
	readonly resume?: never;
};

/** An `extend` that continues the session that wrote its version. Only an agent or a seat takes one. */
export type ResumedLane<M extends LaneMode = "extend"> = Omit<
	LaneInput<M>,
	"resume"
> & { readonly resume: true };

/** A lane input an agent takes: any, or an `extend` that resumes. */
type AgentLane<M extends LaneMode> = LaneInput<M> | ResumedLane<M>;

/** The lane output of a node whose lane mode is `M`: none when it may read. */
export type LaneOut<M extends LaneMode> = "read" extends M
	? Record<never, never>
	: { lane: Type<string> };

/** A lane version: a node's `lane` output, or a lane ref, typed as one. */
const versionOf = (v: Ref<string> | string) =>
	typeof v === "string" ? literal(v, Lane) : v;

/** A new lane cut from the target at `base`, or at `target.base` when absent. */
export const fresh = (base?: string): LaneInput<"fresh"> =>
	base === undefined ? { mode: "fresh" } : { mode: "fresh", base };

/** A copy of version `v`. Any number of nodes may fork one version. */
export const fork = (v: Ref<string> | string): LaneInput<"fork"> => ({
	mode: "fork",
	version: versionOf(v),
});

/**
 * The lane continued from version `v`, which at most one node extends. A lane ref is never extended. With `resume`, an
 * agent continues the session that wrote `v`.
 */
export function extend(v: Ref<string>): LaneInput<"extend">;
export function extend(
	v: Ref<string>,
	options: { resume: true },
): ResumedLane<"extend">;
export function extend(
	v: Ref<string>,
	options?: { resume: true },
): LaneInput<"extend"> | ResumedLane<"extend"> {
	return options
		? { mode: "extend", version: v, resume: true }
		: { mode: "extend", version: v };
}

/** Version `v` with its writes discarded: the node outputs no lane and spends no extension. */
export const read = (v: Ref<string> | string): LaneInput<"read"> => ({
	mode: "read",
	version: versionOf(v),
});

/** A node's lane config, its lane input port and its lane output port. */
function lanePorts({ mode, base, version, resume }: AgentLane<LaneMode>): {
	config: Record<string, string | boolean>;
	in: Record<string, Ref<string>>;
	out: Types;
} {
	return {
		config: defined({ mode, base, resume }) as Record<string, string | boolean>,
		in: version === undefined ? {} : { lane: version },
		out: mode === "read" ? {} : { lane: Lane },
	};
}

/** A file an agent writes in its outbox, and the artifact type of the output it arrives on. */
export type Output<T extends ArtifactRef = ArtifactRef> = {
	readonly type: Type<T>;
	readonly config: Readonly<Record<string, unknown>>;
};

/** A JSON file `file` whose content `type` describes. */
export const JsonOut = <T>(
	file: string,
	type: Type<T>,
): Output<JsonArtifact<T>> => ({
	type: JsonFile(type),
	config: { file, format: "json", schema: type.schema },
});

/** A Markdown file `file`. */
export const MarkdownOut = (file: string): Output => ({
	type: Markdown(),
	config: { file, format: "markdown" },
});

type Outputs = Readonly<Record<string, Output>>;

/** A role from config by name, with any of its harness, model and thinking level overridden. */
export type Role = {
	name: string;
	harness?: string;
	model?: string;
	thinking?: string;
};

/** An artifact mounted read-only at `/in/<name>`, and the hint that says when the agent should read it. */
export type Attachment = { artifact: Ref<ArtifactRef>; hint: string };

type Attachments = Readonly<Record<string, Attachment>>;

/**
 * What bounds an agent's whole run: every turn, correction and retry. None by default. Passing one cancels the agent,
 * which settles `failed` with the limit as its reason and its partial kept.
 */
export type Limits = {
	/** Wall clock from the first turn's start, retry waits included: milliseconds, or a duration such as `45m`. */
	timeout?: number | string;
	/** The most tokens the agent spends, as its usage events sum: a whole number of at least 1. */
	tokens?: number;
};

export type AgentOptions<
	O extends Outputs,
	M extends LaneMode = LaneMode,
> = Common & {
	task: string | Ref<string>;
	lane: AgentLane<M>;
	role: string | Role;
	limits?: Limits;
	/** Appended to the harness's own system prompt. */
	identity?: string | Ref<string>;
	/** Marks a verdict agent, which rules `ok` or `rejected` on work; any other agent does the work. */
	verdict?: boolean;
	attachments?: Attachments;
	out?: O;
	/** Names of `target.checks` the agent may run. */
	checks?: string[];
	/** Absolute host paths bound read-only at their own paths. */
	readOnly?: string[];
};

/** The outputs of an agent: its report, its staged prompt, its lane unless it reads one, and those `O` declares. */
export type AgentOut<O extends Outputs, M extends LaneMode = LaneMode> = {
	report: Type<string>;
	staged: Type<ArtifactRef>;
} & LaneOut<M> & { [K in keyof O]: O[K]["type"] };

const mapValues = <V, W>(
	record: Readonly<Record<string, V>>,
	fn: (value: V) => W,
): Record<string, W> =>
	Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fn(v)]));

/** `record` without its undefined entries, since a config holds only JSON. */
const defined = <T extends object>(record: T) =>
	Object.fromEntries(
		Object.entries(record).filter(([, v]) => v !== undefined),
	) as Partial<T>;

const nonEmpty = <V>(record: Readonly<Record<string, V>>) =>
	Object.keys(record).length ? record : undefined;

const roleOf = (role: string | Role): Role =>
	typeof role === "string" ? { name: role } : role;

/** An attachment's config: its `hint` and its artifact type. */
function attachmentConfig({ artifact, hint }: Attachment) {
	const schema: JsonSchema = artifact.type.schema;
	const type = typeof schema === "object" ? schema[MAESTRO_TYPE] : undefined;
	return defined({ hint, type });
}

/** The input ports an agent has of its own, which no attachment may take. Equal to the host's `AGENT_IN_PORTS`. */
export const AGENT_IN_PORTS = ["prompt", "identity", "lane"];

/** The output ports an agent has of its own, which no declared output may take. Equal to the host's `AGENT_OUT_PORTS`. */
export const AGENT_OUT_PORTS = ["lane", "report", "staged"];

/**
 * Refuses an attachment or output named after one of an agent's own ports.
 * @throws BuildError when one is.
 */
function checkNames(attachments: Attachments, out: Outputs): void {
	const checks = [
		["an attachment", Object.keys(attachments), AGENT_IN_PORTS],
		["an output", Object.keys(out), AGENT_OUT_PORTS],
	] as const;
	for (const [what, names, own] of checks) {
		const taken = names.find((n) => own.includes(n));
		if (taken !== undefined)
			throw new BuildError({
				code: "SCOPE.name",
				message: `'${taken}' names an agent's own port, so ${what} cannot take it`,
				hint: `Rename '${taken}'; ${what} may not take ${own.join(", ")}`,
			});
	}
}

/**
 * `limits` as the config holds them: `timeout` in milliseconds.
 * @throws `BOUND.timeout` or `BOUND.tokens` for a field out of range, naming agent `what`.
 */
function limitsConfig(limits: Limits | undefined, what: string) {
	if (limits === undefined) return undefined;
	const { timeout, tokens } = limits;
	const ms = timeoutMs(timeout, `limits.timeout of agent '${what}'`);
	if (tokens !== undefined && !(Number.isInteger(tokens) && tokens >= 1))
		throw new BuildError({
			code: "BOUND.tokens",
			message: `limits.tokens of agent '${what}' must be a whole number of at least 1, got ${JSON.stringify(tokens)}`,
			hint: "Set it to a count of tokens, or leave it out for no limit",
		});
	return nonEmpty(defined({ timeout: ms, tokens }));
}

/** A `repo.agent` node: a coding agent performing `task` in its lane (architecture 12). */
export function agent<
	O extends Outputs = Record<never, never>,
	M extends LaneMode = LaneMode,
>(opts: AgentOptions<O, M>): Result<AgentOut<O, M>> {
	const {
		task,
		lane,
		role,
		limits,
		identity,
		verdict,
		checks,
		readOnly,
		...rest
	} = opts;
	const { attachments: given, out: givenOut, ...common } = rest;
	const attachments: Attachments = given ?? {};
	const out: Outputs = givenOut ?? {};
	checkNames(attachments, out);
	const ports = lanePorts(lane);
	return hostNode("repo.agent", {
		...common,
		in: defined({
			prompt: task,
			identity,
			...mapValues(attachments, (a) => a.artifact),
			...ports.in,
		}),
		out: {
			report: Text(),
			staged: Dir(),
			...ports.out,
			...mapValues(out, (o) => o.type),
		},
		config: defined({
			role: defined(roleOf(role)),
			lane: ports.config,
			limits: limitsConfig(limits, opts.label ?? roleOf(role).name),
			verdict,
			readOnly,
			checks,
			attachments: nonEmpty(mapValues(attachments, attachmentConfig)),
			out: nonEmpty(mapValues(out, (o) => o.config)),
		}),
	}) as Result<AgentOut<O, M>>;
}

/** What a seat bundles: an agent's standing setup. */
export type SeatOptions<S extends Outputs> = {
	role: string | Role;
	/** The seat's limits, each field overridden by the call's. */
	limits?: Limits;
	/** The seat's standing text, appended to the harness's own system prompt. */
	identity: string | Ref<string>;
	/** Marks the seat's agents as verdict agents (`AgentOptions.verdict`). */
	verdict?: boolean;
	attachments?: Attachments;
	out?: S;
	/** Names of `target.checks` the agent may run. */
	checks?: string[];
	/** Absolute host paths bound read-only at their own paths. */
	readOnly?: string[];
};

/**
 * What a call of a seat adds: the task and the lane, overrides of the seat's role, attachments and outputs, and
 * further checks and read-only binds.
 */
export type SeatCall<C extends Outputs, M extends LaneMode> = Common & {
	task: string | Ref<string>;
	lane: AgentLane<M>;
	role?: Partial<Role>;
	limits?: Limits;
	attachments?: Attachments;
	out?: C;
	checks?: string[];
	readOnly?: string[];
};

/** The names of `a` then those of `b` not in `a`, or nothing when there are none. */
function union(a: string[] = [], b: string[] = []): string[] | undefined {
	const all = [...new Set([...a, ...b])];
	return all.length ? all : undefined;
}

/**
 * An agent's standing setup, as a function that emits a `repo.agent` node per call. A call's role fields override the
 * seat's; its attachments and outputs add to the seat's, the call's winning on a name; its checks and read-only binds add to
 * the seat's.
 */
export function seat<S extends Outputs = Record<never, never>>(
	standing: SeatOptions<S>,
) {
	return <
		C extends Outputs = Record<never, never>,
		M extends LaneMode = LaneMode,
	>(
		call: SeatCall<C, M>,
	): Result<AgentOut<Omit<S, keyof C> & C, M>> =>
		agent({
			...call,
			identity: standing.identity,
			verdict: standing.verdict,
			limits: { ...standing.limits, ...defined(call.limits ?? {}) },
			role: { ...roleOf(standing.role), ...defined(call.role ?? {}) },
			attachments: { ...standing.attachments, ...call.attachments },
			out: { ...standing.out, ...call.out } as Omit<S, keyof C> & C,
			checks: union(standing.checks, call.checks),
			readOnly: union(standing.readOnly, call.readOnly),
		});
}

/** An inline check: shell lines run in order, with a duration such as `10m`, binds and environment. */
export type InlineCheck = {
	run: string | string[];
	timeout?: string;
	readOnly?: string[];
	writable?: string[];
	env?: Record<string, string>;
};

export type CheckOut<M extends LaneMode = LaneMode> = {
	logs: Type<ArtifactRef>;
	output: Type<ArtifactRef>;
} & LaneOut<M>;

/**
 * A `repo.check` node in `lane`. `which` picks what it runs:
 * - absent, every check of `target.checks`;
 * - a name, that check of `target.checks`;
 * - an inline check.
 */
export function check<M extends LaneMode>(
	lane: LaneInput<M>,
	which?: string | InlineCheck,
	common: Common = {},
): Result<CheckOut<M>> {
	const ports = lanePorts(lane);
	return hostNode("repo.check", {
		...common,
		in: ports.in,
		out: { logs: File(), output: Dir(), ...ports.out },
		config: defined({
			lane: ports.config,
			check: typeof which === "object" ? defined(which) : which,
		}),
	}) as Result<CheckOut<M>>;
}

/**
 * A `repo.changeset` node: the patch series of version `v` as a directory, with a commit `message` when given. It opens
 * no lane and spends no extension.
 */
export function changeset(
	v: Ref<string> | string,
	{ message, ...common }: Common & { message?: string | Ref<string> } = {},
): Result<{ changeset: Type<ArtifactRef> }> {
	return hostNode("repo.changeset", {
		...common,
		in: defined({ lane: versionOf(v), message }),
		out: { changeset: Dir() },
	});
}

/**
 * A `repo.commits` node: the target commits git revisions `revs` name (`A..B`, `C^!`, or a bare `B` from `target.base`),
 * resolved once, as a lane version whose base is their one merge base. It opens no lane, and its version is never
 * extended.
 */
export function commits(
	revs: string,
	common: Common = {},
): Result<{ lane: Type<string> }> {
	return hostNode("repo.commits", {
		...common,
		out: { lane: Lane },
		config: { revs },
	});
}

export type ApplyOptions = Common & {
	/** `3way` by default; `clean` refuses a changeset that does not apply cleanly. */
	strategy?: "3way" | "clean";
};

/**
 * A `repo.apply` node: `changeset` applied to `lane`. A conflict rejects it, with a version holding the markers for an
 * agent to extend.
 */
export function apply(
	lane: LaneInput<"fresh" | "fork" | "extend">,
	changeset: Ref<ArtifactRef>,
	{ strategy, ...common }: ApplyOptions = {},
): Result<{ lane: Type<string> }> {
	const ports = lanePorts(lane);
	return hostNode("repo.apply", {
		...common,
		in: { ...ports.in, changeset },
		out: { lane: Lane },
		config: defined({ lane: ports.config, strategy }),
	});
}
