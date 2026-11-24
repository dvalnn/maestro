import { constants } from "node:os";
import { join } from "node:path";
import { isTourSlug, TOUR_MAX_LENGTH, tildeOf } from "@maestro/core";
import { ConfigError } from "@maestro/core/config";
import type {
	ConcertRecord,
	ConcertResult,
	ConcertStatus,
	Records,
	Unencorable,
	Unresumable,
} from "@maestro/core/perform";
import {
	ARTIFACT_TYPES,
	type ArtifactRef,
	type Diagnostic,
	DURATION_EXAMPLE,
	durationMs,
	findMarked,
	type GraphIndex,
	type Ir,
	indexGraph,
	isPlainObject,
	type Ports,
	replaceAt,
	tokensOf,
	withoutKeys,
} from "@maestro/ir";
import {
	type Changes,
	closingBlock,
	cutTo,
	hintLine,
	padCells,
	shellArg,
	shortIds,
	styled,
	type View,
	wrapText,
} from "@maestro/render-text/live";
import type { Colors, Deps } from "./command";

/** A process a signal ends exits with this plus the signal's number. */
export const SIGNAL_EXIT_BASE = 128;

/** The exit codes of every command. */
export const EXIT = {
	ok: 0,
	failed: 1,
	usage: 2,
	rejected: 3,
	timeout: 124,
	/** The signal exit of SIGINT, as Ctrl-C ends a process. */
	interrupted: SIGNAL_EXIT_BASE + constants.signals.SIGINT,
	/** The signal exit of SIGTERM. */
	terminated: SIGNAL_EXIT_BASE + constants.signals.SIGTERM,
} as const;

/** An error to print as it is, with the exit code it ends the command with. */
export class CliError extends Error {
	override readonly name = "CliError";
	readonly exit: number;

	constructor(message: string, exit: number = EXIT.failed) {
		super(message);
		this.exit = exit;
	}
}

/** A usage error: `what` went wrong, and `fix` is what to do next. */
export const usageError = (what: string, fix: string) =>
	new CliError(`${what}\n${fix}`, EXIT.usage);

/** A fault that stops the command with exit 1: `what` went wrong, and `fix` is what to do next. */
export const failure = (what: string, fix: string) =>
	new CliError(`${what}\n${fix}`, EXIT.failed);

/** The hint of a command that needs a concert. */
export const NAME_CONCERT = "Name one as 'maestro ls' lists it";

/**
 * A usage error of a command's positionals. `what` follows the command's name, such as `needs a concert`, and the
 * command's usage line is printed after it.
 */
export class ArgumentError extends CliError {
	constructor(what: string, fix: string) {
		super(`${what}\n${fix}`, EXIT.usage);
	}
}

/** Diagnostics that stop a command, from building a composition or reading an IR file. */
export class Diagnosed extends Error {
	override readonly name = "Diagnosed";
	readonly diagnostics: readonly Diagnostic[];

	constructor(diagnostics: readonly Diagnostic[]) {
		super(diagnostics.map((d) => d.message).join("\n"));
		this.diagnostics = diagnostics;
	}
}

/** The diagnostics `error` carries, if it is one that does. */
export const diagnosticsOf = (
	error: unknown,
): readonly Diagnostic[] | undefined =>
	error instanceof Diagnosed || error instanceof ConfigError
		? error.diagnostics
		: undefined;

/**
 * Whether `d` faults what the user typed on the command line: a `-c`, or a param's flag. A value a file, a preset or a
 * recorded concert set is config, and so is one with no layer.
 */
const isArgument = (d: Diagnostic) =>
	d.layer === "flag" && d.concert === undefined;

/** The exit code of `diagnostics`: usage when any faults the command line, else failed. */
export const diagnosedExit = (diagnostics: readonly Diagnostic[]) =>
	diagnostics.some(isArgument) ? EXIT.usage : EXIT.failed;

