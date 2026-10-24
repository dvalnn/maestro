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
import { lanePorts, laneVersion, sandboxed, withLane } from "./lane-input";
import { type Live, liveInstances } from "./live";
import { runLines, type Verdict } from "./run-lines";
import { carryWriter, openTarget } from "./store";

/** The name an inline check goes by in reasons and logs. */
const INLINE = "inline";

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

/** Seals `lane`; an extend passes the writer of the version it extended on to the new one, so an agent can resume it. */
async function sealed(
	root: string,
	config: CheckConfig,
	inputs: Inputs,
	lane: Lane,
): Promise<string> {
	const version = await lane.seal();
	if (config.lane.mode === "extend")
		carryWriter(root, laneVersion(inputs[LANE_PORT]), version);
	return version;
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
	const store = openTarget(setup.store, target.repo, target.sparse);
	const run = { concert: context.concert, instance, live, emit: context.emit };
	return withLane(
		store,
		setup,
		config.lane,
		inputs[LANE_PORT],
		run,
		async (open) => {
			const { lane, read } = open;
			const s = sandboxed(lane, setup, live);
			const verdicts: Verdict[] = [];
			for (const [name, spec] of checks)
				verdicts.push(await runLines(s, `check '${name}'`, spec));
			const logs = join(context.scratch, "check.log");
			writeFileSync(logs, `${s.log.join("\n")}\n`);
			const { outcome, reason = "" } = overall(verdicts);
			if (outcome === "failed") return { outcome, reason, outputs: { logs } };
			const outputs = {
				logs,
				...(!read && {
					[LANE_PORT]: await sealed(store.root, config, inputs, lane),
				}),
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
