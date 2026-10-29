import type { KeyPath } from "@maestro/core/config";
import type { HostSetup } from "@maestro/core/host";
import {
	CORE_TYPES,
	DURATION_EXAMPLE,
	durationMs,
	type JsonSchema,
	MAX_TIMEOUT,
	validator,
	violations,
} from "@maestro/ir";
import type { Output, Runtime } from "../harness/index";
import type { ApplyStrategy, Sparse } from "../lane/index";
import { PROFILE_PATHS, PROFILES, PROFILES_CONFIG } from "../profile/index";

export const HOST_NAME = "repo";
export const AGENT_KIND = "repo.agent";
export const CHECK_KIND = "repo.check";
export const CHANGESET_KIND = "repo.changeset";
export const APPLY_KIND = "repo.apply";
export const COMMITS_KIND = "repo.commits";
export const LANE_TYPE = "repo.lane";

/** The port a lane version travels on, in and out. */
export const LANE_PORT = "lane";
/** Input ports every agent has; an attachment takes none of these names. */
export const AGENT_IN_PORTS = ["prompt", "identity", LANE_PORT];
/** The port an apply node takes its changeset on. */
export const CHANGESET_PORT = "changeset";

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
		timeout: NAME,
		readOnly: PATHS,
		writable: PATHS,
		env: ENV,
	},
} as const;
const CHECK = { anyOf: [LINES, INLINE_CHECK] } as const;

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
			prepare: CHECK,
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
	roles: {
		type: "object",
		additionalProperties: {
			type: "object",
			required: ["harness", "model"],
			additionalProperties: false,
			properties: { harness: NAME, model: NAME, thinking: NAME },
		},
	},
	sandbox: {
		type: "object",
		additionalProperties: false,
		properties: { readOnly: PATHS, path: PATHS },
	},
	[PROFILES]: PROFILES_CONFIG,
} as const satisfies Record<string, JsonSchema>;

/** The schema of the role fields the command line sets: those of `roles`, none required. */
const COMMAND_ROLES = {
	type: "object",
	additionalProperties: {
		...HOST_CONFIG.roles.additionalProperties,
		required: [],
	},
} as const satisfies JsonSchema;

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

/** An agent's lane input: an `extend` may also resume the session that wrote the version it continues. */
const AGENT_LANE_INPUT = {
	oneOf: [
		...laneInput(["fork", "read"]).oneOf,
		{
			type: "object",
			required: ["mode"],
			additionalProperties: false,
			properties: { mode: { const: "extend" }, resume: { type: "boolean" } },
		},
	],
} as const;

/** Output ports every agent has; a declared output takes none of these names. */
export const AGENT_OUT_PORTS = [LANE_PORT, "report", "staged"];

const OUTBOX_FILE = {
	type: "string",
	pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]*$",
};

