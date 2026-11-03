import { closest } from "@maestro/core";
import { type Diagnostic, IR_VERSION, messageOf } from "@maestro/ir";
import { SDK_VERSION } from "@maestro/sdk/loader";
import pkg from "../package.json";
import {
	COMMON,
	type Command,
	colorOf,
	type Deps,
	helpOf,
	isSet,
	type Options,
	parse,
	peek,
	sharedFlags,
	splitFirst,
} from "./command";
import {
	ArgumentError,
	CliError,
	diagnosedExit,
	diagnosticsOf,
	EXIT,
	hinted,
	jsonOf,
	paint,
	renderDiagnostic,
	table,
	usageError,
} from "./output";

/** A verb is loaded when it is named, so a command pays only for the code it uses. */
type Verb = {
	name: string;
	alias?: string;
	summary: string;
	load(): Promise<Command>;
};

const VERBS: readonly Verb[] = [
	{
		name: "compose",
		alias: "c",
		summary: "Build a composition and check it, without performing it",
		load: async () => (await import("./compose")).compose,
	},
	{
		name: "perform",
		alias: "p",
		summary: "Perform a composition as a concert",
		load: async () => (await import("./perform")).perform,
	},
	{
		name: "resume",
		alias: "r",
		summary: "Resume a failed or rejected concert",
		load: async () => (await import("./perform")).resume,
	},
	{
		name: "encore",
		alias: "e",
		summary: "Perform a concert's composition again as a new concert",
		load: async () => (await import("./perform")).encore,
	},
	{
		name: "ls",
		summary: "List concerts, or the node instances of one",
		load: async () => (await import("./records")).ls,
	},
	{
		name: "wait",
		alias: "wt",
		summary: "Wait for a concert to settle",
		load: async () => (await import("./records")).wait,
	},
	{
		name: "watch",
		alias: "w",
		summary: "Show a concert's node instances live until it settles",
		load: async () => (await import("./watch")).watch,
	},
	{
		name: "kill",
		alias: "k",
		summary: "Stop a running concert",
		load: async () => (await import("./records")).kill,
	},
	{
		name: "config",
		alias: "cfg",
		summary: "Show a composition's config and where each value came from",
		load: async () => (await import("./compose")).config,
	},
	{
		name: "agent",
		alias: "ag",
		summary: "List agent profiles, or show one's environment",
		load: async () => (await import("./agent")).agent,
	},
	{
		name: "repertoire",
		alias: "rep",
		summary: "List installed packs and their compositions",
		load: async () => (await import("./repertoire")).repertoire,
	},
	{
		name: "prune",
		summary: "Delete settled concerts and what they hold",
		load: async () => (await import("./prune")).prune,
	},
	{
		name: "changeset",
		alias: "cs",
		summary: "Show a concert's changeset, or apply it to a checkout or drop it",
		load: async () => (await import("./changeset")).changeset,
	},
	{
		name: "artifact",
		alias: "art",
		summary: "List a concert's artifacts, or show an instance's files",
		load: async () => (await import("./artifact")).artifact,
	},
	{
		name: "tour",
		alias: "t",
		summary: "Put concerts on a tour, or take them off",
		load: async () => (await import("./records")).tour,
	},
];

const versionLine = () =>
	`maestro ${pkg.version} (sdk ${SDK_VERSION}, ir ${IR_VERSION}, bun ${Bun.version})`;

const EXIT_MEANINGS: Readonly<Record<keyof typeof EXIT, string>> = {
	ok: "Done, or the concert settled ok",
	failed:
		"The concert settled failed, a composition or config does not build, or the command could not do what it said",
	usage: "Usage error: bad arguments",
	rejected: "The concert settled rejected, or cs apply left conflicts",
	timeout: "wait --timeout passed, the concert still running",
	interrupted: "Stopped by Ctrl-C",
	terminated: "Stopped by SIGTERM",
};

