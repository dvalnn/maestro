import { type ArtifactRef, type JsonSchema, MAESTRO_TYPE } from "@maestro/ir";
import {
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
import { hostNode } from "@maestro/sdk/host";

/** A lane version, `<concert id>.<node instance id>`. As a param, it is a lane ref to a version of an earlier concert. */
export const Lane: Type<string> = {
	schema: { type: "string", [MAESTRO_TYPE]: "repo.lane" },
};

type LaneMode = "fresh" | "fork" | "join" | "read";

/** Where a node's lane comes from, as `fresh`, `fork`, `join` and `read` make it. */
export type LaneInput<M extends LaneMode = LaneMode> = {
	readonly mode: M;
	readonly base?: string;
	readonly version?: Ref<string>;
};

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

/** The lane continued from version `v`, which at most one node joins. A lane ref is never joined. */
export const join = (v: Ref<string>): LaneInput<"join"> => ({
	mode: "join",
	version: v,
});

/** Version `v` with its writes discarded: the node outputs no lane and spends no join. */
export const read = (v: Ref<string> | string): LaneInput<"read"> => ({
	mode: "read",
	version: versionOf(v),
});

/** A node's lane config, its lane input port and its lane output port. */
function lanePorts({ mode, base, version }: LaneInput): {
	config: Record<string, string>;
	in: Record<string, Ref<string>>;
	out: Types;
} {
	return {
		config: base === undefined ? { mode } : { mode, base },
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

/** An artifact mounted read-only at `/in/<name>`, and when the agent should read it, as the staged prompt says. */
export type AgentRef = { artifact: Ref<ArtifactRef>; when: string };

type AgentRefs = Readonly<Record<string, AgentRef>>;

export type AgentOptions<
	O extends Outputs,
	M extends LaneMode = LaneMode,
> = Common & {
	task: string | Ref<string>;
	lane: LaneInput<M>;
	role: string | Role;
	/** Appended to the harness's own system prompt. */
	identity?: string | Ref<string>;
	refs?: AgentRefs;
	out?: O;
	/** Names of `target.checks` the agent may run. */
	checks?: string[];
	/** Absolute host paths bound read-only at their own paths. */
	readOnly?: string[];
	/** Continues the session that wrote the joined version. */
	resume?: boolean;
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

/** A ref's config: its `when` and its artifact type. */
function refConfig({ artifact, when }: AgentRef) {
	const schema: JsonSchema = artifact.type.schema;
	const type = typeof schema === "object" ? schema[MAESTRO_TYPE] : undefined;
	return defined({ when, type });
}

/** A `repo.agent` node: a coding agent performing `task` in its lane (architecture 12). */
export function agent<
	O extends Outputs = Record<never, never>,
	M extends LaneMode = LaneMode,
>(opts: AgentOptions<O, M>): Result<AgentOut<O, M>> {
	const { task, lane, role, identity, checks, readOnly, resume, ...rest } =
		opts;
	const { refs: givenRefs, out: givenOut, ...common } = rest;
	const refs: AgentRefs = givenRefs ?? {};
	const out: Outputs = givenOut ?? {};
	const ports = lanePorts(lane);
	return hostNode("repo.agent", {
		...common,
		in: defined({
			prompt: task,
			identity,
			...mapValues(refs, (r) => r.artifact),
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
			resume,
			readOnly,
			checks,
			refs: nonEmpty(mapValues(refs, refConfig)),
			out: nonEmpty(mapValues(out, (o) => o.config)),
		}),
	}) as Result<AgentOut<O, M>>;
}

/** What a seat bundles: an agent's standing setup. */
export type SeatOptions<S extends Outputs> = {
	role: string | Role;
	/** The seat's standing text, appended to the harness's own system prompt. */
	identity: string | Ref<string>;
	refs?: AgentRefs;
	out?: S;
	/** Names of `target.checks` the agent may run. */
	checks?: string[];
	/** Absolute host paths bound read-only at their own paths. */
	readOnly?: string[];
};

/**
 * What a call of a seat adds: the task, the lane and `resume`, overrides of the seat's role, refs and outputs, and
 * further checks and read-only binds.
 */
export type SeatCall<C extends Outputs, M extends LaneMode> = Common & {
	task: string | Ref<string>;
	lane: LaneInput<M>;
	role?: Partial<Role>;
	refs?: AgentRefs;
	out?: C;
	checks?: string[];
	readOnly?: string[];
	resume?: boolean;
};

/** The names of `a` then those of `b` not in `a`, or nothing when there are none. */
function union(a: string[] = [], b: string[] = []): string[] | undefined {
	const all = [...new Set([...a, ...b])];
	return all.length ? all : undefined;
}

/**
 * An agent's standing setup, as a function that emits a `repo.agent` node per call. A call's role fields override the
 * seat's; its refs and outputs add to the seat's, the call's winning on a name; its checks and read-only binds add to
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
			role: { ...roleOf(standing.role), ...defined(call.role ?? {}) },
			refs: { ...standing.refs, ...call.refs },
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
		out: { logs: File(), ...ports.out },
		config: defined({
			lane: ports.config,
			check: typeof which === "object" ? defined(which) : which,
		}),
	}) as Result<CheckOut<M>>;
}

/** A `repo.changeset` node: the patch series of version `v` as a directory. It opens no lane and spends no join. */
export function changeset(
	v: Ref<string> | string,
	common: Common = {},
): Result<{ changeset: Type<ArtifactRef> }> {
	return hostNode("repo.changeset", {
		...common,
		in: { lane: versionOf(v) },
		out: { changeset: Dir() },
	});
}

export type ApplyOptions = Common & {
	/** `3way` by default; `ff` refuses any changeset that does not apply cleanly. */
	strategy?: "3way" | "ff";
};

/**
 * A `repo.apply` node: `changesets` applied to `lane` in their order, each on an input port of its name. A conflict
 * rejects it, with a version holding the markers for an agent to join.
 */
export function apply(
	lane: LaneInput<"fresh" | "fork" | "join">,
	changesets: Readonly<Record<string, Ref<ArtifactRef>>>,
	{ strategy, ...common }: ApplyOptions = {},
): Result<{ lane: Type<string> }> {
	const ports = lanePorts(lane);
	return hostNode("repo.apply", {
		...common,
		in: { ...ports.in, ...changesets },
		out: { lane: Lane },
		config: defined({
			lane: ports.config,
			changesets: Object.keys(changesets),
			strategy,
		}),
	});
}
