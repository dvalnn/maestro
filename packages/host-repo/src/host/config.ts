import { homedir } from "node:os";
import { join } from "node:path";
import type { KeyPath } from "@maestro/core/config";
import type { HostSetup } from "@maestro/core/host";
import {
	CORE_TYPES,
	DURATION_EXAMPLE,
	durationMs,
	irSchema,
	type JsonSchema,
	validator,
	violations,
} from "@maestro/ir";
import type { Output } from "../harness/index";
import type { ApplyStrategy, Sparse } from "../lane/index";
import {
	PROFILE_NAME,
	PROFILE_PATHS,
	PROFILES,
	PROFILES_CONFIG,
	SEATS,
	SEATS_CONFIG,
} from "../profile/index";

export const HOST_NAME = "repo";
export const AGENT_KIND = "repo.agent";
export const CHECK_KIND = "repo.check";
export const CHANGESET_KIND = "repo.changeset";
export const APPLY_KIND = "repo.apply";
export const COMMITS_KIND = "repo.commits";
export const LANE_TYPE = "repo.lane";
export const SESSION_TYPE = "repo.session";

/** The port a lane version travels on, in and out. */
export const LANE_PORT = "lane";
/** The port an agent's session travels on: out of every agent, into one that continues it. */
export const SESSION_PORT = "session";
/** Input ports an agent may have of its own. */
export const AGENT_IN_PORTS = ["prompt", LANE_PORT, SESSION_PORT];
/** The attachment directory holding a continuing agent's earlier copies of its changed attachments. */
export const PREVIOUS = "previous";
/** The names no attachment takes: the agent's own ports, and `PREVIOUS`. */
export const RESERVED_ATTACHMENTS = [...AGENT_IN_PORTS, PREVIOUS];
/** The port an apply node takes its changeset on. */
export const CHANGESET_PORT = "changeset";
/** The key of an agent node config built before profiles, which `validate` refuses by name. */
export const LEGACY_ROLE = "role";
/** The config namespace profiles replace, which `validate` refuses by name. */
export const ROLES = "roles";

const NAME = { type: "string", minLength: 1 } as const;
const PATHS = { type: "array", items: NAME } as const;
const LINES = {
	anyOf: [NAME, { type: "array", items: NAME, minItems: 1 }],
} as const;
const PORT_NAME = "^[A-Za-z_][A-Za-z0-9_]*$";
/** The shell's rule for a variable name. */
const ENV_NAME = "^[A-Za-z_][A-Za-z0-9_]*$";
const ENV = {
	type: "object",
	propertyNames: { pattern: ENV_NAME },
	additionalProperties: { type: "string" },
} as const;
const INLINE_CHECK = {
	type: "object",
	required: ["run"],
	additionalProperties: false,
	properties: {
		run: LINES,
		hint: NAME,
		timeout: NAME,
		readOnly: PATHS,
		writable: PATHS,
		env: ENV,
	},
} as const;
const CHECK = { anyOf: [LINES, INLINE_CHECK] } as const;
/** The target's prepare: a check that may also overlay a host cache. */
const PREPARE = {
	anyOf: [
		LINES,
		{
			...INLINE_CHECK,
			properties: {
				...INLINE_CHECK.properties,
				cache: {
					type: "object",
					required: ["path", "at", "env"],
					additionalProperties: false,
					properties: {
						path: { type: "string", pattern: "^(/|~/)" },
						at: { type: "string", pattern: "^/(?!lane(/|$))[^\\n]+$" },
						env: { type: "string", pattern: ENV_NAME },
					},
				},
			},
		},
	],
} as const;

/** The host's config key paths that hold file paths. */
export const HOST_PATHS: readonly KeyPath[] = [
	["target", "repo"],
	...PROFILE_PATHS.map((p) => [PROFILES, "*", ...p]),
];

/** The host's config key paths whose base a profile file gives at resolution. */
export const HOST_DEFERRED: readonly KeyPath[] = [[PROFILES, "*"]];

/** The config namespaces the host owns. */
export const HOST_CONFIG = {
	target: {
		type: "object",
		required: ["repo"],
		additionalProperties: false,
		properties: {
			repo: NAME,
			base: NAME,
			checks: { type: "object", additionalProperties: CHECK },
			prepare: PREPARE,
			sparse: {
				anyOf: [
					{ type: "array", items: NAME, minItems: 1, uniqueItems: true },
					{
						type: "object",
						required: ["patterns"],
						additionalProperties: false,
						properties: {
							patterns: {
								type: "array",
								items: { type: "string", pattern: "^[^\\n]+$" },
								minItems: 1,
							},
						},
					},
				],
			},
		},
	},
	/** Claimed so that `validate` refuses it by name: profiles replace roles. */
	[ROLES]: {},
	sandbox: {
		type: "object",
		additionalProperties: false,
		properties: { readOnly: PATHS, path: PATHS },
	},
	[PROFILES]: PROFILES_CONFIG,
	[SEATS]: SEATS_CONFIG,
} as const satisfies Record<string, JsonSchema>;

