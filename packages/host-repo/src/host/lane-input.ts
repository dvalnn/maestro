import type {
	HostContext,
	HostInstance,
	HostNodeResult,
} from "@maestro/core/host";
import { MAESTRO_TYPE, type Ports } from "@maestro/ir";
import type { Lane, Version } from "../lane/index";
import type { Bind } from "../sandbox/index";
import {
	type CheckSpec,
	LANE_PORT,
	LANE_TYPE,
	type LaneInput,
	type RepoSetup,
} from "./config";
import type { Live } from "./live";
import { pathBinds, runLines, type Sandboxed, tailOf } from "./run-lines";
import type { TargetStore } from "./store";

/** The base a fresh lane is cut at when neither its node nor `target.base` names one. */
const DEFAULT_BASE = "HEAD";
/** How many changed files a refused `target.prepare` names. */
const LISTED_CHANGES = 10;
const PREPARE = "target.prepare";

/** The version node instance `instance` of `concert` writes: `<concert id>.<node instance id>`. */
const versionAt = (concert: string, { id }: HostInstance): Version =>
	`${concert}.${id}`;

/**
 * The version `value`, a lane input, names.
 * @throws Error when it is not a version.
 */
export function laneVersion(value: unknown): Version {
	if (typeof value !== "string")
		throw new Error(
			"input 'lane' is not a lane version. Wire it from a node's 'lane' output, or pass a lane ref",
		);
	return value;
}

/** An instance's lane, and whether it is a `read`, which yields no version. */
type InstanceLane = { lane: Lane; read: boolean };

/**
 * The lane `input` gives the instance whose version is `at`. `value` is its `lane` input, a version, for every mode
 * but `fresh`.
 * @throws Error when `value` is not a version, or the lanes refuse it.
 */
async function openLane(
	store: TargetStore,
	setup: RepoSetup,
	input: LaneInput,
	value: unknown,
	at: Version,
): Promise<InstanceLane> {
	if (input.mode === "fresh") {
		const base = input.base ?? setup.target?.base ?? DEFAULT_BASE;
		return { lane: await store.lanes.fresh(base, at), read: false };
	}
	const version = laneVersion(value);
	if (input.mode === "extend")
		return { lane: await store.lanes.extend(version, at), read: false };
	return {
		lane: await store.lanes.fork(version, at),
		read: input.mode === "read",
	};
}

/** A running instance of `concert`: its live state, and where its progress events go. */
type InstanceRun = {
	concert: string;
	instance: HostInstance;
	live: Live;
	emit: HostContext["emit"];
};

/** The changed files `files` as a refusal names them, up to `LISTED_CHANGES`. */
function changeList(files: string[]): string {
	const more = files.length - LISTED_CHANGES;
	const named = files.slice(0, LISTED_CHANGES).join(", ");
	return more > 0 ? `${named} and ${more} more` : named;
}

/**
 * Runs `spec`, the target's prepare, in `lane`'s sandbox as a check runs, emitting an event as each line starts and ends.
 * @throws Error when a line does not exit 0, or the lines changed content `seal` would record.
 */
async function prepare(
	lane: Lane,
	setup: RepoSetup,
	spec: CheckSpec,
	run: InstanceRun,
) {
	const s: Sandboxed = {
		dir: lane.dir,
		readOnly: readOnlyBinds(lane, setup.readOnly),
		writable: [],
		live: run.live,
		log: [],
	};
	const { outcome, reason } = await runLines(s, PREPARE, spec, {
		start: (start) => run.emit({ kind: "prepare", ...start }),
		end: ({ output, ...end }) =>
			run.emit({ kind: "prepare", ...end, tail: tailOf(output) }),
	});
	if (outcome !== "ok") throw new Error(reason);
	const changed = await lane.changes();
	if (changed.length)
		throw new Error(
			`${PREPARE} changed lane content: ${changeList(changed)}. Ignore those paths, or keep ${PREPARE} from writing them`,
		);
}

/**
 * Runs `body` in the lane `input` gives `run`, after the target's prepare when the lane was checked out. The lane is
 * dropped unless the result carries it, so a failed, cancelled or `read` instance leaves none.
 * @throws Error when the lane cannot be opened, or its prepare fails.
 */
export async function withLane(
	store: TargetStore,
	setup: RepoSetup,
	input: LaneInput,
	value: unknown,
	run: InstanceRun,
	body: (lane: InstanceLane) => Promise<HostNodeResult>,
): Promise<HostNodeResult> {
	const version = versionAt(run.concert, run.instance);
	const lane = await openLane(store, setup, input, value, version);
	const spec = setup.target?.prepare;
	let kept = false;
	try {
		if (spec && lane.lane.checkedOut)
			await prepare(lane.lane, setup, spec, run);
		const result = await body(lane);
		kept = result.outputs?.lane === version;
		return result;
	} finally {
		if (!kept) lane.lane.discard();
	}
}

/** The lane's own read-only binds, then the paths config and the node bind read-only at their own paths. */
export const readOnlyBinds = (lane: Lane, ...paths: string[][]): Bind[] => [
	...lane.readOnly,
	...pathBinds(...paths),
];

const LANE = { [MAESTRO_TYPE]: LANE_TYPE, type: "string" };

/** The lane ports of a node whose lane input is `input`: a version in unless fresh, a version out unless read. */
export const lanePorts = (input: LaneInput): { in: Ports; out: Ports } => ({
	in: input.mode === "fresh" ? {} : { [LANE_PORT]: LANE },
	out: input.mode === "read" ? {} : { [LANE_PORT]: LANE },
});
