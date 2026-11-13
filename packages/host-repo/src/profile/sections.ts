import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { tildeOf } from "@maestro/core";
import type { Roots } from "@maestro/core/host";
import {
	type AgentEnvironment,
	environmentChecks,
	faultCount,
	type Mark,
	type ObservedEnvironment,
} from "../harness/index";
import {
	type Inspection,
	profileRoot,
	readablePath,
	sourceWords,
} from "./index";

/** A row of a section: a key and its value, the words of the source that set it, a check mark and its faults. */
export type SectionRow = {
	key: string;
	value: string;
	source?: string;
	mark?: Mark;
	faults?: string[];
};

/** A line under a section's rows; `dim` for a hint. */
export type SectionFoot = { text: string; dim?: boolean };

/** A view's section: a title, with `value` and the words of the `source` that set it on its line, then rows and foot lines. */
export type Section = {
	title: string;
	value?: string;
	source?: string;
	rows: SectionRow[];
	foot?: SectionFoot[];
};

/** What a harness reported it loaded when probed; `observed` absent when it reported nothing. */
export type ProbeReport = { observed?: ObservedEnvironment };

/** What a profile's sections need besides the profile: its model's window and where to look. */
export type SectionsView = {
	roots: Roots;
	home?: string;
	window?: number;
	/** The command that probes the profile, which a declared-only environment points at. */
	probeCommand?: string;
};

type Places = Pick<SectionsView, "roots" | "home">;

/** `path` relative inside `base` or the workspace, else from `~` under home. */
const readable = (path: string, base: string | undefined, places: Places) =>
	tildeOf(readablePath(path, base, places.roots), places.home);

/** Where profile directory `dir` of profile `name` sits: a pack's within the pack, any other as `readable`. */
function placeOf(dir: string, name: string, places: Places): string {
	if (profileRoot(dir, places.roots) !== "pack")
		return `${readable(dir, undefined, places)}/`;
	const [pack = ""] = name.split("/");
	const bundle = places.roots.packs[pack] ?? dirname(dir);
	return `${pack} pack: ${relative(bundle, dir)}/`;
}

const isDirectory = async (path: string) =>
	(await stat(path).catch(() => undefined))?.isDirectory() ?? false;

/** `path` as `readable` within the profile directory, or relative to it within its namespace directory, with a trailing `/` for a directory. */
async function hostPath(path: string, s: Inspection, places: Places) {
	const shown = path.startsWith(dirname(s.dir) + sep)
		? relative(s.dir, path)
		: readable(path, s.dir, places);
	return (await isDirectory(path)) ? `${shown}/` : shown;
}

/** The words of the source of the value at dotted `key`; none for the profile's own file. */
function wordsAt(s: Inspection, key: string): string | undefined {
	const source = s.sources[key];
	return source && sourceWords(source);
}

/** A row whose value the source at `key` may have set. */
const sourcedRow = (
	s: Inspection,
	key: string,
	rowKey: string,
	value: string,
): SectionRow => {
	const source = wordsAt(s, key);
	return { key: rowKey, value, ...(source !== undefined && { source }) };
};

function headSection(s: Inspection, places: Places): Section {
	return {
		title: s.name,
		rows: [
			{ key: "from", value: placeOf(s.dir, s.name, places) },
			...s.shadows.map((dir, i) => ({
				key: i === 0 ? "shadows" : "",
				value: placeOf(dir, s.name, places),
			})),
		],
	};
}

const RUNTIME_KEYS = ["harness", "model", "thinking"] as const;

/** The runtime rows of `s`; with `version`, the harness row carries the version the harness reported. */
function runtimeSection(s: Inspection, version?: string): Section {
	const rows = RUNTIME_KEYS.flatMap((key): SectionRow[] => {
		const value = s.runtime[key];
		if (value === undefined)
			return key === "thinking" ? [] : [{ key, value: "-" }];
		const shown = key === "harness" && version ? `${value} ${version}` : value;
		return [sourcedRow(s, `runtime.${key}`, key, shown)];
	});
	return { title: "Runtime", rows };
}