/** The lane input schema for a node that may take the modes `others` beside `fresh`. */
const laneInput = (others: readonly string[]) =>
	({
		oneOf: [
			{
				type: "object",
				required: ["mode"],
				additionalProperties: false,
				properties: { mode: { const: "fresh" }, base: NAME },
			},
			{
				type: "object",
				required: ["mode"],
				additionalProperties: false,
				properties: { mode: { enum: others } },
			},
		],
	}) as const;
const LANE_INPUT = laneInput(["fork", "extend", "read"]);

/** Output ports every agent has; a declared output takes none of these names. */
export const AGENT_OUT_PORTS = [LANE_PORT, "report", "staged", SESSION_PORT];

const OUTBOX_FILE = {
	type: "string",
	pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]*$",
};

const CURRENT_AGENT_CONFIG = {
	type: "object",
	required: ["profile", "seat", "lane"],
	additionalProperties: false,
	properties: {
		profile: { type: "string", pattern: PROFILE_NAME.source },
		seat: { type: "string", pattern: irSchema.$defs.name.pattern },
		lane: LANE_INPUT,
		verdict: { type: "boolean" },
		encore: { type: "boolean" },
		checks: { type: "array", items: NAME, uniqueItems: true },
		attachments: {
			type: "object",
			propertyNames: {
				pattern: PORT_NAME,
				not: { enum: RESERVED_ATTACHMENTS },
			},
			additionalProperties: {
				type: "object",
				required: ["hint"],
				additionalProperties: false,
				properties: {
					hint: NAME,
					type: { enum: Object.values(CORE_TYPES) },
				},
			},
		},
		out: {
			type: "object",
			propertyNames: { not: { enum: AGENT_OUT_PORTS } },
			additionalProperties: {
				oneOf: [
					{
						type: "object",
						required: ["file", "format", "schema"],
						additionalProperties: false,
						properties: {
							file: OUTBOX_FILE,
							format: { const: "json" },
							schema: { type: ["object", "boolean"] },
						},
					},
					{
						type: "object",
						required: ["file", "format"],
						additionalProperties: false,
						properties: { file: OUTBOX_FILE, format: { const: "markdown" } },
					},
				],
			},
		},
	},
} as const;

/** An agent node's config; one built before profiles passes here so that `validate` can refuse it by name. */
export const AGENT_CONFIG = {
	if: { type: "object", required: [LEGACY_ROLE] },
	else: CURRENT_AGENT_CONFIG,
} as const;

export const CHECK_CONFIG = {
	type: "object",
	required: ["lane"],
	additionalProperties: false,
	properties: { lane: LANE_INPUT, check: { anyOf: [NAME, INLINE_CHECK] } },
} as const;

export const APPLY_CONFIG = {
	type: "object",
	required: ["lane"],
	additionalProperties: false,
	properties: {
		lane: laneInput(["fork", "extend"]),
		strategy: { enum: ["3way", "clean"] },
	},
} as const;

export const CHANGESET_CONFIG = {
	type: "object",
	additionalProperties: false,
} as const;

export const COMMITS_CONFIG = {
	type: "object",
	required: ["revs"],
	additionalProperties: false,
	properties: { revs: NAME },
} as const;

export type CommitsConfig = { revs: string };

export type LaneInput =
	| { mode: "fresh"; base?: string }
	| { mode: "fork" | "extend" | "read" };

/**
 * Shell lines run in order, and the milliseconds they may take together, none when unset. `readOnly` and `writable` are
 * absolute host paths bound at their own paths; `env` is set for the check alone. `hint` tells an agent what the check
 * covers, and an agent may run only a check that has one.
 */
export type CheckSpec = {
	lines: string[];
	hint?: string;
	timeout?: number;
	readOnly: string[];
	writable: string[];
	env: Record<string, string>;
};

/** The artifact types an attachment can have. */
type AttachmentType = (typeof CORE_TYPES)[keyof typeof CORE_TYPES];

/** A file or directory an agent reads at `/in/<name>`, and the hint that says when it should. */
export type Attachment = { hint: string; type?: AttachmentType };

