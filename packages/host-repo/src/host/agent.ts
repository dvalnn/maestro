import {
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@maestro/core";
import type {
	HostContext,
	HostInstance,
	HostNodeResult,
	HostSetup,
	NodeKind,
} from "@maestro/core/host";
import type { Inputs } from "@maestro/core/node";
import {
	CORE_TYPES,
	compact,
	durationText,
	type HostEvent,
	type HostNode,
	MAESTRO_TYPE,
	messageOf,
	type Ports,
	tokensOf,
	validator,
	violations,
} from "@maestro/ir";
import {
	type AgentEnvironment,
	type ContextPolicy,
	environmentChecks,
	type Harness,
	type HarnessEvent,
	type HarnessRequest,
	type HarnessResult,
	type Metrics,
	type ObservedEnvironment,
	OUTBOX,
	type Output,
	type Runtime,
	SESSION_DIR,
} from "../harness/index";
import type { Lane } from "../lane/index";
import {
	attachmentPath,
	PROFILES,
	type Profile,
	type ProfileFields,
	resolveProfile,
	seatBinding,
	skillPath,
	type Unsettled,
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
	type RepoSetup,
	repoSetup,
	requireTarget,
	SESSION_PORT,
	SESSION_TYPE,
} from "./config";
import { counterpartSession, keysOf } from "./encore";
import {
	CUT_OFF,
	correction,
	type Envelope,
	envelopeOf,
	fileCorrection,
	frame,
	HANDOFF_NOTE,
	HANDOFF_TURN,
	handoffMessage,
	offersSightings,
	REPORT,
	type ReplyKind,
	type Run,
	reply,
	replyKind,
} from "./frame";
import { artifactInput, textInput } from "./inputs";
import { lanePorts, readOnlyBinds, versionAt, withLane } from "./lane-input";
import { type Live, liveInstances } from "./live";
import {
	keepLatest,
	mintSession,
	openSession,
	openTarget,
	partialDir,
	type Session,
} from "./store";
import { continuation, digests, keepTurn, type Turn } from "./turn";
import { contextIn, keepWindow } from "./windows";

/** Between an instance id and a session's index in the id of a session a handoff starts, as in `<instance>#2`. */
const SESSION_INDEX = "#";

/** Turns that ask the agent again, after its final reply is no envelope or a declared output is missing or invalid. */
const MAX_CORRECTIONS = 2;

/** Retries of an agent's turn after a transient provider error, per node. */
const MAX_RETRIES = 2;
/** How long an agent waits before a retry. */
const RETRY_WAIT_MS = 30_000;

const TEXT = { type: "string" };
const SESSION = { type: "string", [MAESTRO_TYPE]: SESSION_TYPE };

const ajv = validator();

/** What an agent's limits bound: wall clock in milliseconds from its first turn, and tokens as `tokensOf` sums. */
type AgentLimits = ProfileFields["limits"];

/**
 * The ports of an agent node; one built before profiles keeps its own, so that `validate` can refuse it by name. It
 * takes a session when its IR gives it the port.
 */
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
	const fields = Object.entries(config.reply ?? {});
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
			...(node.in?.[SESSION_PORT] && { [SESSION_PORT]: SESSION }),
		},
		out: {
			report: REPORT,
			staged: { [MAESTRO_TYPE]: CORE_TYPES.dir },
			[SESSION_PORT]: SESSION,
			...lane.out,
			...Object.fromEntries(fields),
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
 * Session `id`, which node `node` continues on `harness`.
 * @throws Error when it is not in the store, or another harness runs it.
 */
function continued(
	root: string,
	id: string,
	harness: string,
	node: string,
	profile: string,
): Session {
	const session = openSession(root, id);
	if (session.harness !== harness)
		throw new Error(
			`'${node}' runs profile ${profile} on harness '${harness}' and continues session ${id}, of harness '${session.harness}'. Give '${node}' a profile on harness '${session.harness}', or drop its session`,
		);
	return session;
}

/** How the agent's turns end: its envelope, or why there is none. */
type End = { envelope: Envelope } | { failure: string };

/** How the agent's turns ended, and the session they ended in. */
type Turns = { metrics: Metrics; session: Session } & End;

function addMetrics(sum: Metrics, add: Metrics) {
	for (const [k, v] of Object.entries(add)) sum[k] = (sum[k] ?? 0) + v;
}

/**
 * Enforces an agent instance's limits over all its turns: passing one, or a `trip`, records its reason in `live.limit`
 * and stops the run.
 */
type Limiter = {
	usage: (metrics: Metrics) => void;
	trip: (reason: string) => void;
	end: () => void;
};

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
		trip,
		end: () => clearTimeout(timer),
	};
}

