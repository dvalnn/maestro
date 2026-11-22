import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJson, type Json } from "./json";
import { unresolvedOf } from "./route";

/**
 * How many of a milestone's newest concerts of one kind the tick reads: a kind runs one at a time, so its newest
 * settle is among them.
 */
const WINDOW = 20;
/** The slice's fix agent, one instance per fix round, directly or under `fix_until_clean`'s scope. */
const FIX_NODE = /^(.*\/)?fixes\/fix$/;
/** The slice's tester, whose `map` output holds the tests: beside the builder, and as earlier concerts named it. */
const TESTER_NODES = [
	"build/tester",
	"build/test_first/tester",
	"tested/tester",
	"tester",
];

export type Concert = {
	id: string;
	status: string;
	pack: string;
	composition: string;
	tour?: string;
	/** When it started, in milliseconds. */
	startedAt?: number;
	/** The commit its lane is cut from: its `target.base` as `config <id> --json` reads it, when set. */
	base?: string;
	/** When it settled, in milliseconds; absent while it runs. */
	settledAt?: number;
};
export type Result = {
	status: string;
	reason?: string;
	outputs: Record<string, unknown>;
};
/**
 * What one slice concert spent: its run time and tokens by kind, reasoning tokens counted in `output`, its fix rounds,
 * and whether it was an encore of another concert.
 */
export type Spend = {
	short: string;
	elapsedMs: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	fixes: number;
	encore: boolean;
};
/**
 * What a settled concert's agents reported, their obstacles, lessons and sightings: `upheld` is the body of the upheld
 * findings the concert returned, if any.
 */
export type Report = {
	obstacles: string[];
	lessons: string[];
	sightings: Sighting[];
	upheld?: string;
	/** Whether the slice's PR opens as a draft, and the notice at the top of its body that says why. */
	draft?: boolean;
	notice?: string;
	/** How many lenses the slice's last review delivered. */
	delivered?: number;
	/** The PR body the slice's writer wrote. */
	pr?: string;
	/** A review, and the findings the review upheld. */
	review?: string;
	blocking?: string[];
	/** What the tester's map holds, when the concert's tester wrote one. */
	tests?: { pinned: number; deferred: number; untestable: number };
};

/** A defect an agent saw outside its task: `cites` is the rule or behaviour it breaches. */
export type Sighting = { path: string; cites: string; text: string };

/** maestro as the tick sees it, through its `--json` documents. */
export type Maestro = {
	/**
	 * The newest `limit` concerts on `tour` and the tours under it, newest first; `limit` defaults to the tick's window,
	 * and `kind` keeps only the concerts of that pack and composition.
	 */
	concerts(
		tour: string,
		limit?: number,
		kind?: { pack: string; composition: string },
	): Promise<Concert[]>;
	/** Every running concert on every tour, with no `base`. */
	running(): Promise<Concert[]>;
	result(id: string): Promise<Result>;
	/**
	 * Starts `maestro <args>` in the background and returns its concert's id; what it printed is written to `log`,
	 * when given. It runs in `cwd`, else in the tick's own directory.
	 * @throws Error with maestro's refusal when it does not start.
	 */
	start(args: string[], log?: string, cwd?: string): Promise<string>;
	report(id: string): Promise<Report>;
	/** What concert `id` spent. */
	spend(id: string): Promise<Spend>;
	/** Whether maestro's record still holds concert `id`, which `maestro prune` may have deleted. */
	has(id: string): Promise<boolean>;
	/**
	 * The `.maestro/` directory concert `id`'s tree holds its composition in, which an encore of it reopens.
	 * @throws Error when maestro's record of it names none.
	 */
	tree(id: string): Promise<string>;
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
		startedAt: typeof o.startedAt === "number" ? o.startedAt : undefined,
		settledAt: typeof o.settledAt === "number" ? o.settledAt : undefined,
	};
};

/**
 * The `target.base` concert `id` is cut from, as `config <id> --json` reads it; undefined when its value is unset or
 * empty, or its record cannot be read.
 */
