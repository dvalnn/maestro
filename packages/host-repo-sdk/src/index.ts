import {
	ARTIFACT_TYPES,
	type ArtifactRef,
	type JsonSchema,
	MAESTRO_TYPE,
	schemaMarkers,
} from "@maestro/ir";
import {
	BuildError,
	type Common,
	Dir,
	File,
	Json,
	type JsonArtifact,
	JsonFile,
	literal,
	Markdown,
	type Ref,
	type Result,
	type Type,
	type Types,
} from "@maestro/sdk";
import { hostNode } from "@maestro/sdk/host";

/** A lane version, `<concert id>.<node instance id>`. As a param, it is a lane ref to a version of an earlier concert. */
export const Lane: Type<string> = {
	schema: { type: "string", [MAESTRO_TYPE]: "repo.lane" },
};

/** An agent's harness session, which a later agent on the same harness may continue. */
export const Session: Type<string> = {
	schema: { type: "string", [MAESTRO_TYPE]: "repo.session" },
};

type LaneMode = "fresh" | "fork" | "extend" | "read";

/** Where a node's lane comes from, as `fresh`, `fork`, `extend` and `read` make it. */
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

/**
 * The lane continued from version `v`, which at most one node extends. A lane ref is never extended.
 * @throws `TYPE.options` when given options, for a caller the types do not reach: an agent continues a session by its
 * seat call's `session`.
 */
export function extend(
	v: Ref<string>,
	...removed: never[]
): LaneInput<"extend"> {
	if (removed.length)
		throw new BuildError({
			code: "TYPE.options",
			message: "extend takes no options: resume was removed",
			hint: "Continue an agent's session with session: <agent>.out.session in the seat call",
		});
	return { mode: "extend", version: v };
}

/** Version `v` with its writes discarded: the node outputs no lane and spends no extension. */
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
		config: defined({ mode, base }) as Record<string, string>,
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

/** An artifact mounted read-only at `/in/<name>`, and the hint that says when the agent should read it. */
export type Attachment = { artifact: Ref<ArtifactRef>; hint: string };

type Attachments = Readonly<Record<string, Attachment>>;

/** An agent's report: a one-line summary, then only what the record cannot show. A list is left out when empty. */
export type Report = {
	summary: string;
	gaps?: string[];
	obstacles?: string[];
	lessons?: string[];
	sightings?: Sighting[];
};

/** Something an agent saw outside its task's scope: where it is, what is wrong and what it breaches. */
export type Sighting = { path: string; text: string; cites: string };

const LINE = { type: "string", minLength: 1 } as const;
const LINES = { type: "array", items: LINE } as const;
const SIGHTING = {
	type: "object",
	required: ["path", "text", "cites"],
	additionalProperties: false,
	properties: { path: LINE, text: LINE, cites: LINE },
} as const;

/** The schema of an agent's report. Equal to the host's `REPORT`. */
export const REPORT = {
	type: "object",
	required: ["summary"],
	additionalProperties: false,
	properties: {
		summary: LINE,
		gaps: LINES,
		obstacles: LINES,
		lessons: LINES,
		sightings: { type: "array", items: SIGHTING },
	},
} as const;

/** The typed fields of an agent's reply, by name, each a type of JSON values. */
export type Replies = Readonly<Record<string, Type<unknown>>>;

/**
 * The outputs of an agent: its report, its staged prompt, its session, its lane unless it reads one, those `O` declares
 * and the typed reply fields `R` declares.
 */
export type AgentOut<
	O extends Outputs,
	M extends LaneMode = LaneMode,
	R extends Replies = Record<never, never>,
> = {
	report: Type<Report>;
	staged: Type<ArtifactRef>;
	session: Type<string>;
} & LaneOut<M> & { [K in keyof O]: O[K]["type"] } & R;

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

/** An attachment's config: its `hint` and its artifact type. */
function attachmentConfig({ artifact, hint }: Attachment) {
	const schema: JsonSchema = artifact.type.schema;
	const type = typeof schema === "object" ? schema[MAESTRO_TYPE] : undefined;
	return defined({ hint, type });
}

/** The input ports an agent has of its own, which no attachment may take. Equal to the host's `AGENT_IN_PORTS`. */
export const AGENT_IN_PORTS = ["prompt", "lane", "session"];

/** The output ports an agent has of its own, which no declared output may take. Equal to the host's `AGENT_OUT_PORTS`. */
export const AGENT_OUT_PORTS = ["lane", "report", "staged", "session"];

/** The keys of an agent's envelope, which no typed reply field takes beside the agent's output ports. Equal to the host's `ENVELOPE_KEYS`. */
export const ENVELOPE_KEYS = ["report", "blocked", "outcome", "reason"];

/**
 * Refuses an attachment, output or reply field named after one of an agent's own ports or envelope keys, a reply field
 * named after an output, and a reply field whose type holds an artifact.
 * @throws BuildError when one is.
 */
