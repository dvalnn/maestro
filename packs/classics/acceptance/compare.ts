// Extracts a comparable trace from a maestro concert or an sssf run, and diffs two traces:
//   bun compare.ts maestro --record <record.db> --concert <id> --target <setup dir>
//   sssf ls <run id> --json | bun compare.ts sssf --target <setup dir>
//   bun compare.ts diff <a.json> <b.json>
// The setup dir is the one setup.ts made: it holds target/ and refs.txt.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { concertDirs, openRecord, perform } from "@maestro/core/perform";
import { AGENT_KIND, CHECK_KIND, repoHost } from "@maestro/host-repo";
import { buildIr } from "@maestro/testkit";
import { BASE, EXIT, git, refsOf } from "./setup";
import { touched } from "./touched";

const USAGE = `usage: bun compare.ts maestro --record <record.db> --concert <id> --target <setup dir>
       bun compare.ts sssf --target <setup dir> < run.json
       bun compare.ts diff <a.json> <b.json>`;

type Run = "agent" | "check";
const OUTCOMES = ["accepted", "rejected", "failed"] as const;
type Outcome = (typeof OUTCOMES)[number];
type Trace = {
	runs: Run[];
	outcome: Outcome;
	files: string[];
	clean: boolean;
};

const RUN_OF_KIND: Readonly<Record<string, Run>> = {
	[AGENT_KIND]: "agent",
	[CHECK_KIND]: "check",
};
const SSSF_CHECK_STAGE = "quality";
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/gm;