async function baseOf(bin: string, id: string): Promise<string | undefined> {
	// A record that cannot be read leaves the base unknown rather than failing the whole listing.
	const doc = await json(bin, ["config", id]).catch(() => undefined);
	if (!isJson(doc) || !Array.isArray(doc.values)) return undefined;
	const row = doc.values.filter(isJson).find((r) => r.key === "target.base");
	const value = row?.value;
	return typeof value === "string" && value !== "" ? value : undefined;
}

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

/** Each report's `key` entries. */
const entriesOf = (reports: readonly Json[], key: string) =>
	reports.flatMap((r) => strings(r[key]));

const isSighting = (v: unknown): v is Sighting =>
	isJson(v) &&
	typeof v.path === "string" &&
	typeof v.cites === "string" &&
	typeof v.text === "string";

/** Each report's well-formed sightings. */
const sightingsOf = (reports: readonly Json[]): Sighting[] =>
	reports.flatMap((r) =>
		Array.isArray(r.sightings)
			? r.sightings
					.filter(isSighting)
					.map(({ path, cites, text }) => ({ path, cites, text }))
			: [],
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
		fixes: instancesOf(doc).filter(
			(i) => typeof i.node === "string" && FIX_NODE.test(i.node),
		).length,
		encore: typeof doc.encoreOf === "string",
	};
}

/** The `instances` of an `ls <concert> --json` document. */
const instancesOf = (doc: Json) =>
	Array.isArray(doc.instances) ? doc.instances.filter(isJson) : [];

const count = (list: unknown) => (Array.isArray(list) ? list.length : 0);

/** The sizes of the tester's `map` reply, from the agents' `ls <concert> <instance> --json` documents. */
function testsOf(agents: readonly Json[]): Report["tests"] {
	const out = agents.find(
		(i) => typeof i.node === "string" && TESTER_NODES.includes(i.node),
	)?.outputs;
	const map = isJson(out) ? out.map : undefined;
	if (!isJson(map)) return undefined;
	return {
		pinned: count(map.pinned),
		deferred: count(map.deferred),
		untestable: count(map.untestable),
	};
}

/** Output `name` of a `wait <concert> --json` document, as it is. */
const outputOf = (doc: unknown, name: string) =>
	isJson(doc) && isJson(doc.outputs) ? doc.outputs[name] : undefined;

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

/** The `draft` output of a `wait <concert> --json` document; a concert from before it existed is a draft when it upheld findings. */
function draftOf(doc: unknown, upheld?: string) {
	const draft = outputOf(doc, "draft");
	return typeof draft === "boolean"
		? draft
		: unresolvedOf(upheld) !== undefined;
}

/** The `delivered` output of a `wait <concert> --json` document, when it has one. */
function deliveredOf(doc: unknown) {
	const delivered = outputOf(doc, "delivered");
	return typeof delivered === "number" && Number.isInteger(delivered)
		? delivered
		: undefined;
}

/** The writer's PR body in the `pr` output of a `wait <concert> --json` document, when it wrote one. */
const prOf = (doc: unknown) => outputText(doc, "pr") || undefined;

/** The findings the `upheld` output of a review's `wait <concert> --json` document holds, as `<where>: <issue>` lines. */
function blockingOf(doc: unknown) {
	const upheld = outputOf(doc, "upheld");
	if (!Array.isArray(upheld)) return undefined;
	return upheld
		.filter(isJson)
		.map((f) => `${String(f.where)}: ${String(f.issue)}`);
}

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
 * The `--json` document `bin <args>` prints in `cwd`, the process's own when unset, whatever its exit code, since
 * `wait` exits with the concert's; its stdout, then its stderr, are written to `log` when given.
 * @throws Error with its stderr when it prints none.
 */
