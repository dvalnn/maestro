// The replay bench (docs/agents/bench.md): starts one arm's five slice concerts, and prints every arm's results.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	type Concert,
	maestro,
	type Report,
	type Spend,
} from "./factory/maestro";
import { elapsed, shorthand, unresolvedOf } from "./factory/route";

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const USAGE = `usage: bun scripts/bench.ts start <arm> <dir> [<ticket>...] [-- <perform flag>...]
       bun scripts/bench.ts table [--json]`;
const TOUR = "bench";
const SLICE_FILE = join(import.meta.dir, "../.maestro/slice.ts");
/** How many of the bench's newest concerts the table reads. */
const WINDOW = 200;

/** The bench's fixed tickets. */
const TICKETS = [246, 334, 336, 360, 335];

type Row = {
	arm: string;
	ticket: number;
	status: string;
	fixes: number;
	converged: boolean | null;
	pinned: number | null;
	deferred: number | null;
	untestable: number | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	elapsedMs: number;
};

const tourOf = (arm: string, issue: number) => `${TOUR}.${arm}.i${issue}`;
const TOUR_PATTERN = new RegExp(`^${TOUR}\\.([^.]+)\\.i(\\d+)$`);

/**
 * The text of the recorded `<issue>.<ext>` in `dir`.
 * @throws Error naming the file when it is missing.
 */
function recorded(dir: string, issue: number, ext: string) {
	const file = join(dir, `${issue}.${ext}`);
	if (!existsSync(file))
		throw new Error(
			`${file} is missing\nRecord it as docs/agents/bench.md says`,
		);
	return readFileSync(file, "utf8").trim();
}

/**
 * The perform arguments of each of `issues`' replays: its recorded request, base and presets from `dir`, then `extra`.
 * @throws Error naming the first recorded file that is missing.
 */
function plan(arm: string, dir: string, issues: number[], extra: string[]) {
	return TICKETS.filter((issue) => issues.includes(issue)).map((issue) => {
		const presets = recorded(dir, issue, "presets").split(/\s+/);
		return {
			issue,
			args: [
				"perform",
				SLICE_FILE,
				"--request",
				recorded(dir, issue, "md"),
				...presets.flatMap((p) => ["--preset", p]),
				...extra,
				"--tour",
				tourOf(arm, issue),
				"--title",
				`bench #${issue} ${arm}`,
				"-c",
				`target.base=${recorded(dir, issue, "base")}`,
			],
		};
	});
}

/**
 * Starts the replays of `issues` under `arm` detached, printing `#<ticket> <concert id>` for each.
 * @throws Error when `arm` is not one tour segment, or a recorded file is missing.
 */
async function start(
	arm: string,
	dir: string,
	issues: number[],
	extra: string[],
) {
	if (arm.includes("."))
		throw new Error(
			`arm '${arm}' holds a dot\nName the arm without dots, such as main-54cebcdb`,
		);
	const started = plan(arm, dir, issues, extra);
	for (const { issue, args } of started)
		console.log(`#${issue} ${await maestro().start(args)}`);
}

/** The row of concert `c` on `arm`'s ticket, `report` being none while it runs. */
const rowOf = (
	c: Concert,
	[, arm = "", ticket = ""]: string[],
	spend: Spend,
	report?: Report,
): Row => ({
	arm,
	ticket: Number(ticket),
	status: c.status,
	fixes: spend.fixes,
	converged: report ? c.status === "ok" && !unresolvedOf(report.upheld) : null,
	pinned: report?.tests?.pinned ?? null,
	deferred: report?.tests?.deferred ?? null,
	untestable: report?.tests?.untestable ?? null,
	input: spend.input,
	output: spend.output,
	cacheRead: spend.cacheRead,
	cacheWrite: spend.cacheWrite,
	elapsedMs: spend.elapsedMs,
});

/** The rows of every concert on the bench's tours, by arm, ticket, then start. */
async function rows(): Promise<Row[]> {
	const m = maestro();
	const found = await Promise.all(
		(await m.concerts(TOUR, WINDOW)).map(async (c) => {
			const tour = TOUR_PATTERN.exec(c.tour ?? "");
			if (!tour) return undefined;
			const [spend, report] = await Promise.all([
				m.spend(c.id),
				c.status === "running" ? undefined : m.report(c.id),
			]);
			return { at: c.startedAt ?? 0, row: rowOf(c, tour, spend, report) };
		}),
	);
	return found
		.filter((f) => f !== undefined)
		.sort(
			(a, b) =>
				a.row.arm.localeCompare(b.row.arm) ||
				a.row.ticket - b.row.ticket ||
				a.at - b.at,
		)
		.map((f) => f.row);
}

const unknown = (n: number | null) => (n === null ? "-" : `${n}`);
const verdict = (converged: boolean | null) =>
	converged === null ? "-" : converged ? "yes" : "no";

const HEADER = [
	"arm",
	"ticket",
	"status",
	"fixes",
	"converged",
	"pinned",
	"deferred",
	"untestable",
	"in",
	"out",
	"cache read",
	"cache write",
	"time",
];

/** `found` as an aligned text table. */
function render(found: Row[]) {
	const cells = [
		HEADER,
		...found.map((r) => [
			r.arm,
			`#${r.ticket}`,
			r.status,
			`${r.fixes}`,
			verdict(r.converged),
			unknown(r.pinned),
			unknown(r.deferred),
			unknown(r.untestable),
			shorthand(r.input),
			shorthand(r.output),
			shorthand(r.cacheRead),
			shorthand(r.cacheWrite),
			elapsed(r.elapsedMs),
		]),
	];
	const widths = HEADER.map((_, i) =>
		Math.max(...cells.map((row) => (row[i] ?? "").length)),
	);
	return cells
		.map((row) =>
			row
				.map((cell, i) => cell.padEnd(widths[i] ?? 0))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

class UsageError extends Error {}

/** The ticket numbers in `words`, all five when it is empty. */
function ticketsOf(words: string[]) {
	const all = TICKETS;
	if (!words.length) return all;
	const issues = words.map(Number);
	const unknownIssue = words.find((_, i) => !all.includes(issues[i] ?? 0));
	if (unknownIssue !== undefined)
		throw new UsageError(`'${unknownIssue}' is not a bench ticket`);
	return issues;
}

async function main(argv: string[]) {
	const cut = argv.indexOf("--");
	const own = cut < 0 ? argv : argv.slice(0, cut);
	const extra = cut < 0 ? [] : argv.slice(cut + 1);
	const { values, positionals } = parseArgs({
		args: own,
		options: { json: { type: "boolean" } },
		allowPositionals: true,
	});
	const [verb, arm, dir, ...issues] = positionals;
	if (verb === "start" && arm && dir)
		return start(arm, dir, ticketsOf(issues), extra);
	if (verb === "table" && !arm) {
		const found = await rows();
		console.log(values.json ? JSON.stringify(found, null, 2) : render(found));
		return;
	}
	throw new UsageError("");
}

/** Whether `error` is a usage mistake: this script's own, or one `parseArgs` threw. */
const isUsage = (error: unknown) =>
	error instanceof UsageError ||
	(error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		error.code.startsWith("ERR_PARSE_ARGS"));

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error) => {
		const text = error instanceof Error ? error.message : String(error);
		const usage = isUsage(error);
		console.error(usage ? `${text}\n${USAGE}`.trim() : `bench: ${text}`);
		process.exit(usage ? EXIT_USAGE : EXIT_FAILED);
	});
}