/** The most sessions a handoff policy of `max` handoffs gives an instance. */
export const sessionsOf = (max: number) => max + 1;

/** A handoff policy, and what it takes to start the instance's next session. */
type Handoff = {
	/** In tokens. */
	at: number;
	max: number;
	/** The policy's config key, `profiles.<name>.context`. */
	key: string;
	/** The task as first given, which every fresh session is given again. */
	task: string;
	/** Starts the instance's session of 1-based `index`, handed off from session `from`. */
	mint: (index: number, from: Session) => Session;
};

/** What an instance's turns share over every session it runs. */
type Talk = {
	harness: Harness;
	live: Live;
	emit: HostContext["emit"];
	staged: string;
	kind: ReplyKind;
	/** The directory the declared outputs are read from, and those outputs by port. */
	outbox: string;
	out: Record<string, Output>;
	guard: Limiter;
	handoff?: Handoff;
	/** What a compaction the harness reports does under the context policy. */
	compacted: () => void;
	/** Keeps the model's context window in tokens, as the harness reported it. */
	window: (tokens: number) => void;
	/** Keeps the environment the harness reported loading; the latest one stands. */
	environment: (observed: ObservedEnvironment) => void;
};

/**
 * Feeds `e` to the limits, the context policy and the kept windows. Returns whether it shows the context reaching `at`
 * tokens.
 */
function observe(talk: Talk, e: HarnessEvent, at: number | undefined) {
	if (e.kind === "usage") talk.guard.usage(e.metrics);
	if (e.kind === "compaction") talk.compacted();
	if (e.kind === "window") talk.window(e.tokens);
	if (e.kind === "environment") {
		const { kind: _, ...observed } = e;
		talk.environment(observed);
	}
	return e.kind === "context" && at !== undefined && e.used >= at;
}

/** A `usage` harness event, held until the event after it shows whether it pairs with a `context`. */
type Usage = Extract<HarnessEvent, { kind: "usage" }>;

/**
 * One event per model call: a `usage` and the `context` after it become one `context` event carrying both. Returns
 * what `e` releases to the record, and the usage held in its place.
 */
function paired(
	held: Usage | undefined,
	e: HarnessEvent,
): [out: HostEvent[], held: Usage | undefined] {
	if (e.kind === "context" && held !== undefined)
		return [[{ ...e, metrics: held.metrics }], undefined];
	const out = held === undefined ? [] : [held];
	return e.kind === "usage" ? [out, e] : [[...out, e], undefined];
}

/**
 * Runs one turn. Once a context event reaches `at`, the turn is cancelled, and reported `full` unless it settled with
 * its result first.
 */
