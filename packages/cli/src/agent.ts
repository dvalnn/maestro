import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { closest } from "@maestro/core";
import { ConfigError } from "@maestro/core/config";
import { type HostSetup, hostSetup, type Roots } from "@maestro/core/host";
import type { ConcertRecord, Records } from "@maestro/core/perform";
import {
	type Binding,
	findProfile,
	HOST_NAME,
	heldNames,
	type Inspection,
	inspectProfile,
	keepWindow,
	type Profile,
	type ProfileRoot,
	probe,
	probeRequest,
	profileRoot,
	readablePath,
	resolveProfile,
	type SeatedAgent,
	seatedAgents,
	sourceWords,
	unsetMessage,
	windowOf,
} from "@maestro/host-repo";
import {
	type AgentEnvironment,
	type EnvironmentCheck,
	environmentChecks,
	type ObservedEnvironment,
	observedOf,
} from "@maestro/host-repo/harness";
import { messageOf } from "@maestro/ir";
import { padCells } from "@maestro/render-text/live";
import { Document, isScalar } from "yaml";
import {
	COMMON,
	type Command,
	colorOf,
	type Deps,
	isSet,
	type Options,
	only,
	parse,
	splitFirst,
	textOf,
	type Values,
} from "./command";
import { builtinHarnesses, DECLARED } from "./hosts";
import {
	CliError,
	EXIT,
	instanceName,
	jsonOf,
	nameOf,
	paint,
	table,
	tildeOf,
	usageError,
} from "./output";
import { prepare } from "./prepare";
import {
	concertOf,
	instancesInOrder,
	openSession,
	overridesOf,
	type Session,
	setupOf,
	withRecord,
} from "./session";

const AGENT_OPTIONS: Options = {
	...COMMON,
	yaml: {
		type: "boolean",
		desc: "show: print the profile as one folded profile.yaml",
	},
	probe: {
		type: "boolean",
		desc: "show: start the agent as a concert would, check what its harness loads, then stop it",
	},
	concert: {
		type: "string",
		arg: "id",
		desc: "show: the environment a node of this concert recorded, the node named as 'maestro ls <id>' lists it",
	},
	seat: {
		type: "string",
		arg: "key",
		desc: "show: the profile seat <composition id>/<seat> of the composition named, as config binds it",
	},
	prompt: {
		type: "boolean",
		desc: "show: with --seat, print the system prompt each agent in the seat is given",
	},
};

const FIX = "Run 'maestro agent ls', or 'maestro agent show <profile>'";
const NAME_PROFILE = "Name one as 'maestro agent ls' lists it";
const NAME_NODE = "Name one as 'maestro ls <concert>' lists it";
const NAME_COMPOSITION = "Name it by file path or <pack>.<composition>";
/** The flags only `show` takes, and the pairs of them that exclude each other. */
const SHOW_FLAGS = ["yaml", "probe", "concert", "seat", "prompt"] as const;
const EXCLUSIVE = [
	["yaml", "json"],
	["yaml", "probe"],
	["yaml", "concert"],
	["probe", "concert"],
	["seat", "concert"],
	["prompt", "concert"],
	["prompt", "probe"],
	["prompt", "yaml"],
	["seat", "yaml"],
] as const;
const MARK_STYLE = { "✓": "green", "✗": "red", "?": "dim" } as const;

const INDENT = "  ";
/** A row's key column, so its value starts at column 15 under a section header of the same width. */
const KEY_WIDTH = 12;
const HEAD_WIDTH = INDENT.length + KEY_WIDTH;
const KEY_GAP = "  ";
/** The width a fault's lines wrap at. */
const LINE_WIDTH = 80;

/** A seat by its key, `<composition id>/<seat>`, in the composition `target` names as `compose` takes it. */
type SeatRequest = { key: string; target: string; prompt: boolean };

type Request =
	| { action: "ls" }
	| { action: "show"; name: string; probe: boolean }
	| ({ action: "seat"; probe: boolean } & SeatRequest)
	| { action: "recorded"; concert: string; node: string };

type Listed = {
	name: string;
	root: ProfileRoot;
	dir: string;
	shadowsPack: boolean;
	harness?: string;
	model?: string;
	error?: string;
};

type Places = { roots: Roots; home?: string };

type Colored = { color: boolean };

type Look = Places & Colored;

type Setup = Pick<HostSetup, "layers" | "roots">;

