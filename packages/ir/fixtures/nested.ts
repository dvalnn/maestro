import type { Settled } from "../src/outcome";

export function tally(ports: { angles: Settled<unknown>[] }): {
	okCount: number;
	any: boolean;
} {
	const okCount = ports.angles.filter((a) => a.outcome === "ok").length;
	return { okCount, any: okCount > 0 };
}
