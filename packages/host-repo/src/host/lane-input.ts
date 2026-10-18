import type { HostInstance, HostNodeResult } from "@maestro/core/host";
import { MAESTRO_TYPE, type Ports } from "@maestro/ir";
import type { Lane, Version } from "../lane/index";
import type { Bind } from "../sandbox/index";
import { LANE_TYPE, type LaneInput, type RepoSetup } from "./config";
import type { TargetStore } from "./store";

/** The base a fresh lane is cut at when neither its node nor `target.base` names one. */
const DEFAULT_BASE = "HEAD";

/** The version node instance `instance` of `concert` writes: `<concert id>.<node instance id>`. */
const versionAt = (concert: string, { id }: HostInstance): Version =>
	`${concert}.${id}`;

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
	if (typeof value !== "string")
		throw new Error(
			"input 'lane' is not a lane version. Wire it from a node's 'lane' output, or pass a lane ref",
		);
	if (input.mode === "fork")
		return { lane: await store.lanes.fork(value, at), read: false };
	if (input.mode === "join")
		return { lane: await store.lanes.join(value, at), read: false };
	return { lane: await store.lanes.fork(value, at), read: true };
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

/** The lane's own read-only binds, then the paths config and the node bind read-only at their own paths. */
export const readOnlyBinds = (lane: Lane, ...paths: string[][]): Bind[] => [
	...lane.readOnly,
	...paths.flat().map((src) => ({ src })),
];

const LANE_OUT = { [MAESTRO_TYPE]: LANE_TYPE, type: "string" };
/**
 * Untyped, so a lane ref param, which reaches the node as a literal typed only `string`, and a node's `lane` output
 * both fit it. The version is checked when the lane opens.
 */
const LANE_IN = {};

/** The lane ports of a node whose lane input is `input`: a version in unless fresh, a version out unless read. */
export const lanePorts = (input: LaneInput): { in: Ports; out: Ports } => ({
	in: input.mode === "fresh" ? {} : { lane: LANE_IN },
	out: input.mode === "read" ? {} : { lane: LANE_OUT },
});