export type AgentConfig = {
	/** The profile the agent runs, resolved at pre-flight and again as it runs. */
	profile: string;
	/** The seat that emitted the node. */
	seat: string;
	lane: LaneInput;
	/** A verdict agent rules on work, `ok` or `rejected`; any other agent does the work. */
	verdict?: boolean;
	/** `false` starts the agent fresh in an encore, not continuing its counterpart's session. */
	encore?: boolean;
	checks?: string[];
	attachments?: Record<string, Attachment>;
	out?: Record<string, Output>;
};

/** Applies the changeset at input port `changeset` to the lane. */
export type ApplyConfig = {
	lane: LaneInput;
	strategy?: ApplyStrategy;
};

type RawLongCheck = {
	run: string | string[];
	hint?: string;
	timeout?: string;
	readOnly?: string[];
	writable?: string[];
	env?: Record<string, string>;
};

type RawCheck = string | string[] | RawLongCheck;

type RawPrepare = RawCheck | (RawLongCheck & { cache?: PrepareCache });

/** A check node's config, its inline check parsed. */
export type CheckConfig = { lane: LaneInput; check?: string | CheckSpec };

type RawSetup = {
	target?: {
		repo: string;
		base?: string;
		checks?: Record<string, RawCheck>;
		prepare?: RawPrepare;
		sparse?: Sparse;
	};
	sandbox?: { readOnly?: string[]; path?: string[] };
};

/**
 * A host directory, absolute, overlaid at `at` for the target's prepare, whose lines are told `at` in `env`. Writes
 * to it die with the sandbox.
 */
export type PrepareCache = { path: string; at: string; env: string };

/** The target's prepare: a check, and the host cache it may overlay. */
export type PrepareSpec = CheckSpec & { cache?: PrepareCache };

export type Target = {
	repo: string;
	base?: string;
	checks: Record<string, CheckSpec>;
	/** Run in every lane checked out from a commit, before its node's own work. */
	prepare?: PrepareSpec;
	/** Cone-mode directories, relative to the repository root, or `patterns`, that every checked-out lane is narrowed to. */
	sparse?: Sparse;
};

/** The host's config namespaces, parsed. */
export type RepoSetup = {
	store: string;
	target?: Target;
	/** The sandbox's read-only host paths: `sandbox.readOnly`, then the `sandbox.path` directories. */
	readOnly: string[];
	/** The PATH of every sandboxed process: the `sandbox.path` directories in order, then the system's. */
	path: string;
	/** The `sandbox` keys as configured, for validation. */
	sandbox: { readOnly: string[]; path: string[] };
};

const SYSTEM_PATH = "/usr/bin:/bin";

const ajv = validator();

/**
 * `value`, once it matches `schema`.
 * @throws Error naming `what` and each way it does not.
 */
function parsed<T>(schema: JsonSchema, value: unknown, what: string): T {
	const found = violations(ajv, schema, value, (at) => [what, ...at].join("."));
	if (found.length) throw new Error(found.join("; "));
	return value as T;
}

const longForm = (raw: RawCheck): RawLongCheck =>
	typeof raw === "string" || Array.isArray(raw) ? { run: raw } : raw;

/**
 * The check `raw` gives, `label` naming it in errors.
 * @throws Error when its timeout is not a duration.
 */
function checkSpec(raw: RawCheck, label = "check"): CheckSpec {
	const {
		run,
		hint,
		timeout,
		readOnly = [],
		writable = [],
		env = {},
	} = longForm(raw);
	const ms = timeout === undefined ? undefined : durationMs(timeout);
	if (timeout !== undefined && ms === undefined)
		throw new Error(
			`${label} timeout '${timeout}' is not a duration. Write it as ${DURATION_EXAMPLE}`,
		);
	return {
		lines: [run].flat(),
		...(hint !== undefined && { hint }),
		timeout: ms,
		readOnly,
		writable,
		env,
	};
}

/** The prepare `raw` gives, a leading `~/` of its cache path expanded to the host user's home. */
function prepareSpec(raw: RawPrepare): PrepareSpec {
	const spec = checkSpec(raw, "target.prepare");
	if (typeof raw !== "object" || Array.isArray(raw) || !("cache" in raw))
		return spec;
	const { cache } = raw;
	if (!cache) return spec;
	const path = cache.path.startsWith("~/")
		? join(homedir(), cache.path.slice(2))
		: cache.path;
	return { ...spec, cache: { ...cache, path } };
}

