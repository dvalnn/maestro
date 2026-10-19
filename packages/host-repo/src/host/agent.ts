import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	HostContext,
	HostInstance,
	HostNodeResult,
	NodeKind,
} from "@maestro/core/host";
import type { Inputs } from "@maestro/core/node";
import {
	CORE_TYPES,
	type HostNode,
	type JsonSchema,
	MAESTRO_TYPE,
	messageOf,
	type Ports,
	validator,
	violations,
} from "@maestro/ir";
import {
	type Harness,
	type HarnessRequest,
	type Metrics,
	OUTBOX,
	type Role,
} from "../harness/index";
import type { Bind } from "../sandbox/index";
import { type AgentChecks, stageChecks } from "./agent-checks";
import {
	AGENT_CONFIG,
	AGENT_KIND,
	type AgentConfig,
	type Attachment,
	agentConfig,
	LANE_PORT,
	listed,
	namedCheck,
	type Output,
	repoSetup,
	requireTarget,
	resolveRole,
	type Target,
} from "./config";
import { artifactInput, textInput } from "./inputs";
import { lanePorts, readOnlyBinds, withLane } from "./lane-input";
import { type Live, liveInstances } from "./live";
import {
	mintSession,
	openTarget,
	recordWriter,
	type Session,
	writerOf,
} from "./store";

/** Turns that ask the agent again for an envelope, after its first final reply is not one. */
const MAX_CORRECTIONS = 2;

const TEXT = { type: "string" };

/** The directory where an agent's sandbox mounts its attachments. */
const ATTACHMENT_DIR = "/in";
/** Where the sandbox sees attachment `name`. */
const attachmentPath = (name: string) => `${ATTACHMENT_DIR}/${name}`;

/**
 * An agent's final reply (GLOSSARY: Envelope). A work agent's has no `outcome` or `reason`; a verdict agent's has an
 * `outcome` unless blocked.
 */
type Envelope = {
	report: string;
	blocked?: string;
	outcome?: "ok" | "rejected";
	reason?: string;
};

const CAUSE = { type: "string", minLength: 1 };

const envelopeSchema = (verdict: Record<string, JsonSchema>): JsonSchema => ({
	type: "object",
	required: ["report"],
	additionalProperties: false,
	properties: { report: { type: "string" }, blocked: CAUSE, ...verdict },
});

const BLOCKED_BAR =
	"you cannot proceed, the cause is outside your reach, and nothing later in this run will change it.";

/** What a reply kind takes: its envelope's schema, the line that asks for the declared files, and how to reply. */
type ReplyKind = { schema: JsonSchema; files: string; reply: string[] };

const REPLY_LEAD =
	"Your final reply must be only this JSON object, with no other text:";

const WORK: ReplyKind = {
	schema: envelopeSchema({}),
	files: "Before your final reply, write every one of these files:",
	reply: [
		REPLY_LEAD,
		'{"report": "<what you did>"}',
		`Add "blocked": "<the cause>" only when ${BLOCKED_BAR}`,
	],
};

const VERDICT: ReplyKind = {
	schema: envelopeSchema({
		outcome: { enum: ["ok", "rejected"] },
		reason: CAUSE,
	}),
	files:
		"Before your final reply, write every one of these files, even when you reject:",
	reply: [
		REPLY_LEAD,
		'{"report": "<what you did>", "outcome": "ok" | "rejected", "reason": "<why, required when rejected>"}',
		'Set "outcome" to "rejected" when your verdict on the work is negative, and say why in "reason".',
		`Give "blocked": "<the cause>" in place of "outcome" and "reason" only when ${BLOCKED_BAR}`,
	],
};

const FENCED = /^```(?:json)?\n([\s\S]*)\n```$/;

const ajv = validator();

