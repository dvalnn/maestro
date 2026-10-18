import type { HostInstance, HostNodeResult } from "@maestro/core/host";
import { MAESTRO_TYPE, type Ports } from "@maestro/ir";
import type { Lane, Version } from "../lane/index";
import type { Bind } from "../sandbox/index";
import { LANE_PORT, LANE_TYPE, type LaneInput, type RepoSetup } from "./config";
import type { TargetStore } from "./store";

/** The base a fresh lane is cut at when neither its node nor `target.base` names one. */
const DEFAULT_BASE = "HEAD";

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
	if (input.mode === "join")
		return { lane: await store.lanes.join(version, at), read: false };
	return {
		lane: await store.lanes.fork(version, at),
		read: input.mode === "read",
	};
}

/**
 * Runs `body` in the lane `input` gives instance `instance` of `concert`. The lane is dropped unless the result
 * carries it, so a failed, cancelled or `read` instance leaves none.
 * @throws Error when the lane cannot be opened.
 */
export async function withLane(
	store: TargetStore,
	setup: RepoSetup,
	input: LaneInput,
	value: unknown,
	at: { concert: string; instance: HostInstance },
	body: (lane: InstanceLane) => Promise<HostNodeResult>,
): Promise<HostNodeResult> {
	const version = versionAt(at.concert, at.instance);
	const lane = await openLane(store, setup, input, value, version);
	let kept = false;
	try {
		const result = await body(lane);
		kept = result.outputs?.lane === version;
		return result;
	} finally {
		if (!kept) lane.lane.discard();
	}
}

/** Binds of `paths`, each at its own path. */
export const pathBinds = (...paths: string[][]): Bind[] =>
	[...new Set(paths.flat())].map((src) => ({ src }));

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
