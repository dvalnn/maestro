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
import { CORE_CONFIG } from "@maestro/core/config";
import type { Host, HostSetup } from "@maestro/core/host";
import { concertDirs, openRecord, perform } from "@maestro/core/perform";
import { type HostNode, type Ir, type IrEdge, parseIr } from "@maestro/ir";
import {
	type Harness,
	type HarnessRequest,
	type StubStep,
	stubHarness,
} from "../harness/index";
import { runProcesses } from "../sandbox/bubblewrap";
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

/** A target repository whose `main` holds `a.txt` and `files`, by path. */
export function toyTarget(files: Record<string, string> = {}): string {
	const t = tmp("target");
	const git = (...args: string[]) => {
		const p = Bun.spawnSync(["git", ...args], { cwd: t, env: GIT_ENV });
		if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr}`);
	};
	git("init", "-q", "-b", "main");
	for (const [path, content] of Object.entries({ "a.txt": "a\n", ...files })) {
		mkdirSync(dirname(join(t, path)), { recursive: true });
		writeFileSync(join(t, path), content);
	}
	git("add", "-A");
	git("commit", "-qm", "one");
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

const ROLES = {
	builder: { harness: "stub", model: "none" },
	other: { harness: "other", model: "none" },
};
const CHECKS = {
	hello: "test -f hello.txt && touch from-check.txt",
	red: ["true", "exit 1"],
	missing: "no-such-command",
};

/** A harness named `other` that must never be run. */
const other: Harness = {
	name: "other",
	run: () => {
		throw new Error("other was run");
	},
};

/** A repo host whose stub harness replays what `steps` gives each request, and the requests it got. */
export function stubHost(steps: (req: HarnessRequest) => StubStep[]) {
	const requests: HarnessRequest[] = [];
	const host = repoHost({
		harnesses: [
			stubHarness((req) => {
				requests.push(req);
				return steps(req);
			}),
			other,
		],
	});
	return { host, requests };
}

export const fresh = { mode: "fresh" };

export const reply = (envelope: unknown): StubStep => ({
	emit: { type: "text", text: JSON.stringify(envelope) },
});
export const OK = reply({ report: "done" });
export const APPROVED = reply({ outcome: "ok", report: "done" });

export type NodeSpec = {
	id: string;
	kind: "agent" | "check" | "changeset" | "apply";
	config: Record<string, unknown>;
	literals?: Record<string, unknown>;
	lane?: string;
	/** Edges into input ports, from `<node>.<port>`. */
	wires?: Record<string, string>;
	/** A node whose rejection this one tolerates. */
	tolerates?: string;
	identity?: boolean;
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
		...(spec.identity && { in: { identity: { type: "string" } } }),
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

export function irOf(host: Host, specs: NodeSpec[], result: string): Ir {
	const built = specs.map((s) => repoNode(host, s));
	const parsed = parseIr({
		irVersion: "1.0",
		composition: { id: "toy", version: "0.1.0", pack: "test" },
		emitter: { name: "hand", version: "0.1.0" },
		scopes: [],
		nodes: built.map((b) => b.node),
		edges: built.flatMap((b) => b.edges),
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
			roles: ROLES,
			...extra,
		},
		sources: [],
	};
}

export const setupOf = (config: ReturnType<typeof configOf>): HostSetup => ({
	config: { target: config.values.target, roles: config.values.roles },
	store: join(config.values.dataRoot, "hosts", "repo"),
});

export const noCode = async () => () => ({});

export async function start(
	host: Host,
	ir: Ir,
	config: ReturnType<typeof configOf>,
	resume?: string,
) {
	const composed = await compose({
		ir,
		config,
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
		loadCode: noCode,
		recordPath,
		dir,
		concurrency: 4,
		resume,
	});
	return { concert, dir, recordPath };
}

export async function performed(
	host: Host,
	ir: Ir,
	config: ReturnType<typeof configOf>,
	resume?: string,
) {
	const { concert, dir, recordPath } = await start(host, ir, config, resume);
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