const located = ({ source }: Diagnostic) =>
	source
		? `${source.file}:${source.line}${source.column === undefined ? "" : `:${source.column}`}: `
		: "";

export const paint = (
	style: Parameters<typeof styled>[0],
	text: string,
	color: boolean,
) => (color ? styled(style, text) : text);

/** The `-` a table shows for an absent value, dim when `color`. */
export const absent = (color: boolean) => paint("dim", "-", color);

/** `text`, or the dim dash of `absent` when it is empty or missing. */
export const orAbsent = (text: string | undefined, color: boolean) =>
	text || absent(color);

/**
 * A diagnostic as two lines: the source location when known, `error:` or `warning:` and the message, then the hint,
 * which an empty one leaves out.
 * With `color` the severity word is red, or yellow for a warning, and the hint dim.
 */
export function renderDiagnostic(d: Diagnostic, color: boolean): string {
	const warning = d.severity === "warning";
	const label = paint(
		warning ? "yellow" : "red",
		warning ? "warning" : "error",
		color,
	);
	const head = `${located(d)}${label}: ${d.message}`;
	return d.hint === "" ? head : `${head}\n  ${paint("dim", d.hint, color)}`;
}

/** `diagnostics` rendered one each, a run of identical hints printed once, under the last of the run. */
export const renderDiagnostics = (
	diagnostics: readonly Diagnostic[],
	color: boolean,
): string[] =>
	diagnostics.map((d, i) =>
		renderDiagnostic(
			d.hint === diagnostics[i + 1]?.hint ? { ...d, hint: "" } : d,
			color,
		),
	);

/** A warning on one line, `warning: <text>`, with `warning` yellow when `color`. */
export const renderWarning = (text: string, color: boolean) =>
	`${paint("yellow", "warning", color)}: ${text}`;

/**
 * `message` as an error: `error:` before its first line, and when it is two lines the second a dim, indented hint, with
 * `usage` between them when given.
 */
export function hinted(
	message: string,
	color: boolean,
	usage?: string,
): string {
	const [what, fix, ...more] = message.split("\n");
	const head = `${paint("red", "error", color)}: ${what}`;
	if (fix === undefined) return head;
	if (more.length > 0) return `${head}\n${[fix, ...more].join("\n")}`;
	const hint = `  ${paint("dim", fix, color)}`;
	return [head, usage, hint].filter((line) => line !== undefined).join("\n");
}

/** The `stale` cell of an instance or one of its artifacts: `stale` when an earlier attempt left it, else empty. */
export function staleCell({ stale }: { stale?: boolean }): string {
	return stale ? "stale" : "";
}

/** The columns of a table that give way to a terminal, in that order, each cut down to its floor. */
type Give = readonly { column: number; floor: number }[];

/**
 * A table's fit to a terminal `columns` cells wide: either the columns that give way, or a last column that wraps under
 * itself.
 */
type Fit = { columns: number; give: Give } | { columns: number; wrap: true };

/** A fit that cuts columns, the only one that can leave a cell short of its value. */
type Cut = Extract<Fit, { give: Give }>;

const COLUMN_GAP = "  ";

/** The fit of a table to a terminal `columns` cells wide, giving way as `give` says; none when `columns` is 0, off a terminal. */
export const giving = (columns: number, give: Give): Cut | undefined =>
	columns > 0 ? { columns, give } : undefined;

/** The fit of a table whose last column wraps at `columns` cells; none when `columns` is 0, off a terminal. */
export const wrapping = (columns: number): Fit | undefined =>
	columns > 0 ? { columns, wrap: true } : undefined;

/**
 * The fewest cells a wrapped last column breaks at, a layout choice: a wide character is two cells. A narrow terminal wraps the text narrower rather than letting a line overrun it.
 */
const MIN_WRAP = 2;

