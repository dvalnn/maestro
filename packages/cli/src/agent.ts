import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { closest } from "@maestro/core";
import { ConfigError } from "@maestro/core/config";
import { type HostSetup, hostSetup, type Roots } from "@maestro/core/host";
import {
	findProfile,
	HOST_NAME,
	heldNames,
	type Inspection,
	inspectProfile,
	isSettled,
	keepWindow,
	type Profile,
	type ProfileRoot,
	probe,
	probeRequest,
	profileRoot,
	readablePath,
	resolveProfile,
	resolveUnsettled,
	SandboxUnavailable,
	type SeatedAgent,
	seatedAgents,
	sourceWords,
	type Unsettled,
	unsetMessage,
	unsetOf,
	windowOf,
} from "@maestro/host-repo";
import {
	type AgentEnvironment,
	type EnvironmentCheck,
	environmentChecks,
	type ObservedEnvironment,
} from "@maestro/host-repo/harness";
import { messageOf } from "@maestro/ir";
import { padCells } from "@maestro/render-text/live";
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
	type Values,
} from "./command";
import { builtinHarnesses, DECLARED } from "./hosts";
import {
	CliError,
	EXIT,
	jsonOf,
	paint,
	table,
	tildeOf,
	usageError,
} from "./output";
import { prepare } from "./prepare";
import { openSession, overridesOf, type Session, setupOf } from "./session";

const AGENT_OPTIONS: Options = COMMON;

const FIX =
	"Run 'maestro agent ls', 'maestro agent show <profile>', or 'maestro agent probe <profile>'";
const NAME_PROFILE = "Name one as 'maestro agent ls' lists it";
const NAME_AGENT_NODE =
	"Name an agent node, as 'maestro compose <composition>' lists them";
const NAME_COMPOSITION = "Name it by file path or <pack>.<composition>";
const MARK_STYLE = { "✓": "green", "✗": "red", "?": "dim" } as const;

const INDENT = "  ";
/** A row's key column, so its value starts at column 15 under a section header of the same width. */
const KEY_WIDTH = 12;
const HEAD_WIDTH = INDENT.length + KEY_WIDTH;
const KEY_GAP = "  ";
/** The width a fault's lines wrap at. */
const LINE_WIDTH = 80;

type Request =
	| { action: "ls" }
	| { action: "show"; name: string }
	| { action: "probe"; name: string }
	| { action: "prompt"; target: string; node: string };

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

function lsRequest(rest: readonly string[]): Request {
	if (rest.length > 0)
		throw usageError(
			`agent ls takes no profile, got ${rest.length}`,
			"Run 'maestro agent show <profile>' for one profile",
		);
	return { action: "ls" };
}

function showRequest(rest: readonly string[]): Request {
	return {
		action: "show",
		name: only(rest, "profile", NAME_PROFILE, "show"),
	};
}

function probeRequestOf(rest: readonly string[]): Request {
	return {
		action: "probe",
		name: only(rest, "profile", NAME_PROFILE, "probe"),
	};
}

function promptRequest(rest: readonly string[]): Request {
	const [target, node, ...more] = rest;
	if (target === undefined)
		throw usageError(
			"maestro agent prompt needs a composition",
			NAME_COMPOSITION,
		);
	if (node === undefined)
		throw usageError("maestro agent prompt needs a node", NAME_AGENT_NODE);
	if (more.length)
		throw usageError(
			`agent prompt takes a composition and a node, got ${rest.length} arguments`,
			NAME_AGENT_NODE,
		);
	return { action: "prompt", target, node };
}

