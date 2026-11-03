import { parseArgs } from "node:util";
import { closest } from "@maestro/core";
import type { Host } from "@maestro/core/host";
import type { ConcertFilter } from "@maestro/core/perform";
import { messageOf } from "@maestro/ir";
import type { Environment } from "./config";
import {
	ArgumentError,
	compositionOf,
	paint,
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

/**
 * Which streams color: each one that is a terminal, or every one under `--color` or a non-empty `FORCE_COLOR`, unless
 * `--no-color` in `values`, `NO_COLOR` or `TERM=dumb` say no.
 */
export const colorOf = (
	{ env, terminal, stderrTerminal }: Deps,
	values: Values,
): Colors => {
	const on = values.color !== false && !env.NO_COLOR && env.TERM !== "dumb";
	const forced = values.color === true || !!env.FORCE_COLOR;
	return {
		out: on && (forced || terminal !== undefined),
		err: on && (forced || stderrTerminal !== undefined),
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

/** An example: a comment saying what the command does, and the command. */
type Example = readonly [comment: string, command: string];

/** One verb: what it takes, and what it does with its arguments. */
export type Command = {
	usage: string;
	/** Each positional of the usage with what it is and where to find one. */
	arguments?: readonly (readonly [name: string, what: string])[];
	options: Options;
	examples?: readonly Example[];
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
	preset: {
		type: "string",
		arg: "name",
		desc: "Layer the preset .maestro/presets/<name>.yaml, else the user's, on the config; repeatable, later ones winning",
		multiple: true,
	},
	config: {
		type: "string",
		arg: "key=value",
		desc: "Set a config key to a YAML value, over the presets; repeatable",
		multiple: true,
		short: "c",
	},
	color: {
		type: "boolean",
		desc: "Color output even when not a terminal; --no-color turns it off",
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

const PARSER_FLAG = /'(?:-\w, )?(-{1,2}[^' ]+)/;

/** The usage error for `error`, the parser's, ending with `fix`, or a did-you-mean for a long flag `options` nearly has. */
function parserError(error: unknown, options: Options, fix: string) {
	const [what = "unusable arguments"] = messageOf(error).split(/\. |\n/);
	const flag = PARSER_FLAG.exec(what)?.[1];
	if (flag === undefined) return usageError(what, fix);
	if ((error as NodeJS.ErrnoException).code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION")
		return usageError(
			what.includes("does not take")
				? `${flag} takes no value`
				: `${flag} needs a value`,
			fix,
		);
	const near =
		flag.startsWith("--") && closest(flag.slice(2), Object.keys(options));
	return usageError(
		`unknown flag ${flag}`,
		near ? `Did you mean --${near}?` : fix,
	);
}

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
		throw parserError(error, options, fix);
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

/** The first positional of `args` and the rest of them, with `options`' flags before it read as such. */
export function splitFirst(options: Options, args: readonly string[]) {
	const { tokens = [] } = parseArgs({
		args: [...args],
		options: forParser(options),
		allowPositionals: true,
		strict: false,
		allowNegative: true,
		tokens: true,
	});
	const at = tokens.find((t) => t.kind === "positional");
	return {
		first: at?.value,
		/** What came before the first positional. */
		lead: args.slice(0, at?.index ?? args.length),
		rest: args.filter((_, i) => i !== at?.index),
	};
}

export const textOf = (values: Values, name: string) => {
	const value = values[name];
	return typeof value === "string" ? value : undefined;
};

/** The texts given to a repeatable flag, in order, none when it is absent. */
export const textsOf = (values: Values, name: string) =>
	[values[name] ?? []].flat().filter((v) => typeof v === "string");

export const isSet = (values: Values, name: string) => values[name] === true;

/**
 * The one positional of `positionals`, `what` the command's argument is. `verb` is the sub-verb it belongs to, if any.
 * @throws ArgumentError ending with `fix`, for none or several.
 */
export function only(
	positionals: readonly string[],
	what: string,
	fix: string,
	verb?: string,
): string {
	const [first, ...rest] = positionals;
	const lead = verb === undefined ? "" : `${verb} `;
	if (first === undefined)
		throw new ArgumentError(`${lead}needs a ${what}`, fix);
	if (rest.length > 0)
		throw new ArgumentError(
			`${lead}takes one ${what}, got ${positionals.length}`,
			fix,
		);
	return first;
}

/** The flags every command takes but `--json`, which a command may leave out. */
export const SHARED: Options = Object.fromEntries(
	Object.entries(COMMON).filter(([name]) => name !== "json"),
);

const flagName = (name: string, o: OptionSpec) =>
	`${o.short ? `-${o.short}, ` : "    "}--${name}${o.arg ? ` <${o.arg}>` : ""}`;

/** `--preset, -c/--config, --color, --debug, -h/--help`: the shared flags, by name. */
const sharedNames = () =>
	Object.entries(SHARED)
		.map(([name, { short }]) => `${short ? `-${short}/` : ""}--${name}`)
		.join(", ");

/** The shared flags as help rows: each with its placeholder and description, the flag cyan when `color`. */
export function sharedFlags(color: boolean): string {
	return flagRows(Object.entries(SHARED), color);
}

/** Flags as an indented table: each name with its placeholder, then its description. */
function flagRows(
	entries: readonly (readonly [string, OptionSpec | undefined])[],
	color: boolean,
): string {
	const rows = entries.flatMap(([name, o]) =>
		o ? [[flagName(name, o), o.desc]] : [],
	);
	return table(
		rows.map(([flag = "", desc = ""]) => [
			`  ${flag.slice(0, flag.search(/\S/))}${paint("cyan", flag.trim(), color)}`,
			desc,
		]),
	);
}

/**
 * Help for `command`, which `summary` describes: the summary, its usage, its arguments, each flag but the shared ones
 * with its description, `extra` when given, its examples, and a line naming the shared flags. With `color` the
 * headings are bold and the flags cyan.
 */
export function helpOf(
	command: Command,
	summary: string,
	extra?: string,
	color = false,
): string {
	const heading = (text: string) => paint("bold", text, color);
	const own = Object.entries(command.options).filter(
		([name, o]) => !o.hidden && !Object.hasOwn(SHARED, name),
	);
	const sections = [
		summary,
		`${heading("Usage:")} maestro ${command.usage}`,
		command.arguments &&
			`${heading("Arguments:")}\n${table(command.arguments.map(([name, what]) => [`  ${name}`, what]))}`,
		`${heading("Flags:")}\n${flagRows(own, color)}`,
		extra,
		command.examples &&
			`${heading("Examples:")}\n${command.examples.map(([comment, run]) => `  # ${comment}\n  ${run}`).join("\n")}`,
		`Common flags: ${sharedNames()} (see 'maestro --help')`,
	];
	return sections.filter((section) => section !== undefined).join("\n\n");
}
