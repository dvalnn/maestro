import { ConfigError } from "@maestro/core/config";
import type { ConcertResult, ConcertStatus } from "@maestro/core/perform";
import type { NodeInstance } from "@maestro/core/worker";
import {
	type Diagnostic,
	formatInstance,
	type Ir,
	indexGraph,
} from "@maestro/ir";

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

/** A diagnostic as two lines: the source location when known, the code and message, then the hint. */
export function renderDiagnostic(d: Diagnostic): string {
	const label = d.severity === "warning" ? `warning ${d.code}` : d.code;
	const where = d.message.startsWith(located(d)) ? "" : located(d);
	return `${where}${label}: ${d.message}\n  ${d.hint}`;
}

/** Rows of cells in columns two spaces apart, without trailing spaces. */
export function table(rows: readonly (readonly string[])[]): string {
	const widths = rows.reduce<number[]>(
		(w, row) => row.map((cell, i) => Math.max(w[i] ?? 0, cell.length)),
		[],
	);
	return rows
		.map((row) =>
			row
				.map((cell, i) => cell.padEnd(widths[i] ?? 0))
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

const COUNT = "[1-9]\\d*";
const DURATION = new RegExp(`^${COUNT}[smhd]$`);
const WHOLE_NUMBER = new RegExp(`^${COUNT}$`);
export const MS_PER_UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `text` as milliseconds: a positive integer and one unit of `s`, `m`, `h` or `d`, such as `90s` or `7d`.
 * @throws CliError, a usage error naming `flag`, for anything else.
 */
export function parseDuration(flag: string, text: string): number {
	if (!DURATION.test(text))
		throw usageError(
			`${flag} takes a positive whole number and one unit, not '${text}'`,
			`Write it as 90s, 15m, 12h or 7d`,
		);
	const unit = text.slice(-1) as keyof typeof MS_PER_UNIT;
	return Number(text.slice(0, -1)) * MS_PER_UNIT[unit];
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
} => ({
	id,
	status: result?.outcome ?? "running",
	resultNode: result?.node,
	resultExpansion: result?.expansion,
	reason: reasonOf(result),
});

/** The error of a command that finds concert `id` running, which a command on settled concerts refuses. */
export const stillRunning = (id: string, pid: number) =>
	new CliError(
		`concert ${id} is still running in process ${pid}\nWait for it with 'maestro wait ${id}', or stop it with 'maestro kill ${id}'`,
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

/** `instance` of `ir`'s graph as one name, such as `lens[risk]/skeptic`. */
export const instanceName = (ir: Ir, instance: NodeInstance) =>
	formatInstance(instance, indexGraph(ir).groupsOf(instance.node));

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
