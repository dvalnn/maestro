/**
 * Pins each classics variant's agent signature, drawn from `maestro compose --json`, against `.maestro/golden/`.
 * After a change that should alter a signature, regenerate the goldens and review the diff:
 *
 *     MAESTRO_UPDATE_GOLDENS=1 bun test ./.maestro/golden.test.ts && bunx biome format --write .maestro
 */
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classics, maestro, scratch } from "./testing/stub";

const GOLDENS = join(import.meta.dir, "golden");
const SESSION = "repo.session";

const backlog = join(scratch, "backlog.md");
writeFileSync(backlog, "# Backlog\n\n- #7 Greet\n");
const lessons = join(scratch, "lessons.md");
writeFileSync(lessons, "## c1 · t1\n\n- a lesson\n");

type Ports = Record<string, { "x-maestro-type"?: string }>;
type Node = {
	id: string;
	kind?: string;
	items?: string[];
	members?: { result?: string };
	in?: Ports;
	out?: Ports;
	inner?: Ports;
	config?: {
		seat?: string;
		profile?: string;
		attachments?: unknown;
		relay?: { name: string }[];
		out?: unknown;
		reply?: unknown;
		lane?: { mode?: string };
		checks?: unknown;
		verdict?: unknown;
	};
	literals?: { prompt?: string; table?: Record<string, string> };
};
type Edge = {
	from: { node: string; port?: string };
	to: { node: string; port?: string };
};
type Composed = {
	plan: {
		ir: { nodes: Node[]; edges: Edge[] };
		bounds: { nodes: Record<string, unknown> };
	};
};

/** The session of each node's first session port: ports joined by an edge, or by sharing a node and a name. */
function sessionsOf({ ir }: Composed["plan"]) {
	const parent = new Map<string, string>();
	const find = (key: string): string => {
		const up = parent.get(key) ?? key;
		return up === key ? key : find(up);
	};
	const nodes = new Map(ir.nodes.map((n) => [n.id, n]));
	const portsOf = (id: string) => ({
		...nodes.get(id)?.in,
		...nodes.get(id)?.out,
	});
	const sessionPort = (id: string) =>
		Object.entries(portsOf(id)).find(
			([, p]) => p["x-maestro-type"] === SESSION,
		)?.[0];
	for (const { from, to } of ir.edges) {
		if (
			from.port &&
			portsOf(from.node)[from.port]?.["x-maestro-type"] === SESSION
		)
			parent.set(
				find(`${from.node}:${from.port}`),
				find(`${to.node}:${to.port}`),
			);
	}
	for (const { id, members } of ir.nodes) {
		const port = sessionPort(id);
		if (port && members?.result && portsOf(members.result)[port])
			parent.set(find(`${id}:${port}`), find(`${members.result}:${port}`));
	}
	return (id: string) => find(`${id}:${sessionPort(id)}`);
}

/** The task of agent `n` by list item: the lookup table's text per item when a parMap's lookup feeds it, else under `""`. */
function tasksOf(n: Node, { ir }: Composed["plan"]) {
	const into = (id: string, port: string) =>
		ir.edges.find((e) => e.to.node === id && e.to.port === port)?.from.node;
	const node = (id?: string) => ir.nodes.find((x) => x.id === id);
	const lookup = node(into(n.id, "prompt"));
	const table = lookup?.literals?.table;
	if (n.literals?.prompt || !table) return { "": n.literals?.prompt };
	const items = node(into(lookup?.id ?? "", "key"))?.items ?? [];
	return Object.fromEntries(items.map((k) => [k, table[k]]));
}

/** What the compare holds of agent `n` running `task`. */
const signed = (n: Node, task: unknown, { bounds }: Composed["plan"]) => ({
	seat: n.config?.seat,
	profile: n.config?.profile,
	task,
	attachments: n.config?.attachments,
	relay: n.config?.relay?.map((r) => r.name),
	out: n.config?.out,
	reply: n.config?.reply,
	lane: n.config?.lane?.mode,
	checks: n.config?.checks,
	verdict: n.config?.verdict,
	bound: bounds.nodes[n.id],
});

/**
 * The agent signature of a composed plan and the sessions its agents partition into.
 * @param composed the parsed `maestro compose --json` output
 * @returns each seat name, suffixed `[item]` for a parMap's list item, mapped to its agents' seat, profile, task,
 *   attachments, relay names, `out` and `reply` schemas, lane mode, checks, verdict and instance bound in content order; and the sorted groups of
 *   those names that share a session
 */
function signature({ plan }: Composed) {
	const sessionOf = sessionsOf(plan);
	const agents: Record<string, string[]> = {};
	const sessions = new Map<string, string[]>();
	for (const n of plan.ir.nodes.filter((x) => x.kind === "repo.agent")) {
		for (const [item, task] of Object.entries(tasksOf(n, plan))) {
			const key = `${n.config?.seat}${item && `[${item}]`}`;
			agents[key] = [
				...(agents[key] ?? []),
				JSON.stringify(signed(n, task, plan)),
			];
			const session = `${sessionOf(n.id)}|${item}`;
			sessions.set(session, [...(sessions.get(session) ?? []), key]);
		}
	}
	return {
		agents: Object.fromEntries(
			Object.entries(agents)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, v.sort().map((x) => JSON.parse(x))]),
		),
		sessions: [...sessions.values()].map((g) => g.sort()).sort(),
	};
}

const preset = (name: string) => ["--preset", name];
const slice = (tier: string, ...flags: string[]) => [
	".maestro/slice.ts",
	...preset(tier),
	"--request",
	"x",
	"--tier",
	tier,
	...flags,
];
const variants: Record<string, string[]> = {
	"slice-small": slice("small"),
	"slice-ordinary": slice("ordinary"),
	"slice-risky": slice("risky"),
	"slice-revises": slice("ordinary", "--revises", "C^!"),
	review: [".maestro/review.ts", ...preset("risky"), "--revs", "HEAD^!"],
	triage: [
		".maestro/triage.ts",
		...preset("triage"),
		"--issue",
		"#1 Greet by name",
		"--backlog",
		backlog,
	],
	masterclass: [
		".maestro/masterclass.ts",
		...preset("stub"),
		"--lessons",
		lessons,
		"--backlog",
		backlog,
	],
};

test.each(Object.entries(variants))(
	"%s composes to its golden signature",
	async (name, args) => {
		const composed = JSON.parse(
			await maestro([
				"compose",
				...args,
				"--json",
				"-c",
				`packs=[${await classics}]`,
			]),
		);
		const file = join(GOLDENS, `${name}.json`);
		const actual = signature(composed);
		if (process.env.MAESTRO_UPDATE_GOLDENS) {
			mkdirSync(GOLDENS, { recursive: true });
			writeFileSync(file, `${JSON.stringify(actual, null, "\t")}\n`);
		}
		expect(actual).toEqual(JSON.parse(readFileSync(file, "utf8")));
	},
);