/** The ports of an agent node: its `identity` input only where the node declares one. */
function agentPorts(node: HostNode): { in: Ports; out: Ports } {
	const config = agentConfig(node.config);
	const lane = lanePorts(config.lane);
	const identity: Ports = Object.hasOwn(node.in ?? {}, "identity")
		? { identity: TEXT }
		: {};
	const declared = Object.entries(config.out ?? {}).map(([port, o]) => [
		port,
		o.format === "json"
			? {
					...(typeof o.schema === "object" && o.schema),
					[MAESTRO_TYPE]: CORE_TYPES.jsonFile,
				}
			: { [MAESTRO_TYPE]: CORE_TYPES.markdown },
	]);
	const attachments = Object.entries(config.attachments ?? {}).map(
		([name, attachment]) => [
			name,
			{ [MAESTRO_TYPE]: attachment.type ?? CORE_TYPES.file },
		],
	);
	return {
		in: {
			prompt: TEXT,
			...identity,
			...Object.fromEntries(attachments),
			...lane.in,
		},
		out: {
			report: TEXT,
			staged: { [MAESTRO_TYPE]: CORE_TYPES.dir },
			...lane.out,
			...Object.fromEntries(declared),
		},
	};
}

/** What the output contract appended to the task asks of an agent of reply kind `kind`. */
function contract(out: Record<string, Output>, kind: ReplyKind): string {
	const files = Object.values(out).map((o) =>
		o.format === "json"
			? `- ${OUTBOX}/${o.file}: JSON matching this JSON Schema: ${JSON.stringify(o.schema)}`
			: `- ${OUTBOX}/${o.file}: Markdown`,
	);
	return [
		"",
		"---",
		"",
		...(files.length ? [kind.files, ...files, ""] : []),
		...kind.reply,
	].join("\n");
}

const correction = (problem: string, kind: ReplyKind) =>
	[`Your final reply is not the envelope: ${problem}.`, ...kind.reply].join(
		"\n",
	);

/** The envelope of reply kind `kind` that `reply` holds, bare or in one fenced block, or what is wrong with it. */
function envelopeOf(reply: string, kind: ReplyKind): Envelope | string {
	const trimmed = reply.trim();
	let value: unknown;
	try {
		value = JSON.parse(FENCED.exec(trimmed)?.[1] ?? trimmed);
	} catch {
		return "it is not a JSON object";
	}
	const found = violations(ajv, kind.schema, value, (at) =>
		["envelope", ...at].join("."),
	);
	if (found.length) return found.join("; ");
	const envelope = value as Envelope;
	const verdict = envelope.outcome ?? envelope.reason;
	if (envelope.blocked !== undefined && verdict !== undefined)
		return "envelope.blocked excludes envelope.outcome and envelope.reason";
	if (kind === VERDICT && envelope.blocked === undefined && !envelope.outcome)
		return "envelope.outcome is required unless envelope.blocked is set";
	if (envelope.outcome === "rejected" && !envelope.reason)
		return "envelope.reason is required when outcome is rejected";
	return envelope;
}

/**
 * Why the declared output `o` in `outbox` cannot be read, or `undefined` when it can. Only a regular file directly in
 * the outbox is read, so a link cannot reach outside it.
 */
function outputProblem(outbox: string, o: Output): string | undefined {
	const shown = `${OUTBOX}/${o.file}`;
	const stats = lstatSync(join(outbox, o.file), { throwIfNoEntry: false });
	if (!stats) return `the agent wrote no ${shown}`;
	if (!stats.isFile()) return `${shown} is not a regular file`;
	if (o.format === "markdown") return undefined;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(join(outbox, o.file), "utf8"));
	} catch (e) {
		return `${shown} is not JSON: ${messageOf(e)}`;
	}
	const found = violations(ajv, o.schema, value, (at) =>
		[shown, ...at].join(" at "),
	);
	return found.length ? found.join("; ") : undefined;
}

/** The declared outputs' paths by port, or why one cannot be read. */
function readOutbox(
	outbox: string,
	out: Record<string, Output>,
): { outputs: Record<string, string> } | { problem: string } {
	const outputs: Record<string, string> = {};
	for (const [port, o] of Object.entries(out)) {
		const problem = outputProblem(outbox, o);
		if (problem) return { problem: `output '${port}': ${problem}` };
		outputs[port] = join(outbox, o.file);
	}
	return { outputs };
}

/**
 * The session an agent continues, the one that wrote the version it extends.
 * @throws Error when it extends no version, or one no agent of its harness and concert wrote.
 */
