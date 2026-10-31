import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { isJson, type Json } from "./json";

/** How many of a milestone's newest concerts the tick reads: one runs at a time, so the newest settle is among them. */
const WINDOW = 20;
/** How long a detached perform has to announce its concert. */
const START_TIMEOUT_MS = 120_000;
const POLL_MS = 200;
const ANNOUNCE = /^concert (\S+)$/m;
const LOG_TAIL = 600;

export type Concert = {
	id: string;
	status: string;
	pack: string;
	composition: string;
	tour?: string;
};
export type Result = {
	status: string;
	reason?: string;
	outputs: Record<string, unknown>;
};
/**
 * What a settled concert's agents reported, and its spend: `tokens` totals its `tokens_*` metrics but
 * `tokens_reasoning`, and `upheld` is the body of the last review round's upheld findings, if a review ran.
 */
export type Report = {
	tokens: number;
	obstacles: string[];
	gaps: string[];
	upheld?: string;
};

/** maestro as the tick sees it, through its `--json` documents. */
export type Maestro = {
	/** The newest concerts on `tour` and the tours under it, newest first. */
	concerts(tour: string): Promise<Concert[]>;
	result(id: string): Promise<Result>;
	/**
	 * Starts `maestro <args>` detached, its output written to `log`, and returns the concert id it announces.
	 * @throws Error with the log's tail when it exits before announcing one, or does not announce one in time.
	 */
	start(args: string[], log: string): Promise<string>;
	report(id: string): Promise<Report>;
	/**
	 * Applies concert `id`'s changeset to the checkout at `dir`, staged.
	 * @throws Error with maestro's message when it does not apply.
	 */
	apply(id: string, dir: string): Promise<void>;
};

function str(o: Json, key: string): string {
	const v = o[key];
	if (typeof v !== "string") throw new Error(`maestro: ${key} is not a string`);
	return v;
}

const concertOf = (o: unknown): Concert => {
	if (!isJson(o)) throw new Error("maestro: a concert is not an object");
	return {
		id: str(o, "id"),
		status: str(o, "status"),
		pack: str(o, "pack"),
		composition: str(o, "composition"),
		tour: typeof o.tour === "string" ? o.tour : undefined,
	};
};

function resultOf(doc: unknown): Result {
	if (!isJson(doc)) throw new Error("maestro: the result is not an object");
	return {
		status: str(doc, "status"),
		reason: typeof doc.reason === "string" ? doc.reason : undefined,
		outputs: isJson(doc.outputs) ? doc.outputs : {},
	};
}

/** Output tokens already count reasoning tokens. */
const tokensOf = (metrics: Json) =>
	Object.entries(metrics)
		.filter(([k]) => k.startsWith("tokens_") && k !== "tokens_reasoning")
		.reduce((sum, [, v]) => sum + (typeof v === "number" ? v : 0), 0);

const strings = (v: unknown) =>
	Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];

/** Each report's `key` entries, over the `reports` of an `ls <concert> --json` document. */
const entriesOf = (reports: unknown, key: string) =>
	Object.values(isJson(reports) ? reports : {}).flatMap((r) =>
		isJson(r) ? strings(r[key]) : [],
	);

/** The body of the `upheld` file the last fresh `upheld` port of an `art <concert> --json` list names. */
function upheldOf(artifacts: unknown): string | undefined {
	const last = (Array.isArray(artifacts) ? artifacts : [])
		.filter(isJson)
		.findLast((a) => a.port === "upheld" && a.stale !== true);
	if (typeof last?.path !== "string" || !existsSync(last.path))
		return undefined;
	return readFileSync(last.path, "utf8")
		.replace(/^# .*\n/, "")
		.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What a perform that announced no concert printed: its refusal's diagnostics, one per line, else the log's tail. */
function output(log: string): string {
	const text = readFileSync(log, "utf8");
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return text.slice(-LOG_TAIL).trim();
	}
	const diagnostics =
		isJson(doc) && Array.isArray(doc.diagnostics) ? doc.diagnostics : [];
	return diagnostics
		.filter(isJson)
		.map(
			(d) =>
				`${d.code}: ${d.message}${typeof d.hint === "string" ? `\n  ${d.hint}` : ""}`,
		)
		.join("\n");
}

/**
 * Runs `bin <args>`.
 * @throws Error with its stderr when it exits non-zero.
 */
async function run(bin: string, args: string[]) {
	const child = Bun.spawn([bin, ...args], { stdout: "ignore", stderr: "pipe" });
	const [err, code] = await Promise.all([
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(
			`maestro ${args.slice(0, 2).join(" ")}: ${err.trim() || `exit ${code}`}`,
		);
}

/**
 * The `--json` document `bin <args>` prints, whatever its exit code, since `wait` exits with the concert's.
 * @throws Error with its stderr when it prints none.
 */
async function json(bin: string, args: string[]): Promise<unknown> {
	const child = Bun.spawn([bin, ...args, "--json"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	try {
		return JSON.parse(out);
	} catch {
		throw new Error(`maestro ${args[0]}: ${err.trim() || "no JSON document"}`);
	}
}

export function maestro(bin = "maestro"): Maestro {
	return {
		concerts: async (tour) => {
			const rows = await json(bin, [
				"ls",
				"--tour",
				tour,
				"--limit",
				`${WINDOW}`,
			]);
			if (!Array.isArray(rows)) throw new Error("maestro ls: not a list");
			return rows.map(concertOf);
		},
		result: async (id) => resultOf(await json(bin, ["wait", id])),
		report: async (id) => {
			const [doc, artifacts] = await Promise.all([
				json(bin, ["ls", id]),
				json(bin, ["art", id]),
			]);
			if (!isJson(doc)) throw new Error("maestro ls: not an object");
			return {
				tokens: tokensOf(isJson(doc.metrics) ? doc.metrics : {}),
				obstacles: entriesOf(doc.reports, "obstacles"),
				gaps: entriesOf(doc.reports, "gaps"),
				upheld: upheldOf(artifacts),
			};
		},
		apply: (id, dir) => run(bin, ["cs", "apply", id, "-C", dir]),
		start: async (args, log) => {
			const fd = openSync(log, "w");
			const child = spawn(bin, [...args, "--json"], {
				detached: true,
				stdio: ["ignore", fd, fd],
			});
			closeSync(fd);
			let exited = false;
			child.on("exit", () => {
				exited = true;
			});
			for (let waited = 0; waited < START_TIMEOUT_MS; waited += POLL_MS) {
				// Read after taking `exited`, so a perform that announced and exited is never taken for a refusal.
				const done = exited;
				const id = ANNOUNCE.exec(readFileSync(log, "utf8"))?.[1];
				if (id) {
					child.unref();
					return id;
				}
				if (done) throw new Error(`maestro ${args[0]}:\n${output(log)}`);
				await sleep(POLL_MS);
			}
			child.unref();
			throw new Error(
				`maestro ${args[0]} announced no concert:\n${output(log)}`,
			);
		},
	};
}
