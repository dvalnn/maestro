import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { compose } from "@maestro/core/compose";
import { CORE_CONFIG, valuesLayer } from "@maestro/core/config";
import type { Host, HostSetup, Roots } from "@maestro/core/host";
import { concertDirs, openRecord, perform } from "@maestro/core/perform";
import {
	type HostNode,
	IR_VERSION,
	type Ir,
	type IrEdge,
	type IrNode,
	parseIr,
	type Scope,
} from "@maestro/ir";
import {
	contextProblems,
	type Harness,
	type HarnessRequest,
	ownedEntryProblems,
	PROFILE_TOKEN,
	type StubStep,
	stubHarness,
	thinkingProblems,
} from "../harness/index";
import { runProcesses } from "../sandbox/bubblewrap";
import { LANE_PORT } from "./config";
import { repoHost } from "./index";
import { openTarget } from "./store";

const dirs: string[] = [];
export const tmp = (name: string) => {
	const d = mkdtempSync(join(tmpdir(), `host-${name}-`));
	dirs.push(d);
	return d;
};
/** Removes every directory `tmp` made. */
export const cleanup = () => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
};

const GIT_ENV = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "op",
	GIT_AUTHOR_EMAIL: "op@x",
	GIT_COMMITTER_NAME: "op",
	GIT_COMMITTER_EMAIL: "op@x",
};