function resumed(
	root: string,
	lane: unknown,
	harness: string,
	concert: string,
): Session {
	if (typeof lane !== "string")
		throw new Error(
			"resume continues the session of an extended version. Extend a lane version, or drop resume",
		);
	const session = writerOf(root, lane);
	if (!session)
		throw new Error(
			`no agent wrote version ${lane}, so it has no session to resume. Drop resume`,
		);
	if (session.harness !== harness)
		throw new Error(
			`version ${lane} was written by harness '${session.harness}', not '${harness}'. Drop resume, or use a role of '${session.harness}'`,
		);
	if (session.concert !== concert)
		throw new Error(`version ${lane} belongs to another concert. Drop resume`);
	return session;
}

/** How the agent's turns ended: its envelope, or why there is none. */
type Turns = { metrics: Metrics } & (
	| { envelope: Envelope }
	| { failure: string }
);

function addMetrics(sum: Metrics, add: Metrics) {
	for (const [k, v] of Object.entries(add)) sum[k] = (sum[k] ?? 0) + v;
}

async function turn(
	harness: Harness,
	req: HarnessRequest,
	live: Live,
	emit: HostContext["emit"],
) {
	const run = harness.run(req);
	live.stop = () => run.cancel();
	for await (const e of run.events) if (e.kind !== "raw") emit(e);
	return run.result;
}

/** What follows an agent's final reply: how the run ends, or the correction to send. */
type Next = { envelope: Envelope } | { failure: string } | { prompt: string };

function next(reply: string, spent: boolean, kind: ReplyKind): Next {
	const envelope = envelopeOf(reply, kind);
	if (typeof envelope !== "string") return { envelope };
	return spent
		? {
				failure: `the final reply is not the envelope after ${MAX_CORRECTIONS} corrections: ${envelope}. Check the role's model follows the output contract in staged/prompt.md`,
			}
		: { prompt: correction(envelope, kind) };
}

/** Runs the agent, then corrects it in the same session while its final reply is not an envelope. */
async function converse(
	harness: Harness,
	req: HarnessRequest,
	live: Live,
	context: HostContext,
	staged: string,
	kind: ReplyKind,
): Promise<Turns> {
	const metrics: Metrics = {};
	let prompt = req.prompt;
	for (let corrections = 0; ; corrections++) {
		if (live.cancelled) return { metrics, failure: "cancelled" };
		const result = await turn(harness, { ...req, prompt }, live, context.emit);
		addMetrics(metrics, result.metrics);
		if (result.outcome === "failed")
			return { metrics, failure: result.reason ?? "the harness failed" };
		const step = next(result.reply, corrections === MAX_CORRECTIONS, kind);
		if (!("prompt" in step)) return { metrics, ...step };
		prompt = step.prompt;
		writeFileSync(join(staged, `correction-${corrections + 1}.md`), prompt);
	}
}

/** Writes the staged text: the user message, and the identity when there is one, whose path it returns. */
function stage(dir: string, prompt: string, identity: string | undefined) {
	writeFileSync(join(dir, "prompt.md"), prompt);
	if (!identity) return undefined;
	const path = join(dir, "identity.md");
	writeFileSync(path, identity);
	return path;
}

/** What one instance stages and where. */
type Staging = {
	role: Role;
	config: AgentConfig;
	session: Session;
	staged: string;
	outbox: string;
};

/** The harness, model and effort an agent runs on, as its start event and its enrichment report them. */
const identityOf = ({ harness, model, thinking }: Role) => ({
	harness,
	model,
	thinking,
});

/** The node result of `turns`. Once the agent gave an envelope that is not blocked, and readable outputs, `seal` seals its lane. */
async function settle(
	staging: Staging,
	turns: Turns,
	seal: () => Promise<string | undefined>,
): Promise<HostNodeResult> {
	const { role, session } = staging;
	const { metrics } = turns;
	const enrichment = { session: session.id, ...identityOf(role) };
	if ("failure" in turns)
		return { outcome: "failed", reason: turns.failure, metrics, enrichment };
	const { blocked, outcome = "ok", reason = "", report } = turns.envelope;
	if (blocked !== undefined)
		return {
			outcome: "failed",
			reason: `blocked: ${blocked}`,
			metrics,
			enrichment,
		};
	const read = readOutbox(staging.outbox, staging.config.out ?? {});
	if ("problem" in read)
		return outcome === "ok"
			? { outcome: "failed", reason: read.problem, metrics, enrichment }
			: { outcome, reason, metrics, enrichment };
	const version = await seal();
	const outputs = {
		report,
		staged: staging.staged,
		...(version && { [LANE_PORT]: version }),
		...read.outputs,
	};
	return outcome === "ok"
		? { outcome, outputs, metrics, enrichment }
		: { outcome, reason, outputs, metrics, enrichment };
}