const lineCount = (text: string) =>
	text.split("\n").length - (text === "" || text.endsWith("\n") ? 1 : 0);

async function instructionsSections(
	s: Inspection,
	places: Places,
): Promise<Section[]> {
	if (s.instructions === undefined) return [];
	const texts = await Promise.all(
		s.instructions.map((f) => readFile(f, "utf8")),
	);
	const lines = texts.reduce((n, t) => n + lineCount(t), 0);
	const paths = await Promise.all(
		s.instructions.map((f) => hostPath(f, s, places)),
	);
	const value = `${paths.join(", ")}, ${lines} ${lines === 1 ? "line" : "lines"}`;
	const source = wordsAt(s, "instructions");
	return [
		{
			title: "Instructions",
			value,
			...(source !== undefined && { source }),
			rows: [],
		},
	];
}

/** The extras directory of `s` and its source, then its top-level entries, each directory's with a trailing `/`. */
async function extrasSections(
	s: Inspection,
	places: Places,
): Promise<Section[]> {
	if (s.harnessExtras === undefined) return [];
	const found = await readdir(s.harnessExtras, { withFileTypes: true });
	const entries = found
		.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
		.toSorted();
	const source = wordsAt(s, "harnessExtras");
	return [
		{
			title: "Extras",
			value: await hostPath(s.harnessExtras, s, places),
			...(source !== undefined && { source }),
			rows: [{ key: "entries", value: names(entries) }],
		},
	];
}

type Bound = { key: string; host: string; agent: string; words?: string };

/** A `host`/`agent` table under section `title`, one row per bind; nothing when there is none. */
function boundSections(title: string, rows: Bound[]): Section[] {
	if (!rows.length) return [];
	const width = Math.max(
		...["host", ...rows.map((r) => r.host)].map((h) => Bun.stringWidth(h)),
	);
	const cells = (host: string, agent: string) =>
		`${host}${" ".repeat(Math.max(0, width - Bun.stringWidth(host)))}  ${agent}`;
	return [
		{
			title,
			value: cells("host", "agent"),
			rows: rows.map((r) => ({
				key: r.key,
				value: cells(r.host, r.agent),
				...(r.words !== undefined && { source: r.words }),
			})),
		},
	];
}

async function attachmentSections(
	s: Inspection,
	places: Places,
): Promise<Section[]> {
	const rows = await Promise.all(
		Object.entries(s.attachments).map(async ([key, a]) => ({
			key,
			host: await hostPath(a.path, s, places),
			agent: a.agent,
			words: wordsAt(s, `attachments.${key}.path`),
		})),
	);
	return boundSections("Attachments", rows);
}

/** Read-only binds, each at its own host path in the agent's sandbox. */
function readOnlySections(s: Inspection, places: Places): Section[] {
	const rows = s.readOnly.map((path, i) => ({
		key: "",
		host: readable(path, s.dir, places),
		agent: path,
		words: wordsAt(s, `readOnly.${i}`),
	}));
	return boundSections("Read-only", rows);
}

function limitsSections(s: Inspection): Section[] {
	const rows = Object.entries(s.limits).map(([key, value]) =>
		sourcedRow(s, `limits.${key}`, key, String(value)),
	);
	return rows.length ? [{ title: "Limits", rows }] : [];
}

/**
 * The context policy's rows, then the model's window in tokens where one is known, with what it is kept for after a
 * probe, or `? not reported` after one that kept none.
 */
function contextSections(
	s: Inspection,
	window: number | undefined,
	probed: boolean,
): Section[] {
	const rows = Object.entries(s.context ?? {}).map(([key, value]) =>
		sourcedRow(s, `context.${key}`, key, String(value)),
	);
	if (window !== undefined) {
		const { harness, model } = s.runtime;
		const kept = probed ? `  kept for ${harness} ${model}` : "";
		rows.push({ key: "window", value: `${window}${kept}` });
	} else if (probed)
		rows.push({ key: "window", value: "not reported", mark: "?" });
	return rows.length ? [{ title: "Context", rows }] : [];
}

