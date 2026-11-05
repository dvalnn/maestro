import type { HostInstance } from "@maestro/core/host";
import { parseExpansion } from "@maestro/ir";
import { findSession, type Latest, latestOf, type Session } from "./store";
import { hasTurn } from "./turn";

/** The group kind whose iterations an encore's instance matches by the last one, not by its own key. */
const LOOP = "loop";

/** The keys of `instance`'s expansion, outermost first. */
export const keysOf = (instance: HostInstance) =>
	parseExpansion(instance.expansion) ?? [];

/**
 * Whether `latest` sits where `instance` does: the same node, the same key in each group but a loop. A key is an item's
 * position or `parMap` key, so an extra item with none kept matches nothing.
 */
function matches(latest: Latest, instance: HostInstance, keys: string[]) {
	return (
		latest.node === instance.node.id &&
		latest.keys.length === keys.length &&
		keys.every((k, i) => instance.groups[i] === LOOP || latest.keys[i] === k)
	);
}

/** Orders `a` before `b` when it sits in a later iteration of the loops around it, the outermost first. */
function later(a: Latest, b: Latest, groups: HostInstance["groups"]): number {
	for (const [i, kind] of groups.entries()) {
		const by = kind === LOOP ? Number(b.keys[i]) - Number(a.keys[i]) : 0;
		if (by !== 0) return by;
	}
	return 0;
}

/**
 * The session of `instance`'s counterpart in concert `encore`, which an agent on `harness` running profile `profile`
 * continues, or why it starts a fresh one instead. The counterpart is the instance of the same node at the same keys,
 * in a loop its last iteration.
 */
export function counterpartSession(
	root: string,
	encore: string,
	instance: HostInstance,
	runtime: { harness: string; profile: string },
): { session: Session } | { fresh: string } {
	const keys = keysOf(instance);
	const [found] = latestOf(root, encore)
		.filter((latest) => matches(latest, instance, keys))
		.sort((a, b) => later(a, b, instance.groups));
	if (!found)
		return { fresh: `concert ${encore} kept no session of '${instance.id}'` };
	const session = findSession(root, found.session);
	if (!session)
		return {
			fresh: `session ${found.session} is gone from the store: its concert was pruned`,
		};
	if (session.harness !== runtime.harness)
		return {
			fresh: `session ${session.id} runs on harness '${session.harness}', and profile ${runtime.profile} on '${runtime.harness}'`,
		};
	if (!hasTurn(session))
		return { fresh: `session ${session.id} has no settled turn to continue` };
	return { session };
}
