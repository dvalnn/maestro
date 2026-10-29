import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { Roots } from "@maestro/core/host";
import { concertDirs } from "@maestro/core/perform";
import {
	AGENT_IN_PORTS as HOST_IN_PORTS,
	AGENT_OUT_PORTS as HOST_OUT_PORTS,
	REPORT as HOST_REPORT,
	repoHost,
} from "@maestro/host-repo";
import { type HarnessRequest, stubHarness } from "@maestro/host-repo/harness";
import {
	type ArtifactRef,
	type Ir,
	type IrNode,
	MAESTRO_TYPE,
} from "@maestro/ir";
import {
	Bool,
	BuildError,
	code,
	composition,
	iter,
	loop,
	not,
	type Ref,
	Text,
} from "@maestro/sdk";
import * as stdlib from "@maestro/sdk/stdlib";
import { buildIr, composeIr, stubConcert } from "@maestro/testkit";
import { buildThenRepair, byFinding, fold, review } from "./fixtures/examples";
import {
	AGENT_IN_PORTS,
	AGENT_OUT_PORTS,
	apply,
	changeset,
	check,
	extend,
	fork,
	fresh,
	JsonOut,
	Lane,
	MarkdownOut,
	REPORT,
	read,
	Session,
	seat,
} from "./index";