/** The request `positionals` makes. @throws CliError, a usage error, for anything else. */
function requestOf(positionals: readonly string[]): Request {
	const [action, ...rest] = positionals;
	if (action === "ls") return lsRequest(rest);
	if (action === "show") return showRequest(rest);
	if (action === "probe") return probeRequestOf(rest);
	if (action === "prompt") return promptRequest(rest);
	throw usageError(
		`expected ls, show, probe or prompt, got ${action === undefined ? "nothing" : `'${action}'`}`,
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
const sourced = (value: string, words: string | undefined, look: Colored) =>
	words === undefined
		? value
		: `${value}  ${paint("dim", `[${words}]`, look.color)}`;

function headLines(s: Inspection, look: Look): string[] {
	return [
		paint("bold", s.name, look.color),
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
		if (value === undefined)
			return key === "thinking" ? [] : [row(key, "-", look)];
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
 * The context policy's rows, then the model's window in tokens where one is known, with what it is kept for after a
 * probe, or `? not reported` after one that kept none.
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
	if (window !== undefined) {
		const { harness, model } = s.runtime;
		const kept = probed ? `  kept for ${harness} ${model}` : "";
		rows.push(row("window", `${window}${kept}`, look));
	} else if (probed)
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

/** What a harness reported it loaded when probed; `observed` absent when it reported nothing. */
type Report = { how: "probed"; observed?: ObservedEnvironment };

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
	const count = `${faults} ${faults === 1 ? "fault" : "faults"}`;
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

/** The Environment section: declared only, with a dim pointer at `probe`, or checked against `report`. */
function environmentLines(
	declared: AgentEnvironment | null,
	harness: string,
	look: Colored,
	report?: Report,
	probeCommand?: string,
): string[] {
	if (declared === null)
		return [head("Environment", `not declared by ${harness}`, look)];
	if (report) return reportLines(declared, harness, report, look);
	return [
		head("Environment", "declared only", look),
		...environmentRows(declared, harness).map((r) => row(r.key, r.value, look)),
		paint(
			"dim",
			`Run ${probeCommand} to check it against ${harness}`,
			look.color,
		),
	];
}

/** `s` as sections with bold headers and dim keys, each value at column 15, a section with nothing left out. */
async function showText(
	s: Inspection,
	window: number | undefined,
	look: Look,
	report?: Report,
	probeCommand?: string,
): Promise<string> {
	const sections = [
		headLines(s, look),
		runtimeLines(s, look),
		await instructionsLines(s, look),
		await attachmentLines(s, look),
		readOnlyLines(s, look),
		limitsLines(s, look),
		contextLines(s, window, look, report?.how === "probed"),
		s.runtime.harness === undefined
			? [head("Environment", "no harness to declare one", look)]
			: environmentLines(
					s.environment.declared,
					s.runtime.harness,
					look,
					report,
					probeCommand,
				),
	];
	return sections
		.filter((lines) => lines.length)
		.map((lines) => lines.join("\n"))
		.join("\n\n");
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

/** The faults in a row's error but an unset harness or model, each without the `profile <name>: ` lead the row shows. */
function otherFaults({ name, error }: Listed): string[] {
	const lead = `profile ${name}: `;
	const unsetFaults = [
		unsetMessage(name, "harness"),
		unsetMessage(name, "model"),
		unsetMessage(name, "harness or model"),
	];
	return (error?.split(FAULT_SEPARATOR) ?? [])
		.filter((m) => !unsetFaults.includes(m))
		.map((m) => (m.startsWith(lead) ? m.slice(lead.length) : m));
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
			const other = listed[i] ? otherFaults(listed[i]) : [];
			return other.length
				? [
						line,
						`${INDENT}${INDENT}${paint("red", other.join(FAULT_SEPARATOR), color)}`,
					]
				: [line];
		}),
	].join("\n");
}

async function ls(setup: Setup, deps: Deps, values: Values): Promise<number> {
	const held = await heldNames(setup.roots);
	const listed = (
		await Promise.all(held.map((n) => listedOf(n, setup)))
	).flat();
	if (isSet(values, "json")) deps.stdout(jsonOf({ profiles: listed }));
	else if (listed.length) {
		deps.stdout(lsText(listed, colorOf(deps, values).out));
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
		if (error instanceof SandboxUnavailable)
			throw new CliError(`probe of ${profile.name} failed: ${error.message}`);
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

/** `fields` as words, such as `harness and model`. */
const fieldWords = (fields: readonly string[]) => fields.join(" and ");

/** Where to set `fields` of profile `name`, or pass them. */
const unsetFix = (name: string, fields: readonly string[]) =>
	`Pass --preset, or set profiles.${name}.runtime${fields.length === 1 ? `.${fields[0]}` : ""} in .maestro/config.yaml`;

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
const quoted = (text: string) =>
	SHELL_SAFE.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

/** The `maestro agent probe` command for profile `name`, with the `--preset` and `-c` flags `values` gives. */
function probeCommand(name: string, values: Values): string {
	const { presets, config } = overridesOf(values);
	return [
		"maestro agent probe",
		name,
		...(presets ?? []).map((p) => `--preset ${quoted(p)}`),
		...(config ?? []).map((c) => `-c ${quoted(c)}`),
	].join(" ");
}

/** Prints `profile` as `agent show` does, `report` checked when it has one; exits 1 for a fault in it. */
async function show(
	profile: Unsettled,
	report: Report | undefined,
	session: Session,
	values: Values,
): Promise<number> {
	const { deps, config } = session;
	const s = inspectProfile(profile, config.roots, DECLARED);
	const store = repoSetupOf(session)?.store;
	const { harness, model } = profile.fields.runtime;
	const window =
		store === undefined || harness === undefined || model === undefined
			? undefined
			: windowOf(store, { harness, model });
	const { declared } = s.environment;
	const places = { roots: config.roots, home: deps.env.HOME };
	const { out: color, err: errColor } = colorOf(deps, values);
	if (isSet(values, "json"))
		deps.stdout(
			jsonOf({
				...s,
				window: window ?? null,
				environment: environmentJson(declared, report),
			}),
		);
	else
		deps.stdout(
			await showText(
				s,
				window,
				{ ...places, color },
				report,
				probeCommand(profile.name, values),
			),
		);
	const unset = unsetOf(profile);
	if (unset.length)
		deps.stderr(
			`${fieldWords(unset)} unset\n${INDENT}${paint("dim", unsetFix(profile.name, unset), errColor)}`,
		);
	return faultCount(checksOf(declared, report)) ? EXIT.failed : EXIT.ok;
}

/**
 * Probes profile `name` and prints what its harness reported, as `agent show` does.
 * @throws CliError, a usage error, when the profile leaves its harness or model unset.
 */
async function probeProfile(
	name: string,
	setup: Setup,
	session: Session,
	values: Values,
): Promise<number> {
	const profile = await resolveUnsettled(name, setup);
	if (!isSettled(profile))
		throw usageError(
			`profile ${name} leaves ${fieldWords(unsetOf(profile))} unset, so there is nothing to probe`,
			unsetFix(name, unsetOf(profile)),
		);
	return show(profile, await probed(profile, session), session, values);
}

/**
 * The agent of `agents` at node `node` of `target`.
 * @throws CliError, a usage error, when none is, with the nearest agent node it has.
 */
function agentAt(agents: SeatedAgent[], node: string, target: string) {
	const found = agents.find((a) => a.node === node);
	if (found) return found;
	const nodes = agents.map((a) => a.node);
	const near = closest(node, nodes);
	throw usageError(
		`${target} has no agent node '${node}'`,
		near === undefined
			? `Name one of: ${nodes.join(", ") || "none"}`
			: `Did you mean '${near}'?`,
	);
}

/** Prints the system prompt of agent node `request.node`, and on stderr the seat and profile it is bound to. */
async function promptOf(
	request: { target: string; node: string },
	session: Session,
	values: Values,
): Promise<number> {
	const { deps } = session;
	const host = deps.hosts.find((h) => h.name === HOST_NAME);
	if (!host)
		throw new CliError(
			`agent nodes belong to host '${HOST_NAME}', which is not loaded`,
		);
	const reading = { verb: "agent prompt", options: COMMON, examples: true };
	const prepared = await prepare(session, reading, [request.target]);
	const setup = hostSetup(host, prepared.config, session.config.roots);
	const { node, key, binding, prompt } = agentAt(
		seatedAgents(prepared.ir, setup),
		request.node,
		request.target,
	);
	const text = prompt(await resolveUnsettled(binding.profile, setup));
	if (isSet(values, "json")) {
		deps.stdout(jsonOf({ node, seat: { key, ...binding }, prompt: text }));
		return EXIT.ok;
	}
	const words = binding.source && sourceWords(binding.source);
	const color = colorOf(deps, values).err;
	deps.stderr(
		`${paint("bold", node, color)} · seat ${key} · ${binding.profile}${words === undefined ? "" : ` ${paint("dim", `[${words}]`, color)}`}`,
	);
	deps.stdout(text);
	return EXIT.ok;
}

export const agent: Command = {
	pages: (args) => splitFirst(AGENT_OPTIONS, args).first === "show",
	usage:
		"agent ls [flags]  (alias: ag)\n       maestro agent show <profile> [flags]\n       maestro agent probe <profile> [flags]\n       maestro agent prompt <composition> <node> [flags]",
	arguments: [
		["<profile>", "A profile, as 'maestro agent ls' lists it"],
		[
			"<composition>",
			"With prompt, the composition the node sits in: a file, or <pack>.<composition>",
		],
		["<node>", "With prompt, an agent node, as 'maestro compose' lists it"],
	],
	options: AGENT_OPTIONS,
	async execute(args, deps) {
		const { values, positionals } = parse(AGENT_OPTIONS, args, FIX);
		const request = requestOf(positionals);
		const session = await openSession(deps, overridesOf(values));
		if (request.action === "prompt") return promptOf(request, session, values);
		const { config } = session;
		const setup = { layers: config.layers, roots: config.roots };
		if (request.action === "probe")
			return probeProfile(request.name, setup, session, values);
		if (request.action === "show")
			return show(
				await resolveUnsettled(request.name, setup),
				undefined,
				session,
				values,
			);
		return ls(setup, deps, values);
	},
};
