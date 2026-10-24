import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, FIXTURES, scratch } from "./fixtures/packs";
import { idOf, json, world } from "./fixtures/world";
import { builtinHosts } from "./hosts";

afterEach(cleanup);

const REPO = join(FIXTURES, "repo");

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
async function repoWorld(extra = "", env: Record<string, string> = {}) {
	const w = await world();
	const target = await toyTarget();
	writeFileSync(
		join(w.cwd, ".maestro/config.yaml"),
		`target:\n  repo: ${target}\n  base: main\n${extra}`,
	);
	const stubbed = builtinHosts({ ...process.env, ...env });
	const call = (args: string[], over: Parameters<typeof w.call>[1] = {}) =>
		w.call(args, { hosts: stubbed, ...over });
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

/** A composition of one stub agent declaring outputs, then a check. */
async function smokeFile() {
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
	return file;
}

const STUB_DELAY_MS = 700;

test("the built-in stub harness, delayed per turn, performs an agent that declares outputs, and the check after it settles ok", async () => {
	const file = await smokeFile();
	const w = await repoWorld(
		"roles:\n  smoke:\n    harness: stub\n    model: none\n",
		{ MAESTRO_STUB_DELAY: `${STUB_DELAY_MS}ms` },
	);
	const began = Date.now();
	const done = await w.call(["perform", file]);
	expect(Date.now() - began).toBeGreaterThanOrEqual(STUB_DELAY_MS);
	expect(done).toMatchObject({ code: 0 });
	const { instances } = json(await w.call(["ls", idOf(done), "--json"]));
	expect(instances.map((i: { status: string }) => i.status)).toEqual([
		"ok",
		"ok",
	]);
});

test("a malformed MAESTRO_STUB_DELAY fails the stub agent, naming it", async () => {
	const w = await repoWorld(
		"roles:\n  smoke:\n    harness: stub\n    model: none\n",
		{ MAESTRO_STUB_DELAY: "soon" },
	);
	const done = await w.call(["perform", await smokeFile()]);
	expect(done.code).not.toBe(0);
	expect(done.out + done.err).toContain("MAESTRO_STUB_DELAY");
});

/** A composition of a stub agent with an identity and a markdown output in a scope, and two more under a parMap. */
async function artsFile() {
	const file = join(await scratch(), "arts.ts");
	writeFileSync(
		file,
		`import { agent, fresh, MarkdownOut } from "@maestro/host-repo-sdk";
import { composition, iter, use } from "@maestro/sdk";

const inner = composition("inner", { examples: [{}] }, () =>
	agent({
		label: "a",
		task: "nothing",
		identity: "terse",
		lane: fresh(),
		role: "smoke",
		out: { notes: MarkdownOut("notes.md") },
	}),
);

export const arts = composition("arts", { examples: [{}] }, () => {
	use(inner, {});
	return iter.parMap(["x", "y"], () =>
		agent({ label: "b", task: "nothing", lane: fresh(), role: "smoke" }),
		{ onError: "stop" },
	);
});
`,
	);
	return file;
}

test("artifact lists a concert's artifacts, prints an instance's files by a unique ending, and refuses what names none", async () => {
	const w = await repoWorld(SMOKE_ROLE("stub"));
	const done = await w.call(["perform", await artsFile()]);
	expect(done).toMatchObject({ code: 0 });
	const id = idOf(done);
	const area = join(w.root, "data/maestro/concerts", id, "artifacts");
	const listed: { instance: string; port: string; path: string }[] = json(
		await w.call(["art", id, "--json"]),
	);
	expect(
		listed
			.filter((a) => a.instance === "inner/a")
			.map((a) => [a.port, a.path.startsWith(`${area}/`)]),
	).toEqual([
		["notes", true],
		["staged", true],
	]);
	const table = (await w.call(["artifact", id])).out.split("\n");
	expect(table[0]).toMatch(/^instance +port +stale +path$/);
	expect(table).toContain(
		`inner/a      notes          ${listed.find((a) => a.port === "notes")?.path}`,
	);
	expect((await w.call(["art", id, "--path"])).out).toBe(
		listed.map((a) => a.path).join("\n"),
	);

	const staged = (name: string) =>
		readFileSync(
			join(listed.find((a) => a.port === "staged")?.path ?? "", name),
			"utf8",
		);
	const notes = listed.find((a) => a.port === "notes")?.path ?? "";
	/** Stdout of `art <id> ...args` exactly as written. */
	const raw = async (...args: string[]) => {
		const written: string[] = [];
		const done = await w.call(["art", id, ...args], {
			stdout: (line) => written.push(`${line}\n`),
			stdoutBytes: (bytes) => written.push(new TextDecoder().decode(bytes)),
		});
		expect(done.code).toBe(0);
		return written.join("");
	};
	const prompt = staged("prompt.md");
	expect(await raw("a", "staged/prompt.md")).toBe(prompt);
	const ended = (text: string) =>
		text === "" || text.endsWith("\n") ? text : `${text}\n`;
	expect(await raw("inner/a")).toBe(
		`══ notes.md\n${ended(readFileSync(notes, "utf8"))}══ staged/identity.md\n${ended(staged("identity.md"))}══ staged/prompt.md\n${prompt}`,
	);
	expect(await raw("a", "notes.md", "--path")).toBe(`${notes}\n`);
	expect(await raw("parMap[x]/b")).toBe(
		readFileSync(
			join(
				listed.find((a) => a.instance === "parMap[x]/b")?.path ?? "",
				"prompt.md",
			),
			"utf8",
		),
	);

	expect(await w.call(["art", id, "parMap"])).toMatchObject({
		code: 1,
		err: `instance 'parMap' of concert ${id} has no artifacts yet\nSee where it stands with 'maestro ls ${id}'`,
	});
	for (const ending of ["b", "parMap/b"])
		expect(await w.call(["art", id, ending])).toMatchObject({
			code: 2,
			err: `'${ending}' ends 2 instances: parMap[x]/b, parMap[y]/b\nName one of them in full`,
		});
	for (const [args, last] of [
		[[], "Name the concert, as 'maestro ls' lists it"],
		[[id, "nope"], `List them with 'maestro ls ${id}'`],
		[[id, "a", "nope.md"], `List them with 'maestro art ${id} inner/a --path'`],
		[[id, "a", "--json"], "Drop --json to print the instance's files"],
		[[id, "--json", "--path"], "Drop one of them"],
	] as const) {
		const refused = await w.call(["art", ...args]);
		expect(refused.code).toBe(2);
		const text: string = refused.err || json(refused).error;
		expect(text.split("\n").at(-1)).toBe(last);
	}
	expect((await w.call(["art"])).err).toStartWith(
		"expected one concert, got 0",
	);
	const db = new Database(join(w.root, "data/maestro/record.db"));
	db.run(
		"UPDATE instances SET stale = 1 WHERE (node, expansion) IN (SELECT node, expansion FROM artifacts WHERE path LIKE '%notes.md')",
	);
	db.close();
	const note = "warning: instance 'inner/a' is stale, from an earlier attempt";
	const marked: { instance: string; stale?: true }[] = json(
		await w.call(["art", id, "--json"]),
	);
	expect(
		marked.map((a) => [a.instance === "inner/a", "stale" in a, a.stale]),
	).toEqual(
		marked.map((a) =>
			a.instance === "inner/a" ? [true, true, true] : [false, false, undefined],
		),
	);
	expect(
		(await w.call(["art", id])).out
			.split("\n")
			.filter((l) => /^\S+ +\S+ +stale +\//.test(l))
			.map((l) => l.split(" ")[0]),
	).toEqual(["inner/a", "inner/a"]);
	for (const args of [["a"], ["a", "notes.md"], ["a", "--path"]])
		expect((await w.call(["art", id, ...args])).err).toBe(note);
	expect((await w.call(["art", id, "parMap[x]/b"])).err).toBe("");
	rmSync(notes);
	expect(await w.call(["art", id, "a", "notes.md"])).toMatchObject({
		code: 1,
		err: `the artifact is not at ${notes}\nPerform the concert again, or pick another instance`,
	});
});

/** A composition whose agent pins an unloaded harness inline, after a code node that fails while `gate` is missing. */
async function pinned(gate = "/"): Promise<string> {
	const file = join(await scratch(), "pinned.ts");
	writeFileSync(
		file,
		`import { existsSync } from "node:fs";
import { agent, check, fresh, read } from "@maestro/host-repo-sdk";
import { code, composition, Text } from "@maestro/sdk";

export function opened() {
	if (!existsSync("${gate}")) throw new Error("gate closed");
	return { text: "go" };
}

export const pinned = composition("pinned", { examples: [{}] }, () => {
	const gate = code(opened, { in: {}, out: { text: Text() } });
	const a = agent({
		label: "a",
		task: gate.out.text,
		lane: fresh(),
		role: { name: "smoke", harness: "gone", model: "pinned" },
	});
	return check(read(a.out.lane), { run: "true" }, { label: "ok" });
});
`,
	);
	return file;
}

const SMOKE_ROLE = (harness: string, model = "none") =>
	`roles:\n  smoke:\n    harness: ${harness}\n    model: ${model}\n`;

describe("role precedence", () => {
	test("a role field on the command line beats the inline one, which beats the file's, per field", async () => {
		const w = await repoWorld(SMOKE_ROLE("gone"));
		const file = await pinned();
		await Bun.write(
			join(w.cwd, ".maestro/profiles/free.yaml"),
			"roles:\n  smoke:\n    harness: stub\n",
		);
		const refused = await w.call([
			"perform",
			file,
			"-c",
			"roles.smoke.model=x",
		]);
		expect(refused).toMatchObject({ code: 2 });
		expect(refused.err).toContain("harness 'gone', which is not loaded");
		for (const flags of [
			["--profile", "free"],
			["-c", "roles.smoke.harness=stub"],
		])
			expect(await w.call(["perform", file, ...flags])).toMatchObject({
				code: 0,
			});
	});

	test("an inline harness beats the config file's", async () => {
		const w = await repoWorld(SMOKE_ROLE("gone"));
		const file = await pinned();
		writeFileSync(file, readFileSync(file, "utf8").replace('"gone"', '"stub"'));
		expect(await w.call(["perform", file])).toMatchObject({ code: 0 });
	});

	test("compose names what each agent runs on and the layer that set it, in text and JSON", async () => {
		const w = await repoWorld(
			"roles:\n  smoke:\n    harness: stub\n    model: none\n    thinking: low\n",
		);
		const mapped = await smokeFile();
		const inline = await pinned();
		writeFileSync(
			inline,
			readFileSync(inline, "utf8").replace('"gone"', '"stub"'),
		);
		const agents = async (file: string, ...flags: string[]) =>
			json(await w.call(["compose", file, "--json", ...flags])).agents;
		const layers = (v: string, layer: string) => ({ value: v, layer });

		expect(await agents(mapped)).toEqual([
			{
				node: "a",
				role: "smoke",
				harness: layers("stub", "workspace"),
				model: layers("none", "workspace"),
				thinking: layers("low", "workspace"),
			},
		]);
		expect(await agents(mapped, "-c", "roles.smoke.model=big")).toMatchObject([
			{ harness: layers("stub", "workspace"), model: layers("big", "flag") },
		]);
		expect(await agents(inline)).toMatchObject([
			{
				harness: layers("stub", "composition"),
				model: layers("pinned", "composition"),
				thinking: layers("low", "workspace"),
			},
		]);

		const { out } = await w.call([
			"compose",
			mapped,
			"--plan",
			"-c",
			"roles.smoke.model=big",
		]);
		expect(out).toMatch(
			/agents:\n {2}a +smoke +stub +big +low +harness:workspace model:flag thinking:workspace$/,
		);
		expect((await w.call(["compose", inline, "--plan"])).out).toMatch(
			/agents:\n {2}a +smoke +stub +pinned +low +harness:composition model:composition thinking:workspace$/,
		);
	});

	test("a resume reapplies the recorded profile over the inline role", async () => {
		const w = await repoWorld(SMOKE_ROLE("gone"));
		const gate = join(w.cwd, "gate");
		await Bun.write(
			join(w.cwd, ".maestro/profiles/free.yaml"),
			"roles:\n  smoke:\n    harness: stub\n",
		);
		const failed = await w.call([
			"perform",
			await pinned(gate),
			"--profile",
			"free",
		]);
		expect(failed).toMatchObject({ code: 1 });
		expect(failed.err).toContain("gate closed");
		writeFileSync(gate, "");
		expect(await w.call(["perform", "--resume", idOf(failed)])).toMatchObject({
			code: 0,
		});
	});
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

describe("changeset", () => {
	/** Git `args` in `repo`, its stdout trimmed. */
	const git = (repo: string, ...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", repo, ...args], { env: GIT_ENV });
		if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr}`);
		return p.stdout.toString().trim();
	};

	/** A concert of `file` whose changeset rewrites `a.txt` of the target, committed as `one` before it, and `cs`. */
	async function edited(file = "edit.ts") {
		const w = await repoWorld();
		writeFileSync(join(w.target, "a.txt"), "one\n");
		git(w.target, "add", "a.txt");
		git(w.target, "commit", "-q", "-m", "two");
		const done = await w.call(["perform", join(REPO, file)]);
		expect(done).toMatchObject({ code: 0 });
		const cs = (...args: string[]) => w.call(["cs", ...args], { env: GIT_ENV });
		return { ...w, id: idOf(done), cs };
	}

	const a = (repo: string) => readFileSync(join(repo, "a.txt"), "utf8");

	test("show prints the diff on its base and leaves the checkout as it is; --node takes a named instance's", async () => {
		const w = await edited();
		const shown = await w.cs("show", w.id);
		const diff = shown.out;
		expect(shown).toMatchObject({
			code: 0,
			out: expect.stringContaining("-one\n+edited"),
			err: expect.stringMatching(/\(node \S+, concert ok\) on base \w+ two$/),
		});
		expect(a(w.target)).toBe("one\n");
		expect(git(w.target, "status", "--porcelain")).toBe("");
		expect((await w.cs("show", w.id, "--stat")).out).toContain("a.txt | 2");
		expect((await w.cs("show", w.id, "--summary")).out).toMatch(
			/^tour {3}-\ntitle {2}-\nM\ta\.txt$/,
		);

		const { instances } = json(await w.call(["ls", w.id, "--json"]));
		const made = instances.find(
			(i: { outputs?: object }) => i.outputs && "changeset" in i.outputs,
		);
		expect((await w.cs("show", w.id, "--node", made.node)).out).toBe(diff);
		expect(await w.cs("show", w.id, "--node", "edit")).toMatchObject({
			code: 1,
			err: expect.stringContaining("instance 'edit' of concert"),
		});
		expect(await w.cs("show", w.id, "--node", "nope")).toMatchObject({
			code: 2,
		});

		const fan = idOf(await w.call(["perform", join(REPO, "fan.ts")]));
		expect((await w.cs("show", fan, "--node", "innerSet")).out).toContain(
			"+inner",
		);
		expect(await w.cs("show", fan, "--node", "set")).toMatchObject({
			code: 2,
			err: "'set' ends 2 instances: parMap[x]/set, parMap[y]/set\nName one of them in full",
		});

		const checked = await w.call([
			"perform",
			join(REPO, "edit.ts"),
			"-c",
			'target.checks.lint={run: "true"}',
		]);
		const unset = ["-c", "target.checks.lint=!delete"];
		expect(await w.cs("show", idOf(checked), ...unset)).toMatchObject({
			code: 0,
		});
	});

	test("apply stages the changeset on HEAD, refuses uncommitted changes, and drop resets it", async () => {
		const w = await edited();
		const applied = await w.cs("apply", w.id);
		expect(applied).toMatchObject({
			code: 0,
			out: expect.stringContaining("a.txt | 2"),
			err: expect.stringMatching(
				/^applied \S+ \(node \S+, concert ok\) on \w+, staged\. Next: commit it, or 'maestro cs drop'$/,
			),
		});
		expect(git(w.target, "diff", "--cached", "--name-only")).toBe("a.txt");
		expect(await w.cs("apply", w.id)).toMatchObject({
			code: 1,
			err: `${w.target} has uncommitted changes\nCommit or stash them first`,
		});
		for (const refused of [
			["apply", w.id, "--stat"],
			["show", w.id, "--stat", "--summary"],
			["drop", w.id],
		])
			expect(await w.cs(...refused)).toMatchObject({ code: 2 });
		expect(await w.cs("drop")).toMatchObject({
			code: 2,
			err: expect.stringContaining("Pass --yes"),
		});
		expect(await w.cs("drop", "--yes")).toMatchObject({ code: 0 });
		expect(a(w.target)).toBe("one\n");
		expect(await w.cs("drop", "--yes")).toMatchObject({
			code: 0,
			err: `nothing to drop: ${w.target} has no uncommitted changes`,
		});
	});

	test("a patch that conflicts with HEAD exits 3 and leaves the markers", async () => {
		const w = await edited();
		writeFileSync(join(w.target, "a.txt"), "other\n");
		git(w.target, "commit", "-q", "-am", "three");
		expect(await w.cs("apply", w.id)).toMatchObject({
			code: 3,
			err: expect.stringContaining("Resolve the conflicts and commit"),
		});
		expect(a(w.target)).toContain("<<<<<<<");
	});

	test("-C works in another checkout, and refuses one without the base", async () => {
		const w = await edited();
		const clone = join(await scratch(), "clone");
		git(w.target, "clone", "-q", w.target, clone);
		expect(await w.cs("apply", w.id, "-C", clone)).toMatchObject({ code: 0 });
		expect(git(clone, "diff", "--cached", "--name-only")).toBe("a.txt");
		expect(git(w.target, "status", "--porcelain")).toBe("");

		const other = await toyTarget();
		const base = git(w.target, "rev-parse", "HEAD");
		expect(await w.cs("show", w.id, "-C", other)).toMatchObject({
			code: 1,
			err: `base ${base} is not in ${other}\nFetch it first`,
		});
	});

	test("a profile-performed concert's changeset reads from outside its workspace with -C, and without it names the workspace", async () => {
		const w = await edited();
		await Bun.write(join(w.cwd, ".maestro/profiles/free.yaml"), "{}\n");
		const id = idOf(
			await w.call(["perform", join(REPO, "edit.ts"), "--profile", "free"]),
		);
		const outside = { env: GIT_ENV, cwd: await scratch() };
		const cs = (...args: string[]) =>
			w.call(["cs", "show", id, ...args], outside);
		expect(await cs("-C", w.target)).toMatchObject({
			code: 0,
			out: expect.stringContaining("+edited"),
		});
		expect(await cs("-c", `target.repo=${w.target}`)).toMatchObject({
			code: 0,
		});
		const refused = await cs();
		expect(refused.code).toBe(1);
		expect(refused.err).toMatch(
			/profile needs its workspace\nPass -C <repo>, or run from inside workspace 'ws'$/,
		);
		expect(refused.err).not.toContain("Resume");

		const ambient = join(w.root, "config/maestro/config.yaml");
		await Bun.write(ambient, `target:\n  repo: ${w.target}\n`);
		expect(await cs()).toMatchObject({ code: 1, err: refused.err });
		rmSync(ambient);

		rmSync(join(w.cwd, ".maestro/profiles/free.yaml"));
		const missing = await w.call(["cs", "show", id], { env: GIT_ENV });
		expect(missing.err).toContain("Restore");
		expect(missing.err).not.toContain("needs its workspace");
	});

	test("changeset takes the result's changeset, else the last ok one with a warning, and refuses an empty one", async () => {
		const w = await edited("pick.ts");
		expect((await w.cs("show", w.id)).out).toContain("+kept");
		expect(await w.cs("show", w.id, "--node", "emptySet")).toMatchObject({
			code: 1,
			err: expect.stringContaining("is empty\nPick another node with --node"),
		});
		const failed = await w.call(["perform", join(REPO, "reject.ts")]);
		expect(failed).toMatchObject({ code: 3 });
		const shown = await w.cs("show", idOf(failed));
		expect(shown.out).toContain("+kept");
		expect(shown.err).toMatch(
			/^warning: concert \S+ is rejected; this is keptSet's changeset, not a delivered result$/m,
		);
	});
});