function targetOf(raw: RawSetup["target"]): Target | undefined {
	if (!raw) return undefined;
	const { prepare, ...rest } = raw;
	const checks = Object.entries(raw.checks ?? {}).map(
		([name, c]) => [name, checkSpec(c)] as const,
	);
	return {
		...rest,
		checks: Object.fromEntries(checks),
		...(prepare !== undefined && {
			prepare: prepareSpec(prepare),
		}),
	};
}

const isEmptyObject = (value: unknown) =>
	typeof value === "object" && value !== null && !Object.keys(value).length;

/**
 * The host's own namespaces of `setup`, parsed. An unset namespace is `{}`.
 * @throws Error when a namespace does not match its schema.
 */
export function repoSetup(setup: HostSetup): RepoSetup {
	const namespace = <T>(ns: keyof typeof HOST_CONFIG): T | undefined => {
		const value = setup.config[ns];
		const unset = value === undefined || isEmptyObject(value);
		return unset ? undefined : parsed<T>(HOST_CONFIG[ns], value, ns);
	};
	const { readOnly = [], path = [] } =
		namespace<RawSetup["sandbox"]>("sandbox") ?? {};
	return {
		store: setup.store,
		target: targetOf(namespace<RawSetup["target"]>("target")),
		readOnly: [...readOnly, ...path],
		path: [...path, SYSTEM_PATH].join(":"),
		sandbox: { readOnly, path },
	};
}

/** Whether `config`, an agent node's, was built before profiles. */
export const isLegacyAgent = (config: unknown) =>
	typeof config === "object" &&
	config !== null &&
	Object.hasOwn(config, LEGACY_ROLE);

export const agentConfig = (config: unknown): AgentConfig =>
	parsed(CURRENT_AGENT_CONFIG, config ?? {}, "config");

export const applyConfig = (config: unknown): ApplyConfig =>
	parsed(APPLY_CONFIG, config ?? {}, "config");

export const commitsConfig = (config: unknown): CommitsConfig =>
	parsed(COMMITS_CONFIG, config ?? {}, "config");

/**
 * The target `setup` names.
 * @throws Error when `target.repo` is not set.
 */
export function requireTarget(setup: RepoSetup): Target {
	if (!setup.target)
		throw new Error(
			"config 'target.repo' is not set. Set it to the repository lanes are cut from",
		);
	return setup.target;
}

/**
 * The check `name` of `target`.
 * @throws Error when `target.checks` has no check of that name, listing those it has.
 */
export function namedCheck(target: Target, name: string): CheckSpec {
	const spec = Object.hasOwn(target.checks, name)
		? target.checks[name]
		: undefined;
	if (!spec)
		throw new Error(
			`check '${name}' is not in config 'target.checks'. ${useOneOf(Object.keys(target.checks), "Add it under 'target.checks'")}`,
		);
	return spec;
}

/** Why check `name` cannot be given to an agent without a hint, and how to give it one. */
export const noHint = (name: string) => ({
	message: `check '${name}' has no hint, and an agent cannot use a check without one`,
	hint: `Add target.checks.${name}.hint, in the inline form { run, hint }`,
});

/** A check an agent may run: one with the hint the agent reads it by. */
export type AgentCheck = CheckSpec & { hint: string };

/**
 * The check `name` of `target`, for an agent to run.
 * @throws Error as `namedCheck` does, or when the check has no hint.
 */
export function agentCheck(target: Target, name: string): AgentCheck {
	const { hint, ...spec } = namedCheck(target, name);
	if (hint === undefined) {
		const why = noHint(name);
		throw new Error(`${why.message}. ${why.hint}`);
	}
	return { ...spec, hint };
}

/**
 * A check node's `config`, parsed.
 * @throws Error when it does not match its schema, or its timeout is not a duration.
 */
export function checkConfig(config: unknown): CheckConfig {
	const { lane, check } = parsed<{ lane: LaneInput; check?: RawCheck }>(
		CHECK_CONFIG,
		config ?? {},
		"config",
	);
	return typeof check === "object"
		? { lane, check: checkSpec(check) }
		: { lane, check };
}

/** The hint for a name not among `names`: use one of them, or `add` when there are none. */
export const useOneOf = (names: string[], add: string) =>
	names.length ? `Use one of: ${listed(names)}` : add;

/** `items` as prose: `a`, `a and b`, `a, b and c`. */
export const andList = (items: readonly string[]) =>
	new Intl.ListFormat("en-GB", { type: "conjunction" }).format(items);

/** The names of `names`, quoted and comma-separated, or `none` when there are none. */
export const listed = (names: Iterable<string>) =>
	[...names].map((n) => `'${n}'`).join(", ") || "none";
