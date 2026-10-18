import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { messageOf } from "@maestro/core";
import type {
	HostContext,
	HostInstance,
	HostNodeResult,
	NodeKind,
} from "@maestro/core/host";
import type { Inputs } from "@maestro/core/node";
import { validator, violations } from "@maestro/core/ports";
import {
	CORE_TYPES,
	type HostNode,
	type JsonSchema,
	MAESTRO_TYPE,
	type Ports,
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
	agentConfig,
	LANE_PORT,
	listed,
	namedCheck,
	type Output,
	type Ref,
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

/** The directory where an agent's sandbox mounts its refs. */
const REF_DIR = "/in";
/** Where the sandbox sees ref `name`. */
const refPath = (name: string) => `${REF_DIR}/${name}`;

/** An agent's final reply (GLOSSARY: Envelope). */
type Envelope = { outcome: "ok" | "rejected"; reason?: string; report: string };

const ENVELOPE: JsonSchema = {
	type: "object",
	required: ["outcome", "report"],
	additionalProperties: false,
	properties: {
		outcome: { enum: ["ok", "rejected"] },
		reason: { type: "string", minLength: 1 },
		report: { type: "string" },
	},
};

const ENVELOPE_SHAPE =
	'{"outcome": "ok" | "rejected", "reason": "<why, required when rejected>", "report": "<what you did>"}';

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
	const refs = Object.entries(config.refs ?? {}).map(([name, ref]) => [
		name,
		{ [MAESTRO_TYPE]: ref.type ?? CORE_TYPES.file },
	]);
	return {
		in: { prompt: TEXT, ...identity, ...Object.fromEntries(refs), ...lane.in },
		out: {
			report: TEXT,
			staged: { [MAESTRO_TYPE]: CORE_TYPES.dir },
			...lane.out,
			...Object.fromEntries(declared),
		},
	};
}

/** What the output contract appended to the task asks of the agent. */
function contract(out: Record<string, Output>): string {
	const files = Object.values(out).map((o) =>
		o.format === "json"
			? `- ${OUTBOX}/${o.file}: JSON matching this JSON Schema: ${JSON.stringify(o.schema)}`
			: `- ${OUTBOX}/${o.file}: Markdown`,
	);
	return [
		"",
		"---",
		"",
		...(files.length
			? ["Before your final reply, write these files:", ...files, ""]
			: []),
		"Your final reply must be only this JSON object, with no other text:",
		ENVELOPE_SHAPE,
		'Set "outcome" to "rejected" when your own verdict is negative, and say why in "reason".',
	].join("\n");
}

const correction = (problem: string) =>
	`Your final reply is not the envelope: ${problem}.\nReply again with only this JSON object:\n${ENVELOPE_SHAPE}`;

/** The envelope `reply` holds, bare or in one fenced block, or what is wrong with it. */
function envelopeOf(reply: string): Envelope | string {
	const trimmed = reply.trim();
	let value: unknown;
	try {
		value = JSON.parse(FENCED.exec(trimmed)?.[1] ?? trimmed);
	} catch {
		return "it is not a JSON object";
	}
	const found = violations(ajv, ENVELOPE, value, (at) =>
		["envelope", ...at].join("."),
	);
	if (found.length) return found.join("; ");
	const envelope = value as Envelope;
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
 * The session an agent continues, the one that wrote the version it joins.
 * @throws Error when it joins no version, or one no agent of its harness and concert wrote.
 */
function resumed(
	root: string,
	config: AgentConfig,
	lane: unknown,
	harness: string,
	concert: string,
): Session {
	if (config.lane.mode !== "join" || typeof lane !== "string")
		throw new Error(
			"resume continues the session of a joined version. Join the lane, or drop resume",
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

/** Runs the agent, then corrects it in the same session while its final reply is not an envelope. */
async function converse(
	harness: Harness,
	req: HarnessRequest,
	live: Live,
	context: HostContext,
	staged: string,
): Promise<Turns> {
	const metrics: Metrics = {};
	let prompt = req.prompt;
	for (let corrections = 0; ; corrections++) {
		if (live.cancelled) return { metrics, failure: "cancelled" };
		const result = await turn(harness, { ...req, prompt }, live, context.emit);
		addMetrics(metrics, result.metrics);
		if (result.outcome === "failed")
			return { metrics, failure: result.reason ?? "the harness failed" };
		const envelope = envelopeOf(result.reply);
		if (typeof envelope !== "string") return { metrics, envelope };
		if (corrections === MAX_CORRECTIONS)
			return {
				metrics,
				failure: `the final reply is not the envelope after ${MAX_CORRECTIONS} corrections: ${envelope}. Check the role's model follows the output contract in staged/prompt.md`,
			};
		prompt = correction(envelope);
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

/** The node result of `turns`. Once the agent gave its envelope and readable outputs, `seal` seals its lane. */
async function settle(
	staging: Staging,
	turns: Turns,
	seal: () => Promise<string | undefined>,
): Promise<HostNodeResult> {
	const { role, session } = staging;
	const { metrics } = turns;
	const enrichment = {
		session: session.id,
		harness: role.harness,
		model: role.model,
	};
	if ("failure" in turns)
		return { outcome: "failed", reason: turns.failure, metrics, enrichment };
	const { outcome, reason = "", report } = turns.envelope;
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

/** The prompt text each ref adds, one line per ref. */
const refNote = (refs: [string, Ref][]) =>
	refs.length
		? [
				"",
				"",
				"Read-only references in your sandbox:",
				...refs.map(
					([name, ref]) => `- ${refPath(name)}: read when ${ref.when}`,
				),
			].join("\n")
		: "";

/** What the refs and checks of `config` add to an agent's sandbox and prompt. */
function extrasOf(
	config: AgentConfig,
	target: Target,
	inputs: Inputs,
	context: HostContext,
): AgentChecks {
	const refs = Object.entries(config.refs ?? {});
	const checks = stageChecks(
		context.scratch,
		(config.checks ?? []).map((name) => [name, namedCheck(target, name)]),
	);
	const mounts: Bind[] = refs.map(([name]) => ({
		src: artifactInput(inputs, context, name),
		dst: refPath(name),
	}));
	return {
		...checks,
		readOnly: [...mounts, ...checks.readOnly],
		note: refNote(refs) + checks.note,
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
	const store = openTarget(setup.store, target.repo);
	const session = config.resume
		? resumed(
				store.root,
				config,
				inputs[LANE_PORT],
				role.harness,
				context.concert,
			)
		: mintSession(store.root, role.harness, context.concert);
	const at = { concert: context.concert, instance };
	return withLane(
		store,
		setup,
		config.lane,
		inputs[LANE_PORT],
		at,
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
			const extras = extrasOf(config, target, inputs, context);
			const prompt =
				textInput(inputs, "prompt") + extras.note + contract(config.out ?? {});
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
			};
			const turns = await converse(harness, req, live, context, staging.staged);
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