const names = (list: readonly string[]) =>
	list.length ? list.join(" ") : "none";

type EnvironmentRow = {
	part: keyof AgentEnvironment;
	key: string;
	value: string;
};

/** The rows of `declared`, the environment harness `harness` launches with. */
function environmentRows(
	declared: AgentEnvironment,
	harness: string,
): EnvironmentRow[] {
	return [
		{ part: "tools", key: "tools", value: names(declared.tools) },
		{
			part: "subagents",
			key: "subagents",
			value: declared.subagents ? "on" : "off",
		},
		{ part: "skills", key: "skills", value: names(declared.skills) },
		{ part: "mcp", key: "mcp", value: names(declared.mcp) },
		{ part: "hooks", key: "hooks", value: names(declared.hooks) },
		{ part: "contextFiles", key: "files", value: names(declared.contextFiles) },
		{ part: "compaction", key: "compaction", value: `${harness}'s own` },
	];
}

/** The checklist of `declared` against `report`, its title naming the harness, the fault count last. */
function reportSection(
	declared: AgentEnvironment,
	harness: string,
	report: ProbeReport,
): Section {
	const { observed } = report;
	const checks = environmentChecks(declared, observed ?? {});
	const version = observed?.version ? ` ${observed.version}` : "";
	const said = observed ? `${harness}${version}` : `nothing from ${harness}`;
	const faults = faultCount(checks);
	return {
		title: "Environment",
		value: `probed ${said}`,
		rows: environmentRows(declared, harness).flatMap((r) => {
			const check = checks.find((c) => c.part === r.part);
			return check
				? [
						{
							key: r.key,
							value: r.value,
							mark: check.mark,
							faults: check.faults,
						},
					]
				: [];
		}),
		foot: [
			{ text: "" },
			{ text: `${faults} ${faults === 1 ? "fault" : "faults"}` },
		],
	};
}

/** The Environment section: declared only, with a dim pointer at `probe`, or checked against `report`. */
function environmentSection(
	s: Inspection,
	view: SectionsView,
	report?: ProbeReport,
): Section {
	const { harness } = s.runtime;
	if (harness === undefined)
		return {
			title: "Environment",
			value: "no harness to declare one",
			rows: [],
		};
	const { declared } = s.environment;
	if (declared === null)
		return {
			title: "Environment",
			value: `not declared by ${harness}`,
			rows: [],
		};
	if (report) return reportSection(declared, harness, report);
	return {
		title: "Environment",
		value: "declared only",
		rows: environmentRows(declared, harness).map(({ key, value }) => ({
			key,
			value,
		})),
		foot: [
			{
				text: `Run ${view.probeCommand} to check it against ${harness}`,
				dim: true,
			},
		],
	};
}

/** The sections of `s`, as `agent show` and `agent probe` print them; one with nothing to show is left out. */
export async function profileSections(
	s: Inspection,
	view: SectionsView,
): Promise<Section[]> {
	return [
		headSection(s, view),
		runtimeSection(s),
		...(await instructionsSections(s, view)),
		...(await extrasSections(s, view)),
		...(await attachmentSections(s, view)),
		...readOnlySections(s, view),
		...limitsSections(s),
		...contextSections(s, view.window, false),
		environmentSection(s, view),
	];
}

/**
 * The sections of `agent probe`: the title, the runtime rows with the harness's probed version, the context window,
 * the harness extras and the environment checklist. The rest stays `profileSections`'s.
 */
export async function probeSections(
	s: Inspection,
	view: SectionsView,
	report: ProbeReport,
): Promise<Section[]> {
	const version = report.observed?.version;
	return [
		{ title: s.name, rows: runtimeSection(s, version).rows },
		...contextSections(s, view.window, true),
		...(await extrasSections(s, view)),
		environmentSection(s, view, report),
	];
}
