import type { HostText } from "@maestro/core/host";
import type { Enrichment, HostEvent } from "@maestro/ir";
import { lastLine } from "./run-lines";

/** The `kind` of the progress event a prepare line emits as it starts and ends. */
const PREPARE_KIND = "prepare";

const stringOf = (value: unknown) =>
	typeof value === "string" && value !== "" ? value : undefined;

/** `prepare <line>/<of>: <run>` while the line runs, and its last output line, else how it ended, once it ended. */
function progress(event: HostEvent): string | undefined {
	const { kind, line, of, run, ended, tail } = event;
	if (kind !== PREPARE_KIND || typeof line !== "number") return undefined;
	if (typeof run !== "string") return undefined;
	const total = typeof of === "number" ? `/${of}` : "";
	const shown =
		typeof ended === "string"
			? (lastLine([typeof tail === "string" ? tail : ""]) ?? ended)
			: run;
	return `${PREPARE_KIND} ${line}${total}: ${shown}`;
}

/** `<harness> · <model without its provider> · <thinking>`, the thinking when the role sets one. */
function actor(enrichment: Enrichment): string | undefined {
	const harness = stringOf(enrichment.harness);
	const model = stringOf(enrichment.model);
	if (harness === undefined || model === undefined) return undefined;
	const thinking = stringOf(enrichment.thinking);
	return [
		harness,
		model.slice(model.lastIndexOf("/") + 1),
		...(thinking === undefined ? [] : [thinking]),
	].join(" · ");
}

/** How the repo host's prepare events and agents read as text. */
export const repoText: HostText = { progress, actor };