/** Throws an error that says what went wrong, then the likely fix on its own line. */
function fail(what: string, fix: string): never {
	throw new Error(`${what}\n${fix}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The files the patches in `dir` touch, each once, sorted. */
function filesIn(dir: string): string[] {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".patch"))
		.flatMap((f) =>
			[...readFileSync(join(dir, f), "utf8").matchAll(DIFF_GIT)].flatMap(
				([, a, b]) => [a, b],
			),
		)
		.filter((f): f is string => f !== undefined);
	return [...new Set(files)].sort();
}

/**
 * Whether the target in setup dir `dir` has no uncommitted change and the refs `setup.ts` recorded.
 * @throws Error when `dir` is not a setup dir.
 */
function isClean(dir: string): boolean {
	const target = join(dir, "target");
	const refs = join(dir, "refs.txt");
	if (!existsSync(target) || !existsSync(refs))
		fail(
			`${dir} is not a setup dir: it has no target/ or refs.txt`,
			"Pass --target the setup dir setup.ts made",
		);
	return (
		git(target, "status", "--porcelain") === "" &&
		refsOf(target) === readFileSync(refs, "utf8")
	);
}

/**
 * The trace of concert `concert` in the record at `record`, whose data root is the record's directory.
 * @throws Error when there is no such record or concert, or the concert is still running.
 */
export async function maestroTrace(
	record: string,
	concert: string,
	dir: string,
): Promise<Trace> {
	if (!existsSync(record))
		fail(
			`no record at ${record}`,
			"Pass --record the record.db the concert ran into",
		);
	const records = openRecord(record);
	try {
		const found = records.find(concert);
		if (!found) fail(`no concert '${concert}' in ${record}`, "Check --concert");
		const result = records.result(concert);
		if (!result)
			fail(`concert '${concert}' is still running`, "Compare it once it ends");
		const kinds = new Map(found.ir.nodes.map((n) => [n.id, n.kind]));
		const runs = records
			.instances(concert)
			.filter((i) => i.startedAt !== undefined)
			.map((i) => ({ i, run: RUN_OF_KIND[kinds.get(i.node) ?? ""] }));
		const lane = runs.findLast(({ run }) => run === "check")?.i.outputs?.lane;
		return {
			runs: runs.flatMap(({ run }) => (run ? [run] : [])),
			outcome: result.outcome === "ok" ? "accepted" : result.outcome,
			files:
				typeof lane === "string"
					? await touchedFiles(dirname(record), lane, dir)
					: [],
			clean: isClean(dir),
		};
	} finally {
		records.close();
	}
}

/**
 * The files lane version `lane` changes, by performing `touched` on it in a throwaway record, under `dataRoot`.
 * @throws Error when the changeset does not settle `ok`.
 */
async function touchedFiles(
	dataRoot: string,
	lane: string,
	dir: string,
): Promise<string[]> {
	const work = await mkdtemp(join(tmpdir(), "maestro-touched-"));
	try {
		const values = {
			dataRoot,
			target: { repo: join(dir, "target"), base: BASE },
		};
		const concert = await perform({
			ir: buildIr(touched, { lane }),
			config: { values, sources: [], layers: [] },
			roots: { user: join(work, "roots"), packs: {} },
			hosts: [repoHost({ harnesses: [] })],
			loadCode: async (ref) => {
				throw new Error(`touched runs no code, got '${ref.export}'`);
			},
			recordPath: join(work, "record.db"),
			dir: work,
			concurrency: 1,
		});
		const result = await concert.done;
		const changeset = result.outputs?.changeset;
		if (result.outcome !== "ok" || !isRecord(changeset))
			fail(
				`cannot read lane '${lane}': ${"reason" in result ? result.reason : "it has no changeset"}`,
				"Pass --record the record.db in the data root the concert ran under",
			);
		const { path } = changeset;
		if (typeof path !== "string")
			fail(`lane '${lane}' gave a changeset with no path`, "Check --record");
		return filesIn(join(concertDirs(work, concert.id).artifacts, path));
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

type Leg = { ref: string; stage?: string; state: string };

const NOT_A_RUN = [
	"stdin is not an sssf run",
	"Pipe in the output of 'sssf ls <run id> --json'",
] as const;

/** `value` as a leg of an sssf run. @throws Error when it is not one. */
function legOf(value: unknown): Leg {
	if (
		!isRecord(value) ||
		typeof value.ref !== "string" ||
		typeof value.state !== "string"
	)
		fail(...NOT_A_RUN);
	const { ref, state, stage } = value;
	return { ref, state, ...(typeof stage === "string" && { stage }) };
}

/**
 * The trace of the sssf run `view`, the JSON of `sssf ls <run id> --json`: its outcome is its last leg's.
 * @throws Error when `view` is not a run, has no leg, or its last leg has not settled.
 */
export function sssfTrace(view: unknown, dir: string): Trace {
	if (
		!isRecord(view) ||
		typeof view.series_dir !== "string" ||
		!Array.isArray(view.legs)
	)
		fail(...NOT_A_RUN);
	const legs = view.legs.map(legOf);
	const last = legs.at(-1);
	if (!last) fail("the run has no leg", "Compare a run that performed");
	const outcome = OUTCOMES.find((o) => o === last.state);
	if (!outcome)
		fail(`leg ${last.ref} is ${last.state}`, "Compare a run that has ended");
	if (!existsSync(view.series_dir))
		fail(
			`no series dir at ${view.series_dir}`,
			"Run compare on the machine the sssf run wrote it on",
		);
	return {
		runs: legs.map((l) => (l.stage === SSSF_CHECK_STAGE ? "check" : "agent")),
		outcome,
		files: filesIn(view.series_dir),
		clean: isClean(dir),
	};
}

/** One line per field whose value differs between `a` and `b`. */
export function diff(
	a: Readonly<Record<string, unknown>>,
	b: Readonly<Record<string, unknown>>,
): string[] {
	const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])];
	return fields.flatMap((f) => {
		const [x, y] = [JSON.stringify(a[f]), JSON.stringify(b[f])];
		return x === y ? [] : [`${f}: ${x} != ${y}`];
	});
}

function usage(): never {
	console.error(USAGE);
	process.exit(EXIT.trouble);
}

/** The trace in `file`. @throws Error naming the file when it holds no JSON object. */
function readTrace(file: string): Record<string, unknown> {
	const fix = "Pass a trace that compare.ts printed";
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		fail(`cannot read ${file}: ${messageOf(error)}`, fix);
	}
	if (!isRecord(value)) fail(`${file} holds no trace`, fix);
	return value;
}

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** Prints each line where the traces in files `a` and `b` differ, and returns the exit code. */
function diffFiles(positionals: string[]): number {
	const [a, b] = positionals;
	if (positionals.length !== 2 || !a || !b) usage();
	const lines = diff(readTrace(a), readTrace(b));
	for (const line of lines) console.log(line);
	return lines.length ? EXIT.mismatch : EXIT.ok;
}

type Flags = { record?: string; concert?: string; target?: string };

/** What stdin holds, as JSON. @throws Error when it is not JSON. */
async function stdinJson(): Promise<unknown> {
	try {
		return await Bun.stdin.json();
	} catch {
		fail(...NOT_A_RUN);
	}
}

/** The trace `command` extracts, as its flags name it. */
async function extract(command: string | undefined, flags: Flags) {
	const { record, concert, target } = flags;
	if (!target) usage();
	if (command === "maestro" && record && concert)
		return maestroTrace(resolve(record), concert, resolve(target));
	if (command === "sssf") return sssfTrace(await stdinJson(), resolve(target));
	usage();
}

/** `args` parsed. Exits with the usage when they hold an unknown flag. */
function parsed(args: string[]) {
	try {
		return parseArgs({
			args,
			options: {
				record: { type: "string" },
				concert: { type: "string" },
				target: { type: "string" },
			},
			allowPositionals: true,
		});
	} catch (error) {
		console.error(messageOf(error));
		usage();
	}
}

async function main([command, ...args]: string[]): Promise<number> {
	const { values, positionals } = parsed(args);
	if (command === "diff") return diffFiles(positionals);
	if (positionals.length) usage();
	console.log(JSON.stringify(await extract(command, values), null, "\t"));
	return EXIT.ok;
}

if (import.meta.main) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		console.error(messageOf(error));
		process.exitCode = EXIT.trouble;
	}
}
