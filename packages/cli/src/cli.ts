import { messageOf } from "@maestro/ir";
import {
	COMMON,
	type Command,
	type Deps,
	helpOf,
	isSet,
	peek,
} from "./command";
import {
	CliError,
	diagnosticsOf,
	EXIT,
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
		alias: "w",
		summary: "Wait for a concert to settle",
		load: async () => (await import("./records")).wait,
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
		name: "prune",
		summary: "Delete settled concerts and what they hold",
		load: async () => (await import("./prune")).prune,
	},
	{
		name: "tour",
		alias: "t",
		summary: "Put concerts on a tour, or take them off",
		load: async () => (await import("./records")).tour,
	},
];

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
		"See 'maestro <command> --help' for a command's flags.",
	].join("\n");

const describe = (error: unknown, debug: boolean) =>
	debug && error instanceof Error && error.stack
		? error.stack
		: messageOf(error);

/** Prints what stopped a command, on stderr, or as one document on stdout under `--json`, and gives its exit code. */
function report(error: unknown, deps: Deps, args: readonly string[]): number {
	const early = peek(COMMON, args);
	const json = isSet(early, "json");
	const diagnostics = diagnosticsOf(error);
	if (diagnostics) {
		if (json) deps.stdout(jsonOf({ ok: false, diagnostics }));
		else for (const d of diagnostics) deps.stderr(renderDiagnostic(d));
		return EXIT.usage;
	}
	const exit = error instanceof CliError ? error.exit : EXIT.failed;
	const message = describe(error, isSet(early, "debug"));
	if (json) deps.stdout(jsonOf({ ok: false, error: message, exit }));
	else deps.stderr(message);
	return exit;
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
		if (word === undefined) throw usageError("no command given", rootHelp());
		const command = await verbOf(word).load();
		if (isSet(peek(COMMON, args), "help")) {
			deps.stdout(helpOf(command));
			return EXIT.ok;
		}
		return await command.execute(args, deps);
	} catch (error) {
		return report(error, deps, args);
	}
}
