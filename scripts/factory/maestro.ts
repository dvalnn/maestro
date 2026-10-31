import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tail = (log: string) => readFileSync(log, "utf8").slice(-LOG_TAIL).trim();

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
				if (done) throw new Error(`maestro ${args[0]}: ${tail(log)}`);
				await sleep(POLL_MS);
			}
			child.unref();
			throw new Error(`maestro ${args[0]} announced no concert: ${tail(log)}`);
		},
	};
}
