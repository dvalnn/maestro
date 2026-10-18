import type { HostSetup } from "@maestro/core/host";
import { validator, violations } from "@maestro/core/ports";
import { CORE_TYPES, durationMs, type JsonSchema } from "@maestro/ir";
import type { Role } from "../harness/index";
import type { ApplyStrategy } from "../lane/index";

export const HOST_NAME = "repo";
export const AGENT_KIND = "repo.agent";
export const CHECK_KIND = "repo.check";
export const CHANGESET_KIND = "repo.changeset";
export const APPLY_KIND = "repo.apply";
export const LANE_TYPE = "repo.lane";

/** The port a lane version travels on, in and out. */
export const LANE_PORT = "lane";
/** Input ports every agent has; a ref takes none of these names. */
const AGENT_IN_PORTS = ["prompt", "identity", LANE_PORT];

/** The timeout of a check whose config gives none. */
const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

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

/** The config namespaces the host owns. */
export const HOST_CONFIG = {
	target: {
		type: "object",
		required: ["repo"],
		additionalProperties: false,
		properties: {
			repo: NAME,
			base: NAME,
			checks: {
				type: "object",
				additionalProperties: { anyOf: [LINES, INLINE_CHECK] },
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
		properties: { readOnly: PATHS },
	},
} as const satisfies Record<string, JsonSchema>;

/** The lane input schema for a node that may also take the modes `others` beside `fresh`. */
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
const LANE_INPUT = laneInput(["fork", "join", "read"]);

/** Output ports every agent has; a declared output takes none of these names. */
const AGENT_PORTS = [LANE_PORT, "report", "staged"];

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
		lane: LANE_INPUT,
		resume: { type: "boolean" },
		readOnly: PATHS,
		checks: { type: "array", items: NAME, uniqueItems: true },
		refs: {
			type: "object",
			propertyNames: {
				pattern: PORT_NAME,
				not: { enum: AGENT_IN_PORTS },
			},
			additionalProperties: {
				type: "object",
				required: ["when"],
				additionalProperties: false,
				properties: {
					when: NAME,
					type: { enum: Object.values(CORE_TYPES) },
				},
			},
		},
		out: {
			type: "object",
			propertyNames: { not: { enum: AGENT_PORTS } },
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
	required: ["lane", "changesets"],
	additionalProperties: false,
	properties: {
		lane: laneInput(["fork", "join"]),
		changesets: {
			type: "array",
			minItems: 1,
			uniqueItems: true,
			items: { type: "string", pattern: PORT_NAME, not: { const: LANE_PORT } },
		},
		strategy: { enum: ["3way", "ff"] },
	},
} as const;

export const CHANGESET_CONFIG = {
	type: "object",
	additionalProperties: false,
} as const;

export type LaneInput =
	| { mode: "fresh"; base?: string }
	| { mode: "fork" | "join" | "read" };

/**
 * Shell lines run in order, and the milliseconds they may take together. `readOnly` and `writable` are absolute host
 * paths bound at their own paths; `env` is set for the check alone.
 */
export type CheckSpec = {
	lines: string[];
	timeout: number;
	readOnly: string[];
	writable: string[];
	env: Record<string, string>;
};

/** The artifact types a ref can have. */
type RefType = (typeof CORE_TYPES)[keyof typeof CORE_TYPES];

/** A file or directory an agent reads at `/in/<name>`, and when it should. */
export type Ref = { when: string; type?: RefType };

export type Output =
	| { file: string; format: "json"; schema: JsonSchema }
	| { file: string; format: "markdown" };

export type AgentConfig = {
	role: { name: string } & Partial<Role>;
	lane: LaneInput;
	resume?: boolean;
	readOnly?: string[];
	checks?: string[];
	refs?: Record<string, Ref>;
	out?: Record<string, Output>;
};

/** Applies the artifacts at input ports `changesets`, in that order, to the lane. */
export type ApplyConfig = {
	lane: LaneInput;
	changesets: string[];
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
	target?: { repo: string; base?: string; checks?: Record<string, RawCheck> };
	roles?: Record<string, Role>;
	sandbox?: { readOnly?: string[] };
};

export type Target = {
	repo: string;
	base?: string;
	checks: Record<string, CheckSpec>;
};

/** The host's config namespaces, parsed. */
export type RepoSetup = {
	store: string;
	target?: Target;
	roles: Record<string, Role>;
	readOnly: string[];
};

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
 * The check `raw` gives.
 * @throws Error when its timeout is not a duration.
 */
function checkSpec(raw: RawCheck): CheckSpec {
	const {
		run,
		timeout,
		readOnly = [],
		writable = [],
		env = {},
	} = longForm(raw);
	const ms =
		timeout === undefined ? DEFAULT_CHECK_TIMEOUT_MS : durationMs(timeout);
	if (ms === undefined)
		throw new Error(
			`check timeout '${timeout}' is not a duration. Write it as 500ms, 90s, 15m, 12h or 7d`,
		);
	return { lines: [run].flat(), timeout: ms, readOnly, writable, env };
}

function targetOf(raw: RawSetup["target"]): Target | undefined {
	if (!raw) return undefined;
	const checks = Object.entries(raw.checks ?? {}).map(
		([name, c]) => [name, checkSpec(c)] as const,
	);
	return { ...raw, checks: Object.fromEntries(checks) };
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
	return {
		store: setup.store,
		target: targetOf(namespace<RawSetup["target"]>("target")),
		roles: namespace<RawSetup["roles"]>("roles") ?? {},
		readOnly: namespace<RawSetup["sandbox"]>("sandbox")?.readOnly ?? [],
	};
}

export const agentConfig = (config: unknown): AgentConfig =>
	parsed(AGENT_CONFIG, config ?? {}, "config");

export const applyConfig = (config: unknown): ApplyConfig =>
	parsed(APPLY_CONFIG, config ?? {}, "config");

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

/**
 * The role `config` names, with its overrides laid over it.
 * @throws Error when `roles` has no role of that name, listing those it has.
 */
export function resolveRole(
	config: AgentConfig["role"],
	roles: Record<string, Role>,
): Role {
	const { name, ...overrides } = config;
	const role = Object.hasOwn(roles, name) ? roles[name] : undefined;
	if (!role)
		throw new Error(
			`role '${name}' is not in config 'roles'. ${useOneOf(Object.keys(roles), "Add it under 'roles'")}`,
		);
	return { ...role, ...overrides };
}