const ENVIRONMENT: readonly (readonly [string, string])[] = [
	["NO_COLOR", "Turn color off, when not empty"],
	["FORCE_COLOR", "Color output even when not a terminal, when not empty"],
	["TERM", "dumb turns color off"],
	["MAESTRO_TOUR", "The tour a new concert joins when --tour is not given"],
	[
		"XDG_CONFIG_HOME",
		"Where maestro/ holds the user config, presets and .env (default ~/.config)",
	],
	[
		"XDG_DATA_HOME",
		"Where maestro/ holds concerts and installed packs (default ~/.local/share)",
	],
];

const rootHelp = (color: boolean) => {
	const heading = (text: string) => paint("bold", text, color);
	return [
		`${heading("Usage:")} maestro <command> [flags]`,
		"",
		heading("Commands:"),
		table(
			VERBS.map((v) => [
				`  ${v.name}`,
				v.alias ? `(${v.alias})` : "",
				v.summary,
			]),
		),
		"",
		heading("Flags:"),
		`  ${paint("cyan", "--version", color)}  Print the maestro, SDK, IR and Bun versions`,
		`  ${paint("cyan", "--help", color)}     Show this help`,
		"",
		heading("Common flags (every command):"),
		sharedFlags(color),
		"",
		heading("Exit codes:"),
		table(
			Object.entries(EXIT).map(([name, code]) => [
				`  ${code}`,
				EXIT_MEANINGS[name as keyof typeof EXIT],
			]),
		),
		"",
		heading("Environment:"),
		table(ENVIRONMENT.map(([name, what]) => [`  ${name}`, what])),
		"",
		"See 'maestro <command> --help', or 'maestro help <command>', for a command's flags.",
	].join("\n");
};

/** The command a message is about: its name, as `maestro <name>`, its usage, and whether its help has examples. */
type At = { name: string; usage: string; examples: boolean };

/** `error` as it reads after `maestro <command>`, the hint pointing to the command's examples when it has any. */
function argumentText(error: ArgumentError, at: At): string {
	const [what, fix] = error.message.split("\n");
	const see = at.examples
		? `, or see 'maestro ${at.name} --help' for examples`
		: "";
	return `maestro ${at.name} ${what}\n${fix}${see}`;
}

/** The usage lines of `at` as typed, without the flags and alias. */
const usageLine = (at: At) =>
	`Usage: maestro ${at.usage.replace(/ +\[flags\]| +\(alias: \w+\)/g, "")}`;

/** The message of `error`, plain: its stack under `debug`, else what it says. */
function plain(error: unknown, debug: boolean, at?: At): string {
	if (debug && error instanceof Error && error.stack) return error.stack;
	return error instanceof ArgumentError && at
		? argumentText(error, at)
		: messageOf(error);
}

/** `message` of an error nobody anticipated, on one line, with the hint to report it. */
const unexpected = (message: string) =>
	`unexpected: ${message.replace(/\s*\n\s*/g, " ")}\nThis is a bug in maestro. Rerun with --debug and report it upstream with the output`;

/** The text of `error` for the terminal: a CliError leads with `error:` and its hint is dim, an argument error adds the usage. */
const describe = (error: unknown, debug: boolean, color: boolean, at?: At) => {
	const message = plain(error, debug, at);
	if (debug) return message;
	if (!(error instanceof CliError)) return hinted(unexpected(message), color);
	return hinted(
		message,
		color,
		error instanceof ArgumentError && at ? usageLine(at) : undefined,
	);
};

/** Prints `diagnostics` on stderr, or as one document on stdout under `--json`. */
function printDiagnostics(
	diagnostics: readonly Diagnostic[],
	deps: Deps,
	json: boolean,
	color: boolean,
) {
	if (json) deps.stdout(jsonOf({ ok: false, diagnostics }));
	else for (const d of diagnostics) deps.stderr(renderDiagnostic(d, color));
}

/**
 * Prints what stopped a command, on stderr, or as one document on stdout under `--json` when `options`, the command's,
 * take it, and gives its exit code. `at` is the command, once it is known.
 */