const given = (values: Values, flag: string) =>
	isSet(values, flag) || textOf(values, flag) !== undefined;

function lsRequest(rest: readonly string[], values: Values): Request {
	if (rest.length > 0)
		throw usageError(
			`agent ls takes no profile, got ${rest.length}`,
			"Run 'maestro agent show <profile>' for one profile",
		);
	const flag = SHOW_FLAGS.find((f) => given(values, f));
	if (flag !== undefined)
		throw usageError(`agent ls takes no --${flag}`, `Drop --${flag}`);
	return { action: "ls" };
}

function showRequest(rest: readonly string[], values: Values): Request {
	const pair = EXCLUSIVE.find((p) => p.every((f) => given(values, f)));
	if (pair)
		throw usageError(
			`--${pair[0]} and --${pair[1]} both given`,
			"Pass one of them",
		);
	const concert = textOf(values, "concert");
	if (concert !== undefined)
		return {
			action: "recorded",
			concert,
			node: only(rest, "node", NAME_NODE, "show"),
		};
	const probe = isSet(values, "probe");
	const prompt = isSet(values, "prompt");
	const key = textOf(values, "seat");
	if (key !== undefined) {
		const target = only(rest, "composition", NAME_COMPOSITION, "show");
		return { action: "seat", key, target, probe, prompt };
	}
	if (prompt)
		throw usageError(
			"--prompt takes --seat: the prompt is a seat's",
			"Add --seat <composition id>/<seat> and name its composition",
		);
	return {
		action: "show",
		name: only(rest, "profile", NAME_PROFILE, "show"),
		probe,
	};
}

/** The request `positionals` and `values` make. @throws CliError, a usage error, for anything else. */
function requestOf(values: Values, positionals: readonly string[]): Request {
	const [action, ...rest] = positionals;
	if (action === "ls") return lsRequest(rest, values);
	if (action === "show") return showRequest(rest, values);
	throw usageError(
		`expected ls or show, got ${action === undefined ? "nothing" : `'${action}'`}`,
		FIX,
	);
}

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

/** `path` as `readable` within the profile directory, with a trailing `/` for a directory. */
async function hostPath(path: string, s: Inspection, places: Places) {
	const shown = readable(path, s.dir, places);
	return (await isDirectory(path)) ? `${shown}/` : shown;
}

const head = (title: string, value: string, look: Colored) =>
	`${paint("bold", title.padEnd(HEAD_WIDTH), look.color)}${value}`;

const row = (key: string, value: string, look: Colored) =>
	`${INDENT}${paint("dim", `${key}${KEY_GAP}`.padEnd(KEY_WIDTH), look.color)}${value}`;

/** The words of the source of the value at dotted `key`; none for the profile's own file. */
function wordsAt(s: Inspection, key: string): string | undefined {
	const source = s.sources[key];
	return source && sourceWords(source);
}

/** `value`, then the dim `[words]` of its source when a layer other than the profile's own file set it. */
const sourced = (value: string, words: string | undefined, look: Look) =>
	words === undefined
		? value
		: `${value}  ${paint("dim", `[${words}]`, look.color)}`;

/** The system prompt the agents of `nodes` are given, which is the same for each of them. */
type Prompted = { nodes: string[]; prompt: string };

/** A seat, by its key, the profile it is bound to, and its agents' system prompts when asked for. */
type Seated = { key: string; binding: Binding; prompts?: Prompted[] };

function headLines(s: Inspection, look: Look, seated?: Seated): string[] {
	const { key, binding } = seated ?? {};
	const words = binding?.source && sourceWords(binding.source);
	return [
		paint("bold", s.name, look.color),
		...(key === undefined
			? []
			: [row("seat", sourced(key, words, look), look)]),
		row("from", placeOf(s.dir, s.name, look), look),
		...s.shadows.map((dir, i) =>
			row(i === 0 ? "shadows" : "", placeOf(dir, s.name, look), look),
		),
	];
}

const RUNTIME_KEYS = ["harness", "model", "thinking"] as const;

function runtimeLines(s: Inspection, look: Look): string[] {
	const rows = RUNTIME_KEYS.flatMap((key) => {
		const value = s.runtime[key];
		if (value === undefined) return [];
		return [row(key, sourced(value, wordsAt(s, `runtime.${key}`), look), look)];
	});
	return [paint("bold", "Runtime", look.color), ...rows];
}

