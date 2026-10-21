import { join } from "node:path";
import { ConfigError } from "@maestro/core/config";
import type {
	ConcertRecord,
	ConcertResult,
	ConcertStatus,
	Records,
	Unresumable,
} from "@maestro/core/perform";
import {
	ARTIFACT_TYPES,
	type ArtifactRef,
	type Diagnostic,
	DURATION_EXAMPLE,
	durationMs,
	findMarked,
	formatInstance,
	type Ir,
	indexGraph,
	isPlainObject,
	type NodeInstance,
	replaceAt,
} from "@maestro/ir";
import {
	closingBlock,
	padCells,
	shortIds,
	styled,
	tokensOf,
	type View,
} from "@maestro/render-text/live";
import type { Colors, Deps } from "./command";

/** The exit codes of every command. */
export const EXIT = {
	ok: 0,
	failed: 1,
	usage: 2,
	rejected: 3,
	timeout: 124,
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

const located = ({ source }: Diagnostic) =>
	source
		? `${source.file}:${source.line}${source.column === undefined ? "" : `:${source.column}`}: `
		: "";

const paint = (
	style: Parameters<typeof styled>[0],
	text: string,
	color: boolean,
) => (color ? styled(style, text) : text);

/**
 * A diagnostic as two lines: the source location when known, the code and message, then the hint. With `color` the code
 * is red, or yellow for a warning, and the hint dim.
 */
export function renderDiagnostic(d: Diagnostic, color: boolean): string {
	const warning = d.severity === "warning";
	const label = paint(
		warning ? "yellow" : "red",
		warning ? `warning ${d.code}` : d.code,
		color,
	);
	const where = d.message.startsWith(located(d)) ? "" : located(d);
	return `${where}${label}: ${d.message}\n  ${paint("dim", d.hint, color)}`;
}

/** `message` with its second line dim when `color`, if it is two lines: a hint, not a longer text. */
export function hinted(message: string, color: boolean): string {
	const [what, fix, ...more] = message.split("\n");
	return fix === undefined || more.length > 0
		? message
		: `${what}\n${paint("dim", fix, color)}`;
}

/** Rows of cells in columns two spaces apart, without trailing spaces. A cell's width leaves out its color codes. */
export function table(rows: readonly (readonly string[])[]): string {
	const widths = rows.reduce<number[]>(
		(w, row) =>
			row.map((cell, i) => Math.max(w[i] ?? 0, Bun.stringWidth(cell))),
		[],
	);
	return rows
		.map((row) =>
			row
				.map((cell, i) => padCells(cell, widths[i] ?? 0))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
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

/** `value` as the one JSON document a command prints with `--json`. */
export const jsonOf = (value: unknown) => JSON.stringify(value, null, 2);

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

/** `path` with the home directory `home` at its start shown as `~`. */
const tildeOf = (path: string, home: string | undefined) =>
	home && (path === home || path.startsWith(`${home}/`))
		? `~${path.slice(home.length)}`
		: path;

/**
 * How a closing block shows: colored on each stream `color` names. With `artifacts`, the concert's artifact area, it
 * holds where and why the concert ended and its outputs; without, its `concert` row alone.
 */
type Closing = { color: Colors; artifacts?: string };

/**
 * Prints how the settled concert `row` ended: its `concert` row, and where and why when not ok, on stderr, then the
 * outputs of `result` on stdout. On a terminal stderr the reason wraps at its width; on a terminal stdout an artifact
 * path starts `~` for home.
 */
export function printClosing(
	deps: Deps,
	store: Records,
	row: ConcertRecord,
	result: ConcertResult,
	{ color, artifacts }: Closing,
) {
	const { terminal, stderrTerminal } = deps;
	const view = viewOf(row, color.err, {
		rows: 0,
		columns: stderrTerminal?.().columns ?? 0,
		tokens: tokensOf(store.metrics(row.id)),
		unique: shortIds(store.ids()).unique(row.id),
	});
	const area =
		terminal && artifacts !== undefined
			? tildeOf(artifacts, deps.env.HOME)
			: artifacts;
	const block = closingBlock(
		view,
		area === undefined
			? undefined
			: {
					at: atOf(row.ir, result),
					reason: reasonOf(result),
					outputs: outputRows(row.ir, area, result),
				},
		color.out,
	);
	deps.stderr(block.head);
	if (block.outputs !== undefined) deps.stdout(block.outputs);
}

/** The instance `result` settled at, when it is not ok. */
const atOf = (ir: Ir, result: ConcertResult) =>
	result.outcome === "ok" ||
	result.node === undefined ||
	result.expansion === undefined
		? undefined
		: instanceName(ir, { node: result.node, expansion: result.expansion });

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

const isArtifactRef = (value: unknown): value is ArtifactRef =>
	isPlainObject(value) && typeof value.path === "string";

/** A control character, or a line or paragraph separator: anything that would break a string's line. */
const BREAKING = /[\p{Cc}\u2028\u2029]/u;
/** The separators `JSON.stringify` leaves as they are. */
const SEPARATORS = /[\u2028\u2029]/g;

/**
 * `value` on one line: a string without a control character or line separator, a number, a boolean or null as it is,
 * else compact JSON.
 */
const oneLine = (value: unknown) =>
	(typeof value === "string" && !BREAKING.test(value)) ||
	typeof value === "number" ||
	typeof value === "boolean" ||
	value === null
		? String(value)
		: JSON.stringify(value).replace(
				SEPARATORS,
				(c) => `\\u${c.charCodeAt(0).toString(16)}`,
			);

/**
 * The outputs of `result` as a port and its value on one line, with each artifact in a value replaced by its path in
 * the artifact area `artifacts`.
 */
function outputRows(
	ir: Ir,
	artifacts: string,
	result: ConcertResult,
): [port: string, value: string][] {
	const out = ir.nodes.find((n) => n.id === result.node)?.out ?? {};
	return Object.entries(result.outputs ?? {}).map(([port, value]) => {
		let shown = structuredClone(value);
		for (const { type, pointer, value: ref } of findMarked(
			out[port] ?? {},
			value,
		))
			if (ARTIFACT_TYPES.has(type) && isArtifactRef(ref))
				shown = replaceAt(shown, pointer, join(artifacts, ref.path));
		return [port, oneLine(shown)];
	});
}

/** The error of a command that finds concert `id` running, which a command on settled concerts refuses. */
export const stillRunning = (id: string, pid: number) =>
	new CliError(
		`concert ${id} is still running in process ${pid}\nWait for it with 'maestro wait ${id}', or stop it with 'maestro kill ${id}'`,
	);

/** The error of `perform --resume` for a concert core refuses to resume. */
export const resumeRefused = ({ concert }: Unresumable) =>
	concert.status === "running"
		? stillRunning(concert.id, concert.pid)
		: new CliError(
				`concert ${concert.id} finished ok, so it has nothing to resume\nPerform its composition as a new concert with 'maestro perform <composition>'`,
			);

const TOUR = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOUR_MAX_LENGTH = 64;

/**
 * `text` as a tour slug: lower-case letters and digits in words joined by single hyphens, at most 64 characters.
 * @throws CliError, a usage error naming `source`, for anything else.
 */
export function parseTour(source: string, text: string): string {
	if (!TOUR.test(text) || text.length > TOUR_MAX_LENGTH)
		throw usageError(
			`${source} takes a slug of at most ${TOUR_MAX_LENGTH} characters, not '${text}'`,
			"Write it in lower-case words joined by hyphens, such as release-2-3",
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

/** `instance` of `ir`'s graph as one name, such as `lens[risk]/skeptic`. */
export const instanceName = (ir: Ir, instance: NodeInstance) =>
	formatInstance(instance, indexGraph(ir).groupsOf(instance.node));

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