async function json(
	bin: string,
	args: string[],
	log?: string,
	cwd?: string,
): Promise<unknown> {
	const child = Bun.spawn([bin, ...args, "--json"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (log) writeFileSync(log, out + err);
	try {
		return JSON.parse(out);
	} catch {
		throw new Error(`maestro ${args[0]}: ${err.trim() || "no JSON document"}`);
	}
}

/** Whether a step row of `ls <concert> --json` is one `report` reads in full: an agent that left notes, or the tester. */
const isRead = (i: Json) =>
	typeof i.harness === "string" &&
	typeof i.name === "string" &&
	(isJson(i.notes) ||
		(typeof i.node === "string" && TESTER_NODES.includes(i.node)));

/**
 * The `ls <concert> <instance> --json` document of each step `isRead` picks from `doc`. A report's obstacles, lessons and
 * sightings show as its row's notes, so one read per agent would cost a process for each agent that left nothing.
 */
const agentsOf = (bin: string, id: string, doc: Json) =>
	Promise.all(
		instancesOf(doc)
			.filter(isRead)
			.map((i) => json(bin, ["ls", id, String(i.name)])),
	).then((docs) => docs.filter(isJson));

/**
 * The rows of an `ls --json` list.
 * @throws Error with maestro's own message when it answered with an error document, else that it is not a list.
 */
function listOf(doc: unknown): unknown[] {
	if (Array.isArray(doc)) return doc;
	const error = isJson(doc) ? doc.error : undefined;
	throw new Error(typeof error === "string" ? error : "maestro ls: not a list");
}

export function maestro(bin = "maestro"): Maestro {
	return {
		concerts: async (tour, limit = WINDOW, kind) => {
			const rows = await json(bin, [
				"ls",
				"--tour",
				tour,
				"--limit",
				`${limit}`,
				...(kind ? ["--composition", `${kind.pack}.${kind.composition}`] : []),
			]);
			const list = listOf(rows);
			return Promise.all(
				list.map(async (row) => {
					const concert = concertOf(row);
					return { ...concert, base: await baseOf(bin, concert.id) };
				}),
			);
		},
		running: async () => {
			const rows = await json(bin, ["ls", "--status", "running", "--all"]);
			return listOf(rows).map(concertOf);
		},
		result: async (id) => resultOf(await json(bin, ["wait", id])),
		report: async (id) => {
			const [doc, result] = await Promise.all([
				json(bin, ["ls", id]),
				json(bin, ["wait", id]),
			]);
			if (!isJson(doc)) throw new Error("maestro ls: not an object");
			const agents = await agentsOf(bin, id, doc);
			const reports = agents.flatMap((a) =>
				isJson(a.report) ? [a.report] : [],
			);
			const upheld = upheldOf(result);
			return {
				obstacles: entriesOf(reports, "obstacles"),
				lessons: entriesOf(reports, "lessons"),
				sightings: sightingsOf(reports),
				upheld,
				draft: draftOf(result, upheld),
				delivered: deliveredOf(result),
				notice: outputText(result, "notice") || undefined,
				pr: prOf(result),
				review: outputText(result, "review"),
				blocking: blockingOf(result),
				tests: testsOf(agents),
			};
		},
		spend: async (id) => spendOf(await json(bin, ["ls", id])),
		has: async (id) => {
			const doc = await json(bin, ["ls", id]);
			return !(isJson(doc) && doc.ok === false);
		},
		tree: async (id) => {
			const doc = await json(bin, ["config", id]);
			if (!isJson(doc) || typeof doc.moduleDir !== "string")
				throw new Error(
					`maestro config ${id}: ${refusal(doc) || "its record names no tree"}`,
				);
			return doc.moduleDir;
		},
		apply: (id, dir) => run(bin, ["cs", "apply", id, "-C", dir]),
		start: async (args, log, cwd) => {
			const doc = await json(bin, [...args, "--detach"], log, cwd);
			if (isJson(doc) && typeof doc.id === "string") return doc.id;
			throw new Error(`maestro ${args[0]}:\n${refusal(doc)}`);
		},
	};
}