const widthsOf = (rows: readonly (readonly string[])[]) =>
	rows.reduce<number[]>(
		(w, row) =>
			row.map((cell, i) => Math.max(w[i] ?? 0, Bun.stringWidth(cell))),
		[],
	);

type Rows = readonly (readonly string[])[];

/**
 * `rows` with the cells of the columns `give` names cut with `…`, in its order, until a row fits or each is at its floor,
 * and whether any cell was cut.
 */
function fitted(
	rows: Rows,
	{ columns, give }: Cut,
): { rows: Rows; cut: boolean } {
	const widths = widthsOf(rows);
	let excess =
		widths.reduce((sum, w) => sum + w, 0) +
		COLUMN_GAP.length * Math.max(0, widths.length - 1) -
		columns;
	for (const { column, floor } of give) {
		const width = widths[column] ?? 0;
		const take = Math.min(Math.max(excess, 0), Math.max(width - floor, 0));
		widths[column] = width - take;
		excess -= take;
	}
	const cutRows = rows.map((row) =>
		row.map((cell, i) =>
			give.some((g) => g.column === i) ? cutTo(cell, widths[i] ?? 0) : cell,
		),
	);
	return {
		rows: cutRows,
		cut: cutRows.some((row, r) => row.some((cell, i) => cell !== rows[r]?.[i])),
	};
}

/**
 * `row` as its lines. A full row's last cell wraps at `wrapAt` cells when that is above 0, each of its own lines
 * wrapped apart, and each later line leaves the other cells blank, so it sits under its own column.
 */
function linesOf(
	row: readonly string[],
	width: number,
	wrapAt: number,
): string[][] {
	if (wrapAt === 0 || row.length !== width) return [[...row]];
	const head = row.slice(0, -1);
	const [first = "", ...more] = (row.at(-1) ?? "")
		.split("\n")
		.flatMap((part) => wrapText(part, wrapAt));
	return [
		[...head, first],
		...more.map((text) => [...head.map(() => ""), text]),
	];
}

/** The cells a wrapping `fit` leaves the last of `width` columns of `widths`; 0, no wrap, for any other fit. */
function wrapAtOf(widths: readonly number[], width: number, fit?: Fit): number {
	if (fit === undefined || !("wrap" in fit)) return 0;
	const leading = widths
		.slice(0, width - 1)
		.reduce((sum, w) => sum + w + COLUMN_GAP.length, 0);
	return Math.max(MIN_WRAP, fit.columns - leading);
}

/**
 * Rows of cells in columns two spaces apart, without trailing spaces. A cell's width leaves out its color codes. With
 * `bold` the first row is bold. With a `fit` that gives, a table wider than its columns cuts the cells of the columns it
 * names; with one that wraps, its last column wraps under itself at the cells the others leave, so each line fits
 * unless the columns before it alone are wider.
 */
export function table(rows: Rows, bold = false, fit?: Fit): string {
	return laidOut(rows, bold, fit).text;
}

/** `table(rows, bold, fit)` as its text, and whether `fit` cut a cell. */
export function laidOut(
	rows: Rows,
	bold = false,
	fit?: Fit,
): { text: string; cut: boolean } {
	const { rows: cells, cut } =
		fit && "give" in fit ? fitted(rows, fit) : { rows, cut: false };
	const widths = widthsOf(cells);
	const width = Math.max(0, ...cells.map((row) => row.length));
	const wrapAt = wrapAtOf(widths, width, fit);
	const text = cells
		.flatMap((row, r) =>
			linesOf(row, width, wrapAt).map((line) =>
				line
					.map((cell, i) =>
						padCells(
							bold && r === 0 ? paint("bold", cell, true) : cell,
							widths[i] ?? 0,
						),
					)
					.join(COLUMN_GAP)
					.trimEnd(),
			),
		)
		.join("\n");
	return { text, cut };
}

/**
 * `table(rows, bold, fit)`, followed by the dim line `hint` when `fit` cut a cell; the hint is a command to run, so it is never
 * cut. Without a `fit` it is the table alone.
 */
