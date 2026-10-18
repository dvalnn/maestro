import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { concertDirs } from "@maestro/core/perform";
import { repoHost } from "@maestro/host-repo";
import { type HarnessRequest, stubHarness } from "@maestro/host-repo/harness";
import type { ArtifactRef, Ir, IrNode } from "@maestro/ir";
import { BuildError, composition, type Ref, Text } from "@maestro/sdk";
import * as stdlib from "@maestro/sdk/stdlib";
import { buildIr, composeIr, stubConcert } from "@maestro/testkit";
import {
	buildThenRepair,
	byFinding,
	fold,
	nthChangeset,
	review,
} from "./fixtures/examples";
import {
	agent,
	apply,
	changeset,
	check,
	fork,
	fresh,
	JsonOut,
	join,
	Lane,
	MarkdownOut,
	read,
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

const ROLES = ["builder", "implementer", "resolver", "reviewer"];

/** A repo host on a toy target whose stub harness writes the files `writes` gives each request, and the requests it got. */
function repo(
	writes: (req: HarnessRequest) => Record<string, string> = () => ({}),
	checks: Record<string, string> = { test: "true", lint: "true" },
) {
	const requests: HarnessRequest[] = [];
	const host = repoHost({
		harnesses: [
			stubHarness((req) => {
				requests.push(req);
				return [
					...Object.entries(writes(req)).map(([write, content]) => ({
						write,
						content,
					})),
					{
						emit: {
							type: "text",
							text: JSON.stringify({ outcome: "ok", report: "done" }),
						},
					},
				];
			}),
		],
	});
	const hostConfig = {
		target: {
			repo: toyTarget(),
			base: "main",
			checks,
		},
		roles: Object.fromEntries(
			ROLES.map((r) => [r, { harness: "stub", model: "none" }]),
		),
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
	};
	const composeIt = (ir: Ir) => composeIr(ir, { hosts: [host], config });
	return { host, hostConfig, requests, composeIt };
}

const CODE = { byFinding, nthChangeset };

const nodeOf = (ir: Ir, id: string): IrNode | undefined =>
	ir.nodes.find((n) => n.id === id);

function buildCode(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof BuildError) return error.diagnostic.code;
		throw error;
	}
	throw new Error("expected a BuildError, and none was thrown");
}

