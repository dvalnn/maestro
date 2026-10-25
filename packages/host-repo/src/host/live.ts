import type { HostInstance, HostNodeResult } from "@maestro/core/host";

/**
 * A running instance: whether it was cancelled, why it was stopped for passing a limit, and how to stop what it runs
 * now.
 */
export type Live = {
	cancelled: boolean;
	limit?: string;
	stop?: () => Promise<unknown>;
};

/** The running instances of one kind, so its `cancel` reaches what `execute` started. */
export function liveInstances() {
	const live = new Map<string, Live>();
	return {
		async execute(
			instance: HostInstance,
			body: (live: Live) => Promise<HostNodeResult>,
		): Promise<HostNodeResult> {
			const state: Live = { cancelled: false };
			live.set(instance.id, state);
			try {
				return await body(state);
			} finally {
				live.delete(instance.id);
			}
		},
		async cancel(instance: HostInstance) {
			const state = live.get(instance.id);
			if (!state) return;
			state.cancelled = true;
			await state.stop?.();
		},
	};
}
