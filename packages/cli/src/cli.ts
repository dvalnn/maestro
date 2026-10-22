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
	peek,
} from "./command";
import {
	CliError,
	diagnosticsOf,
	EXIT,
	hinted,
	jsonOf,
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
		summary: "Perform a composition as a concert, or resume one",
		load: async () => (await import("./perform")).perform,
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
		summary: "List a concert's artifacts, or print an instance's files",
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

const rootHelp = () =>
	[
		"Usage: maestro <command> [flags]",
		"",
		"Commands:",
		table(
			VERBS.map((v) => [
				`  ${v.name}`,
				v.alias ? `(${v.alias})` : "",
				v.summary,
			]),
		),
		"",
		"Flags:",
		"  --version  Print the maestro, SDK, IR and Bun versions",
		"  --help     Show this help",
		"",
		"See 'maestro <command> --help' for a command's flags.",
	].join("\n");

/** The text of `error`: its stack under `debug`, else its message, with the hint of a CliError dim when `color`. */
const describe = (error: unknown, debug: boolean, color: boolean) => {
	if (debug && error instanceof Error && error.stack) return error.stack;
	const message = messageOf(error);
	return error instanceof CliError ? hinted(message, color) : message;
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

/** Prints what stopped a command, on stderr, or as one document on stdout under `--json`, and gives its exit code. */
function report(error: unknown, deps: Deps, args: readonly string[]): number {
	const early = peek(COMMON, args);
	const json = isSet(early, "json");
	const { err: color } = colorOf(deps, early);
	const diagnostics = diagnosticsOf(error);
	if (diagnostics) {
		printDiagnostics(diagnostics, deps, json, color);
		return EXIT.usage;
	}
	const exit = error instanceof CliError ? error.exit : EXIT.failed;
	const message = describe(error, isSet(early, "debug"), color && !json);
	if (json) deps.stdout(jsonOf({ ok: false, error: message, exit }));
	else deps.stderr(message);
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
	if (!verb)
		throw usageError(
			`unknown command '${word}'`,
			"Pick one of the commands in 'maestro --help'",
		);
	return verb;
}

/**
 * Reads `argv`, the arguments after the executable, and carries out the command it names.
 * @returns the exit code.
 */
export async function main(
	argv: readonly string[],
	deps: Deps,
): Promise<number> {
	const [word, ...args] = argv;
	try {
		if (word === "--help" || word === "-h") {
			deps.stdout(rootHelp());
			return EXIT.ok;
		}
		if (word === "--version") {
			deps.stdout(versionLine());
			return EXIT.ok;
		}
		if (word === undefined) throw usageError("no command given", rootHelp());
		const command = await verbOf(word).load();
		if (isSet(peek(COMMON, args), "help")) {
			deps.stdout(helpOf(command, await extraHelp(command, args, deps)));
			return EXIT.ok;
		}
		return await command.execute(args, deps);
	} catch (error) {
		return report(error, deps, args);
	}
}
