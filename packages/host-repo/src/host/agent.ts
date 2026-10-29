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
	compact,
	durationText,
	type HostNode,
	MAESTRO_TYPE,
	messageOf,
	type Ports,
	tokensOf,
	validator,
	violations,
} from "@maestro/ir";
import {
	type Harness,
	type HarnessRequest,
	type HarnessResult,
	type Metrics,
	OUTBOX,
	type Output,
	type Runtime,
} from "../harness/index";
import type { Lane } from "../lane/index";
import {
	PROFILES,
	type Profile,
	type ProfileFields,
	resolveProfile,
} from "../profile/index";
import type { Bind } from "../sandbox/index";
import { type AgentChecks, stageChecks } from "./agent-checks";
import { writeChangeset } from "./apply";
import {
	AGENT_CONFIG,
	AGENT_KIND,
	type AgentCheck,
	type AgentConfig,
	agentCheck,
	agentConfig,
	isLegacyAgent,
	LANE_PORT,
	listed,
	repoSetup,
	requireTarget,
	type Target,
} from "./config";
import {
	attachmentPath,
	CUT_OFF,
	correction,
	type Envelope,
	envelopeOf,
	frame,
	REPORT,
	type ReplyKind,
	type Run,
	VERDICT,
	WORK,
} from "./frame";
import { artifactInput, textInput } from "./inputs";
import { lanePorts, readOnlyBinds, versionAt, withLane } from "./lane-input";
import { type Live, liveInstances } from "./live";
import {
	mintSession,
	openTarget,
	partialDir,
	recordWriter,
	type Session,
	writerOf,
} from "./store";

/** Turns that ask the agent again for an envelope, after its first final reply is not one. */
const MAX_CORRECTIONS = 2;

/** Retries of an agent's turn after a transient provider error, per node. */
const MAX_RETRIES = 2;
/** How long an agent waits before a retry. */
const RETRY_WAIT_MS = 30_000;

const TEXT = { type: "string" };

const ajv = validator();

/** What an agent's limits bound: wall clock in milliseconds from its first turn, and tokens as `tokensOf` sums. */
type AgentLimits = ProfileFields["limits"];

/** The ports of an agent node; one built before profiles keeps its own, so that `validate` can refuse it by name. */
function agentPorts(node: HostNode): { in: Ports; out: Ports } {
	if (isLegacyAgent(node.config))
		return { in: node.in ?? {}, out: node.out ?? {} };
	const config = agentConfig(node.config);
	const lane = lanePorts(config.lane);
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
			...Object.fromEntries(attachments),
			...lane.in,
		},
		out: {
			report: REPORT,
			staged: { [MAESTRO_TYPE]: CORE_TYPES.dir },
			...lane.out,
			...Object.fromEntries(declared),
		},
	};
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
			`version ${lane} was written by harness '${session.harness}', not '${harness}'. Drop resume, or run a profile on '${session.harness}'`,
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

/**
 * Enforces an agent instance's limits over all its turns: passing one records its reason in `live.limit` and stops the
 * run.
 */
type Limiter = { usage: (metrics: Metrics) => void; end: () => void };

/** Starts the wall clock of `limits.timeout` now. */
function limiter(limits: AgentLimits, live: Live): Limiter {
	const spent: Metrics = {};
	const trip = (reason: string) => {
		if (live.limit !== undefined) return;
		live.limit = reason;
		void live.stop?.();
	};
	const { timeout, tokens } = limits;
	const timer =
		timeout === undefined
			? undefined
			: setTimeout(
					() => trip(`passed its timeout of ${durationText(timeout)}`),
					timeout,
				);
	return {
		usage(metrics) {
			addMetrics(spent, metrics);
			const total = tokensOf(spent);
			if (tokens !== undefined && total > tokens)
				trip(
					`passed its token limit of ${compact(tokens)} (${compact(total)} spent)`,
				);
		},
		end: () => clearTimeout(timer),
	};
}

async function turn(
	harness: Harness,
	req: HarnessRequest,
	live: Live,
	emit: HostContext["emit"],
	limits: Limiter,
) {
	const run = harness.run(req);
	live.stop = () => run.cancel();
	for await (const e of run.events) {
		if (e.kind === "usage") limits.usage(e.metrics);
		if (e.kind !== "raw") emit(e);
	}
	return run.result;
}

/** Waits `ms`, or until `live` is stopped. */
function pause(ms: number, live: Live): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		live.stop = async () => {
			clearTimeout(timer);
			resolve();
		};
	});
}

/** What follows an agent's final reply: how the run ends, or the correction to send. */
type Next = { envelope: Envelope } | { failure: string } | { prompt: string };

function next(reply: string, spent: boolean, kind: ReplyKind): Next {
	const envelope = envelopeOf(reply, kind);
	if (typeof envelope !== "string") return { envelope };
	return spent
		? {
				failure: `the final reply is not the JSON object asked for after ${MAX_CORRECTIONS} corrections: ${envelope}. Check the profile's model follows the reply contract in staged/instructions.md`,
			}
		: { prompt: correction(envelope, kind) };
}