export function fittedTable(
	rows: Rows,
	bold: boolean,
	fit: Cut | undefined,
	hint: string,
): string {
	const { text, cut } = laidOut(rows, bold, fit);
	return cut ? `${text}\n${hintLine(hint, bold)}` : text;
}

/**
 * The command that repeats `maestro <verb> <args>` as JSON: `args` shell-quoted without the flags that only choose how it
 * prints, and `--json` before a `--` that ends the flags.
 */
export function jsonAgain(verb: string, args: readonly string[]): string {
	const end = args.indexOf("--");
	const flags = end < 0 ? args : args.slice(0, end);
	const rest = end < 0 ? [] : args.slice(end);
	const kept = flags.filter(
		(a) => !["--json", "--color", "--no-color"].includes(a),
	);
	return `maestro ${verb} ${[...kept, "--json", ...rest].map(shellArg).join(" ")}`;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];
const BYTES_PER_UNIT = 1024;

/** `bytes` in the largest binary unit that keeps it at 1 or more, such as `1.5 KiB`. */
export function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
		value /= BYTES_PER_UNIT;
		unit++;
	}
	const shown = unit === 0 ? String(value) : value.toFixed(1);
	return `${shown} ${BYTE_UNITS[unit]}`;
}

/**
 * `text` as milliseconds, a duration such as `90s` or `7d`.
 * @throws CliError, a usage error naming `flag`, for anything else.
 */
export function parseDuration(flag: string, text: string): number {
	const ms = durationMs(text);
	if (ms === undefined)
		throw usageError(
			`${flag} takes a positive whole number and one unit, not '${text}'`,
			`Write it as ${DURATION_EXAMPLE}`,
		);
	return ms;
}

type DiffPart = "mail" | "header" | "hunk";

const HUNK_STYLES: Readonly<Record<string, Parameters<typeof paint>[0]>> = {
	"@": "cyan",
	"+": "green",
	"-": "red",
};

const MAIL_START = /^From [0-9a-f]{40} /;

/**
 * The part of a patch `line` is in, after `part`: file headers run from a `diff` line, or from a `--- ` line in the
 * mail part, to the first `@@`, and a `git format-patch` mail start returns to the mail part.
 */
const partAt = (part: DiffPart, line: string): DiffPart => {
	if (MAIL_START.test(line)) return "mail";
	if (line.startsWith("diff ") || (part === "mail" && line.startsWith("--- ")))
		return "header";
	return part === "header" && line.startsWith("@@") ? "hunk" : part;
};

/**
 * Unified diff `text` with its file headers bold, hunk headers cyan, and added lines green and removed ones red, as
 * `git diff` colors it. Text before the first `diff` or `--- ` line, such as a patch's mail header, is left as it is.
 */
export function diffColored(text: string): string {
	let part: DiffPart = "mail";
	return text
		.split("\n")
		.map((line) => {
			part = partAt(part, line);
			const style = part === "header" ? "bold" : HUNK_STYLES[line[0] ?? ""];
			return style && part !== "mail" ? paint(style, line, true) : line;
		})
		.join("\n");
}

/** `value` as the one JSON document a command prints with `--json`: indented by two on a terminal stdout, else on one line. */
export const jsonOf = (value: unknown, { terminal }: Deps) =>
	JSON.stringify(value, null, terminal ? 2 : undefined);

/** The exit code of a concert with `status`: `running` is a wait that gave up. */
export const exitOf = (status: ConcertStatus) =>
	({
		ok: EXIT.ok,
		rejected: EXIT.rejected,
		failed: EXIT.failed,
		running: EXIT.timeout,
	})[status];

/** The reason a concert result gives, if it is not ok. */
export const reasonOf = (result: ConcertResult | undefined) =>
	result && "reason" in result ? result.reason : undefined;