const lineCount = (text: string) =>
	text.split("\n").length - (text === "" || text.endsWith("\n") ? 1 : 0);

async function instructionsLines(s: Inspection, look: Look): Promise<string[]> {
	if (s.instructions === undefined) return [];
	const lines = lineCount(await readFile(s.instructions, "utf8"));
	const value = `${await hostPath(s.instructions, s, look)}, ${lines} ${lines === 1 ? "line" : "lines"}`;
	return [
		head(
			"Instructions",
			sourced(value, wordsAt(s, "instructions"), look),
			look,
		),
	];
}

type Bound = { key: string; host: string; agent: string; words?: string };

/** A `host`/`agent` table under section `title`, one row per bind; nothing when there is none. */
function boundLines(title: string, rows: Bound[], look: Look): string[] {
	if (!rows.length) return [];
	const width = Math.max(
		...["host", ...rows.map((r) => r.host)].map((h) => Bun.stringWidth(h)),
	);
	const cells = (host: string, agent: string) =>
		`${padCells(host, width)}  ${agent}`;
	return [
		head(title, cells("host", "agent"), look),
		...rows.map((r) =>
			row(r.key, cells(r.host, sourced(r.agent, r.words, look)), look),
		),
	];
}

async function attachmentLines(s: Inspection, look: Look): Promise<string[]> {
	const rows = await Promise.all(
		Object.entries(s.attachments).map(async ([key, a]) => ({
			key,
			host: await hostPath(a.path, s, look),
			agent: a.agent,
			words: wordsAt(s, `attachments.${key}.path`),
		})),
	);
	return boundLines("Attachments", rows, look);
}

/** Read-only binds, each at its own host path in the agent's sandbox. */
function readOnlyLines(s: Inspection, look: Look): string[] {
	const rows = s.readOnly.map((path, i) => ({
		key: "",
		host: readable(path, s.dir, look),
		agent: path,
		words: wordsAt(s, `readOnly.${i}`),
	}));
	return boundLines("Read-only", rows, look);
}

function limitsLines(s: Inspection, look: Look): string[] {
	const rows = Object.entries(s.limits).map(([key, value]) =>
		row(key, sourced(String(value), wordsAt(s, `limits.${key}`), look), look),
	);
	return rows.length ? [paint("bold", "Limits", look.color), ...rows] : [];
}

/**
 * The context policy's rows, then the model's window in tokens where one is known, or `? not reported` after a probe
 * that kept none.
 */
function contextLines(
	s: Inspection,
	window: number | undefined,
	look: Look,
	probed: boolean,
): string[] {
	const rows = Object.entries(s.context ?? {}).map(([key, value]) =>
		row(key, sourced(String(value), wordsAt(s, `context.${key}`), look), look),
	);
	if (window !== undefined) rows.push(row("window", String(window), look));
	else if (probed)
		rows.push(
			`${paint("dim", "?", look.color)} ${row("window", "not reported", look).slice(INDENT.length)}`,
		);
	return rows.length ? [paint("bold", "Context", look.color), ...rows] : [];
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

/** `text` broken at spaces into lines of at most `width` cells; a longer word keeps a line of its own. */
function wrapWords(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const word of text.split(" ")) {
		const joined = `${lines.at(-1)} ${word}`;
		if (lines.length && Bun.stringWidth(joined) <= width)
			lines[lines.length - 1] = joined;
		else lines.push(word);
	}
	return lines;
}

/** What a harness reported it loaded: `probed` now, or `recorded` by a concert; `observed` absent when it reported nothing. */
type Report = { how: "probed" | "recorded"; observed?: ObservedEnvironment };

/** A row of the checklist: its mark, then the key and value as `row` lays them, each fault under it at column 15. */
function checkedLines(
	{ key, value }: EnvironmentRow,
	check: EnvironmentCheck,
	look: Colored,
): string[] {
	const mark = paint(MARK_STYLE[check.mark], check.mark, look.color);
	const lines = check.faults.flatMap((f) =>
		wrapWords(f, LINE_WIDTH - HEAD_WIDTH),
	);
	return [
		`${mark} ${row(key, value, look).slice(INDENT.length)}`,
		...lines.map(
			(l) => `${" ".repeat(HEAD_WIDTH)}${paint("red", l, look.color)}`,
		),
	];
}

const faultCount = (checks: readonly EnvironmentCheck[]) =>
	checks.reduce((n, c) => n + c.faults.length, 0);