/**
 * Why a failed `result` ends the node, a passed limit first, or `undefined` once the wait for a retry is over and the
 * turn may run again. A transient failure with `retries` spent, or any other, ends it.
 */
async function recover(
	result: HarnessResult,
	retries: number,
	live: Live,
	emit: HostContext["emit"],
): Promise<string | undefined> {
	if (live.limit) return live.limit;
	const reason = result.reason ?? "the harness failed";
	if (!result.transient) return reason;
	if (live.cancelled) return "cancelled";
	if (retries === MAX_RETRIES)
		return `${reason} (after ${retries + 1} attempts)`;
	emit({
		kind: "fault",
		reason: `${reason}. Retry ${retries + 1} of ${MAX_RETRIES} in ${RETRY_WAIT_MS / 1000}s`,
		transient: true,
	});
	await pause(RETRY_WAIT_MS, live);
	return undefined;
}

/** `body`'s result, run under `limits`, whose clock stops when it settles. */
async function within<T>(
	limits: AgentLimits,
	live: Live,
	body: (guard: Limiter) => Promise<T>,
): Promise<T> {
	const guard = limiter(limits, live);
	try {
		return await body(guard);
	} finally {
		guard.end();
	}
}

/** Why the instance must stop before its next turn: the limit it passed, or its cancel. */
const halted = (live: Live) =>
	live.limit ?? (live.cancelled ? "cancelled" : undefined);

/**
 * Runs the agent, then corrects it in the same session while its final reply is not an envelope. A transient failure
 * runs the turn again in the same session, after a wait, up to `MAX_RETRIES` times. A limit `guard` passes ends it.
 */
async function converse(
	harness: Harness,
	req: HarnessRequest,
	live: Live,
	context: HostContext,
	staged: string,
	kind: ReplyKind,
	guard: Limiter,
): Promise<Turns> {
	const metrics: Metrics = {};
	let prompt = req.prompt;
	let corrections = 0;
	let retries = 0;
	for (;;) {
		const halt = halted(live);
		if (halt) return { metrics, failure: halt };
		const result = await turn(
			harness,
			{ ...req, prompt },
			live,
			context.emit,
			guard,
		);
		addMetrics(metrics, result.metrics);
		if (result.outcome === "failed") {
			const failure = await recover(result, retries, live, context.emit);
			if (failure !== undefined) return { metrics, failure };
			retries++;
			prompt = CUT_OFF;
			continue;
		}
		const step = next(result.reply, corrections === MAX_CORRECTIONS, kind);
		if (!("prompt" in step)) return { metrics, ...step };
		prompt = step.prompt;
		corrections++;
		writeFileSync(join(staged, `correction-${corrections}.md`), prompt);
	}
}

/**
 * Stages the user message and the system-prompt file, the profile's `instructions` when it has any, then `framed`.
 * Returns the system-prompt file's path.
 */
function stage(
	dir: string,
	prompt: string,
	instructions: string | undefined,
	framed: string,
) {
	writeFileSync(join(dir, "prompt.md"), prompt);
	const own = instructions
		? `${readFileSync(instructions, "utf8").trimEnd()}\n\n`
		: "";
	const path = join(dir, "instructions.md");
	writeFileSync(path, `${own}${framed}\n`);
	return path;
}

/** What one instance stages and where. */
type Staging = {
	profile: Profile;
	config: AgentConfig;
	session: Session;
	staged: string;
	outbox: string;
};

/** The harness, model and effort an agent runs on, as its start event and its enrichment report them. */
const runtimeOf = ({ harness, model, thinking }: Runtime) => ({
	harness,
	model,
	thinking,
});

/**
 * The node result of `turns`, its enrichment holding the report once there is one. Once the agent gave an envelope that
 * is not blocked, and readable outputs, `seal` seals its lane.
 */
