type Settled = { outcome: "ok" | "skipped" | "rejected" | "failed" };

export function tally(ports: { angles: Settled[] }): {
	okCount: number;
	any: boolean;
} {
	const okCount = ports.angles.filter((a) => a.outcome === "ok").length;
	return { okCount, any: okCount > 0 };
}
