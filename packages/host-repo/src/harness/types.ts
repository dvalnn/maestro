import type { JsonSchema } from "@maestro/ir";
import type { Bind } from "../sandbox/index";

/** What an agent runs on: its harness, and the model and thinking level in that harness's own terms. */
export type Runtime = { harness: string; model: string; thinking?: string };

/** What a harness loads for an agent as its adapter launches it (GLOSSARY: Agent environment), each list by name. */
export type AgentEnvironment = {
	/** The built-in tools the adapter names at launch, whatever the harness's defaults. */
	tools: string[];
	subagents: boolean;
	skills: string[];
	mcp: string[];
	hooks: string[];
	contextFiles: string[];
	/** `harness`: the harness compacts on its own terms. */
	compaction: "harness";
};

type Switched =
	| "tools"
	| "subagents"
	| "skills"
	| "mcp"
	| "hooks"
	| "contextFiles";

/**
 * Each part of an agent environment an adapter pins, its declared value beside the flags and variables that make it
 * true. Parts switched by one flag share one `argv` array, which launches once.
 */
export type Baseline = {
	[P in Switched]: {
		declared: AgentEnvironment[P];
		argv: readonly string[];
		env?: Readonly<Record<string, string>>;
	};
};

/** The environment `baseline` declares, and the argv and env that launch it. */
export function baselineOf(baseline: Baseline): {
	declared: AgentEnvironment;
	argv: string[];
	env: Record<string, string>;
} {
	const { tools, subagents, skills, mcp, hooks, contextFiles } = baseline;
	const switches = [tools, subagents, skills, mcp, hooks, contextFiles];
	return {
		declared: {
			tools: tools.declared,
			subagents: subagents.declared,
			skills: skills.declared,
			mcp: mcp.declared,
			hooks: hooks.declared,
			contextFiles: contextFiles.declared,
			compaction: "harness",
		},
		argv: [...new Set(switches.map((s) => s.argv))].flat(),
		env: Object.assign({}, ...switches.map((s) => s.env)),
	};
}

/** The parts of an agent environment a harness can report loading, each a list of names. */
const REPORTED = [
	"tools",
	"subagents",
	"skills",
	"mcp",
	"hooks",
	"contextFiles",
] as const;

type Reported = (typeof REPORTED)[number];

/** What a harness reports it loaded at startup, each list by name. A part it does not report is absent. */
export type ObservedEnvironment = {
	/** The harness's own version. */
	version?: string;
	model?: string;
} & Partial<Record<Reported, string[]>>;

const strings = (v: unknown): string[] | undefined =>
	Array.isArray(v) && v.every((s) => typeof s === "string") ? v : undefined;

/** `value`, an environment report as JSON, parsed: anything not a string or a list of names is left out. */
export function observedOf(value: unknown): ObservedEnvironment {
	const v = new Map(
		Object.entries(typeof value === "object" && value !== null ? value : {}),
	);
	const text = (key: string) => {
		const s = v.get(key);
		return typeof s === "string" ? { [key]: s } : {};
	};
	const lists = REPORTED.flatMap((part) => {
		const list = strings(v.get(part));
		return list ? [[part, list]] : [];
	});
	return { ...text("version"), ...text("model"), ...Object.fromEntries(lists) };
}

/** How a part of an agent environment stands against its report: `?` when the harness did not report it. */
export type EnvironmentCheck = {
	part: keyof AgentEnvironment;
	mark: "✓" | "✗" | "?";
	/** One line per way the report contradicts the declaration. */
	faults: string[];
};

/** The faults of `observed` names against `declared` ones: each extra loaded, each declared one missing. */
const listFaults = (
	declared: readonly string[],
	observed: readonly string[],
) => [
	...observed
		.filter((name) => !declared.includes(name))
		.map((name) => `${name} loaded, not declared`),
	...declared
		.filter((name) => !observed.includes(name))
		.map((name) => `${name} declared, not loaded`),
];

/** The faults of each reported part: a list that differs from the declared one. A subagent tool is a fault of `subagents` only. */
function faultsOf(
	part: Reported,
	declared: AgentEnvironment,
	observed: ObservedEnvironment,
) {
	const seen = observed[part] ?? [];
	if (part === "tools")
		return listFaults(
			declared.tools,
			seen.filter((name) => !observed.subagents?.includes(name)),
		);
	if (part === "subagents")
		return declared.subagents
			? []
			: seen.map((name) => `${name} loaded, subagents declared off`);
	return listFaults(declared[part], seen);
}