export const AGENT_CONFIG = {
	type: "object",
	required: ["role", "lane"],
	additionalProperties: false,
	properties: {
		role: {
			type: "object",
			required: ["name"],
			additionalProperties: false,
			properties: { name: NAME, harness: NAME, model: NAME, thinking: NAME },
		},
		lane: AGENT_LANE_INPUT,
		limits: {
			type: "object",
			additionalProperties: false,
			properties: {
				timeout: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT },
				tokens: { type: "integer", minimum: 1 },
			},
		},
		verdict: { type: "boolean" },
		readOnly: PATHS,
		checks: { type: "array", items: NAME, uniqueItems: true },
		attachments: {
			type: "object",
			propertyNames: {
				pattern: PORT_NAME,
				not: { enum: AGENT_IN_PORTS },
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
	| { mode: "fork" | "read" }
	| { mode: "extend"; resume?: boolean };

/**
 * Shell lines run in order, and the milliseconds they may take together, none when unset. `readOnly` and `writable` are absolute host
 * paths bound at their own paths; `env` is set for the check alone.
 */
export type CheckSpec = {
	lines: string[];
	timeout?: number;
	readOnly: string[];
	writable: string[];
	env: Record<string, string>;
};

/** The artifact types an attachment can have. */
type AttachmentType = (typeof CORE_TYPES)[keyof typeof CORE_TYPES];

/** A file or directory an agent reads at `/in/<name>`, and the hint that says when it should. */
export type Attachment = { hint: string; type?: AttachmentType };

/** What stops an agent that runs on: wall clock in milliseconds from its first turn, and tokens as `tokensOf` sums. */
export type AgentLimits = { timeout?: number; tokens?: number };

export type AgentConfig = {
	role: { name: string } & Partial<Runtime>;
	lane: LaneInput;
	limits?: AgentLimits;
	/** A verdict agent rules on work, `ok` or `rejected`; any other agent does the work. */
	verdict?: boolean;
	readOnly?: string[];
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
	timeout?: string;
	readOnly?: string[];
	writable?: string[];
	env?: Record<string, string>;
};

type RawCheck = string | string[] | RawLongCheck;

/** A check node's config, its inline check parsed. */
export type CheckConfig = { lane: LaneInput; check?: string | CheckSpec };

type RawSetup = {
	target?: {
		repo: string;
		base?: string;
		checks?: Record<string, RawCheck>;
		prepare?: RawCheck;
		sparse?: Sparse;
	};
	roles?: Record<string, Runtime>;
	sandbox?: { readOnly?: string[]; path?: string[] };
};

export type Target = {
	repo: string;
	base?: string;
	checks: Record<string, CheckSpec>;
	/** Run in every lane checked out from a commit, before its node's own work. */
	prepare?: CheckSpec;
	/** Cone-mode directories, relative to the repository root, or `patterns`, that every checked-out lane is narrowed to. */
	sparse?: Sparse;
};

/** The host's config namespaces, parsed. */
export type RepoSetup = {
	store: string;
	target?: Target;
	roles: Record<string, Runtime>;
	/** The fields of `roles` that `--profile` and `-c` set, which outrank a composition's inline role fields. */
	commandRoles: Record<string, Partial<Runtime>>;
	/** The key paths `--profile` and `-c` replaced whole with `!replace`. */
	commandReplaced: readonly KeyPath[];
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
	return { lines: [run].flat(), timeout: ms, readOnly, writable, env };
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
			prepare: checkSpec(prepare, "target.prepare"),
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
		roles: namespace<RawSetup["roles"]>("roles") ?? {},
		commandRoles: parsed(
			COMMAND_ROLES,
			setup.commandLine.values.roles ?? {},
			"roles",
		),
		commandReplaced: setup.commandLine.replaced,
		readOnly: [...readOnly, ...path],
		path: [...path, SYSTEM_PATH].join(":"),
		sandbox: { readOnly, path },
	};
}

export const agentConfig = (config: unknown): AgentConfig =>
	parsed(AGENT_CONFIG, config ?? {}, "config");

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

/** The names of `names`, quoted and comma-separated, or `none` when there are none. */
export const listed = (names: Iterable<string>) =>
	[...names].map((n) => `'${n}'`).join(", ") || "none";

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
	Object.hasOwn(record, key) ? record[key] : undefined;

/** Where a role field comes from: the config file's role, the composition's inline fields, or the command line. */
export type RoleTier = "file" | "composition" | "command";

/** A role field's value and the tier that set it, with the origin of the tier it displaced, when one did. */
export type RoleOrigin = {
	value: string;
	tier: RoleTier;
	beneath?: { value: string; tier: RoleTier };
};

/** The fields a role resolves to, each with the tier that set it. */
export type RoleOrigins = Partial<Record<keyof Runtime, RoleOrigin>>;

/**
 * The fields `role` resolves to, each with its tier: the config file's role of its name, then its inline fields, then
 * the command line's fields of that role. Each field comes from the highest tier that sets it, and a role the command
 * line replaced whole has no inline fields.
 */
export function roleOrigins(
	role: AgentConfig["role"],
	setup: RepoSetup,
): RoleOrigins {
	const { name, ...pinned } = role;
	const replaced = setup.commandReplaced.some(
		(path) => path[0] === "roles" && (path.length === 1 || path[1] === name),
	);
	const tiers: [RoleTier, Partial<Runtime> | undefined][] = [
		["file", own(setup.roles, name)],
		["composition", replaced ? {} : pinned],
		["command", own(setup.commandRoles, name)],
	];
	const origins: Record<string, RoleOrigin> = {};
	for (const [tier, fields] of tiers)
		for (const [field, value] of Object.entries(fields ?? {})) {
			const beneath = origins[field];
			origins[field] = {
				value,
				tier,
				...(beneath && {
					beneath: { value: beneath.value, tier: beneath.tier },
				}),
			};
		}
	return origins;
}

/** The fields `role` resolves to, as `roleOrigins` says. */
export const roleFields = (
	role: AgentConfig["role"],
	setup: RepoSetup,
): Partial<Runtime> =>
	Object.fromEntries(
		Object.entries(roleOrigins(role, setup)).map(([k, o]) => [k, o.value]),
	);

/**
 * The role `config` names, resolved as `roleFields` says.
 * @throws Error when `setup.roles` has no role of that name, listing those it has.
 */
export function resolveRole(
	config: AgentConfig["role"],
	setup: RepoSetup,
): Runtime {
	if (!own(setup.roles, config.name))
		throw new Error(
			`role '${config.name}' is not in config 'roles'. ${useOneOf(Object.keys(setup.roles), "Add it under 'roles'")}`,
		);
	return roleFields(config, setup) as Runtime;
}
