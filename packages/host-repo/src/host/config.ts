import type { HostSetup } from "@maestro/core/host";
import { validator, violations } from "@maestro/core/ports";
import { durationMs, type JsonSchema } from "@maestro/ir";
import type { Role } from "../harness/index";

export const HOST_NAME = "repo";
export const AGENT_KIND = "repo.agent";
export const CHECK_KIND = "repo.check";
export const LANE_TYPE = "repo.lane";

/** The timeout of a check whose config gives none. */
const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

const NAME = { type: "string", minLength: 1 } as const;
const PATHS = { type: "array", items: NAME } as const;
const LINES = {
	anyOf: [NAME, { type: "array", items: NAME, minItems: 1 }],
} as const;
const INLINE_CHECK = {
	type: "object",
	required: ["run"],
	additionalProperties: false,
	properties: {
		run: LINES,
		timeout: NAME,
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

const LANE_INPUT = {
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
			properties: { mode: { enum: ["fork", "join", "read"] } },
		},
	],
} as const;

/** Output ports every agent has; a declared output takes none of these names. */
const AGENT_PORTS = ["lane", "report", "staged"];

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

export type LaneInput =
	| { mode: "fresh"; base?: string }
	| { mode: "fork" | "join" | "read" };

/** Shell lines run in order, and the milliseconds they may take together. */
export type CheckSpec = { lines: string[]; timeout: number };

export type Output =
	| { file: string; format: "json"; schema: JsonSchema }
	| { file: string; format: "markdown" };

export type AgentConfig = {
	role: { name: string } & Partial<Role>;
	lane: LaneInput;
	resume?: boolean;
	readOnly?: string[];
	out?: Record<string, Output>;
};

type RawCheck =
	| string
	| string[]
	| { run: string | string[]; timeout?: string };

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

/**
 * The check `raw` gives.
 * @throws Error when its timeout is not a duration.
 */
function checkSpec(raw: RawCheck): CheckSpec {
	if (typeof raw === "string" || Array.isArray(raw))
		return { lines: [raw].flat(), timeout: DEFAULT_CHECK_TIMEOUT_MS };
	const { run, timeout } = raw;
	const ms =
		timeout === undefined ? DEFAULT_CHECK_TIMEOUT_MS : durationMs(timeout);
	if (ms === undefined)
		throw new Error(
			`check timeout '${timeout}' is not a duration. Write it as 500ms, 90s, 15m, 12h or 7d`,
		);
	return { lines: [run].flat(), timeout: ms };
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
			`role '${name}' is not in config 'roles'. ${
				Object.keys(roles).length
					? `Use one of: ${listed(Object.keys(roles))}`
					: `Add it under 'roles'`
			}`,
		);
	return { ...role, ...overrides };
}