describe("lanes", () => {
	test("a lane ref param forked or read is a repo.lane literal, and composes", async () => {
		const follow = composition(
			"follow",
			{ params: { from: Lane }, examples: [{ from: "c.lens/skeptic" }] },
			({ from }) => {
				const copied = agent({ task: "go", lane: fork(from), role: "builder" });
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
		expect(nodeOf(ir, "look")?.out).toEqual({ logs: expect.anything() });
		const { composeIt, requests } = repo();
		expect(await composeIt(ir)).toMatchObject({ ok: true });
		expect(requests).toEqual([]);
	});

	test("one version joined twice fails compose with HOST.lane, with no spend", async () => {
		const twice = composition("twice", { examples: [{}] }, () => {
			const first = agent({ task: "a", lane: fresh(), role: "builder" });
			agent({
				label: "x",
				task: "b",
				lane: join(first.out.lane),
				role: "builder",
			});
			return agent({
				label: "y",
				task: "c",
				lane: join(first.out.lane),
				role: "builder",
			});
		});
		const { composeIt, requests } = repo();
		const composed = await composeIt(buildIr(twice));
		expect(composed.ok).toBe(false);
		if (!composed.ok)
			expect(composed.diagnostics.map((d) => d.code)).toContain("HOST.lane");
		expect(requests).toEqual([]);
	});
});

test("every option of agent, check and apply composes against the repo host", async () => {
	const shared = tmp();
	const cache = tmp();
	const everything = composition("everything", { examples: [{}] }, () => {
		const built = agent({
			task: "build",
			lane: fresh("main"),
			role: { name: "builder", harness: "stub", model: "m", thinking: "low" },
			identity: "You build.",
			checks: ["test"],
			readOnly: [shared],
		});
		const resumed = agent({
			label: "resumed",
			task: "go on",
			lane: join(built.out.lane),
			role: "builder",
			resume: true,
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
			join(checked.out.lane),
			{ built: changeset(built.out.lane).out.changeset },
			{ strategy: "ff" },
		);
	});
	const ir = buildIr(everything);
	expect(nodeOf(ir, "again")).toMatchObject({
		config: { check: { run: "true" } },
	});
	expect(await repo().composeIt(ir)).toMatchObject({ ok: true });
});

describe("seat", () => {
	const reviewer = seat({
		role: { name: "reviewer", model: "a/one", thinking: "high" },
		identity: "You review.",
		out: {
			notes: MarkdownOut("notes.md"),
			score: JsonOut("score.json", Text()),
		},
		checks: ["test"],
	});

	test("two calls emit agents with the seat's identity, its role overridden where the call sets it, and its outputs and checks added to", async () => {
		const twoCalls = composition("two_calls", { examples: [{}] }, () => {
			const first = reviewer({ label: "first", task: "look", lane: fresh() });
			const second = reviewer({
				label: "second",
				task: "look again",
				lane: fork(first.out.lane),
				role: { model: "b/two", thinking: undefined },
				refs: { earlier: { artifact: first.out.notes, when: "first" } },
				out: { notes: MarkdownOut("more.md"), plan: MarkdownOut("plan.md") },
				checks: ["lint", "test"],
			});
			const carried: Ref<ArtifactRef>[] = [second.out.score, second.out.plan];
			return carried[0];
		});
		const ir = buildIr(twoCalls);
		const identity = { identity: "You review." };
		expect(nodeOf(ir, "first")).toMatchObject({
			literals: { prompt: "look", ...identity },
			config: {
				role: { name: "reviewer", model: "a/one", thinking: "high" },
				lane: { mode: "fresh" },
				checks: ["test"],
				out: {
					notes: { file: "notes.md", format: "markdown" },
					score: { file: "score.json", format: "json" },
				},
			},
		});
		expect(nodeOf(ir, "second")).toMatchObject({
			literals: { prompt: "look again", ...identity },
			config: {
				role: { name: "reviewer", model: "b/two", thinking: "high" },
				lane: { mode: "fork" },
				checks: ["test", "lint"],
				refs: { earlier: { when: "first", type: "core.markdown" } },
				out: {
					notes: { file: "more.md" },
					score: { file: "score.json" },
					plan: { file: "plan.md" },
				},
			},
		});
		expect(Object.keys(nodeOf(ir, "second")?.out ?? {}).sort()).toEqual([
			"lane",
			"notes",
			"plan",
			"report",
			"score",
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
			literals: { identity: expect.any(String) },
		});
		expect(nodeOf(ir, "loop/repair")).toMatchObject({
			literals: { identity: expect.any(String) },
			config: { refs: { logs: { type: "core.file" } } },
		});
		expect(await repo().composeIt(ir)).toMatchObject({ ok: true });
	});

	test("build-then-repair repairs a red check in the builder's session", async () => {
		const ir = buildIr(buildThenRepair);
		const { host, hostConfig, requests } = repo(
			(req): Record<string, string> =>
				req.prompt.startsWith("Make") ? { "fixed.txt": "x\n" } : {},
			{ test: "test -f fixed.txt" },
		);
		const concert = await stubConcert(ir, {
			hosts: [host],
			config: hostConfig,
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
		const { host, hostConfig, requests } = repo();
		const concert = await stubConcert(ir, {
			hosts: [host],
			config: hostConfig,
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
		{
			tasks: ["Write b.txt.", "Write c.txt.", "Write d.txt."],
			agents: 3,
			added: ["b.txt", "c.txt", "d.txt"],
		},
		{
			tasks: ["Write b.txt.", "Write b.txt. Twice", "Write c.txt."],
			agents: 4,
			added: ["b.txt", "c.txt", "+resolved"],
		},
	])(
		"the fold builds, composes, and merges $tasks in a stub concert",
		async ({ tasks, agents, added }) => {
			const ir = buildIr(fold, { tasks }, CODE);
			const { host, hostConfig, composeIt, requests } = repo(implement);
			expect(await composeIt(ir)).toMatchObject({ ok: true });

			const concert = await stubConcert(ir, {
				hosts: [host],
				config: hostConfig,
				code: { ...stdlib, ...CODE },
			});
			const result = concert.record
				.instances(concert.id)
				.find((i) => i.node === "result")?.outputs?.changeset as ArtifactRef;
			expect(concert.result).toMatchObject({ outcome: "ok", node: "result" });
			expect(requests).toHaveLength(agents);
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