/** The checklist of `declared` against `report`, its header naming the harness, the fault count last. */
function reportLines(
	declared: AgentEnvironment,
	harness: string,
	report: Report,
	look: Colored,
): string[] {
	const { observed } = report;
	const checks = environmentChecks(declared, observed ?? {});
	const version = observed?.version ? ` ${observed.version}` : "";
	const said = observed ? `${harness}${version}` : `nothing from ${harness}`;
	const faults = faultCount(checks);
	const count = `${faults} ${faults === 1 ? "fault" : "faults"}${report.how === "recorded" ? " recorded" : ""}`;
	return [
		head("Environment", `${report.how} ${said}`, look),
		...environmentRows(declared, harness).flatMap((r) => {
			const check = checks.find((c) => c.part === r.part);
			return check ? checkedLines(r, check, look) : [];
		}),
		"",
		count,
	];
}

/** The Environment section: declared only, with a dim pointer at `--probe`, or checked against `report`. */
function environmentLines(
	declared: AgentEnvironment | null,
	harness: string,
	look: Colored,
	report?: Report,
): string[] {
	if (declared === null)
		return [head("Environment", `not declared by ${harness}`, look)];
	if (report) return reportLines(declared, harness, report, look);
	return [
		head("Environment", "declared only", look),
		...environmentRows(declared, harness).map((r) => row(r.key, r.value, look)),
		paint("dim", `Add --probe to check it against ${harness}`, look.color),
	];
}

/** `s` as sections with bold headers and dim keys, each value at column 15, a section with nothing left out. */
async function showText(
	s: Inspection,
	window: number | undefined,
	look: Look,
	report?: Report,
	seated?: Seated,
): Promise<string> {
	const sections = [
		headLines(s, look, seated),
		runtimeLines(s, look),
		await instructionsLines(s, look),
		await attachmentLines(s, look),
		readOnlyLines(s, look),
		limitsLines(s, look),
		contextLines(s, window, look, report?.how === "probed"),
		environmentLines(s.environment.declared, s.runtime.harness, look, report),
	];
	return sections
		.filter((lines) => lines.length)
		.map((lines) => lines.join("\n"))
		.join("\n\n");
}

/** The fields of `s` as its `profile.yaml` would hold them, paths read as `readable`, empty fields left out. */
function profileValues(s: Inspection, places: Places): Record<string, unknown> {
	const { runtime, instructions, attachments, readOnly, limits, context } = s;
	const at = (path: string) => readable(path, s.dir, places);
	const entries = Object.entries(attachments);
	return {
		runtime,
		...(instructions !== undefined && { instructions: at(instructions) }),
		...(entries.length && {
			attachments: Object.fromEntries(
				entries.map(([key, a]) => [key, { path: at(a.path), hint: a.hint }]),
			),
		}),
		...(readOnly.length && { readOnly }),
		...(Object.keys(limits).length && { limits }),
		...(context !== undefined && { context }),
	};
}

/** The trailing comment of each value: its source's words, and for an attachment where the agent sees it. */
function commentsOf(s: Inspection): Map<string, string[]> {
	const comments = new Map<string, string[]>();
	const add = (key: string, text: string) =>
		comments.set(key, [...(comments.get(key) ?? []), text]);
	for (const key of Object.keys(s.sources)) {
		const words = wordsAt(s, key);
		if (words !== undefined) add(key, words);
	}
	for (const [key, a] of Object.entries(s.attachments))
		add(`attachments.${key}.path`, `agent sees ${a.agent}`);
	return comments;
}

const YAML_OPTIONS = { lineWidth: 0 };

/** `values` as a YAML document led by `comments`, one `#` line each. */
function yamlOf(values: unknown, comments: readonly string[]): Document {
	const doc = new Document(values);
	const lead = comments.map((line) => ` ${line}`).join("\n");
	if (doc.contents) doc.contents.commentBefore = lead;
	return doc;
}