async function turn(talk: Talk, req: HarnessRequest, at?: number) {
	const run = talk.harness.run(req);
	talk.live.stop = () => run.cancel();
	let full = false;
	let held: Usage | undefined;
	for await (const e of run.events) {
		if (e.kind === "raw") continue;
		const [out, next] = paired(held, e);
		held = next;
		for (const event of out) talk.emit(event);
		if (observe(talk, e, at) && !full) {
			full = true;
			void run.cancel();
		}
	}
	if (held !== undefined) talk.emit(held);
	const result = await run.result;
	return { result, full: full && result.outcome === "failed" };
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

/** Where an instance's turns stand: the request of its next turn, its session and that session's 1-based index. */
type Talking = {
	req: HarnessRequest;
	session: Session;
	index: number;
	corrections: number;
	retries: number;
	metrics: Metrics;
};

/**
 * What follows a turn that ran to its end: how the run ends, or nothing once `state` holds the next turn. A transient
 * failure runs the turn again after a wait, up to `MAX_RETRIES` times; a reply that is no envelope, or an `ok` one with a bad declared output, gets a correction.
 */
async function follow(
	talk: Talk,
	state: Talking,
	result: HarnessResult,
): Promise<End | undefined> {
	if (result.outcome === "failed") {
		const failure = await recover(result, state.retries, talk.live, talk.emit);
		if (failure !== undefined) return { failure };
		state.retries++;
		state.req = { ...state.req, prompt: CUT_OFF };
		return undefined;
	}
	const spent = state.corrections === MAX_CORRECTIONS;
	const step = next(result.reply, spent, talk.kind);
	const prompt = "envelope" in step ? filed(talk, step.envelope, spent) : step;
	if (!("prompt" in prompt)) return prompt;
	state.corrections++;
	state.req = { ...state.req, prompt: prompt.prompt };
	writeFileSync(
		join(talk.staged, `correction-${state.corrections}.md`),
		prompt.prompt,
	);
	return undefined;
}

/**
 * What follows an `envelope` that is no failure: itself, or once it claims `ok` and is not blocked, the correction for a
 * declared output that is missing or invalid. Once `spent`, it is returned anyway, and `settle` fails it with that problem.
 */
function filed(talk: Talk, envelope: Envelope, spent: boolean): Next {
	if (envelope.blocked !== undefined || (envelope.outcome ?? "ok") !== "ok")
		return { envelope };
	const read = readOutbox(talk.outbox, talk.out);
	if (!("problem" in read)) return { envelope };
	return spent
		? { envelope }
		: { prompt: fileCorrection(read.problem, talk.kind) };
}

/** The handoff note at `path`, when the agent wrote one: a regular file with text, so a link cannot reach outside. */
function noteAt(path: string): string | undefined {
	if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return undefined;
	return readFileSync(path, "utf8").trim() || undefined;
}

/**
 * Ends the session of a turn cut short by a full context: runs its handoff turn, then puts the next session in `state`,
 * its user message the note and the task. A halted instance, a session past `handoff.max` resets, a failed handoff turn
 * or a missing note ends the run.
 */
async function handOff(
	talk: Talk,
	handoff: Handoff,
	state: Talking,
): Promise<End | undefined> {
	const halt = halted(talk.live);
	if (halt) return { failure: halt };
	if (state.index > handoff.max)
		return {
			failure: `context: session ${state.index} filled, past ${handoff.key}.max of ${handoff.max} handoffs. Raise ${handoff.key}.max, or split the task`,
		};
	const note = join(state.session.dir, HANDOFF_NOTE);
	rmSync(note, { force: true });
	const { result } = await turn(talk, { ...state.req, prompt: HANDOFF_TURN });
	addMetrics(state.metrics, result.metrics);
	const stopped = halted(talk.live);
	if (stopped) return { failure: stopped };
	if (result.outcome === "failed")
		return {
			failure: `context: handoff turn failed: ${result.reason ?? "the harness failed"}`,
		};
	const text = noteAt(note);
	if (text === undefined)
		return {
			failure: `context: no handoff note from session ${state.index}. Check the profile's model writes ${SESSION_DIR}/${HANDOFF_NOTE} when asked`,
		};
	talk.emit(sessionEvent(state, "handoff"));
	state.index++;
	state.session = handoff.mint(state.index, state.session);
	const prompt = handoffMessage(
		state.index,
		sessionsOf(handoff.max),
		text,
		handoff.task,
	);
	writeFileSync(join(talk.staged, `session-${state.index}.md`), prompt);
	state.req = {
		...state.req,
		prompt,
		session: { dir: state.session.dir, id: state.session.harnessId },
	};
	return undefined;
}

/** Why a session ended: a handoff to the next, the agent's result, or the run's failure. */
type Ended = "handoff" | "settled" | "failed";

/** The record of a session's end: its id, its index in the instance, why it ended, and a failure's reason. */
const sessionEvent = (state: Talking, ended: Ended, reason?: string) => ({
	kind: "session",
	id: state.session.id,
	index: state.index,
	ended,
	...(reason !== undefined && { reason }),
});

/**
 * Runs the agent from `req` in `session` until it gives an envelope or fails, over every session a handoff starts. Under
 * a handoff policy each session's end is recorded.
 */
async function converse(
	talk: Talk,
	req: HarnessRequest,
	session: Session,
): Promise<Turns> {
	const state: Talking = {
		req,
		session,
		index: 1,
		corrections: 0,
		retries: 0,
		metrics: {},
	};
	let end: End | undefined;
	while (end === undefined) {
		const halt = halted(talk.live);
		if (halt) {
			end = { failure: halt };
			break;
		}
		const { result, full } = await turn(talk, state.req, talk.handoff?.at);
		addMetrics(state.metrics, result.metrics);
		end =
			full && talk.handoff
				? await handOff(talk, talk.handoff, state)
				: await follow(talk, state, result);
	}
	if (talk.handoff)
		talk.emit(
			"failure" in end
				? sessionEvent(state, "failed", end.failure)
				: sessionEvent(state, "settled"),
		);
	return { metrics: state.metrics, session: state.session, ...end };
}

/** The system prompt of `run`: the profile's `instructions` when it has any, then the host's frame of the run. */
function systemPrompt(instructions: string | undefined, run: Run): string {
	const own = instructions
		? `${readFileSync(instructions, "utf8").trimEnd()}\n\n`
		: "";
	return `${own}${frame(run)}`;
}

/** Stages the user message and the system-prompt file of `run`. Returns the system-prompt file's path. */
export function stage(
	dir: string,
	prompt: string,
	instructions: string | undefined,
	run: Run,
) {
	writeFileSync(join(dir, "prompt.md"), prompt);
	const path = join(dir, "instructions.md");
	writeFileSync(path, `${systemPrompt(instructions, run)}\n`);
	return path;
}

/** The session an instance runs, whether it `continues` it, and why an encore's agent starts it instead, if so. */
type Seated = { session: Session; continues: boolean; fallback?: string };

/** What one instance stages and where. */
type Staging = Seated & {
	profile: Profile;
	config: AgentConfig;
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
	const { profile, fallback } = staging;
	const { metrics, session } = turns;
	const ran = {
		session: session.id,
		sessionDir: session.dir,
		...runtimeOf(profile.fields.runtime),
		profile,
		...(fallback !== undefined && { encoreFresh: fallback }),
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
		[SESSION_PORT]: session.id,
		...(version && { [LANE_PORT]: version }),
		...read.outputs,
		...turns.envelope.fields,
	};
	return outcome === "ok"
		? { outcome, outputs, metrics, enrichment }
		: { outcome, reason, outputs, metrics, enrichment };
}

/** `result` with the checks of `observed` against `declared` in its enrichment, when the harness reported an environment. */
function withEnvironment(
	result: HostNodeResult,
	declared: AgentEnvironment | undefined,
	observed: ObservedEnvironment | undefined,
): HostNodeResult {
	if (!declared || !observed) return result;
	return {
		...result,
		enrichment: {
			...result.enrichment,
			environment: environmentChecks(declared, observed),
		},
	};
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

/** What an agent's sandbox adds for its checks and attachments, and the host path of each attachment by name. */
type Extras = AgentChecks & { sources: Record<string, string> };

/**
 * The checks of the target of `setup` an agent of `config` may run, by name.
 * @throws Error when it names one and `setup` has no target, or as `agentCheck` does.
 */
const agentChecks = (config: AgentConfig, setup: RepoSetup) =>
	(config.checks ?? []).map((name): [string, AgentCheck] => [
		name,
		agentCheck(requireTarget(setup), name),
	]);

/** What the graph's and the profile's attachments and the checks `named` add to an agent's sandbox. */
function extrasOf(
	{ config, profile }: Staging,
	named: [string, AgentCheck][],
	inputs: Inputs,
	context: HostContext,
	base: string,
	path: string,
): Extras {
	const graph = Object.entries(config.attachments ?? {});
	const own = Object.entries(profile.fields.attachments);
	const checks = stageChecks(context.scratch, named, base, path);
	const sources: Record<string, string> = Object.fromEntries([
		...graph.map(([name]) => [name, artifactInput(inputs, context, name)]),
		...own.map(([name, a]) => [name, a.path]),
	]);
	const mounts: Bind[] = Object.entries(sources).map(([name, src]) => ({
		src,
		dst: attachmentPath(name),
	}));
	return {
		...checks,
		sources,
		readOnly: [...mounts, ...skillBinds(profile), ...checks.readOnly],
	};
}

/** Whether an encore's `instance` looks for its counterpart: its seat does not opt out, and its node takes no session. */
const encoreMatches = (instance: HostInstance, config: AgentConfig) =>
	config.encore !== false && !instance.node.in?.[SESSION_PORT];

/**
 * The session an instance runs:
 * - the one at its `session` input, when its node takes one;
 * - in an encore, its counterpart's (`counterpartSession`), unless its seat opts out with `encore: false`;
 * - else one it starts, recording its profile's harness extras, in an encore with why the counterpart's could not go
 *   on.
 */
function sessionOf(
	root: string,
	inputs: Inputs,
	instance: HostInstance,
	staging: Pick<Staging, "profile" | "config">,
	{ concert, encore }: HostContext,
): Seated {
	const { profile, config } = staging;
	const { harness } = profile.fields.runtime;
	const given = inputs[SESSION_PORT];
	if (typeof given === "string")
		return {
			session: continued(root, given, harness, instance.node.id, profile.name),
			continues: true,
		};
	const matched =
		encore === undefined || !encoreMatches(instance, config)
			? undefined
			: counterpartSession(root, encore, instance, {
					harness,
					profile: profile.name,
				});
	if (matched && "session" in matched)
		return { session: matched.session, continues: true };
	return {
		session: mintSession(
			root,
			harness,
			concert,
			instance.id,
			profile.fields.harnessExtras,
		),
		continues: false,
		...(matched && { fallback: matched.fresh }),
	};
}

/** The read-only binds that mount `profile`'s skills. */
export const skillBinds = (profile: Unsettled): Bind[] =>
	profile.fields.skills.map((s) => ({ src: s.dir, dst: skillPath(s.name) }));

/** The skills of `profile`, by mount name, each with its description. */
export const profileSkills = (profile: Unsettled): Run["skills"] =>
	profile.fields.skills.map((s) => [s.name, s.description]);

/** The attachments of `profile`, by name, each with its hint and whether its path is a file or a directory. */
export const profileAttached = (profile: Unsettled): Run["attachments"] =>
	Object.entries(profile.fields.attachments).map(([name, a]) => [
		name,
		a.hint,
		statSync(a.path, { throwIfNoEntry: false })?.isDirectory()
			? "directory"
			: "file",
	]);

/**
 * What the frame tells an agent of `config` running `profile` about its run: its checks `named`, its attachments, the
 * graph's then the profile's, each with its hint and kind, and the profile's skills.
 */
function toldOf(
	config: AgentConfig,
	profile: Unsettled,
	named: [string, AgentCheck][],
	sightings: boolean,
): Run {
	const { context } = profile.fields;
	return {
		lane: config.lane.mode === "read" ? "read" : "write",
		checks: named.map(([name, spec]) => [name, spec.hint]),
		attachments: [
			...Object.entries(config.attachments ?? {}).map(
				([name, a]): Run["attachments"][number] => [
					name,
					a.hint,
					a.type === CORE_TYPES.dir ? "directory" : "file",
				],
			),
			...profileAttached(profile),
		],
		skills: profileSkills(profile),
		out: Object.values(config.out ?? {}),
		kind: replyKind(config.verdict, config.reply, sightings),
		sessions:
			context?.strategy === "handoff" ? sessionsOf(context.max) : undefined,
	};
}

/**
 * The system prompt an agent node of `config` running `profile` is given under `setup`, as its run stages it.
 * @throws Error as `agentChecks` does.
 */
export const agentPrompt = (
	config: AgentConfig,
	profile: Unsettled,
	setup: HostSetup,
	out: Record<string, unknown> | undefined,
) =>
	systemPrompt(
		profile.fields.instructions,
		toldOf(
			config,
			profile,
			agentChecks(config, repoSetup(setup)),
			offersSightings(out),
		),
	);

/**
 * The context policy's part in an instance's turns: a handoff policy's trigger and next sessions, and what a compaction
 * does. Under `handoff` a compaction is recorded as a fault; under a capped `compact`, one past `max` ends the run.
 */
function policyOf(
	profile: Profile,
	context: ContextPolicy | undefined,
	task: string,
	mint: Handoff["mint"],
	emit: HostContext["emit"],
	guard: Limiter,
): Pick<Talk, "handoff" | "compacted"> {
	const key = `${PROFILES}.${profile.name}.context`;
	if (context?.strategy === "handoff")
		return {
			handoff: { at: context.at, max: context.max, key, task, mint },
			compacted: () =>
				emit({
					kind: "fault",
					reason: `context: the harness compacted the session before its handoff. Lower ${key}.at below its compaction point`,
				}),
		};
	let count = 0;
	return {
		compacted() {
			count++;
			const max = context?.max;
			if (max !== undefined && count > max)
				guard.trip(
					`context: compacted ${count} times, past ${key}.max of ${max}. Raise ${key}.max, or split the task`,
				);
		},
	};
}

/** Keeps `turn` as the last turn of `session`, unless its run was cut short by a cancel or a limit. */
function keepSettled(
	live: Live,
	session: Session,
	turn: Turn,
	sources: Record<string, string>,
) {
	if (live.cancelled || live.limit !== undefined) return;
	keepTurn(session, turn, sources);
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
	const { profile: name } = seatBinding(context.setup, instance, config);
	const profile = await resolveProfile(name, context.setup);
	const { runtime } = profile.fields;
	const harness = harnesses.find((h) => h.name === runtime.harness);
	if (!harness)
		throw new Error(
			`harness '${runtime.harness}' is not loaded. Set '${PROFILES}.${profile.name}.runtime.harness' to one of: ${listed(harnesses.map((h) => h.name))}`,
		);
	const policy = contextIn(profile, setup.store);
	if ("message" in policy) throw new Error(`${policy.message}. ${policy.fix}`);
	const target = requireTarget(setup);
	const store = openTarget(setup.store, target.repo, target.sparse);
	const seated = sessionOf(
		store.root,
		inputs,
		instance,
		{ profile, config },
		context,
	);
	const { session, continues } = seated;
	const keptLatest = (latest: Session) =>
		keepLatest(store.root, context.concert, instance.id, {
			node: instance.node.id,
			keys: keysOf(instance),
			session: latest.id,
		});
	keptLatest(session);
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
				...seated,
				profile,
				config,
				staged: join(context.scratch, "staged"),
				outbox: join(context.scratch, "out"),
			};
			mkdirSync(staging.staged);
			mkdirSync(staging.outbox);
			context.emit({ kind: "agent", ...runtimeOf(runtime) });
			const named = agentChecks(config, setup);
			const extras = extrasOf(
				staging,
				named,
				inputs,
				context,
				lane.base,
				setup.path,
			);
			const told = toldOf(
				config,
				profile,
				named,
				offersSightings(instance.node.out),
			);
			const { kind, out: outputs } = told;
			const now: Turn = {
				task: textInput(inputs, "prompt"),
				attachments: digests(extras.sources),
				commit: lane.head(),
				reply: sha256Hex(reply(told).join("\n\n")),
			};
			const opening = continues
				? continuation(session, now)
				: { message: now.task, readOnly: [] };
			const req: HarnessRequest = {
				runtime,
				prompt: opening.message,
				lane: lane.dir,
				readOnly: [
					...readOnlyBinds(lane, setup.readOnly, profile.fields.readOnly),
					...extras.readOnly,
					...opening.readOnly,
				],
				writable: extras.writable,
				env: { PATH: setup.path, ...extras.env },
				instructions: stage(
					staging.staged,
					opening.message,
					profile.fields.instructions,
					told,
				),
				outbox: staging.outbox,
				outputs,
				...(config.reply && { reply: config.reply }),
				session: { dir: session.dir, id: session.harnessId },
				verdict: config.verdict,
				instance: instance.id,
				context: policy.context,
				window: policy.window,
				...(session.extras !== undefined && { extras: session.extras }),
			};
			// A handoff keeps the run's request, so its session keeps the extras that request carries.
			const mint = (index: number, from: Session) =>
				mintSession(
					store.root,
					runtime.harness,
					context.concert,
					`${instance.id}${SESSION_INDEX}${index}`,
					from.extras,
				);
			let observed: ObservedEnvironment | undefined;
			const turns = await within(profile.fields.limits, live, (guard) =>
				converse(
					{
						harness,
						live,
						emit: context.emit,
						staged: staging.staged,
						kind,
						outbox: staging.outbox,
						out: config.out ?? {},
						guard,
						...policyOf(
							profile,
							policy.context,
							now.task,
							mint,
							context.emit,
							guard,
						),
						window: (tokens) => keepWindow(setup.store, runtime, tokens),
						environment: (o) => {
							observed = o;
						},
					},
					req,
					session,
				),
			);
			keptLatest(turns.session);
			const settled = withEnvironment(
				await settle(staging, turns, async () =>
					read ? undefined : lane.seal(),
				),
				harness.environment,
				observed,
			);
			keepSettled(
				live,
				turns.session,
				{ ...now, commit: lane.head() },
				extras.sources,
			);
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
