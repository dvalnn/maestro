import { parseArgs } from "node:util";
import { closest } from "@maestro/core";
import type { Host } from "@maestro/core/host";
import { messageOf } from "@maestro/ir";
import type { Environment } from "./config";
import { table, usageError } from "./output";

/** What a command reads and writes outside itself: the hosts, the working directory, the environment and its output. */
export type Deps = {
	hosts: readonly Host[];
	cwd: string;
	env: Environment;
	/** Prints a line on stdout. */
	stdout(line: string): void;
	/** Prints a line on stderr. */
	stderr(line: string): void;
	/** Asks a yes-or-no question on the terminal. Absent when stdin is not a terminal. */
	confirm?(question: string): Promise<boolean>;
	/** The size of the terminal stdout writes to. Absent when stdout is not a terminal. */
	terminal?(): { columns: number; rows: number };
	/** The width of the terminal stderr writes to. Absent when stderr is not a terminal. */
	stderrTerminal?(): { columns: number };
};

/** Whether output is colored: unless `enabled` is false, `NO_COLOR` is set or `TERM` is `dumb`. */
export const colorOn = ({ env }: Deps, enabled = true) =>
	enabled && !env.NO_COLOR && env.TERM !== "dumb";

type OptionSpec = {
	type: "string" | "boolean";
	/** The value's placeholder in help, for a `string` option. */
	arg?: string;
	desc: string;
	multiple?: boolean;
	short?: string;
};

export type Options = Readonly<Record<string, OptionSpec>>;

export type Values = Readonly<
	Record<string, string | boolean | (string | boolean)[] | undefined>
>;

/** One verb: what it takes, and what it does with its arguments. */
export type Command = {
	usage: string;
	options: Options;
	execute(args: readonly string[], deps: Deps): Promise<number>;
	/** What `--help` adds after the flags for `args`, such as the params of the composition they name. */
	help?(args: readonly string[], deps: Deps): Promise<string | undefined>;
};

/** The flags every command takes. */
export const COMMON: Options = {
	json: { type: "boolean", desc: "Print one JSON document on stdout" },
	profile: {
		type: "string",
		arg: "name",
		desc: "Layer .maestro/profiles/<name>.yaml on the config",
	},
	debug: { type: "boolean", desc: "Show stack traces" },
	help: { type: "boolean", short: "h", desc: "Show this help" },
};

const forParser = (options: Options) =>
	Object.fromEntries(
		Object.entries(options).map(([name, { type, multiple, short }]) => [
			name,
			{ type, ...(multiple && { multiple }), ...(short && { short }) },
		]),
	);

/**
 * `args` read against `options`.
 * @throws CliError, a usage error ending with `fix`, for a flag `options` lacks or one without its value.
 */
export function parse(options: Options, args: readonly string[], fix: string) {
	try {
		const { values, positionals } = parseArgs({
			args: [...args],
			options: forParser(options),
			allowPositionals: true,
			allowNegative: true,
		});
		return { values: values as Values, positionals };
	} catch (error) {
		const [what = "unusable arguments"] = messageOf(error).split(". ");
		const flag = /^Unknown option '--([^']+)'/.exec(what)?.[1];
		const near = flag && closest(flag, Object.keys(options));
		throw usageError(what, near ? `Did you mean --${near}?` : fix);
	}
}

/** The flags of `options` found in `args`, with nothing refused, so a flag only a later reading knows is skipped. */
export const peek = (options: Options, args: readonly string[]): Values =>
	parseArgs({
		args: [...args],
		options: forParser(options),
		allowPositionals: true,
		strict: false,
	}).values as Values;

export const textOf = (values: Values, name: string) => {
	const value = values[name];
	return typeof value === "string" ? value : undefined;
};

export const isSet = (values: Values, name: string) => values[name] === true;

/** The one positional of `positionals`. @throws CliError, a usage error ending with `fix`, for none or several. */
export function only(
	positionals: readonly string[],
	what: string,
	fix: string,
): string {
	const [first, ...rest] = positionals;
	if (first === undefined || rest.length > 0)
		throw usageError(`expected one ${what}, got ${positionals.length}`, fix);
	return first;
}

/** Help for `command`: its usage, then each flag with its description, then `extra` when given. */
export function helpOf(command: Command, extra?: string): string {
	const flags = Object.entries(command.options).map(([name, o]) => [
		`${o.short ? `-${o.short}, ` : "    "}--${name}${o.arg ? ` <${o.arg}>` : ""}`,
		o.desc,
	]);
	return [
		`Usage: maestro ${command.usage}`,
		"",
		"Flags:",
		table(flags.map(([flag = "", desc = ""]) => [`  ${flag}`, desc])),
		...(extra === undefined ? [] : ["", extra]),
	].join("\n");
}