/** `s` as one folded `profile.yaml`, each layer and agent path a trailing comment, then its environment. */
function showYaml(s: Inspection, places: Places): string {
	const profile = yamlOf(profileValues(s, places), [
		s.name,
		`from    ${placeOf(s.dir, s.name, places)}`,
		...s.shadows.map((dir) => `shadows ${placeOf(dir, s.name, places)}`),
	]);
	for (const [key, texts] of commentsOf(s)) {
		const node = profile.getIn(key.split("."), true);
		if (isScalar(node)) node.comment = ` ${texts.join("; ")}`;
	}
	const { declared } = s.environment;
	const environment =
		declared === null
			? `# environment not declared by ${s.runtime.harness}`
			: yamlOf(declared, ["environment, declared only"]).toString(YAML_OPTIONS);
	return `${profile.toString(YAML_OPTIONS)}---\n${environment}`.trimEnd();
}

const FAULT_SEPARATOR = "; ";

/** The row of profile `name`, which the roots of `setup` hold. */
async function listedOf(name: string, setup: Setup): Promise<Listed[]> {
	const found = await findProfile(name, setup.roots);
	if (!found) return [];
	const { roots } = setup;
	const base = {
		name,
		root: profileRoot(found.dir, roots),
		dir: found.dir,
		shadowsPack: found.shadows.some((d) => profileRoot(d, roots) === "pack"),
	};
	try {
		const { harness, model } = (await resolveProfile(name, setup)).fields
			.runtime;
		return [{ ...base, harness, model }];
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		const message = error.diagnostics
			.map((d) => d.message)
			.join(FAULT_SEPARATOR);
		return [{ ...base, error: message }];
	}
}

/**
 * The faults in a row's error, each without the `profile <name>: ` lead the row already shows: whether any is an unset
 * harness or model, and the rest.
 */
function faultsOf({ name, error }: Listed) {
	const lead = `profile ${name}: `;
	const unsetFaults = [
		unsetMessage(name, "harness"),
		unsetMessage(name, "model"),
	];
	const all = error?.split(FAULT_SEPARATOR) ?? [];
	return {
		unset: all.some((m) => unsetFaults.includes(m)),
		other: all
			.filter((m) => !unsetFaults.includes(m))
			.map((m) => (m.startsWith(lead) ? m.slice(lead.length) : m)),
	};
}

/** The roster as a table: name, harness, model, the winning root and a pack shadow, other faults under a broken row. */
function lsText(listed: readonly Listed[], color: boolean): string {
	const header = ["Profiles", "harness", "model", "from"].map((h) =>
		paint("bold", h, color),
	);
	const rows = listed.map((l) => [
		`${INDENT}${l.name}`,
		l.harness ?? "-",
		l.model ?? "-",
		l.root,
		l.shadowsPack ? paint("dim", "[shadows pack]", color) : "",
	]);
	const [top = "", ...lines] = table([header, ...rows]).split("\n");
	return [
		top,
		...lines.flatMap((line, i) => {
			const other = listed[i] ? faultsOf(listed[i]).other : [];
			return other.length
				? [
						line,
						`${INDENT}${INDENT}${paint("red", other.join(FAULT_SEPARATOR), color)}`,
					]
				: [line];
		}),
	].join("\n");
}

/** The footer counting profiles with no harness or model, or none when every profile has both. */
function unsetFooter(listed: readonly Listed[], color: boolean): string {
	const count = listed.filter((l) => faultsOf(l).unset).length;
	if (count === 0) return "";
	const what = `${count} ${count === 1 ? "profile has" : "profiles have"} no harness or model`;
	const fix =
		"Set them under profiles: in .maestro/config.yaml, or pass --preset";
	return `${what}\n${INDENT}${paint("dim", fix, color)}`;
}

async function ls(setup: Setup, deps: Deps, values: Values): Promise<number> {
	const held = await heldNames(setup.roots);
	const listed = (
		await Promise.all(held.map((n) => listedOf(n, setup)))
	).flat();
	if (isSet(values, "json")) deps.stdout(jsonOf({ profiles: listed }));
	else if (listed.length) {
		const color = colorOf(deps, values);
		deps.stdout(lsText(listed, color.out));
		const footer = unsetFooter(listed, color.err);
		if (footer) deps.stderr(footer);
	} else
		deps.stderr(
			"no profile in any profile root\nCreate .maestro/profiles/<name>/profile.yaml, or install a pack that ships one",
		);
	return EXIT.ok;
}

/** The repo host's setup, none when the host is not loaded. */
function repoSetupOf(session: Session) {
	const host = session.deps.hosts.find((h) => h.name === HOST_NAME);
	return host && setupOf(session, host);
}

/**
 * What the harness of `profile` reports when started as a concert would start it. The model's window it reports is
 * kept for pre-flight.
 * @throws CliError when the harness is not loaded, or its run fails or times out before it reports.
 */
