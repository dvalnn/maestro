import type { HostText } from "@maestro/core/host";
import type { Enrichment, HostEvent } from "@maestro/ir";
import { METRIC } from "../harness/types";
import type { Report } from "./frame";
import { lastLine } from "./run-lines";

/** The `kind` of the progress event a prepare line emits as it starts and ends. */
const PREPARE_KIND = "prepare";

const stringOf = (value: unknown) =>
	typeof value === "string" && value !== "" ? value : undefined;

type Wording = { word: string; detail: string };

/** `prepare`, `<line>/<of>: <run>` while the line runs, and its last output line, else how it ended, once it ended. */
function prepareWording(event: HostEvent): Wording | undefined {
	const { line, of, run, ended, tail } = event;
	if (typeof line !== "number" || typeof run !== "string") return undefined;
	const total = typeof of === "number" ? `/${of}` : "";
	const shown =
		typeof ended === "string"
			? (lastLine([typeof tail === "string" ? tail : ""]) ?? ended)
			: run;
	return { word: PREPARE_KIND, detail: `${line}${total}: ${shown}` };
}

/** `tool`, `<name> <input as compact JSON>`, the input left out when there is none. */
function toolWording({ name, input }: HostEvent): Wording | undefined {
	if (typeof name !== "string") return undefined;
	const detail =
		input === undefined ? name : `${name} ${JSON.stringify(input)}`;
	return { word: "tool", detail };
}

/** `usage`, `in <n> · out <n> · cache <n>`, cache the tokens read from and written to it. */
function usageWording({ metrics }: HostEvent): Wording | undefined {
	if (typeof metrics !== "object" || metrics === null) return undefined;
	const counts = new Map(Object.entries(metrics));
	const count = (name: string) => {
		const value = counts.get(name);
		return typeof value === "number" ? value : 0;
	};
	const cache = count(METRIC.tokensCacheRead) + count(METRIC.tokensCacheWrite);
	return {
		word: "usage",
		detail: `in ${count(METRIC.tokensIn)} · out ${count(METRIC.tokensOut)} · cache ${cache}`,
	};
}

/** `result`, the tool result's size in bytes. */
function resultWording({ bytes }: HostEvent): Wording | undefined {
	return typeof bytes === "number"
		? { word: "result", detail: String(bytes) }
		: undefined;
}

/** `environment`, the count of tools the harness reported loading. */
function environmentWording({ tools }: HostEvent): Wording | undefined {
	return Array.isArray(tools)
		? { word: "environment", detail: `${tools.length} tools` }
		: undefined;
}

/** The wording of each progress kind the host words, by kind. */
const WORDINGS: ReadonlyMap<
	unknown,
	(event: HostEvent) => Wording | undefined
> = new Map([
	[PREPARE_KIND, prepareWording],
	["tool", toolWording],
	["tool_result", resultWording],
	["usage", usageWording],
	["environment", environmentWording],
]);

const progress = (event: HostEvent) => WORDINGS.get(event.kind)?.(event);

/** `<harness> · <model without its provider> · <thinking>`, the thinking when the runtime sets one. */
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

/** The host directory of the session that ran an agent, where its harness writes the transcript. */
const where = (enrichment: Enrichment) => stringOf(enrichment.sessionDir);

/** The headings of the report lists an agent's notes show, by report field. */
const NOTED = { obstacles: "Obstacles", lessons: "Lessons" } as const;

/** The report an agent's enrichment holds, if any; a report as text, from an older record, reads as its `summary`. */
export function reportOf({ report }: Enrichment): Report | undefined {
	if (typeof report === "string") return { summary: report };
	return typeof report === "object" && report !== null
		? (report as Report)
		: undefined;
}

/** An agent's report obstacles and lessons, each non-empty list under its heading. */
function notes(enrichment: Enrichment): Record<string, string[]> {
	const lists = new Map(Object.entries(reportOf(enrichment) ?? {}));
	return Object.fromEntries(
		Object.entries(NOTED).flatMap(([field, heading]) => {
			const list = lists.get(field);
			return Array.isArray(list) && list.length
				? [[heading, list.map(String)]]
				: [];
		}),
	);
}

/** How the repo host's prepare, tool, result and usage events and its agents read as text. */
export const repoText: HostText = { progress, actor, where, notes };