/** Each part of `declared` checked against `observed`, in declaration order; compaction is never reported. */
export function environmentChecks(
	declared: AgentEnvironment,
	observed: ObservedEnvironment,
): EnvironmentCheck[] {
	const checks = REPORTED.map((part): EnvironmentCheck => {
		if (observed[part] === undefined) return { part, mark: "?", faults: [] };
		const faults = faultsOf(part, declared, observed);
		return { part, mark: faults.length ? "✗" : "✓", faults };
	});
	return [...checks, { part: "compaction", mark: "?", faults: [] }];
}

/** A context policy's `at` as a profile gives it: a prompt size in tokens, or a share of the model's window. */
export type ContextAt = { tokens: number } | { percent: number };

/**
 * How an agent's run resets its context as it fills (GLOSSARY: Context policy), once a prompt reaches `at`, by default
 * in tokens. `max` caps the resets.
 */
export type ContextPolicy<At = number> =
	| { strategy: "handoff"; at: At; max: number }
	| { strategy: "compact"; at: At; max?: number };

/** A profile field a harness cannot honour, why, and the fix. */
export type RuntimeProblem = {
	/** The key under the profile, as in `runtime.thinking`. */
	field: `runtime.${keyof Runtime}` | `context.${"strategy" | "at" | "max"}`;
	/** Leads with the harness's name, as in `claude has no thinking level 'turbo'`. */
	reason: string;
	/** `PROFILE_TOKEN` in it stands for the profile's name. */
	fix: string;
};

/** What a `RuntimeProblem` fix writes for the name of the profile it concerns. */
export const PROFILE_TOKEN = "<profile>";

/** Named, additive numbers (GLOSSARY: Metric), e.g. `tokens_in`. */
export type Metrics = Record<string, number>;

/** The token metric names adapters report. */
export const METRIC = {
	tokensIn: "tokens_in",
	tokensOut: "tokens_out",
	tokensCacheRead: "tokens_cache_read",
	tokensCacheWrite: "tokens_cache_write",
	tokensReasoning: "tokens_reasoning",
} as const;

/** Where an adapter's sandbox sees `HarnessRequest.outbox`. */
export const OUTBOX = "/out";
/** Where an adapter's sandbox sees `HarnessRequest.session.dir`. */
export const SESSION_DIR = "/session";
/** Where an adapter's sandbox sees `HarnessRequest.instructions`. */
export const INSTRUCTIONS = "/instructions.md";

/** A file the agent writes in the outbox: Markdown, or JSON valid against `schema`. */
export type Output =
	| { file: string; format: "json"; schema: JsonSchema }
	| { file: string; format: "markdown" };

export type HarnessRequest = {
	runtime: Runtime;
	/** Any size: adapters stage it through stdin or a lane file, never argv. */
	prompt: string;
	/** Host directory of the lane the agent works in. */
	lane: string;
	/** Read-only binds from config, the profile, attachments and the checks the agent may run. Cannot widen write access. */
	readOnly?: Bind[];
	/** Read-write binds outside the lane, beside the outbox and session: those of the checks the agent may run. */
	writable?: Bind[];
	/** Environment of the agent process. The adapter's own variables win over these. */
	env?: Record<string, string>;
	/**
	 * Host path of a file bound read-only at `INSTRUCTIONS`, whose text the adapter appends to the harness's own system
	 * prompt, never replacing it. Without it the system prompt is unchanged.
	 */
	instructions?: string;
	/** Host directory bound read-write at `OUTBOX`, outside the lane. The agent writes declared outputs there. */
	outbox: string;
	/** The files the agent must write in the outbox. */
	outputs: Output[];
	/**
	 * Host directory bound read-write at `SESSION_DIR`, and a UUID. The same dir and id continue the session; a new
	 * id starts one.
	 */
	session: { dir: string; id: string };
	/** Whether the agent is a verdict agent (GLOSSARY), whose envelope carries an outcome. Adapters need not read it. */
	verdict?: boolean;
	/** The agent's node instance id as `ls` prints it, such as `loop[0]/review`. Only the stub reads it. */
	instance?: string;
	/** The profile's context policy. Without one the harness compacts on its own terms. */
	context?: ContextPolicy;
	/** The model's context window in tokens as maestro last observed it, when it has. */
	window?: number;
};