function checkNames(
	attachments: Attachments,
	out: Outputs,
	reply: Replies,
): void {
	const checks = [
		[
			"an attachment",
			Object.keys(attachments),
			AGENT_IN_PORTS,
			"an agent's own port",
		],
		["an output", Object.keys(out), AGENT_OUT_PORTS, "an agent's own port"],
		[
			"a reply field",
			Object.keys(reply),
			AGENT_OUT_PORTS,
			"an agent's own port",
		],
		[
			"a reply field",
			Object.keys(reply),
			ENVELOPE_KEYS.filter((k) => !AGENT_OUT_PORTS.includes(k)),
			"an envelope key",
		],
		[
			"a reply field",
			Object.keys(reply),
			Object.keys(out),
			"a declared output",
		],
	] as const;
	for (const [what, names, own, holder] of checks) {
		const taken = names.find((n) => own.includes(n));
		if (taken !== undefined)
			throw new BuildError({
				code: "SCOPE.name",
				message: `'${taken}' is ${holder}, so ${what} cannot take it`,
				hint: `Rename '${taken}'; ${what} may not take ${own.join(", ")}`,
			});
	}
	const held = Object.entries(reply).find(([, { schema }]) =>
		schemaMarkers(schema).some((m) => ARTIFACT_TYPES.has(m.type)),
	);
	if (held)
		throw new BuildError({
			code: "TYPE.reply",
			message: `reply field '${held[0]}' holds an artifact, which no reply field can`,
			hint: `Declare '${held[0]}' as an output, JsonOut or MarkdownOut, or give the field a JSON value type`,
		});
}

/**
 * What a seat holds: the profile its agents run, whether an encore continues them, and the outputs, verdict and checks
 * the graph expects of them.
 */
export type SeatOptions<S extends Outputs> = {
	/** The profile's name, bare or `<pack id>/<name>`; the seat's own name by default. */
	profile?: string;
	/** Marks the seat's agents as verdict agents, which rule `ok` or `rejected` on work; any other agent does the work. */
	verdict?: boolean;
	/** `false` starts the seat's agents fresh in an encore, rather than continuing their counterparts' sessions. */
	encore?: boolean;
	out?: S;
	/** Names of `target.checks` the agent may run. */
	checks?: string[];
};

/**
 * What a call of a seat adds: the task and the lane, the session it continues, attachments, outputs and typed reply
 * fields, and checks.
 */
export type SeatCall<
	C extends Outputs,
	M extends LaneMode,
	R extends Replies = Replies,
> = Common & {
	task: string | Ref<string>;
	lane: LaneInput<M>;
	/** An earlier agent's `out.session` on the same harness, continued in place; a fresh session when absent. */
	session?: Ref<string>;
	attachments?: Attachments;
	out?: C;
	/**
	 * Typed fields of the agent's reply, beside its report, each an output the host validates against its type. The
	 * agent gives each unless it is blocked, a rejection included.
	 */
	reply?: R;
	/** Names of `target.checks` the agent may run, beside the seat's. */
	checks?: string[];
};

/** The names of `a` then those of `b` not in `a`, or nothing when there are none. */
function union(a: string[] = [], b: string[] = []): string[] | undefined {
	const all = [...new Set([...a, ...b])];
	return all.length ? all : undefined;
}

/**
 * Seat `name` (ADR 0013), as a function that emits a `repo.agent` node (see the host-repo README) per call: a coding
 * agent running the seat's profile on `task` in its lane. A call's outputs add to the seat's, the call's winning on a
 * name, and its checks add to the seat's.
 */
export function seat<S extends Outputs = Record<never, never>>(
	name: string,
	standing: SeatOptions<S> = {},
) {
	return <
		C extends Outputs = Record<never, never>,
		M extends LaneMode = LaneMode,
		R extends Replies = Record<never, never>,
	>(
		call: SeatCall<C, M, R>,
	): Result<AgentOut<Omit<S, keyof C> & C, M, R>> => {
		const {
			task,
			lane,
			session,
			attachments = {},
			out: callOut,
			reply: callReply = {},
			checks,
			...common
		} = call;
		const out: Outputs = { ...standing.out, ...callOut };
		const reply: Replies = callReply;
		checkNames(attachments, out, reply);
		const ports = lanePorts(lane);
		return hostNode("repo.agent", {
			...common,
			in: {
				prompt: task,
				...mapValues(attachments, (a) => a.artifact),
				...ports.in,
				...(session && { session }),
			},
			out: {
				report: Json<Report>(REPORT),
				staged: Dir(),
				session: Session,
				...ports.out,
				...reply,
				...mapValues(out, (o) => o.type),
			},
			config: defined({
				profile: standing.profile ?? name,
				seat: name,
				lane: ports.config,
				verdict: standing.verdict,
				encore: standing.encore,
				checks: union(standing.checks, checks),
				attachments: nonEmpty(mapValues(attachments, attachmentConfig)),
				reply: nonEmpty(mapValues(reply, (t) => t.schema)),
				out: nonEmpty(mapValues(out, (o) => o.config)),
			}),
		}) as Result<AgentOut<Omit<S, keyof C> & C, M, R>>;
	};
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
 * A `repo.changeset` node: the patch series of version `v` as a directory, with a commit `message` when given. Given
 * `since`, a version `v` extends, only the patches after it. It opens no lane and spends no extension.
 */
export function changeset(
	v: Ref<string> | string,
	{
		message,
		since,
		...common
	}: Common & {
		message?: string | Ref<string>;
		since?: Ref<string> | string;
	} = {},
): Result<{ changeset: Type<ArtifactRef> }> {
	return hostNode("repo.changeset", {
		...common,
		in: defined({
			lane: versionOf(v),
			message,
			since: since === undefined ? undefined : versionOf(since),
		}),
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