/** What a view holds beside the record's row, off a terminal: no size, so nothing wraps. */
export const UNFRAMED = { columns: 0, rows: 0, tokens: 0, unique: 0 };

/** The view of concert `row`, with the terminal size, token total and unique short id length given, none by default. */
export const viewOf = (
	row: ConcertRecord,
	color: boolean,
	{ unique, tokens, ...size } = UNFRAMED,
): View => ({
	concert: {
		id: row.id,
		label: `${row.pack}.${row.composition}`,
		title: row.title,
		status: row.status,
		unique,
		startedAt: row.startedAt,
		settledAt: row.settledAt,
	},
	tokens,
	now: Date.now(),
	color,
	...size,
});

/**
 * How a closing block shows: colored on each stream `color` names. With `artifacts`, the concert's artifact area, it
 * holds where and why the concert ended and its outputs; without, its `concert` row alone. `changes` is what the
 * concert's changeset touches, shown on a terminal stdout.
 */
type Closing = { color: Colors; artifacts?: string; changes?: Changes };

/**
 * Prints how the settled concert `row` ended: its `concert` row, and where and why when not ok, on stderr, then the
 * outputs of `result` on stdout. The hint after the outputs names the step it ended at when not ok. On a terminal stderr the reason wraps at its width; on a terminal stdout an artifact
 * path starts `~` for home.
 */
export function printClosing(
	deps: Deps,
	store: Records,
	row: ConcertRecord,
	result: ConcertResult,
	{ color, artifacts, changes }: Closing,
) {
	const { terminal, stderrTerminal } = deps;
	const short = shortIds(store.ids());
	const view = viewOf(row, color.err, {
		rows: 0,
		columns: stderrTerminal?.().columns ?? 0,
		tokens: tokensOf(store.metrics(row.id)),
		unique: short.unique(row.id),
	});
	const at = atOf(indexGraph(row.ir), result);
	const id = short.label(row.id, false);
	const area =
		terminal && artifacts !== undefined
			? tildeOf(artifacts, deps.env.HOME)
			: artifacts;
	const block = closingBlock(
		view,
		area === undefined
			? undefined
			: {
					at,
					reason: reasonOf(result),
					outputs: outputRows(row.ir, area, result),
					summary: terminal && {
						columns: terminal().columns,
						changes,
						// The step a concert ended at holds its report; an ok one's steps are listed.
						hint:
							at === undefined
								? `Details: maestro ls ${id} --json`
								: `Details: maestro ls ${id} ${shellArg(at)} --json`,
						cutHint: `Full outputs: maestro wait ${id} --json | jq .outputs`,
					},
				},
		color.out,
	);
	deps.stderr(block.head);
	if (block.outputs !== undefined) deps.stdout(block.outputs);
}

/** The instance `result` settled at, when it is not ok. */
const atOf = (graph: GraphIndex, result: ConcertResult) =>
	result.outcome === "ok" ||
	result.node === undefined ||
	result.expansion === undefined
		? undefined
		: graph.instanceName({
				node: result.node,
				expansion: result.expansion,
			});

/** A concert's run time in milliseconds: up to now while it runs. */
export const elapsedOf = ({ settledAt, startedAt }: ConcertRecord) =>
	(settledAt ?? Date.now()) - startedAt;

/** Concert `id`'s metrics and their `tokensOf` total, as its `--json` documents carry them. */
export const spendOf = (store: Records, id: string) => {
	const metrics = store.metrics(id);
	return { metrics, tokens: tokensOf(metrics) };
};

/**
 * The JSON document of concert `id` and its `result`, `undefined` while it is running: the record's columns, in
 * camelCase.
 */
export const resultDoc = (
	id: string,
	result: ConcertResult | undefined,
): {
	id: string;
	status: ConcertStatus;
	resultNode?: string;
	resultExpansion?: string;
	reason?: string;
	outputs?: Record<string, unknown>;
} => ({
	id,
	status: result?.outcome ?? "running",
	resultNode: result?.node,
	resultExpansion: result?.expansion,
	reason: reasonOf(result),
	outputs: result?.outputs,
});

