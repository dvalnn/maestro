import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJson, type Json } from "./json";

/** How many of a milestone's newest concerts the tick reads: one runs at a time, so the newest settle is among them. */
const WINDOW = 20;

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
 * What one slice concert spent: its run time and tokens by kind, reasoning tokens counted in `output`, and whether it
 * was an encore of another concert.
 */
export type Spend = {
	short: string;
	elapsedMs: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	encore: boolean;
};
/** What a settled concert's agents reported: `upheld` is the body of the upheld findings the concert returned, if any. */
export type Report = {
	obstacles: string[];
	gaps: string[];
	upheld?: string;
	/** The PR body the slice's writer wrote. */
	pr?: string;
};

/** maestro as the tick sees it, through its `--json` documents. */
export type Maestro = {
	/** The newest concerts on `tour` and the tours under it, newest first. */
	concerts(tour: string): Promise<Concert[]>;
	result(id: string): Promise<Result>;
	/**
	 * Starts `maestro <args>` in the background and returns its concert's id.
	 * @throws Error with maestro's refusal when it does not start.
	 */
	start(args: string[]): Promise<string>;
	report(id: string): Promise<Report>;
	/** What concert `id` spent. */
	spend(id: string): Promise<Spend>;
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

const strings = (v: unknown) =>
	Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];

/** Each report's `key` entries, over the `reports` of an `ls <concert> --json` document. */
const entriesOf = (reports: unknown, key: string) =>
	Object.values(isJson(reports) ? reports : {}).flatMap((r) =>
		isJson(r) ? strings(r[key]) : [],
	);

const metric = (metrics: unknown, name: string) => {
	const value = isJson(metrics) ? metrics[name] : undefined;
	return typeof value === "number" ? value : 0;
};

/** The spend of an `ls <concert> --json` document. */
function spendOf(doc: unknown): Spend {
	if (!isJson(doc)) throw new Error("maestro ls: not an object");
	return {
		short: str(doc, "short"),
		elapsedMs: typeof doc.elapsedMs === "number" ? doc.elapsedMs : 0,
		input: metric(doc.metrics, "tokens_in"),
		output: metric(doc.metrics, "tokens_out"),
		cacheRead: metric(doc.metrics, "tokens_cache_read"),
		cacheWrite: metric(doc.metrics, "tokens_cache_write"),
		encore: typeof doc.encoreOf === "string",
	};
}

/** The text of output `name` of a `wait <concert> --json` document, under the concert's `artifacts`, trimmed. */
function outputText(doc: unknown, name: string): string | undefined {
	if (!isJson(doc) || typeof doc.artifacts !== "string") return undefined;
	const output = isJson(doc.outputs) ? doc.outputs[name] : undefined;
	if (!isJson(output) || typeof output.path !== "string") return undefined;
	const path = join(doc.artifacts, output.path);
	return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

/** The body of the `upheld` output of a `wait <concert> --json` document, under its heading. */
const upheldOf = (doc: unknown) =>
	outputText(doc, "upheld")
		?.replace(/^# .*\n/, "")
		.trim();

/** The writer's PR body in the `pr` output of a `wait <concert> --json` document, when it wrote one. */
const prOf = (doc: unknown) => outputText(doc, "pr") || undefined;

/** What a perform that started no concert printed: its error, else its refusal's diagnostics, one per line. */
function refusal(doc: unknown): string {
	if (isJson(doc) && typeof doc.error === "string") return doc.error;
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
			const [doc, result] = await Promise.all([
				json(bin, ["ls", id]),
				json(bin, ["wait", id]),
			]);
			if (!isJson(doc)) throw new Error("maestro ls: not an object");
			return {
				obstacles: entriesOf(doc.reports, "obstacles"),
				gaps: entriesOf(doc.reports, "gaps"),
				upheld: upheldOf(result),
				pr: prOf(result),
			};
		},
		spend: async (id) => spendOf(await json(bin, ["ls", id])),
		apply: (id, dir) => run(bin, ["cs", "apply", id, "-C", dir]),
		start: async (args) => {
			const doc = await json(bin, [...args, "--detach"]);
			if (isJson(doc) && typeof doc.id === "string") return doc.id;
			throw new Error(`maestro ${args[0]}:\n${refusal(doc)}`);
		},
	};
}