function report(
	error: unknown,
	deps: Deps,
	args: readonly string[],
	options: Options,
	at?: At,
): number {
	const early = peek(options, args);
	const json = Object.hasOwn(options, "json") && isSet(early, "json");
	const { err: color } = colorOf(deps, early);
	const diagnostics = diagnosticsOf(error);
	if (diagnostics) {
		printDiagnostics(diagnostics, deps, json, color);
		return diagnosedExit(diagnostics);
	}
	const exit = error instanceof CliError ? error.exit : EXIT.failed;
	const debug = isSet(early, "debug");
	if (json)
		deps.stdout(jsonOf({ ok: false, error: plain(error, debug, at), exit }));
	else deps.stderr(describe(error, debug, color, at));
	return exit;
}

/** What `command` adds to its help for `args`; when that fails, why on stderr, and nothing added. */
async function extraHelp(
	command: Command,
	args: readonly string[],
	deps: Deps,
): Promise<string | undefined> {
	try {
		return await command.help?.(args, deps);
	} catch (error) {
		const [why] = messageOf(error).split("\n", 1);
		deps.stderr(`params not shown: ${why}`);
		return undefined;
	}
}

/** The verb `word` names, by its name or its alias. */
function verbOf(word: string): Verb {
	const verb = VERBS.find((v) => v.name === word || v.alias === word);
	if (verb) return verb;
	const near = closest(
		word,
		VERBS.flatMap((v) => (v.alias ? [v.name, v.alias] : [v.name])),
	);
	const nearest =
		near && VERBS.find((v) => v.name === near || v.alias === near);
	throw usageError(
		`unknown command '${word}'`,
		nearest
			? `Did you mean '${nearest.name}'?`
			: "Pick one of the commands in 'maestro --help'",
	);
}

/**
 * What `maestro` with no command word does: prints the version or the help it asks for, else refuses.
 * @throws CliError, a usage error, for a flag the common ones lack, or when it asks for neither.
 */
function bare(argv: readonly string[], deps: Deps): number {
	const common = peek(COMMON, argv);
	if (argv.includes("--version")) deps.stdout(versionLine());
	else if (isSet(common, "help"))
		deps.stdout(rootHelp(colorOf(deps, common).out));
	else {
		parse(COMMON, argv, "Flags are listed in 'maestro --help'");
		throw usageError(
			"no command given",
			argv.length === 0
				? rootHelp(false)
				: "See 'maestro --help' for the commands",
		);
	}
	return EXIT.ok;
}

/** The arguments that ask for the help of what `maestro help` was given: a command, or none for the root's. */
function helpArgs(args: readonly string[]): string[] {
	const { first, rest } = splitFirst(COMMON, args);
	return first === undefined ? ["--help", ...rest] : [first, ...rest, "--help"];
}

/**
 * Reads `argv`, the arguments after the executable, and carries out the command it names. The common flags may come
 * before the command.
 * @returns the exit code.
 */
export async function main(
	argv: readonly string[],
	deps: Deps,
): Promise<number> {
	const { first: word, lead, rest } = splitFirst(COMMON, argv);
	const args = [...rest.slice(lead.length), ...lead];
	let options = COMMON;
	let at: At | undefined;
	try {
		if (word === undefined) return bare(argv, deps);
		if (word === "help") return await main(helpArgs(args), deps);
		const verb = verbOf(word);
		const command = await verb.load();
		options = command.options;
		at = {
			name: verb.name,
			usage: command.usage,
			examples: command.examples !== undefined,
		};
		const common = peek(COMMON, argv);
		if (isSet(common, "help")) {
			const { out } = colorOf(deps, common);
			const extra = await extraHelp(command, args, deps);
			deps.stdout(helpOf(command, verb.summary, extra, out));
			return EXIT.ok;
		}
		return await command.execute(args, deps);
	} catch (error) {
		return report(error, deps, args, options, at);
	}
}