/** The `--json` document `perform`, `wait` and `watch` end with: concert `id`'s `result`, spend and artifact area. */
export const concertDoc = (
	store: Records,
	id: string,
	result: ConcertResult | undefined,
	artifacts: string,
) => ({ ...resultDoc(id, result), ...spendOf(store, id), artifacts });

export const isArtifactRef = (value: unknown): value is ArtifactRef =>
	isPlainObject(value) && typeof value.path === "string";

/**
 * The outputs of `result` as a port and its value, with each artifact in a value replaced by its path in the artifact
 * area `artifacts`, and whether the whole value is an artifact.
 */
function outputRows(
	ir: Ir,
	artifacts: string,
	result: ConcertResult,
): [port: string, value: unknown, whole: boolean][] {
	const outputs = result.outputs ?? {};
	const ports = ir.nodes.find((n) => n.id === result.node)?.out ?? {};
	const whole = new Set(
		portArtifacts(ports, outputs)
			.filter(({ pointer }) => pointer === "")
			.map(({ port }) => port),
	);
	const shown = withArtifactPaths(ports, outputs, (ref) =>
		join(artifacts, ref.path),
	);
	return Object.entries(shown).map(([port, value]) => [
		port,
		value,
		whole.has(port),
	]);
}

/** Each artifact in `outputs` of node `node` of `ir`: its port, its JSON Pointer in that port's value, and its ref. */
export const artifactRefs = (
	ir: Ir,
	node: string | undefined,
	outputs: Readonly<Record<string, unknown>>,
) => portArtifacts(ir.nodes.find((n) => n.id === node)?.out ?? {}, outputs);

/**
 * A copy of `values` on `ports`, each artifact in them replaced by `pathOf` its ref; by default its path relative to
 * the concert's artifact area.
 */
export function withArtifactPaths(
	ports: Ports,
	values: Readonly<Record<string, unknown>>,
	pathOf: (ref: ArtifactRef) => string = (ref) => ref.path,
): Record<string, unknown> {
	const shown = structuredClone({ ...values });
	for (const { port, pointer, ref } of portArtifacts(ports, values))
		shown[port] = replaceAt(shown[port], pointer, pathOf(ref));
	return shown;
}

/** Each artifact in `values` on `ports`: its port, its JSON Pointer in that port's value, and its ref. */
function portArtifacts(
	ports: Ports,
	values: Readonly<Record<string, unknown>>,
): { port: string; pointer: string; ref: ArtifactRef }[] {
	return Object.entries(values).flatMap(([port, value]) =>
		findMarked(ports[port] ?? {}, value).flatMap(
			({ type, pointer, value: ref }) =>
				ARTIFACT_TYPES.has(type) && isArtifactRef(ref)
					? [{ port, pointer, ref }]
					: [],
		),
	);
}

/** The error of a command that finds concert `id` running, which a command on settled concerts refuses. */
export const stillRunning = (id: string, pid: number) =>
	new CliError(
		`concert ${id} is still running in process ${pid}\nWait for it with 'maestro wait ${id}', or stop it with 'maestro kill ${id}'`,
	);

/** The error of `resume` for a concert core refuses to resume. */
export const resumeRefused = ({ concert }: Unresumable) =>
	concert.status === "running"
		? stillRunning(concert.id, concert.pid)
		: new CliError(
				`concert ${concert.id} finished ok, so it has nothing to resume\nPerform its composition as a new concert with 'maestro perform <composition>'`,
			);