async function settle(
	staging: Staging,
	turns: Turns,
	seal: () => Promise<string | undefined>,
): Promise<HostNodeResult> {
	const { profile, session } = staging;
	const { metrics } = turns;
	const ran = {
		session: session.id,
		sessionDir: session.dir,
		...runtimeOf(profile.fields.runtime),
		profile,
	};
	if ("failure" in turns)
		return {
			outcome: "failed",
			reason: turns.failure,
			metrics,
			enrichment: ran,
		};
	const { blocked, outcome = "ok", reason = "", report } = turns.envelope;
	// The report rides the enrichment too, since a blocked or failed agent has no outputs.
	const enrichment = { ...ran, report };
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

/**
 * `result`, and when it failed after changing `lane`, those changes kept as a changeset directory in the store and named
 * as `partial` in its enrichment. The partial is no lane version, so nothing takes it as input.
 */
async function keepPartial(
	result: HostNodeResult,
	lane: Lane,
	dir: string,
): Promise<HostNodeResult> {
	if (result.outcome !== "failed" || !(await lane.changes()).length)
		return result;
	const partial = writeChangeset(dir, await lane.changeset(), undefined);
	return { ...result, enrichment: { ...result.enrichment, partial } };
}

/** What an agent's sandbox adds for its checks and attachments, and those the frame lists, each with its hint. */
type Extras = AgentChecks & Pick<Run, "checks" | "attachments">;

/** What the graph's and the profile's attachments and the checks of `staging` add to an agent's sandbox and frame. */
function extrasOf(
	{ config, profile }: Staging,
	target: Target,
	inputs: Inputs,
	context: HostContext,
	base: string,
	path: string,
): Extras {
	const graph = Object.entries(config.attachments ?? {});
	const own = Object.entries(profile.fields.attachments);
	const named = (config.checks ?? []).map((name): [string, AgentCheck] => [
		name,
		agentCheck(target, name),
	]);
	const checks = stageChecks(context.scratch, named, base, path);
	const mounts: Bind[] = [
		...graph.map(([name]) => ({
			src: artifactInput(inputs, context, name),
			dst: attachmentPath(name),
		})),
		...own.map(([name, a]) => ({ src: a.path, dst: attachmentPath(name) })),
	];
	return {
		...checks,
		readOnly: [...mounts, ...checks.readOnly],
		checks: named.map(([name, spec]) => [name, spec.hint]),
		attachments: [...graph, ...own].map(([name, a]) => [name, a.hint]),
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
	const profile = await resolveProfile(config.profile, context.setup);
	const { runtime } = profile.fields;
	const harness = harnesses.find((h) => h.name === runtime.harness);
	if (!harness)
		throw new Error(
			`harness '${runtime.harness}' is not loaded. Set '${PROFILES}.${profile.name}.runtime.harness' to one of: ${listed(harnesses.map((h) => h.name))}`,
		);
	const target = requireTarget(setup);
	const store = openTarget(setup.store, target.repo, target.sparse);
	const session =
		config.lane.mode === "extend" && config.lane.resume
			? resumed(store.root, inputs[LANE_PORT], runtime.harness, context.concert)
			: mintSession(store.root, runtime.harness, context.concert);
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
				profile,
				config,
				session,
				staged: join(context.scratch, "staged"),
				outbox: join(context.scratch, "out"),
			};
			mkdirSync(staging.staged);
			mkdirSync(staging.outbox);
			context.emit({ kind: "agent", ...runtimeOf(runtime) });
			const extras = extrasOf(
				staging,
				target,
				inputs,
				context,
				lane.base,
				setup.path,
			);
			const kind = config.verdict ? VERDICT : WORK;
			const prompt = textInput(inputs, "prompt");
			const outputs = Object.values(config.out ?? {});
			const framed = frame({
				lane: config.lane.mode === "read" ? "read" : "write",
				checks: extras.checks,
				attachments: extras.attachments,
				out: outputs,
				kind,
			});
			const req: HarnessRequest = {
				runtime,
				prompt,
				lane: lane.dir,
				readOnly: [
					...readOnlyBinds(lane, setup.readOnly, profile.fields.readOnly),
					...extras.readOnly,
				],
				writable: extras.writable,
				env: { PATH: setup.path, ...extras.env },
				instructions: stage(
					staging.staged,
					prompt,
					profile.fields.instructions,
					framed,
				),
				outbox: staging.outbox,
				outputs,
				session: { dir: session.dir, id: session.id },
				verdict: config.verdict,
				instance: instance.id,
			};
			const turns = await within(profile.fields.limits, live, (guard) =>
				converse(harness, req, live, context, staging.staged, kind, guard),
			);
			const settled = await settle(staging, turns, async () => {
				if (read) return undefined;
				const version = await lane.seal();
				recordWriter(store.root, version, session);
				return version;
			});
			if (read) return settled;
			return keepPartial(
				settled,
				lane,
				partialDir(store.root, versionAt(context.concert, instance)),
			);
		},
	);
}

/**
 * The `repo.agent` kind, running each instance's profile on the harness of that name among `harnesses`. Its cancel returns
 * once the instance has settled, so its kept partial reaches the record before the engine abandons the call.
 */
export function agentKind(harnesses: readonly Harness[]): NodeKind {
	const live = liveInstances();
	const settling = new Map<string, Promise<unknown>>();
	return {
		name: AGENT_KIND,
		config: AGENT_CONFIG,
		ports: agentPorts,
		execute: (instance, inputs, context) => {
			const run = live.execute(instance, (state) =>
				execute(harnesses, instance, inputs, context, state),
			);
			settling.set(
				instance.id,
				run
					.then(
						() => {},
						() => {},
					)
					.finally(() => settling.delete(instance.id)),
			);
			return run;
		},
		cancel: async (instance) => {
			await live.cancel(instance);
			await settling.get(instance.id);
		},
	};
}
