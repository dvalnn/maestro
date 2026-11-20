import type { HostText } from "@maestro/core/host";
import { AGENT_OUT_PORTS } from "@maestro/host-repo-sdk/call";
import {
	compact,
	type Enrichment,
	type HostEvent,
	isPlainObject,
} from "@maestro/ir";
import { type EnvironmentCheck, isMark, METRIC } from "../harness/types";
import { REPORT_FIELDS, type Report } from "./frame";
import { lastLine } from "./run-lines";

/** The `kind` of the progress event a prepare line emits as it starts and ends. */
const PREPARE_KIND = "prepare";

const stringOf = (value: unknown) =>
	typeof value === "string" && value !== "" ? value : undefined;

type Wording = { word: string; detail: string };

/** What separates the parts of a detail or an actor. */
const SEP = " · ";
/** A tool result's code: whether the tool reported an error. */
const RETURN_CODE = { ok: "ok", error: "error" } as const;

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

/** `usage`, `in <n> · out <n> · cache <n>` in `compact` form, cache the tokens read from and written to it. */
function usageWording({ metrics }: HostEvent): Wording | undefined {
	if (typeof metrics !== "object" || metrics === null) return undefined;
	const counts = new Map(Object.entries(metrics));
	const amount = (name: string) => {
		const value = counts.get(name);
		return typeof value === "number" ? value : 0;
	};
	const count = (name: string) => compact(amount(name));
	const cache = compact(
		amount(METRIC.tokensCacheRead) + amount(METRIC.tokensCacheWrite),
	);
	return {
		word: "usage",
		detail: [
			`in ${count(METRIC.tokensIn)}`,
			`out ${count(METRIC.tokensOut)}`,
			`cache ${cache}`,
		].join(SEP),
	};
}

/** `result`, the tool result's size in bytes, then `ok` or `error` when the event says which. */
function resultWording({ bytes, error }: HostEvent): Wording | undefined {
	if (typeof bytes !== "number") return undefined;
	const code =
		typeof error === "boolean"
			? [error ? RETURN_CODE.error : RETURN_CODE.ok]
			: [];
	return { word: "result", detail: [String(bytes), ...code].join(SEP) };
}

/**
 * `context`, the prompt size of the latest model call in `compact` tokens: the agent's running context total. When the
 * event carries the call's usage `metrics`, the usage detail follows it.
 */
function contextWording(event: HostEvent): Wording | undefined {
	const { used } = event;
	if (typeof used !== "number") return undefined;
	const usage = usageWording(event);
	return {
		word: "context",
		detail:
			usage === undefined
				? compact(used)
				: [compact(used), usage.detail].join(SEP),
	};
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
	["context", contextWording],
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
	].join(SEP);
}

/** An agent's harness, model, thinking and profile name, each one its enrichment holds; undefined when it names no harness. */
function actorFields(
	enrichment: Enrichment,
): Record<string, string> | undefined {
	const harness = stringOf(enrichment.harness);
	if (harness === undefined) return undefined;
	const { profile } = enrichment;
	const fields = {
		harness,
		model: stringOf(enrichment.model),
		thinking: stringOf(enrichment.thinking),
		profile: isPlainObject(profile) ? stringOf(profile.name) : undefined,
	};
	return Object.fromEntries(
		Object.entries(fields).flatMap(([key, value]) =>
			value === undefined ? [] : [[key, value]],
		),
	);
}

/** The headings of the report lists an agent's notes show, by report field. */
const NOTED = {
	obstacles: "Obstacles",
	lessons: "Lessons",
	sightings: "Sightings",
} as const;

/** A report list item as a note line: a sighting reads `path · cites · text`, a line as it is. */
const noteLine = (item: unknown) =>
	isPlainObject(item)
		? [item.path, item.cites, item.text].map(String).join(SEP)
		: String(item);

/** An environment check as a record holds it, its part not yet known to be one. */
type StoredCheck = Omit<EnvironmentCheck, "part"> & { part: string };

const storedCheck = (value: unknown): StoredCheck[] =>
	isPlainObject(value) &&
	typeof value.part === "string" &&
	isMark(value.mark) &&
	Array.isArray(value.faults) &&
	value.faults.every((f) => typeof f === "string")
		? [{ part: value.part, mark: value.mark, faults: value.faults }]
		: [];

/** The checks of an agent's latest environment report its enrichment holds, less any malformed; none for an older record. */
const checksOf = ({ environment }: Enrichment): StoredCheck[] =>
	Array.isArray(environment) ? environment.flatMap(storedCheck) : [];

/** The report an agent's enrichment holds, if any; a report as text, from an older record, reads as its `summary`. */
function envelopeOf({ report }: Enrichment): Report | undefined {
	if (typeof report === "string") return { summary: report };
	return typeof report === "object" && report !== null
		? (report as Report)
		: undefined;
}

/**
 * The session an agent ran in, and the faults of its latest environment report by part, each left out when its
 * enrichment holds none.
 */
function details(enrichment: Enrichment): Record<string, unknown> {
	const id = stringOf(enrichment.session);
	const dir = stringOf(enrichment.sessionDir);
	const faulty = checksOf(enrichment).filter(({ faults }) => faults.length);
	return {
		...(id !== undefined && dir !== undefined && { session: { id, dir } }),
		...(Array.isArray(enrichment.environment) && {
			environment: {
				faults: Object.fromEntries(faulty.map((c) => [c.part, c.faults])),
			},
		}),
	};
}

const summaryOf = (enrichment: Enrichment) =>
	stringOf(envelopeOf(enrichment)?.summary);

/** The heading of an encore's agent's note saying why it started a fresh session. */
const FRESH = "Fresh session";

/**
 * An agent's report obstacles, lessons and sightings, then the faults of its environment report, then why an encore's
 * agent started a fresh session, each non-empty list under its heading.
 */
function notes(enrichment: Enrichment): Record<string, string[]> {
	const lists = new Map(Object.entries(envelopeOf(enrichment) ?? {}));
	const faults = checksOf(enrichment).flatMap(({ part, faults }) =>
		faults.map((fault) => `${part}: ${fault}`),
	);
	const fresh = stringOf(enrichment.encoreFresh);
	return Object.fromEntries([
		...Object.entries(NOTED).flatMap(([field, heading]) => {
			const list = lists.get(field);
			return Array.isArray(list) && list.length
				? [[heading, list.map(noteLine)]]
				: [];
		}),
		...(faults.length ? [["Environment", faults]] : []),
		...(fresh === undefined ? [] : [[FRESH, [fresh]]]),
	]);
}

/** How the repo host's prepare, tool, result, usage, context and environment events and its agents read as text. */
export const repoText: HostText = {
	progress,
	actor,
	notes,
	report: envelopeOf,
	actorFields,
	details,
	summary: summaryOf,
	bookkeeping: AGENT_OUT_PORTS,
	reportFields: REPORT_FIELDS,
};