const gitIn = (repo: string, ...args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], { cwd: repo, env: GIT_ENV });
	if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr}`);
};

/** Commits `files`, by path, on the checked-out branch of `repo`. */
export function commitTo(repo: string, files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), content);
	}
	gitIn(repo, "add", "-A");
	gitIn(repo, "commit", "-qm", Object.keys(files).join(" "));
}

/** A target repository whose `main` holds `a.txt` and `files`, by path. */
export function toyTarget(files: Record<string, string> = {}): string {
	const t = tmp("target");
	gitIn(t, "init", "-q", "-b", "main");
	commitTo(t, { "a.txt": "a\n", ...files });
	return t;
}

/** Every entry under `dir` with its kind, size, mtime, ctime and content. Atime is left out. */
export function snapshot(dir: string): string[] {
	const out: string[] = [];
	const walk = (p: string) => {
		const s = lstatSync(p, { bigint: true });
		const body = s.isFile() ? readFileSync(p, "latin1") : "";
		out.push(
			`${relative(dir, p)} ${s.mode} ${s.size} ${s.mtimeNs} ${s.ctimeNs} ${body}`,
		);
		if (s.isDirectory())
			for (const e of readdirSync(p).sort()) walk(join(p, e));
	};
	walk(dir);
	return out;
}

const CHECKS = {
	hello: "test -f hello.txt && touch from-check.txt",
	red: ["true", "exit 1"],
	missing: "no-such-command",
};

/** The `at` in tokens that `other` refuses, with a fix naming the profile. */
const NAMING_AT = 777;

/** A harness named `other`, whose one thinking level is `low`, that reports no compaction, and must never be run. */
const other: Harness = {
	name: "other",
	run: () => {
		throw new Error("other was run");
	},
	runtimeProblems: (runtime, context) => [
		...thinkingProblems("other", ["low"], runtime),
		...contextProblems("other", { compactions: false, compact: true }, context),
		...(context?.strategy === "handoff" && context.at === NAMING_AT
			? [
					{
						field: "context.at" as const,
						reason: "other takes no such at",
						fix: `Run maestro agent show ${PROFILE_TOKEN}`,
					},
				]
			: []),
	],
};

/**
 * A repo host whose stub harness replays what `steps` gives each request, and the requests it got. The same stub runs
 * as harness `kit` too, which takes harness extras and writes `settings.json` itself.
 */
export function stubHost(steps: (req: HarnessRequest) => StubStep[]) {
	const requests: HarnessRequest[] = [];
	const stub = stubHarness((req) => {
		requests.push(req);
		return steps(req);
	});
	const kit: Harness = {
		...stub,
		name: "kit",
		extrasProblems: (dir) => ownedEntryProblems("kit", ["settings.json"], dir),
	};
	const host = repoHost({ harnesses: [stub, other, kit] });
	return { host, requests };
}

export const fresh = { mode: "fresh" };

export const reply = (envelope: unknown): StubStep => ({
	emit: { type: "text", text: JSON.stringify(envelope) },
});
export const DONE = { summary: "done" };
export const OK = reply({ report: DONE });
export const APPROVED = reply({ outcome: "ok", report: DONE });

export type NodeSpec = {
	id: string;
	kind: "agent" | "check" | "changeset" | "apply" | "commits";
	config: Record<string, unknown>;
	literals?: Record<string, unknown>;
	lane?: string;
	/** The node whose session this agent continues, by an edge into its `session` port. */
	session?: string;
	/** Edges into input ports, from `<node>.<port>`. */
	wires?: Record<string, string>;
	/** A node whose rejection this one tolerates. */
	tolerates?: string;
	message?: boolean;
};

/** A node of `host` with the ports its kind gives it, fed by `literals` and, from `lane`, an edge. */
function repoNode(
	host: Host,
	spec: NodeSpec,
): { node: HostNode; edges: IrEdge[] } {
	const kind = `repo.${spec.kind}` as const;
	const draft: HostNode = {
		id: spec.id,
		kind,
		config: spec.config,
		in: {
			...(spec.message && { message: { type: "string" } }),
			...((spec.session !== undefined ||
				spec.literals?.session !== undefined) && {
				session: { type: "string" },
			}),
		},
	};
	const ports = host.kinds.find((k) => k.name === kind)?.ports(draft);
	const node = {
		...draft,
		in: ports?.in,
		out: ports?.out,
		literals: spec.literals,
	};
	const wires = {
		...(spec.lane && { lane: `${spec.lane}.lane` }),
		...(spec.session && { session: `${spec.session}.session` }),
		...spec.wires,
	};
	const edges: IrEdge[] = Object.entries(wires).map(([port, from]) => {
		const [node = "", out = ""] = from.split(".");
		return {
			kind: "data",
			from: { node, port: out },
			to: { node: spec.id, port },
		};
	});
	const tolerate: IrEdge[] = spec.tolerates
		? [
				{
					kind: "control",
					from: { node: spec.tolerates },
					to: { node: spec.id },
					tolerate: "rejected",
				},
			]
		: [];
	return { node, edges: [...edges, ...tolerate] };
}

/** A loop `id` around the node `id/step`, its state the step's out ports and started over the lane port from `start`. */
type LoopSpec = { id: string; start: string };

const SEED: Record<string, unknown> = {
	string: "",
	array: [],
	object: {},
};

function loopOf(loop: LoopSpec, step: HostNode | undefined) {
	const state = step?.out ?? {};
	const node: IrNode = {
		id: loop.id,
		kind: "loop",
		cardinality: { upTo: 2 },
		in: state,
		inner: {
			...state,
			ok: { type: "boolean" },
			reason: { type: "string" },
			index: { type: "integer" },
		},
		out: state,
		literals: Object.fromEntries(
			Object.entries(state)
				.filter(([port]) => port !== LANE_PORT)
				.map(([port, type]) => [port, SEED[(type as { type: string }).type]]),
		),
		members: { result: `${loop.id}/step` },
		test: { at: "start", port: { node: loop.id, port: "ok" } },
	};
	const start: IrEdge = {
		kind: "data",
		from: { node: loop.start, port: LANE_PORT },
		to: { node: loop.id, port: LANE_PORT },
	};
	return { node, start };
}

export function irOf(
	host: Host,
	specs: NodeSpec[],
	result: string,
	loop?: LoopSpec,
	scopes: Scope[] = [],
): Ir {
	const built = specs.map((s) => repoNode(host, s));
	const looped = loop
		? loopOf(loop, built.find((b) => b.node.id === `${loop.id}/step`)?.node)
		: undefined;
	const parsed = parseIr({
		irVersion: IR_VERSION,
		composition: { id: "toy", version: "0.1.0", pack: "test" },
		emitter: { name: "hand", version: "0.1.0" },
		scopes,
		nodes: [...built.map((b) => b.node), ...(looped ? [looped.node] : [])],
		edges: [
			...built.flatMap((b) => b.edges),
			...(looped ? [looped.start] : []),
		],
		result: { node: result },
	});
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
	return parsed.ir;
}

export function configOf(target: string, extra: Record<string, unknown> = {}) {
	const dataRoot = tmp("data");
	return {
		values: {
			concurrency: 4,
			caps: {},
			dataRoot,
			workspace: "",
			target: { repo: target, base: "main", checks: CHECKS },
			...extra,
		},
		sources: [],
		layers: [valuesLayer(extra, { layer: "workspace" })],
	};
}

const rootsDir = mkdtempSync(join(tmpdir(), "host-roots-"));
process.once("exit", () => rmSync(rootsDir, { recursive: true, force: true }));

/** The pack whose bundle `ROOTS` holds, empty until a test writes its profiles. */
export const PACK = "acme";

/**
 * The roots a test concert gives its hosts: a workspace root holding the profiles `profile` writes, a user root that
 * does not exist, and the bundle of `PACK`.
 */
export const ROOTS: Roots = {
	workspace: rootsDir,
	user: "/nonexistent",
	packs: { [PACK]: join(rootsDir, PACK) },
};

/**
 * Writes profile `name`, its `profile.yaml` and `files` beside it by path, in the workspace root of `ROOTS`, or in the
 * bundle of `PACK` when `inPack`.
 */
export function profile(
	name: string,
	yaml: string,
	files: Record<string, string> = {},
	inPack = false,
): string {
	const dir = join(rootsDir, ...(inPack ? [PACK] : []), "profiles", name);
	for (const [path, text] of Object.entries({
		"profile.yaml": yaml,
		...files,
	})) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

profile("builder", "runtime: { harness: stub, model: none }\n");
profile("other", "runtime: { harness: other, model: none }\n");

/** The config of an agent node of seat and profile `name` on `lane`. */
export const agentOn = (lane: Record<string, unknown>, name = "builder") => ({
	profile: name,
	seat: name,
	lane,
});

export const setupOf = (config: ReturnType<typeof configOf>): HostSetup => ({
	config: { target: config.values.target },
	sources: [],
	layers: [],
	commandLine: { values: {}, replaced: [] },
	store: join(config.values.dataRoot, "hosts", "repo"),
	roots: ROOTS,
});

export const noCode = async () => () => ({});

/** Which earlier concert a concert resumes, or is an encore of. */
type Earlier = { resume?: string; encore?: string };

export async function start(
	host: Host,
	ir: Ir,
	config: ReturnType<typeof configOf>,
	earlier: Earlier = {},
) {
	const composed = await compose({
		ir,
		config,
		roots: ROOTS,
		core: CORE_CONFIG,
		packs: {},
		hosts: [host],
		loadCode: noCode,
		caps: {},
	});
	if (!composed.ok) throw new Error(JSON.stringify(composed.diagnostics));
	const dir = join(config.values.dataRoot, "concerts");
	const recordPath = join(config.values.dataRoot, "record.db");
	const concert = await perform({
		ir,
		hosts: [host],
		config,
		roots: ROOTS,
		loadCode: noCode,
		recordPath,
		dir,
		concurrency: 4,
		...earlier,
	});
	return { concert, dir, recordPath };
}

export async function performed(
	host: Host,
	ir: Ir,
	config: ReturnType<typeof configOf>,
	earlier: Earlier = {},
) {
	const { concert, dir, recordPath } = await start(host, ir, config, earlier);
	const result = await concert.done;
	const record = openRecord(recordPath);
	const instances = record.instances(concert.id);
	record.close();
	const artifact = (node: string, port: string) => {
		const ref = instances.find((i) => i.node === node)?.outputs?.[port] as {
			path: string;
		};
		return join(concertDirs(dir, concert.id).artifacts, ref.path);
	};
	return { id: concert.id, result, instances, artifact };
}

export const changed = async (
	config: ReturnType<typeof configOf>,
	target: string,
	version: string,
) =>
	(
		await openTarget(setupOf(config).store, target).lanes.changeset(version)
	).patches.join("");

const parentOf = (pid: number) =>
	Number(/\) \S (\d+)/.exec(readFileSync(`/proc/${pid}/stat`, "utf8"))?.[1]);

/** Whether `pid` descends from this process, by its parent chain. */
function ownedProcess(pid: number): boolean {
	try {
		for (let p = pid; p > 1; p = parentOf(p))
			if (p === process.pid) return true;
	} catch {} // exited while walking
	return false;
}

/** Live sandbox processes this process started, so a run in another checkout does not count. */
export const sandboxed = () => runProcesses("").filter(ownedProcess);
