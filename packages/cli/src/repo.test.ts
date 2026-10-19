import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, FIXTURES, scratch } from "./fixtures/packs";
import { idOf, json, world } from "./fixtures/world";
import { builtinHosts } from "./hosts";

afterEach(cleanup);

const REPO = join(FIXTURES, "repo");
const hosts = builtinHosts(process.env);

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
async function toyTarget(): Promise<string> {
	const target = await scratch();
	for (const args of [
		["init", "-q", "-b", "main"],
		["commit", "-q", "--allow-empty", "-m", "one"],
	]) {
		const p = Bun.spawnSync(["git", ...args], { cwd: target, env: GIT_ENV });
		if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr}`);
	}
	return target;
}

/** A world whose workspace config points the repo host at a toy target, with `extra` config lines. */
async function repoWorld(extra = "") {
	const w = await world();
	const target = await toyTarget();
	writeFileSync(
		join(w.cwd, ".maestro/config.yaml"),
		`target:\n  repo: ${target}\n  base: main\n${extra}`,
	);
	const call = (args: string[]) => w.call(args, { hosts });
	return { ...w, call, target };
}

test("a lane ref names a version by the instance id ls shows, ls shows its disk use and prune frees it", async () => {
	const w = await repoWorld();
	const marked = await w.call(["perform", join(REPO, "mark.ts")]);
	expect(marked).toMatchObject({ code: 0 });
	const id = idOf(marked);

	const shown = "parMap[risk]/skeptic";
	expect((await w.call(["ls", id])).out).toContain(shown);
	const { instances } = json(await w.call(["ls", id, "--json"]));
	const ref = `${id}.${shown}`;
	expect(
		instances.find((i: { node: string }) => i.node === "parMap/skeptic")
			?.outputs.lane,
	).toBe(ref);
	const followed = await w.call([
		"perform",
		join(REPO, "follow.ts"),
		"--from",
		ref,
	]);
	expect(followed).toMatchObject({ code: 0 });

	const diskOf = async () =>
		json(await w.call(["ls", "--json"])).find(
			(r: { id: string }) => r.id === id,
		)?.diskUse;
	expect(await diskOf()).toBeGreaterThan(64 * 1024);
	expect(await w.call(["prune", id, "--yes"])).toMatchObject({ code: 0 });
	expect(await diskOf()).toBeUndefined();
	expect(
		await w.call(["perform", join(REPO, "follow.ts"), "--from", ref]),
	).toMatchObject({ code: 1 });
});

test("the built-in stub harness performs an agent that declares outputs, and the check after it settles ok", async () => {
	const file = join(await scratch(), "smoke.ts");
	writeFileSync(
		file,
		`import { agent, check, fresh, JsonOut, MarkdownOut, read } from "@maestro/host-repo-sdk";
import { composition, List, Struct, Text } from "@maestro/sdk";

const Rows = Struct({ rows: List(Struct({ name: Text() })) });

export const smoke = composition("smoke", { examples: [{}] }, () => {
	const a = agent({
		label: "a",
		task: "nothing",
		lane: fresh(),
		role: "smoke",
		out: { rows: JsonOut("rows.json", Rows), notes: MarkdownOut("notes.md") },
	});
	return check(read(a.out.lane), { run: "true" }, { label: "ok" });
});
`,
	);
	const w = await repoWorld(
		"roles:\n  smoke:\n    harness: stub\n    model: none\n",
	);
	const done = await w.call(["perform", file]);
	expect(done).toMatchObject({ code: 0 });
	const { instances } = json(await w.call(["ls", idOf(done), "--json"]));
	expect(instances.map((i: { status: string }) => i.status)).toEqual([
		"ok",
		"ok",
	]);
});

/** Each real harness behind its gate: the agent's identity and file, and the metrics it reports. */
const REAL_HARNESSES = [
	{
		gate: "MAESTRO_PI",
		harness: "pi",
		model: process.env.MAESTRO_PI_MODEL ?? "github-copilot/gpt-5-mini",
	},
	{
		gate: "MAESTRO_CLAUDE",
		harness: "claude",
		model: process.env.MAESTRO_CLAUDE_MODEL ?? "haiku",
	},
];

for (const { gate, harness, model } of REAL_HARNESSES) {
	test.skipIf(!process.env[gate])(
		`${harness} performs an agent with an identity, and its file is in the version a check reads`,
		async () => {
			const w = await repoWorld(
				`roles:\n  writer:\n    harness: ${harness}\n    model: ${model}\n    thinking: low\n`,
			);
			const done = await w.call(["perform", join(REPO, "write.ts")]);
			expect(done).toMatchObject({ code: 0 });
			const { instances } = json(await w.call(["ls", idOf(done), "--json"]));
			const agent = instances.find((i: { node: string }) => i.node === "write");
			expect(agent.outputs.report.toLowerCase()).toContain("kumquat");
			expect(agent.metrics.tokens_in).toBeGreaterThan(0);
			const [identity] = [
				...new Bun.Glob("**/staged/identity.md").scanSync({
					cwd: w.root,
					absolute: true,
				}),
			];
			expect(readFileSync(identity ?? "", "utf8")).toContain("kumquat");
		},
		180_000,
	);
}
