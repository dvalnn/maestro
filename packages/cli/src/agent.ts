import { readFile, stat } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { ConfigError } from "@maestro/core/config";
import type { HostSetup, Roots } from "@maestro/core/host";
import {
	findProfile,
	heldNames,
	type Inspection,
	inspectProfile,
	type ProfileRoot,
	profileRoot,
	readablePath,
	resolveProfile,
	sourceWords,
} from "@maestro/host-repo";
import type { AgentEnvironment } from "@maestro/host-repo/harness";
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
	type Values,
} from "./command";
import { DECLARED } from "./hosts";
import { EXIT, jsonOf, paint, table, tildeOf, usageError } from "./output";
import { openSession, overridesOf } from "./session";

const AGENT_OPTIONS: Options = {
	...COMMON,
	yaml: {
		type: "boolean",
		desc: "show: print the profile as one folded profile.yaml",
	},
};

const FIX = "Run 'maestro agent ls', or 'maestro agent show <profile>'";
const NAME_PROFILE = "Name a profile, as 'maestro agent ls' lists it";

const INDENT = "  ";
/** A row's key column, so its value starts at column 15 under a section header of the same width. */
const KEY_WIDTH = 12;
const HEAD_WIDTH = INDENT.length + KEY_WIDTH;
const KEY_GAP = "  ";

type Request = { action: "ls" } | { action: "show"; name: string };

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

type Look = Places & { color: boolean };

type Setup = Pick<HostSetup, "layers" | "roots">;

function lsRequest(rest: readonly string[], values: Values): Request {
	if (rest.length > 0)
		throw usageError(
			`agent ls takes no profile, got ${rest.length}`,
			"Run 'maestro agent show <profile>' for one profile",
		);
	if (isSet(values, "yaml"))
		throw usageError("agent ls takes no --yaml", "Drop --yaml");
	return { action: "ls" };
}

function showRequest(rest: readonly string[], values: Values): Request {
	const name = only(rest, "profile", NAME_PROFILE);
	if (isSet(values, "yaml") && isSet(values, "json"))
		throw usageError("--yaml and --json both given", "Pass one of them");
	return { action: "show", name };
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

const head = (title: string, value: string, look: Look) =>
	`${paint("bold", title.padEnd(HEAD_WIDTH), look.color)}${value}`;

const row = (key: string, value: string, look: Look) =>
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

const names = (list: readonly string[]) =>
	list.length ? list.join(" ") : "none";

/** The rows of `declared`, the environment harness `harness` launches with. */
function environmentRows(
	declared: AgentEnvironment,
	harness: string,
): [string, string][] {
	const { less } = declared.tools;
	return [
		[
			"tools",
			`${harness}'s defaults${less.length ? `, less ${names(less)}` : ""}`,
		],
		["subagents", declared.subagents ? "on" : "off"],
		["skills", names(declared.skills)],
		["mcp", names(declared.mcp)],
		["hooks", names(declared.hooks)],
		["files", names(declared.contextFiles)],
		["compaction", `${harness}'s own`],
	];
}

function environmentLines(s: Inspection, look: Look): string[] {
	const { declared } = s.environment;
	const { harness } = s.runtime;
	if (declared === null)
		return [head("Environment", `not declared by ${harness}`, look)];
	return [
		head("Environment", "declared only", look),
		...environmentRows(declared, harness).map(([k, v]) => row(k, v, look)),
	];
}

/** `s` as sections with bold headers and dim keys, each value at column 15, a section with nothing left out. */
async function showText(s: Inspection, look: Look): Promise<string> {
	const sections = [
		headLines(s, look),
		runtimeLines(s, look),
		await instructionsLines(s, look),
		await attachmentLines(s, look),
		readOnlyLines(s, look),
		limitsLines(s, look),
		environmentLines(s, look),
	];
	return sections
		.filter((lines) => lines.length)
		.map((lines) => lines.join("\n"))
		.join("\n\n");
}

/** The fields of `s` as its `profile.yaml` would hold them, paths read as `readable`, empty fields left out. */
function profileValues(s: Inspection, places: Places): Record<string, unknown> {
	const { runtime, instructions, attachments, readOnly, limits } = s;
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
		const message = error.diagnostics.map((d) => d.message).join("; ");
		return [{ ...base, error: message }];
	}
}

/** The roster as a table: name, harness, model, the winning root and a pack shadow, a broken one's error under it. */
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
			const error = listed[i]?.error;
			return error === undefined
				? [line]
				: [line, `${INDENT}${INDENT}${paint("red", error, color)}`];
		}),
	].join("\n");
}

async function ls(setup: Setup, deps: Deps, values: Values): Promise<number> {
	const held = await heldNames(setup.roots);
	const listed = (
		await Promise.all(held.map((n) => listedOf(n, setup)))
	).flat();
	if (isSet(values, "json")) deps.stdout(jsonOf({ profiles: listed }));
	else if (listed.length)
		deps.stdout(lsText(listed, colorOf(deps, values).out));
	else
		deps.stderr(
			"no profile in any profile root\nCreate .maestro/profiles/<name>/profile.yaml, or install a pack that ships one",
		);
	return EXIT.ok;
}

async function show(
	name: string,
	setup: Setup,
	deps: Deps,
	values: Values,
): Promise<number> {
	const s = inspectProfile(
		await resolveProfile(name, setup),
		setup.roots,
		DECLARED,
	);
	const places = { roots: setup.roots, home: deps.env.HOME };
	if (isSet(values, "json")) deps.stdout(jsonOf(s));
	else if (isSet(values, "yaml")) deps.stdout(showYaml(s, places));
	else
		deps.stdout(
			await showText(s, { ...places, color: colorOf(deps, values).out }),
		);
	return EXIT.ok;
}

export const agent: Command = {
	usage: "agent ls [flags]\n       maestro agent show <profile> [flags]",
	options: AGENT_OPTIONS,
	async execute(args, deps) {
		const { values, positionals } = parse(AGENT_OPTIONS, args, FIX);
		const request = requestOf(values, positionals);
		const { config } = await openSession(deps, overridesOf(values));
		const setup = { layers: config.layers, roots: config.roots };
		return request.action === "ls"
			? ls(setup, deps, values)
			: show(request.name, setup, deps, values);
	},
};