const dirs: string[] = [];
const tmp = () => {
	const dir = mkdtempSync(joinPath(tmpdir(), "host-repo-sdk-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "op",
	GIT_AUTHOR_EMAIL: "op@x",
	GIT_COMMITTER_NAME: "op",
	GIT_COMMITTER_EMAIL: "op@x",
};

/** A git repository with one commit on `main`. */
function toyTarget(): string {
	const target = tmp();
	for (const args of [
		["init", "-q", "-b", "main"],
		["commit", "-q", "--allow-empty", "-m", "one"],
	]) {
		const p = Bun.spawnSync(["git", ...args], { cwd: target, env: GIT_ENV });
		if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr}`);
	}
	return target;
}

const PROFILES = [
	"builder",
	"implementer",
	"resolver",
	"reviewer",
	"lens",
	"skeptic",
	"consolidator",
	"acme/critic",
];

/** A profile on harness `other`, which is loaded but never run. */
const ELSEWHERE = "elsewhere";

/** A workspace root holding each of `PROFILES` on the stub harness. */
function profileRoots(): Roots {
	const workspace = tmp();
	for (const name of [...PROFILES, ELSEWHERE]) {
		const dir = joinPath(workspace, "profiles", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			joinPath(dir, "profile.yaml"),
			`runtime: { harness: ${name === ELSEWHERE ? "other" : "stub"}, model: none }\n`,
		);
	}
	return { workspace, user: "/nonexistent", packs: {} };
}

/**
 * A repo host on a toy target whose stub harness writes the files `writes` gives each request, the requests it got, and
 * the system prompt each was staged with.
 */
function repo(
	writes: (req: HarnessRequest) => Record<string, string> = () => ({}),
	checks: Record<string, unknown> = {
		test: { run: "true", hint: "the tests" },
		lint: { run: "true", hint: "the linter" },
	},
) {
	const requests: HarnessRequest[] = [];
	const framed = new Map<HarnessRequest, string>();
	const host = repoHost({
		harnesses: [
			stubHarness((req) => {
				requests.push(req);
				framed.set(req, readFileSync(req.instructions ?? "", "utf8"));
				return [
					...Object.entries(writes(req)).map(([write, content]) => ({
						write,
						content,
					})),
					{
						emit: {
							type: "text",
							text: JSON.stringify({ report: { summary: "done" } }),
						},
					},
				];
			}),
			{
				name: "other",
				run: () => {
					throw new Error("other was run");
				},
			},
		],
	});
	const hostConfig = {
		target: {
			repo: toyTarget(),
			base: "main",
			checks,
		},
	};
	const config = {
		values: {
			concurrency: 4,
			caps: {},
			dataRoot: tmp(),
			workspace: "",
			...hostConfig,
		},
		sources: [],
		layers: [],
	};
	const roots = profileRoots();
	const composeIt = (ir: Ir) => composeIr(ir, { hosts: [host], config, roots });
	return { host, hostConfig, roots, requests, framed, composeIt };
}

const CODE = { byFinding };

function buildCode(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof BuildError) return error.diagnostic.code;
		throw error;
	}
	throw new Error("expected a BuildError, and none was thrown");
}

const builder = seat("builder");

/** A session carried through a code node, as loop state carries it. */
export const carry = ({ session }: { session: string }) => ({
	session,
	done: true,
});
const carried = (session: Ref<string>) =>
	code(carry, { in: { session }, out: { session: Session, done: Bool() } });

const nodeOf = (ir: Ir, id: string): IrNode | undefined =>
	ir.nodes.find((n) => n.id === id);

describe("lanes", () => {
	test("a lane ref param forked or read is a repo.lane literal, and composes", async () => {
		const follow = composition(
			"follow",
			{ params: { from: Lane }, examples: [{ from: "c.lens/skeptic" }] },
			({ from }) => {
				const copied = builder({ task: "go", lane: fork(from) });
				const look = check(
					read(copied.out.lane),
					{ run: "true" },
					{ label: "look" },
				);
				// @ts-expect-error a node that reads its lane outputs none
				void look.out.lane;
				return look;
			},
		);
		const ir = buildIr(follow, { from: "c.lens/skeptic" });
		expect(nodeOf(ir, "agent")).toMatchObject({
			in: { lane: Lane.schema },
			literals: { lane: "c.lens/skeptic" },
			config: { lane: { mode: "fork" } },
		});
		expect(nodeOf(ir, "look")?.out).toEqual({
			logs: expect.anything(),
			output: expect.anything(),
		});
		const { composeIt, requests } = repo();
		expect(await composeIt(ir)).toMatchObject({ ok: true });
		expect(requests).toEqual([]);
	});

	test.each<[string, string, string, () => Ref<unknown> | object]>([
		[
			"one version extended twice",
			"HOST.lane",
			"'y' extends 'agent.lane', which 'x' extends too; a version is extended at most once",
			() => {
				const first = builder({ task: "a", lane: fresh() });
				builder({ label: "x", task: "b", lane: extend(first.out.lane) });
				return builder({ label: "y", task: "c", lane: extend(first.out.lane) });
			},
		],
		[
			"one session continued in a parMap body",
			"HOST.session",
			"'parMap/agent' continues the session of 'agent' from outside group 'parMap', whose iterations run side by side; a session has one runner at a time",
			() => {
				const first = builder({ task: "a", lane: fresh() });
				return iter.parMap(
					["b", "c"],
					(task) =>
						builder({ task, lane: fresh(), session: first.out.session }),
					{ onError: "stop" },
				);
			},
		],
		[
			"a session carried through a code node and loop state to another harness",
			"HOST.session",
			"'loop/agent' runs profile elsewhere on harness 'other' and continues the session of 'agent', profile builder on harness 'stub'; a session runs on one harness",
			() => {
				const first = builder({ task: "a", lane: fresh() });
				return loop.while((s) => not(s.out.done), {
					init: carried(first.out.session),
					step: (s) =>
						carried(
							seat(ELSEWHERE)({
								task: "b",
								lane: fresh(),
								session: s.out.session,
							}).out.session,
						),
					max: 2,
				});
			},
		],
		[
			"one session continued by two agents, once through an alias",
			"HOST.session",
			"'y' continues the session of 'agent', which 'x' continues too, neither after the other; a session has one runner at a time",
			() => {
				const first = builder({ task: "a", lane: fresh() });
				const alias = carried(first.out.session);
				builder({
					label: "x",
					task: "b",
					lane: fresh(),
					session: first.out.session,
				});
				return builder({
					label: "y",
					task: "c",
					lane: fresh(),
					session: alias.out.session,
				});
			},
		],
	])(
		"%s fails compose with %s, with no spend",
		async (_, want, message, body) => {
			const { composeIt, requests } = repo();
			const composed = await composeIt(
				buildIr(composition("bad", { examples: [{}] }, body), {}, { carry }),
			);
			expect(composed.ok).toBe(false);
			if (!composed.ok)
				expect(composed.diagnostics.map((d) => [d.code, d.message])).toEqual([
					[want, message],
				]);
			expect(requests).toEqual([]);
		},
	);
});

test("every option of a seat call, check and apply composes against the repo host", async () => {
	const shared = tmp();
	const cache = tmp();
	const everything = composition("everything", { examples: [{}] }, () => {
		const built = builder({
			task: "build",
			lane: fresh("main"),
			checks: ["test"],
		});
		const resumed = builder({
			label: "resumed",
			task: "go on",
			lane: extend(built.out.lane),
			session: built.out.session,
		});
		const checked = check(fork(resumed.out.lane), {
			run: ["true", "true"],
			timeout: "1m",
			readOnly: [shared],
			writable: [cache],
			env: { CI: "1" },
		});
		check(
			read(checked.out.lane),
			{ run: "true", timeout: undefined },
			{
				label: "again",
			},
		);
		return apply(
			extend(checked.out.lane),
			changeset(built.out.lane).out.changeset,
			{ strategy: "clean" },
		);
	});
	const ir = buildIr(everything);
	expect(nodeOf(ir, "resumed")).toMatchObject({
		in: { session: { [MAESTRO_TYPE]: "repo.session" } },
		out: { session: { [MAESTRO_TYPE]: "repo.session" } },
		config: { lane: { mode: "extend" } },
	});
	expect(nodeOf(ir, "agent")?.in).toEqual({ prompt: expect.anything() });
	expect(ir.edges).toContainEqual({
		kind: "data",
		from: { node: "agent", port: "session" },
		to: { node: "resumed", port: "session" },
	});
	expect(nodeOf(ir, "apply")).toMatchObject({
		in: { changeset: expect.anything() },
		config: { lane: { mode: "extend" }, strategy: "clean" },
	});
	expect(nodeOf(ir, "again")).toMatchObject({
		config: { check: { run: "true" } },
	});
	expect(await repo().composeIt(ir)).toMatchObject({ ok: true });
});

test("the agent's own port names are the host's, and each is refused only on the side that has it", () => {
	expect(AGENT_IN_PORTS).toEqual(HOST_IN_PORTS);
	expect(AGENT_OUT_PORTS).toEqual(HOST_OUT_PORTS);
	expect(REPORT).toEqual(HOST_REPORT);
	const refused = (field: "attachments" | "out", name: string) => {
		const clash = composition("clash", { examples: [{}] }, () => {
			const first = builder({ task: "a", lane: fresh() });
			return builder({
				task: "b",
				lane: fresh(),
				[field]:
					field === "out"
						? { [name]: MarkdownOut("x.md") }
						: { [name]: { artifact: first.out.report, hint: "now" } },
			});
		});
		try {
			buildIr(clash);
			return false;
		} catch (error) {
			if (error instanceof BuildError)
				return error.diagnostic.code === "SCOPE.name";
			throw error;
		}
	};
	for (const name of ["prompt", "lane", "report", "staged"]) {
		expect(refused("attachments", name)).toBe(AGENT_IN_PORTS.includes(name));
		expect(refused("out", name)).toBe(AGENT_OUT_PORTS.includes(name));
	}
});

test("changeset lowers a message, literal or ref, to a message input, and has none otherwise", () => {
	const ir = buildIr(
		composition("messages", { examples: [{}] }, () => {
			const built = builder({ task: "a", lane: fresh() });
			changeset(built.out.lane, { label: "bare" });
			changeset(built.out.lane, { label: "literal", message: "Fix it" });
			return changeset(built.out.lane, {
				label: "ref",
				message: built.out.report.get("summary"),
			});
		}),
	);
	expect(nodeOf(ir, "bare")?.in).not.toHaveProperty("message");
	expect(nodeOf(ir, "literal")?.literals).toMatchObject({ message: "Fix it" });
	expect(nodeOf(ir, "ref")?.in).toHaveProperty("message");
	expect(nodeOf(ir, "ref")?.literals).not.toHaveProperty("message");
});

test("only a seat call takes a session, extend refuses the removed resume, and apply takes one changeset", () => {
	composition("types", { examples: [{}] }, () => {
		const built = builder({ task: "a", lane: fresh() });
		const cs = changeset(built.out.lane).out.changeset;
		// @ts-expect-error a session is the seat call's, not the lane input's
		builder({ task: "b", lane: { ...fresh(), session: built.out.session } });
		// @ts-expect-error only a seat call continues a session
		check(fresh(), undefined, { session: built.out.session });
		// @ts-expect-error apply takes one changeset, not a record of them
		apply(fresh(), { a: cs, b: cs });
		return built;
	});
	const resumed = composition("resumed", { examples: [{}] }, () => {
		const built = builder({ task: "a", lane: fresh() });
		return builder({
			task: "b",
			// @ts-expect-error resume was removed: a seat call takes session
			lane: extend(built.out.lane, { resume: true }),
		});
	});
	expect(buildCode(() => buildIr(resumed))).toBe("TYPE.options");
});

describe("seat", () => {
	const reviewer = seat("reviewer", {
		verdict: true,
		out: {
			notes: MarkdownOut("notes.md"),
			score: JsonOut("score.json", Text()),
		},
		checks: ["test"],
	});
	const critic = seat("critic", { profile: "acme/critic" });

	test("calls emit agents running the seat's own profile, or the one it names, with its outputs and checks added to", async () => {
		const calls = composition("calls", { examples: [{}] }, () => {
			const first = reviewer({ label: "first", task: "look", lane: fresh() });
			const second = reviewer({
				label: "second",
				task: "look again",
				lane: fork(first.out.lane),
				attachments: {
					earlier: { artifact: first.out.notes, hint: "first" },
				},
				out: { notes: MarkdownOut("more.md"), plan: MarkdownOut("plan.md") },
				checks: ["lint", "test"],
			});
			critic({ label: "third", task: "judge", lane: read(first.out.lane) });
			const carried: Ref<ArtifactRef>[] = [second.out.score, second.out.plan];
			return carried[0];
		});
		const ir = buildIr(calls);
		expect(nodeOf(ir, "first")).toMatchObject({
			literals: { prompt: "look" },
			config: {
				profile: "reviewer",
				seat: "reviewer",
				lane: { mode: "fresh" },
				verdict: true,
				checks: ["test"],
				out: {
					notes: { file: "notes.md", format: "markdown" },
					score: { file: "score.json", format: "json" },
				},
			},
		});
		expect(nodeOf(ir, "second")).toMatchObject({
			literals: { prompt: "look again" },
			config: {
				profile: "reviewer",
				seat: "reviewer",
				lane: { mode: "fork" },
				verdict: true,
				checks: ["test", "lint"],
				attachments: { earlier: { hint: "first", type: "core.markdown" } },
				out: {
					notes: { file: "more.md" },
					score: { file: "score.json" },
					plan: { file: "plan.md" },
				},
			},
		});
		expect(nodeOf(ir, "third")).toMatchObject({
			config: { profile: "acme/critic", seat: "critic" },
		});
		expect(Object.keys(nodeOf(ir, "second")?.out ?? {}).sort()).toEqual([
			"lane",
			"notes",
			"plan",
			"report",
			"score",
			"session",
			"staged",
		]);
		const { composeIt } = repo();
		expect(await composeIt(ir)).toMatchObject({ ok: true });
	});
});

describe("examples", () => {
	test("a review whose skeptic shares its lens's model family fails the build with ASSERT, with no spend", async () => {
		const pair = { lensModel: "openai/gpt-5", skepticModel: "openai/o3" };
		expect(buildCode(() => buildIr(review, pair, CODE))).toBe("ASSERT.failed");
		const { composeIt, requests } = repo();
		expect(await composeIt(buildIr(review, {}, CODE))).toMatchObject({
			ok: true,
		});
		expect(requests).toEqual([]);
	});

	test("build-then-repair builds a seated build and repair, and composes", async () => {
		const ir = buildIr(buildThenRepair);
		expect(nodeOf(ir, "build")).toMatchObject({
			config: { profile: "builder", seat: "builder" },
		});
		expect(nodeOf(ir, "loop/repair")).toMatchObject({
			config: {
				profile: "builder",
				seat: "builder",
				attachments: { logs: { type: "core.file" } },
			},
		});
		expect(await repo().composeIt(ir)).toMatchObject({ ok: true });
	});

	test("build-then-repair repairs a red check in the builder's session", async () => {
		const ir = buildIr(buildThenRepair);
		const { host, hostConfig, roots, requests } = repo(
			(req): Record<string, string> =>
				req.prompt.includes("Make check") ? { "fixed.txt": "x\n" } : {},
			{ test: { run: "test -f fixed.txt", hint: "fixed.txt exists" } },
		);
		const concert = await stubConcert(ir, {
			hosts: [host],
			config: hostConfig,
			roots,
			code: stdlib,
		});
		await concert.close();
		expect(concert.result).toMatchObject({ outcome: "ok", node: "result" });
		const [build, repair] = requests;
		expect(requests).toHaveLength(2);
		expect(repair?.session).toEqual(
			build?.session as HarnessRequest["session"],
		);
	});

	test("build-then-repair runs no repair on a green build", async () => {
		const ir = buildIr(buildThenRepair);
		const { host, hostConfig, roots, requests } = repo();
		const concert = await stubConcert(ir, {
			hosts: [host],
			config: hostConfig,
			roots,
			code: stdlib,
		});
		await concert.close();
		expect(concert.result).toMatchObject({ outcome: "ok", node: "result" });
		expect(requests.map((r) => r.prompt)).toEqual([
			expect.stringContaining("Add a greeting"),
		]);
	});

	/** What an implementer writes: the file its task names, holding the task. A resolver writes `resolved`. */
	const implement = (req: HarnessRequest): Record<string, string> => {
		const task = req.prompt.split("\n")[0] ?? "";
		const file = /^Write (\S+)\./.exec(task)?.[1];
		if (file) return { [file]: `${task}\n` };
		return req.prompt.startsWith("Resolve") ? { "b.txt": "resolved\n" } : {};
	};

	test.each([
		{ tasks: ["Write b.txt."], agents: 1, added: ["b.txt"], resolved: false },
		{
			tasks: ["Write b.txt.", "Write c.txt.", "Write d.txt."],
			agents: 3,
			added: ["b.txt", "c.txt", "d.txt"],
			resolved: false,
		},
		{
			tasks: ["Write b.txt.", "Write b.txt. Twice", "Write c.txt."],
			agents: 4,
			added: ["b.txt", "c.txt", "+resolved"],
			resolved: true,
		},
	])(
		"the fold builds, composes, and merges $tasks in a stub concert",
		async ({ tasks, agents, added, resolved }) => {
			const ir = buildIr(fold, { tasks }, CODE);
			const { host, hostConfig, roots, composeIt, requests, framed } =
				repo(implement);
			expect(await composeIt(ir)).toMatchObject({ ok: true });

			const concert = await stubConcert(ir, {
				hosts: [host],
				config: hostConfig,
				roots,
				code: { ...stdlib, ...CODE },
			});
			const result = concert.record
				.instances(concert.id)
				.find((i) => i.node === "result")?.outputs?.changeset as ArtifactRef;
			expect(concert.result).toMatchObject({ outcome: "ok", node: "result" });
			expect(requests).toHaveLength(agents);
			const resolver = requests.find((r) => r.prompt.startsWith("Resolve"));
			expect(resolver !== undefined).toBe(resolved);
			if (resolver)
				expect(framed.get(resolver)).toContain(
					"- `/in/incoming`: Read when you need",
				);
			const series = joinPath(
				concertDirs(concert.dir, concert.id).artifacts,
				result.path,
			);
			const patches = readdirSync(series)
				.filter((f) => f.endsWith(".patch"))
				.map((f) => readFileSync(joinPath(series, f), "utf8"))
				.join("");
			await concert.close();
			for (const line of added) expect(patches).toContain(line);
		},
	);
});
