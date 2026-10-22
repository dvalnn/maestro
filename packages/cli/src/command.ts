import { parseArgs } from "node:util";
import { closest } from "@maestro/core";
import type { Host } from "@maestro/core/host";
import type { ConcertFilter } from "@maestro/core/perform";
import { messageOf } from "@maestro/ir";
import type { Environment } from "./config";
import {
	compositionOf,
	parseTour,
	renderWarning,
	STATUSES,
	statusOf,
	table,
	usageError,
} from "./output";

/** What a command reads and writes outside itself: the hosts, the working directory, the environment and its output. */
export type Deps = {
	hosts: readonly Host[];
	cwd: string;
	env: Environment;
	/** Prints a line on stdout. */
	stdout(line: string): void;
	/** Writes `bytes` on stdout as they are, adding no newline. */
	stdoutBytes(bytes: Uint8Array): void;
	/** Prints a line on stderr. */
	stderr(line: string): void;
	/** Asks a yes-or-no question on the terminal. Absent when stdin is not a terminal. */
	confirm?(question: string): Promise<boolean>;
	/** The size of the terminal stdout writes to. Absent when stdout is not a terminal. */
	terminal?(): { columns: number; rows: number };
	/** The width of the terminal stderr writes to. Absent when stderr is not a terminal. */
	stderrTerminal?(): { columns: number };
	/** The terminal as a screen a view drives by keys. Absent unless stdin and stdout are both terminals. */
	screen?: Screen;
};

/** A terminal taken over whole, from `enter` until `leave`. */
export type Screen = {
	/**
	 * Takes the terminal: the alternate screen, the cursor hidden and stdin raw. `onKey` gets each chunk of input, and
	 * an empty one when what is drawn must be drawn again, after a resize or a resume.
	 */
	enter(onKey: (chunk: string) => void): void;
	/** Draws `lines` over the whole screen, while it is taken. */
	draw(lines: readonly string[]): void;
	/** Gives the terminal back as `enter` found it. Idempotent. */
	leave(): void;
};

export type Colors = { out: boolean; err: boolean };

/** Which streams color: each one that is a terminal, unless `--no-color` in `values`, `NO_COLOR` or `TERM=dumb` say no. */
export const colorOf = (
	{ env, terminal, stderrTerminal }: Deps,
	values: Values,
): Colors => {
	const on = values.color !== false && !env.NO_COLOR && env.TERM !== "dumb";
	return {
		out: on && terminal !== undefined,
		err: on && stderrTerminal !== undefined,
	};
};

/** Prints `text` as a warning on stderr, colored as `values` say, unless `values` hold `--json`. */
export function warn(deps: Deps, values: Values, text: string) {
	if (!isSet(values, "json"))
		deps.stderr(renderWarning(text, colorOf(deps, values).err));
}

type OptionSpec = {
	type: "string" | "boolean";
	/** The value's placeholder in help, for a `string` option. */
	arg?: string;
	desc: string;
	multiple?: boolean;
	short?: string;
	/** Left out of help: a debug flag whose output may change. */
	hidden?: boolean;
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

export const FILTER_OPTIONS = {
	status: {
		type: "string",
		arg: "status",
		desc: `Only concerts that are ${STATUSES.join(", ")}`,
	},
	composition: {
		type: "string",
		arg: "pack.name",
		desc: "Only this composition, as <pack>.<composition>",
	},
	tour: {
		type: "string",
		arg: "slug",
		desc: "Only this tour and the tours under it (epic matches epic.story)",
	},
	workspace: { type: "string", arg: "name", desc: "Only this workspace" },
} as const satisfies Options;

/**
 * The `store.concerts` filter of `--tour`, `--workspace`, `--status` and `--composition`.
 * @throws CliError, a usage error, for a bad filter value.
 */
export function filterOf(values: Values): ConcertFilter {
	const tour = textOf(values, "tour");
	return {
		tour: tour === undefined ? undefined : parseTour("--tour", tour),
		workspace: textOf(values, "workspace"),
		status: statusOf(textOf(values, "status")),
		...compositionOf(textOf(values, "composition")),
	};
}

/** The flags every command takes. */
export const COMMON: Options = {
	json: { type: "boolean", desc: "Print one JSON document on stdout" },
	profile: {
		type: "string",
		arg: "name",
		desc: "Layer .maestro/profiles/<name>.yaml on the config",
	},
	config: {
		type: "string",
		arg: "key=value",
		desc: "Set a config key to a YAML value, over the profile; repeatable",
		multiple: true,
		short: "c",
	},
	color: {
		type: "boolean",
		desc: "Color output on a terminal (default); --no-color turns it off",
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
		allowNegative: true,
	}).values as Values;

export const textOf = (values: Values, name: string) => {
	const value = values[name];
	return typeof value === "string" ? value : undefined;
};

/** The texts given to a repeatable flag, in order, none when it is absent. */
export const textsOf = (values: Values, name: string) =>
	[values[name] ?? []].flat().filter((v) => typeof v === "string");

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
	const flags = Object.entries(command.options)
		.filter(([, o]) => !o.hidden)
		.map(([name, o]) => [
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
