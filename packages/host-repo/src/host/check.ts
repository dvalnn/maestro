import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	HostContext,
	HostInstance,
	HostNodeResult,
	NodeKind,
} from "@maestro/core/host";
import type { Inputs } from "@maestro/core/node";
import { CORE_TYPES, MAESTRO_TYPE } from "@maestro/ir";
import type { Lane } from "../lane/index";
import { type Bind, bubblewrap } from "../sandbox/index";
import {
	CHECK_CONFIG,
	CHECK_KIND,
	type CheckConfig,
	type CheckSpec,
	checkConfig,
	LANE_PORT,
	namedCheck,
	repoSetup,
	requireTarget,
	type Target,
} from "./config";
import { lanePorts, pathBinds, readOnlyBinds, withLane } from "./lane-input";
import { type Live, liveInstances } from "./live";
import { openTarget } from "./store";

/** A check's usage error. */
export const USAGE_EXIT = 3;
/** The exit a line that runs past its check's timeout counts as, as `timeout(1)` gives. */
const TIMEOUT_EXIT = 124;
/** The shell's exit for a command it cannot find. */
const NOT_FOUND_EXIT = 127;
/** Exits that mean the check could not run, rather than that it found a fault. */
export const FAILED_EXITS = [USAGE_EXIT, TIMEOUT_EXIT, NOT_FOUND_EXIT];
/** The name an inline check goes by in reasons and logs. */
const INLINE = "inline";

type Verdict = { outcome: "ok" | "rejected" | "failed"; reason?: string };

/** How a line ended: its exit code, or the signal that killed it. */
type Ended = { code: number } | { signal: string };

/** The checks `config` runs, by name. */
function checksOf(config: CheckConfig, target: Target): [string, CheckSpec][] {
	const { check } = config;
	if (typeof check === "object") return [[INLINE, check]];
	if (check !== undefined) return [[check, namedCheck(target, check)]];
	if (!Object.keys(target.checks).length)
		throw new Error(
			"config 'target.checks' names no check. Add one, or give the node an inline check",
		);
	return Object.entries(target.checks);
}

type Sandboxed = {
	lane: Lane;
	binds: Bind[];
	live: Live;
	log: string[];
};

/** Runs `line` of check `spec` in the lane until `deadline`, an epoch millisecond, logging its output. */
async function runLine(
	s: Sandboxed,
	spec: CheckSpec,
	line: string,
	deadline: number,
): Promise<Ended> {
	const proc = bubblewrap.start({
		lane: s.lane.dir,
		argv: ["sh", "-c", line],
		env: spec.env,
		readOnly: [...s.binds, ...pathBinds(spec.readOnly)],
		writable: pathBinds(spec.writable),
	});
	s.live.stop = () => proc.kill();
	let late = false;
	const timer = setTimeout(
		() => {
			late = true;
			proc.kill().catch(() => {});
		},
		Math.max(0, deadline - Date.now()),
	);
	try {
		for await (const out of proc.stdout) s.log.push(out);
		const exit = await proc.exited;
		if (exit.stderr) s.log.push(exit.stderr.trimEnd());
		if (late) return { code: TIMEOUT_EXIT };
		return exit.code === null
			? { signal: String(exit.signal) }
			: { code: exit.code };
	} finally {
		clearTimeout(timer);
	}
}

const how = (ended: Ended) =>
	"code" in ended
		? `exited ${ended.code}`
		: `was killed by signal ${ended.signal}`;

/** Whether a line that ended so means the check could not run. */
const couldNotRun = (ended: Ended) =>
	!("code" in ended) || FAILED_EXITS.includes(ended.code);

/** Runs the lines of check `name` in order, the first that does not exit 0 stopping it. */
async function runCheck(
	s: Sandboxed,
	name: string,
	spec: CheckSpec,
): Promise<Verdict> {
	const deadline = Date.now() + spec.timeout;
	for (const [i, line] of spec.lines.entries()) {
		if (s.live.cancelled) return { outcome: "failed", reason: "cancelled" };
		s.log.push(`$ ${line}`);
		const ended = await runLine(s, spec, line, deadline);
		const what = `check '${name}' line ${i + 1} ${how(ended)}`;
		s.log.push(`[${what}]`);
		if ("code" in ended && ended.code === 0) continue;
		const failed = couldNotRun(ended) || s.live.cancelled;
		return {
			outcome: failed ? "failed" : "rejected",
			reason: `${what}: ${line}`,
		};
	}
	return { outcome: "ok" };
}

/** The worst of `verdicts`, its reason naming every check that was not ok. */
function overall(verdicts: Verdict[]): Verdict {
	const reasons = verdicts.flatMap((v) => (v.reason ? [v.reason] : []));
	const outcomes = verdicts.map((v) => v.outcome);
	const outcome = outcomes.includes("failed")
		? "failed"
		: outcomes.includes("rejected")
			? "rejected"
			: "ok";
	return outcome === "ok"
		? { outcome }
		: { outcome, reason: reasons.join("; ") };
}

async function execute(
	instance: HostInstance,
	inputs: Inputs,
	context: HostContext,
	live: Live,
): Promise<HostNodeResult> {
	const setup = repoSetup(context.setup);
	const config = checkConfig(instance.node.config);
	const target = requireTarget(setup);
	const checks = checksOf(config, target);
	const store = openTarget(setup.store, target.repo);
	const at = { concert: context.concert, instance };
	return withLane(
		store,
		setup,
		config.lane,
		inputs[LANE_PORT],
		at,
		async (open) => {
			const { lane, read } = open;
			const s: Sandboxed = {
				lane,
				binds: readOnlyBinds(lane, setup.readOnly),
				live,
				log: [],
			};
			const verdicts: Verdict[] = [];
			for (const [name, spec] of checks)
				verdicts.push(await runCheck(s, name, spec));
			const logs = join(context.scratch, "check.log");
			writeFileSync(logs, `${s.log.join("\n")}\n`);
			const { outcome, reason = "" } = overall(verdicts);
			if (outcome === "failed") return { outcome, reason, outputs: { logs } };
			const outputs = {
				logs,
				...(!read && { [LANE_PORT]: await lane.seal() }),
			};
			return outcome === "ok"
				? { outcome, outputs }
				: { outcome, reason, outputs };
		},
	);
}

/** The `repo.check` kind, running each line in the sandbox. */
export function checkKind(): NodeKind {
	const live = liveInstances();
	return {
		name: CHECK_KIND,
		config: CHECK_CONFIG,
		ports(node) {
			const lane = lanePorts(checkConfig(node.config).lane);
			return {
				in: lane.in,
				out: { logs: { [MAESTRO_TYPE]: CORE_TYPES.file }, ...lane.out },
			};
		},
		execute: (instance, inputs, context) =>
			live.execute(instance, (state) =>
				execute(instance, inputs, context, state),
			),
		cancel: (instance) => live.cancel(instance),
	};
}