/** The prompt text the attachments add, one line per attachment. */
const attachmentNote = (attachments: [string, Attachment][]) =>
	attachments.length
		? [
				"",
				"",
				"Read-only attachments in your sandbox:",
				...attachments.map(
					([name, a]) => `- ${attachmentPath(name)}: ${a.hint}`,
				),
			].join("\n")
		: "";

/** What the attachments and checks of `config` add to an agent's sandbox and prompt. */
function extrasOf(
	config: AgentConfig,
	target: Target,
	inputs: Inputs,
	context: HostContext,
): AgentChecks {
	const attachments = Object.entries(config.attachments ?? {});
	const checks = stageChecks(
		context.scratch,
		(config.checks ?? []).map((name) => [name, namedCheck(target, name)]),
	);
	const mounts: Bind[] = attachments.map(([name]) => ({
		src: artifactInput(inputs, context, name),
		dst: attachmentPath(name),
	}));
	return {
		...checks,
		readOnly: [...mounts, ...checks.readOnly],
		note: attachmentNote(attachments) + checks.note,
	};
}

async function execute(
	harnesses: readonly Harness[],
	instance: HostInstance,
	inputs: Inputs,
	context: HostContext,
	live: Live,
): Promise<HostNodeResult> {
	const setup = repoSetup(context.setup);
	const config = agentConfig(instance.node.config);
	const role = resolveRole(config.role, setup.roles);
	const harness = harnesses.find((h) => h.name === role.harness);
	if (!harness)
		throw new Error(
			`harness '${role.harness}' is not loaded. Use one of: ${listed(harnesses.map((h) => h.name))}`,
		);
	const target = requireTarget(setup);
	const store = openTarget(setup.store, target.repo, target.sparse);
	const session =
		config.lane.mode === "extend" && config.lane.resume
			? resumed(store.root, inputs[LANE_PORT], role.harness, context.concert)
			: mintSession(store.root, role.harness, context.concert);
	const run = { concert: context.concert, instance, live, emit: context.emit };
	return withLane(
		store,
		setup,
		config.lane,
		inputs[LANE_PORT],
		run,
		async (open) => {
			const { lane, read } = open;
			const staging: Staging = {
				role,
				config,
				session,
				staged: join(context.scratch, "staged"),
				outbox: join(context.scratch, "out"),
			};
			mkdirSync(staging.staged);
			mkdirSync(staging.outbox);
			context.emit({ kind: "agent", ...identityOf(role) });
			const extras = extrasOf(config, target, inputs, context);
			const kind = config.verdict ? VERDICT : WORK;
			const prompt =
				textInput(inputs, "prompt") +
				extras.note +
				contract(config.out ?? {}, kind);
			const identity =
				inputs.identity === undefined
					? undefined
					: textInput(inputs, "identity");
			const req: HarnessRequest = {
				role,
				prompt,
				lane: lane.dir,
				readOnly: [
					...readOnlyBinds(lane, setup.readOnly, config.readOnly ?? []),
					...extras.readOnly,
				],
				writable: extras.writable,
				env: extras.env,
				identity: stage(staging.staged, prompt, identity),
				outbox: staging.outbox,
				session: { dir: session.dir, id: session.id },
				verdict: config.verdict,
			};
			const turns = await converse(
				harness,
				req,
				live,
				context,
				staging.staged,
				kind,
			);
			return settle(staging, turns, async () => {
				if (read) return undefined;
				const version = await lane.seal();
				recordWriter(store.root, version, session);
				return version;
			});
		},
	);
}

/** The `repo.agent` kind, running each instance's role on the harness of that name among `harnesses`. */
export function agentKind(harnesses: readonly Harness[]): NodeKind {
	const live = liveInstances();
	return {
		name: AGENT_KIND,
		config: AGENT_CONFIG,
		ports: agentPorts,
		execute: (instance, inputs, context) =>
			live.execute(instance, (state) =>
				execute(harnesses, instance, inputs, context, state),
			),
		cancel: (instance) => live.cancel(instance),
	};
}
