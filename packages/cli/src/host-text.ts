import type { Host, HostText } from "@maestro/core/host";
import type { ConcertEvent, Enrichment, Ir } from "@maestro/ir";
import type { Annotated } from "@maestro/render-text/live";
import { withArtifactPaths } from "./output";

/** The text hooks of the host that registers each node of `ir`, by node id, found by the namespace of its kind. */
export function hostTextOf(
	hosts: readonly Host[],
	ir: Ir,
): (node: string) => HostText | undefined {
	const kinds = new Map(ir.nodes.map((n) => [n.id, n.kind]));
	return (node) => {
		const kind = kinds.get(node) ?? "";
		const namespace = kind.slice(0, Math.max(0, kind.indexOf(".")));
		return hosts.find((h) => h.name === namespace)?.text;
	};
}

/** `events`, each progress event with the wording and actor its host gives it. */
export function annotated(
	events: readonly ConcertEvent[],
	hostText: ReturnType<typeof hostTextOf>,
): Annotated[] {
	return events.map((e) => {
		if (e.type !== "progress") return e;
		const text = hostText(e.node);
		const wording = text?.progress?.(e.event);
		const actor = text?.actor?.(e.event);
		return {
			...e,
			...(wording !== undefined && { wording }),
			...(actor !== undefined && { actor }),
		};
	});
}

/** The notes its host gives the instance of `node` that settled with `enrichment`, by heading; empty when none. */
export const notesOf = (
	enrichment: Enrichment | undefined,
	node: string,
	hostText: ReturnType<typeof hostTextOf>,
): Record<string, string[]> =>
	(enrichment && hostText(node)?.notes?.(enrichment)) ?? {};

/** The full report its host gives the instance of `node` that settled with `enrichment`, if any. */
export const reportOf = (
	enrichment: Enrichment | undefined,
	node: string,
	hostText: ReturnType<typeof hostTextOf>,
): Record<string, unknown> | undefined =>
	enrichment && hostText(node)?.report?.(enrichment);

/** Who its host says ran the instance of `node` that settled with `enrichment`. */
export const actorOf = (
	enrichment: Enrichment | undefined,
	node: string,
	hostText: ReturnType<typeof hostTextOf>,
): string | undefined => enrichment && hostText(node)?.actor?.(enrichment);

/** The one-line summary its host gives the instance of `node` that settled with `enrichment`, if any. */
export const summaryOf = (
	enrichment: Enrichment | undefined,
	node: string,
	hostText: ReturnType<typeof hostTextOf>,
): string | undefined => enrichment && hostText(node)?.summary?.(enrichment);

/** Who its host says ran the instance of `node` that settled with `enrichment`, as named fields, if anyone. */
export const actorFieldsOf = (
	enrichment: Enrichment | undefined,
	node: string,
	hostText: ReturnType<typeof hostTextOf>,
): Record<string, string> | undefined =>
	enrichment && hostText(node)?.actorFields?.(enrichment);

/** What its host adds of the instance of `node` that settled with `enrichment` to the instance's detail; empty when none. */
export const detailsOf = (
	enrichment: Enrichment | undefined,
	node: string,
	hostText: ReturnType<typeof hostTextOf>,
): Record<string, unknown> =>
	(enrichment && hostText(node)?.details?.(enrichment)) ?? {};

/**
 * The values of `outputs`, the outputs of the instance of `node`, without the ports its host keeps its bookkeeping in,
 * each artifact as its path relative to the concert's artifact area; undefined when none is left.
 */
export function valuesOf(
	ir: Ir,
	node: string,
	outputs: Readonly<Record<string, unknown>> | undefined,
	hostText: ReturnType<typeof hostTextOf>,
): Record<string, unknown> | undefined {
	const skipped = new Set(hostText(node)?.bookkeeping ?? []);
	const kept = Object.entries(outputs ?? {}).filter(
		([port]) => !skipped.has(port),
	);
	if (kept.length === 0) return undefined;
	const out = ir.nodes.find((n) => n.id === node)?.out ?? {};
	return withArtifactPaths(out, Object.fromEntries(kept));
}