/** The error of `encore` for a concert core refuses an encore of; one that did not settle `ok` may resume. */
export function encoreRefused({ concert }: Unencorable): CliError {
	const { id, status, pid } = concert;
	if (status === "running") return stillRunning(id, pid);
	const change = "Change a param, the config or the target";
	return new CliError(
		`nothing changed since concert ${id}: its params, config and target revision are the same\n${
			status === "ok"
				? change
				: `${change}, or resume it with 'maestro resume ${id}'`
		}`,
	);
}

/**
 * `text` as a tour slug: one or more dot-separated segments, each lower-case letters and digits in words joined by
 * single hyphens, at most 64 characters in all.
 * @throws CliError, a usage error naming `source`, for anything else.
 */
export function parseTour(source: string, text: string): string {
	if (!isTourSlug(text))
		throw usageError(
			`${source} takes a slug of at most ${TOUR_MAX_LENGTH} characters, not '${text}'`,
			"Write it as lower-case words joined by hyphens, in non-empty segments joined by dots, such as release-2.build-3",
		);
	return text;
}

export const STATUSES: readonly ConcertStatus[] = [
	"running",
	"ok",
	"failed",
	"rejected",
];

/**
 * `text` as a concert status, or `undefined` for no text.
 * @throws CliError, a usage error, for any other word.
 */
export function statusOf(text: string | undefined): ConcertStatus | undefined {
	if (text === undefined) return undefined;
	const status = STATUSES.find((s) => s === text);
	if (!status)
		throw usageError(
			`--status takes one of ${STATUSES.join(", ")}, not '${text}'`,
			"Pick one of those",
		);
	return status;
}

/**
 * The pack and composition filters of `--composition <pack>.<composition>`.
 * @throws CliError, a usage error, for any other form.
 */
export function compositionOf(text: string | undefined) {
	if (text === undefined) return {};
	const dot = text.indexOf(".");
	if (dot < 1 || dot === text.length - 1)
		throw usageError(
			`--composition takes <pack>.<composition>, not '${text}'`,
			"Write it as greet.hello",
		);
	return { pack: text.slice(0, dot), composition: text.slice(dot + 1) };
}

/** How many names an error listing matches shows. */
const LISTED = 5;

/** `names` comma-joined, the first few only, then how many more there are. */
export function listedOf(names: readonly string[]): string {
	const more = names.length - LISTED;
	return `${names.slice(0, LISTED).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** Whether `name` ends in the `/`-separated segments of `text`, each equal to its segment with or without its keys. */
function endsIn(name: string, text: string): boolean {
	const own = name.split("/");
	const given = text.split("/");
	const start = own.length - given.length;
	return (
		start >= 0 &&
		given.every((segment, i) => {
			const at = own[start + i] ?? "";
			return segment === at || segment === withoutKeys(at);
		})
	);
}

/**
 * The one of `names` that `text` names: itself, else the one it is a whole-segment ending of, such as `build` for
 * `loop[0]/build`.
 * @throws CliError, a usage error naming `maestro ls <concert>` when it names none, or listing the names it ends.
 */
export function resolveInstanceName(
	text: string,
	names: Iterable<string>,
	concert: string,
): string {
	const all = new Set(names);
	if (all.has(text)) return text;
	const matching = [...all].filter((name) => endsIn(name, text)).sort();
	if (matching.length > 1)
		throw usageError(
			`'${text}' ends ${matching.length} instances: ${listedOf(matching)}`,
			"Name one of them in full",
		);
	if (matching[0] === undefined)
		throw usageError(
			`no instance '${text}' in concert ${concert}`,
			`List them with 'maestro ls ${concert}'`,
		);
	return matching[0];
}

const WHOLE_NUMBER = /^[1-9]\d*$/;

/**
 * `text` as a positive whole number.
 * @throws CliError, a usage error naming `flag`, for anything else.
 */
export function parseCount(flag: string, text: string): number {
	if (!WHOLE_NUMBER.test(text))
		throw usageError(
			`${flag} takes a positive whole number, not '${text}'`,
			"Write it as 20",
		);
	return Number(text);
}