export type HarnessEvent =
	| { kind: "text"; text: string }
	/** A tool call, with its arguments as the harness gave them. */
	| { kind: "tool"; name: string; input: unknown; id?: string }
	/**
	 * A tool result's size in bytes as the agent's context took it, and whether the tool reported an error, paired with
	 * its call by `id`; never its text.
	 */
	| { kind: "tool_result"; id?: string; bytes: number; error: boolean }
	| { kind: "thinking"; text: string }
	/** Usage reported by the harness. The run's metrics are the sum of these. */
	| { kind: "usage"; metrics: Metrics }
	/** The prompt size of a model call in tokens, input and cache read and write together. */
	| { kind: "context"; used: number }
	/** The model's context window in tokens, as the harness reports it. */
	| { kind: "window"; tokens: number }
	/** The harness compacted the session's context. */
	| { kind: "compaction" }
	/** What the harness reports it loaded, once at its startup. */
	| ({ kind: "environment" } & ObservedEnvironment)
	/** The harness finished all its work and will not continue on its own. A run without one is `failed`. */
	| { kind: "settled" }
	/**
	 * The harness cannot be trusted to continue: the run is killed and fails with `reason`. `transient` says the
	 * provider error behind it may pass, so the same session may try again.
	 */
	| { kind: "fault"; reason: string; transient?: boolean }
	/** A well-formed harness event the adapter has no model for. */
	| { kind: "raw"; data: unknown };

export type HarnessResult = {
	/** `failed` covers the run not completing, including cancel (reason `cancelled`). */
	outcome: "ok" | "failed";
	reason?: string;
	/** Whether the failure may pass on a retry in the same session: a transient fault, or a stream that ended early. */
	transient?: boolean;
	/** Text of the agent's last assistant message, `""` when there was none. */
	reply: string;
	metrics: Metrics;
};

export interface HarnessRun {
	/** Events as they happen. Buffered, so ignoring it never stalls the agent. */
	readonly events: AsyncIterable<HarnessEvent>;
	readonly result: Promise<HarnessResult>;
	/** Kills the agent's process tree, unless it reported `settled` first. `result` then resolves `failed`/`cancelled`. */
	cancel(): Promise<void>;
}

/** The seam to a coding-agent runtime (D-20). */
export interface Harness {
	readonly name: string;
	/** The agent environment it launches with, which its environment report is checked against. */
	readonly environment?: AgentEnvironment;
	run(req: HarnessRequest): HarnessRun;
	/**
	 * Each field of `runtime` and `context`, one naming this harness, it cannot honour, given the model's context
	 * `window` in tokens when one is known. A harness without it honours every field.
	 */
	runtimeProblems?(
		runtime: Runtime,
		context?: ContextPolicy,
		window?: number,
	): RuntimeProblem[];
}

/** The problem of a `thinking` level that is none of `levels`, the documented levels of harness `harness`. */
export const thinkingProblems = (
	harness: string,
	levels: readonly string[],
	{ thinking }: Runtime,
): RuntimeProblem[] =>
	thinking === undefined || levels.includes(thinking)
		? []
		: [
				{
					field: "runtime.thinking",
					reason: `${harness} has no thinking level '${thinking}'`,
					fix: `Use one of: ${levels.join(", ")}`,
				},
			];

/** A `window` event of `tokens`, none when it is not a whole number of at least 1. */
export const windowEvents = (tokens: unknown): HarnessEvent[] =>
	Number.isSafeInteger(tokens) && Number(tokens) > 0
		? [{ kind: "window", tokens: Number(tokens) }]
		: [];

/** What a harness does under a context policy. */
export type ContextSupport = {
	/** It emits a compaction event when it compacts. */
	compactions: boolean;
	/** It sets its own compaction point from `at`. */
	compact: boolean;
};

/**
 * The problems of `context` on harness `harness`, which supports `can`:
 * - `compact` on a harness whose compaction point maestro cannot set;
 * - a capped `compact` on one that emits no compaction event.
 */
export function contextProblems(
	harness: string,
	can: ContextSupport,
	context: ContextPolicy | undefined,
): RuntimeProblem[] {
	if (!context) return [];
	const compact = context.strategy === "compact";
	if (compact && !can.compact)
		return [
			{
				field: "context.strategy",
				reason: `${harness} takes no compaction point from maestro`,
				fix: "Use strategy handoff",
			},
		];
	if (compact && context.max !== undefined && !can.compactions)
		return [
			{
				field: "context.max",
				reason: `${harness} reports no compaction, so it cannot be capped`,
				fix: "Drop context.max, or use strategy handoff",
			},
		];
	return [];
}