async function probed(profile: Profile, session: Session): Promise<Report> {
	const { deps } = session;
	const { runtime } = profile.fields;
	const harnesses = builtinHarnesses(deps.env);
	const harness = harnesses.find((h) => h.name === runtime.harness);
	const setup = repoSetupOf(session);
	if (!harness || !setup)
		throw usageError(
			`harness '${runtime.harness}' is not loaded`,
			`Set 'profiles.${profile.name}.runtime.harness' to one of: ${harnesses.map((h) => h.name).join(", ")}`,
		);
	deps.stderr(`probing ${runtime.harness}…`);
	const scratch = await mkdtemp(join(tmpdir(), "maestro-probe-"));
	try {
		const req = probeRequest(profile, setup, scratch);
		const { observed, window } = await probe(harness, req);
		if (window !== undefined) keepWindow(setup.store, runtime, window);
		return { how: "probed", ...(observed && { observed }) };
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError(
			`probe of ${profile.name} failed: ${messageOf(error)}\nRun the profile once, or check ${runtime.harness}'s login`,
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** The checks of `report` against `declared`; none without both. */
const checksOf = (declared: AgentEnvironment | null, report?: Report) =>
	declared && report ? environmentChecks(declared, report.observed ?? {}) : [];

/** The `environment` of `--json`: the declaration, and with a report what was observed and each part's check. */
const environmentJson = (declared: AgentEnvironment | null, report?: Report) =>
	report
		? {
				declared,
				observed: report.observed ?? null,
				checks: checksOf(declared, report),
			}
		: { declared };

/** Each prompt alone when there is one, else each led by the nodes given it. */
function promptText(prompts: readonly Prompted[], color: boolean): string {
	const [only, ...more] = prompts;
	if (only && !more.length) return only.prompt;
	return prompts
		.map(
			(p) =>
				`${paint("bold", `nodes ${p.nodes.join(", ")}`, color)}\n\n${p.prompt}`,
		)
		.join("\n\n");
}

async function show(
	profile: Profile,
	probing: boolean,
	session: Session,
	values: Values,
	seated?: Seated,
): Promise<number> {
	const { deps, config } = session;
	const s = inspectProfile(profile, config.roots, DECLARED);
	const report = probing ? await probed(profile, session) : undefined;
	const store = repoSetupOf(session)?.store;
	const window =
		store === undefined ? undefined : windowOf(store, profile.fields.runtime);
	const { declared } = s.environment;
	const places = { roots: config.roots, home: deps.env.HOME };
	const { out: color } = colorOf(deps, values);
	if (isSet(values, "json"))
		deps.stdout(
			jsonOf({
				...s,
				window: window ?? null,
				...(seated && {
					seat: { key: seated.key, ...seated.binding },
					...(seated.prompts && { prompts: seated.prompts }),
				}),
				environment: environmentJson(declared, report),
			}),
		);
	else if (seated?.prompts) deps.stdout(promptText(seated.prompts, color));
	else if (isSet(values, "yaml")) deps.stdout(showYaml(s, places));
	else
		deps.stdout(
			await showText(s, window, { ...places, color }, report, seated),
		);
	return faultCount(checksOf(declared, report)) ? EXIT.failed : EXIT.ok;
}

/**
 * The agents of `ir` that sit in seat `key` of `target`.
 * @throws CliError, a usage error, when none does, with the nearest seat key it has.
 */
function seatAgents(
	agents: SeatedAgent[],
	{ key, target }: SeatRequest,
): [SeatedAgent, ...SeatedAgent[]] {
	const [first, ...rest] = agents.filter((a) => a.key === key);
	if (first) return [first, ...rest];
	const keys = [...new Set(agents.map((a) => a.key))];
	const near = closest(key, keys);
	throw usageError(
		`${target} seats no agent at '${key}'`,
		near === undefined
			? `Name one of: ${keys.join(", ") || "none"}`
			: `Did you mean '${near}'?`,
	);
}

/** Shows the profile seat `request.key` is bound to, or with `request.prompt` the system prompts of its agents. */
async function showSeat(
	request: SeatRequest & { probe: boolean },
	session: Session,
	values: Values,
): Promise<number> {
	const host = session.deps.hosts.find((h) => h.name === HOST_NAME);
	if (!host)
		throw new CliError(
			`seats belong to host '${HOST_NAME}', which is not loaded`,
		);
	const reading = { verb: "agent show", options: COMMON, examples: true };
	const prepared = await prepare(session, reading, [request.target]);
	const setup = hostSetup(host, prepared.config, session.config.roots);
	const agents = seatAgents(seatedAgents(prepared.ir, setup), request);
	const [{ binding }] = agents;
	const profile = await resolveProfile(binding.profile, setup);
	const prompts = request.prompt
		? [...Map.groupBy(agents, (a) => a.prompt(profile))].map(
				([prompt, group]) => ({ nodes: group.map((a) => a.node), prompt }),
			)
		: undefined;
	return show(profile, request.probe, session, values, {
		key: request.key,
		binding,
		...(prompts && { prompts }),
	});
}

/** The progress events concert `row` recorded for instance `name`, in order. */
const eventsOf = (store: Records, row: ConcertRecord, name: string) =>
	store
		.events(row.id)
		.flatMap((e) =>
			e.type === "progress" && instanceName(row.ir, e) === name
				? [e.event]
				: [],
		);

/** The runtime of the last agent start among `events` and the last environment reported; none without a start. */
function recordedReport(events: readonly Record<string, unknown>[]) {
	const ran = events.findLast((e) => e.kind === "agent");
	if (typeof ran?.harness !== "string") return undefined;
	const reported = events.findLast((e) => e.kind === "environment");
	const report: Report = {
		how: "recorded",
		...(reported && { observed: observedOf(reported) }),
	};
	const model = typeof ran.model === "string" ? ran.model : "-";
	return { harness: ran.harness, model, report };
}

/** The environment a node of a concert recorded, checked as `--probe` checks it; a fault never fails the command. */
async function recorded(
	{ concert, node }: { concert: string; node: string },
	session: Session,
	values: Values,
): Promise<number> {
	const { deps } = session;
	return withRecord(session, async (store) => {
		const record = concertOf(store, concert);
		const names = instancesInOrder(store, record).map((i) =>
			instanceName(record.ir, i),
		);
		const name = nameOf(node, names, record.id);
		const ran = recordedReport(eventsOf(store, record, name));
		if (!ran)
			throw new CliError(
				`instance '${name}' of concert ${record.id} ran no agent\nName an agent node, as 'maestro ls ${record.id}' lists it`,
			);
		const { harness, model, report } = ran;
		const declared = DECLARED.get(harness) ?? null;
		if (isSet(values, "json")) {
			deps.stdout(
				jsonOf({
					concert: record.id,
					instance: name,
					runtime: { harness, model },
					environment: environmentJson(declared, report),
				}),
			);
			return EXIT.ok;
		}
		const look = { color: colorOf(deps, values).out };
		const heading = [
			paint("bold", name, look.color),
			row("concert", record.id, look),
			row("harness", harness, look),
			row("model", model, look),
		];
		const env = environmentLines(declared, harness, look, report);
		deps.stdout([...heading, "", ...env].join("\n"));
		return EXIT.ok;
	});
}

export const agent: Command = {
	pages: (args) => splitFirst(AGENT_OPTIONS, args).first === "show",
	usage:
		"agent ls [flags]  (alias: ag)\n       maestro agent show <profile> [--probe] [flags]\n       maestro agent show --seat <composition id>/<seat> <composition> [--prompt] [flags]\n       maestro agent show --concert <id> <node> [flags]",
	arguments: [
		["<profile>", "A profile, as 'maestro agent ls' lists it"],
		[
			"<composition>",
			"With --seat, the composition the seat sits in: a file, or <pack>.<composition>",
		],
		[
			"<node>",
			"With --concert, a node of that concert, as 'maestro ls <concert>' lists it",
		],
	],
	options: AGENT_OPTIONS,
	async execute(args, deps) {
		const { values, positionals } = parse(AGENT_OPTIONS, args, FIX);
		const request = requestOf(values, positionals);
		const session = await openSession(deps, overridesOf(values));
		if (request.action === "recorded")
			return recorded(request, session, values);
		if (request.action === "seat") return showSeat(request, session, values);
		const { config } = session;
		const setup = { layers: config.layers, roots: config.roots };
		if (request.action === "show")
			return show(
				await resolveProfile(request.name, setup),
				request.probe,
				session,
				values,
			);
		return ls(setup, deps, values);
	},
};
