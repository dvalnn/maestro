import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { HarnessRequest, StubStep } from "../harness/index";
import { stubHarness } from "../harness/index";
import { resolveProfile } from "../profile/index";
import { profileAttached } from "./agent";
import { probe, probeRequest } from "./probe";
import { concertUsage, releaseConcert } from "./store";
import {
	agentOn,
	cleanup,
	configOf,
	DONE,
	fresh,
	irOf,
	type NodeSpec,
	OK,
	PACK,
	performed,
	profile,
	reply,
	sandboxed,
	setupOf,
	start,
	stubHost,
	tmp,
	toyTarget,
} from "./test-support";
import { keepWindow, windowOf } from "./windows";

afterEach(cleanup);

const realSetTimeout = globalThis.setTimeout;
const waits: number[] = [];
/** The retry waits kept to run by hand, while holding; else each runs at once. */
let held: (() => void)[] | undefined;
beforeEach(() => {
	waits.length = 0;
	held = undefined;
	globalThis.setTimeout = ((f: () => void, ms?: number) => {
		if (ms === 30_000) {
			waits.push(ms);
			held?.push(f);
			return realSetTimeout(held ? () => {} : f, 0);
		}
		return realSetTimeout(f, ms);
	}) as typeof setTimeout;
});
afterEach(() => {
	globalThis.setTimeout = realSetTimeout;
});

const usage = (tokens_in: number): StubStep => ({
	emit: { type: "usage", tokens_in, tokens_out: 1 },
});
const fault = (transient: boolean): StubStep => ({
	emit: { type: "fault", reason: "529 overloaded", transient },
});

type Limits = { timeout?: string; tokens?: number };

/** The profile of `limits` on the stub harness, written once, or `builder` when there are none. */
function limitedProfile(limits: Limits | undefined): string {
	if (!limits) return "builder";
	const name = `limited-${limits.timeout ?? "none"}-${limits.tokens ?? "none"}`;
	profile(
		name,
		`runtime: { harness: stub, model: none }\nlimits: ${JSON.stringify(limits)}\n`,
	);
	return name;
}

const lone = (host: Parameters<typeof irOf>[0], limits?: Limits) =>
	irOf(
		host,
		[
			{
				id: "x",
				kind: "agent",
				config: agentOn({ mode: "fresh" }, limitedProfile(limits)),
				literals: { prompt: "go" },
			},
		],
		"x",
	);

async function run(steps: (n: number) => StubStep[]) {
	const { host, requests } = stubHost(() => steps(requests.length));
	const { result, instances } = await performed(
		host,
		lone(host),
		configOf(toyTarget()),
	);
	return { result, metrics: instances[0]?.metrics, requests };
}

describe("agent retry", () => {
	test("a transient failure then success ends ok with every attempt's metrics", async () => {
		const { result, metrics, requests } = await run((n) =>
			n === 1 ? [usage(10), fault(true)] : [usage(5), OK],
		);
		expect(result).toMatchObject({ outcome: "ok" });
		expect(metrics).toEqual({ tokens_in: 15, tokens_out: 2 });
		expect(requests).toHaveLength(2);
		expect(requests[1]?.prompt).toContain("cut off");
		expect(requests[1]?.session).toEqual(requests[0]?.session);
		expect(waits).toHaveLength(1);
	});

	test("transient failures past MAX_RETRIES fail with the attempt count", async () => {
		const { result, metrics, requests } = await run(() => [
			usage(1),
			fault(true),
		]);
		expect(requests).toHaveLength(3);
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "529 overloaded (after 3 attempts)",
		});
		expect(metrics).toMatchObject({ tokens_in: 3 });
	});

	test("a non-transient failure is not retried", async () => {
		const { result, requests } = await run(() => [fault(false)]);
		expect(requests).toHaveLength(1);
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "529 overloaded",
		});
	});

	test("a cancel during the wait ends the node with no retry", async () => {
		held = [];
		const { host, requests } = stubHost(() => [fault(true)]);
		const { concert } = await start(host, lone(host), configOf(toyTarget()));
		while (!waits.length) await Bun.sleep(20);
		await concert.cancel();
		for (const f of held) f();
		expect(await concert.done).toMatchObject({ outcome: "failed" });
		await Bun.sleep(50);
		expect(requests).toHaveLength(1);
	});
});

describe("agent session", () => {
	profile(
		"before",
		"runtime: { harness: stub, model: none }\nattachments: { kb: { path: kb, hint: kb }, old: { path: old, hint: old } }\n",
		{ kb: "a\n", old: "o\n" },
	);
	profile(
		"after",
		"runtime: { harness: stub, model: none }\nattachments: { kb: { path: kb, hint: kb }, new: { path: new, hint: new } }\n",
		{ kb: "b\n", new: "n\n" },
	);
	const agent = (id: string, spec: Partial<NodeSpec> = {}): NodeSpec => ({
		id,
		kind: "agent",
		config: agentOn({ mode: "fresh" }),
		literals: { prompt: "go" },
		...spec,
	});
	const extending: Partial<NodeSpec> = {
		config: agentOn({ mode: "extend" }),
		lane: "w",
	};
	const turnFile = (dir: string) => join(dir, "..", "turn.json");
	const keptTask = (dir: string): string | undefined =>
		existsSync(turnFile(dir))
			? JSON.parse(readFileSync(turnFile(dir), "utf8")).task
			: undefined;
	const previousOf = (req: HarnessRequest) =>
		(req.readOnly ?? [])
			.filter((b) => b.dst?.startsWith("/in/previous/"))
			.map((b) => readFileSync(b.src, "utf8"));
	/** A row: the first agent's profile and whether it writes a file, the second agent, and its delta. */
	type Row = [string, string, boolean, Partial<NodeSpec>, string | RegExp];
	test.each<Row>([
		[
			"nothing changed",
			"builder",
			false,
			extending,
			"- Task: unchanged.\n- Attachments: unchanged.\n- Working copy: unchanged.",
		],
		[
			"the task changed",
			"builder",
			false,
			{ ...extending, literals: { prompt: "again" } },
			"- Task: changed, the new text below.\n- Attachments: unchanged.\n- Working copy: unchanged.",
		],
		[
			"the working copy moved",
			"builder",
			true,
			{},
			/^- Task: unchanged\.\n- Attachments: unchanged\.\n- Working copy: was `(\w{40})`, now `(?!\1)(\w{40})`; `git diff \1 \2` shows what changed\.$/,
		],
		[
			"an attachment changed, one is new and one dropped",
			"before",
			false,
			{ ...extending, config: agentOn({ mode: "extend" }, "after") },
			"- Task: unchanged.\n- Attachments: `/in/kb` changed, the earlier copy at `/in/previous/kb`; `/in/new` new; `/in/old` dropped.\n- Working copy: unchanged.",
		],
	])(
		"when %s, a continuation runs in the session it is given and is told so",
		async (_, first, writes, second, delta) => {
			let turn = 0;
			/** The task of the session's last turn as each turn starts, and the earlier copies each turn is given. */
			const kept: (string | undefined)[] = [];
			const previous: string[] = [];
			const { host, requests } = stubHost((req) => {
				kept.push(keptTask(req.session.dir));
				previous.push(...previousOf(req));
				return writes && turn++ === 0
					? [{ write: "w.txt", content: "w" }, OK]
					: [OK];
			});
			const ir = irOf(
				host,
				[
					agent("w", { config: agentOn({ mode: "fresh" }, first) }),
					agent("r", { ...second, session: "w" }),
				],
				"r",
			);
			const { id, instances } = await performed(
				host,
				ir,
				configOf(toyTarget()),
			);
			const [minted, continuing] = requests;
			expect(minted?.prompt).toBe("go");
			expect(continuing?.session).toEqual(minted?.session);
			expect(minted?.session.dir).toEndWith(
				`sessions/${encodeURIComponent(`${id}.w`)}/harness`,
			);
			for (const node of ["w", "r"]) {
				const instance = instances.find((i) => i.node === node);
				expect(instance?.outputs?.session).toBe(`${id}.w`);
				expect(instance?.enrichment?.sessionDir).toBe(minted?.session.dir);
			}
			const [since = "", task] = (continuing?.prompt ?? "")
				.replace("# Since your last turn\n\n", "")
				.split("\n\n# Task\n\n");
			expect(since).toMatch(delta);
			expect(since.split("\n")).toHaveLength(3);
			expect(task).toBe(String(second.literals?.prompt ?? "go"));
			expect(previous).toEqual(first === "before" ? ["a\n"] : []);
			kept.push(keptTask(minted?.session.dir ?? ""));
			expect(kept).toEqual([undefined, "go", task]);
		},
	);

	test("a turn cut short keeps the earlier turn as the session's last", async () => {
		const { host, requests } = stubHost(() =>
			requests.length > 1 ? [{ hang: true }] : [OK],
		);
		const ir = irOf(
			host,
			[agent("w"), agent("r", { literals: { prompt: "again" }, session: "w" })],
			"r",
		);
		const { concert } = await start(host, ir, configOf(toyTarget()));
		while (requests.length < 2) await Bun.sleep(20);
		await concert.cancel();
		expect(await concert.done).toMatchObject({ outcome: "failed" });
		expect(keptTask(requests[1]?.session.dir ?? "")).toBe("go");
	});

	/** A row: what is done to the first concert's session, the profile continuing it, and the reason it fails with. */
	type Broken = [
		string,
		(home: string) => void,
		string,
		(session: string, home: string) => string,
	];
	test.each<Broken>([
		[
			"its concert was pruned",
			(home) => rmSync(home, { recursive: true }),
			"builder",
			(session) =>
				`session ${session} of node 'w' is not in the store: its concert was pruned. Perform the composition anew`,
		],
		[
			"it runs on another harness",
			() => {},
			"other",
			(session) =>
				`'r' runs profile other on harness 'other' and continues session ${session}, of harness 'stub'. Give 'r' a profile on harness 'stub', or drop its session`,
		],
		[
			"its last turn is missing",
			(home) => rmSync(join(home, "turn.json")),
			"builder",
			(session, home) =>
				`session ${session} has no readable last turn at '${join(home, "turn.json")}'. Perform the composition anew`,
		],
		[
			"its last turn is malformed",
			(home) => writeFileSync(join(home, "turn.json"), "{"),
			"builder",
			(session, home) =>
				`session ${session} has no readable last turn at '${join(home, "turn.json")}'. Perform the composition anew`,
		],
	])(
		"continuing a session when %s fails the agent",
		async (_, broken, name, reason) => {
			const { host, requests } = stubHost(() => [OK]);
			const config = configOf(toyTarget());
			const first = await performed(
				host,
				irOf(host, [agent("w")], "w"),
				config,
			);
			const session = `${first.id}.w`;
			const home = join(requests[0]?.session.dir ?? "", "..");
			broken(home);
			const ir = irOf(
				host,
				[
					agent("r", {
						config: agentOn({ mode: "fresh" }, name),
						literals: { prompt: "go", session },
					}),
				],
				"r",
			);
			const { result } = await performed(host, ir, config);
			expect(result).toMatchObject({
				outcome: "failed",
				reason: reason(session, home),
			});
			expect(requests).toHaveLength(1);
		},
	);
});

describe("agent encore", () => {
	const agent = (id: string, spec: Partial<NodeSpec> = {}): NodeSpec => ({
		id,
		kind: "agent",
		config: agentOn(fresh),
		literals: { prompt: "go" },
		...spec,
	});
	const optedOut = agent("x", { config: { ...agentOn(fresh), encore: false } });

	test("an encore continues each counterpart's session, but at a session input, an opted-out seat or a released one", async () => {
		const { host } = stubHost(() => [OK]);
		const config = configOf(toyTarget());
		const again = (n: number) => ({
			...config,
			values: { ...config.values, concurrency: n },
		});
		type Run = Awaited<ReturnType<typeof performed>>;
		/** Each node's session, and why it started fresh in an encore, if it did. */
		const seated = (run: Run) =>
			Object.fromEntries(
				run.instances.map((i) => [
					i.node,
					[i.outputs?.session, i.enrichment?.encoreFresh],
				]),
			);
		const first = await performed(
			host,
			irOf(host, [agent("w"), agent("r"), optedOut], "w"),
			config,
		);
		const ir = irOf(
			host,
			[agent("w"), agent("r", { session: "w" }), optedOut, agent("y")],
			"w",
		);
		const second = await performed(host, ir, again(2), { encore: first.id });
		const third = await performed(host, ir, again(1), { encore: second.id });
		const { store } = setupOf(config);
		await releaseConcert(store, first.id);
		expect(await concertUsage(store, first.id)).toBe(0);
		const last = await performed(host, ir, again(3), { encore: third.id });

		const [a, b, c, d] = [first.id, second.id, third.id, last.id];
		expect(seated(second)).toEqual({
			w: [`${a}.w`, undefined],
			r: [`${a}.w`, undefined],
			x: [`${b}.x`, undefined],
			y: [`${b}.y`, `concert ${a} kept no session of 'y'`],
		});
		expect(seated(third)).toEqual({
			w: [`${a}.w`, undefined],
			r: [`${a}.w`, undefined],
			x: [`${c}.x`, undefined],
			y: [`${b}.y`, undefined],
		});
		expect(seated(last)).toEqual({
			w: [
				`${d}.w`,
				`session ${a}.w is gone from the store: its concert was pruned`,
			],
			r: [`${d}.w`, undefined],
			x: [`${d}.x`, undefined],
			y: [`${b}.y`, undefined],
		});
	});

	test("an encore after only a profile file changed is not refused", async () => {
		const dir = profile("edited", "runtime: { harness: stub, model: none }\n", {
			"kb.md": "a\n",
		});
		const { host } = stubHost(() => [OK]);
		const config = configOf(toyTarget());
		const ir = irOf(
			host,
			[agent("w", { config: agentOn(fresh, "edited") })],
			"w",
		);
		const first = await performed(host, ir, config);
		writeFileSync(join(dir, "kb.md"), "b\n");
		const second = await performed(host, ir, config, { encore: first.id });
		expect(second.result).toMatchObject({ outcome: "ok" });
		await expect(
			performed(host, ir, config, { encore: second.id }),
		).rejects.toThrow("was performed from the same IR, config and host facts");
	});
});

describe("agent profile", () => {
	test("an agent runs the workspace profile that shadows its pack's, with its binds and attachments, and records it", async () => {
		const packed = profile(
			"builder",
			"runtime: { harness: stub, model: packed }\n",
			{},
			true,
		);
		const dir = profile(
			`${PACK}/builder`,
			"runtime: { harness: stub, model: none }\nattachments: { kb: { path: kb, hint: for the house style } }\n",
			{ "kb/style.md": "terse\n" },
		);
		const { host, requests } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: { ...agentOn({ mode: "fresh" }), profile: `${PACK}/builder` },
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const config = configOf(toyTarget(), {
			profiles: { [`${PACK}/builder`]: { readOnly: [packed] } },
		});
		const { result, instances, artifact } = await performed(host, ir, config);

		expect(result).toMatchObject({ outcome: "ok" });
		const [request] = requests;
		expect(request?.runtime).toEqual({ harness: "stub", model: "none" });
		expect(request?.readOnly).toContainEqual({ src: packed });
		expect(request?.readOnly).toContainEqual({
			src: join(dir, "kb"),
			dst: "/in/kb",
		});
		expect(
			readFileSync(join(artifact("x", "staged"), "instructions.md"), "utf8"),
		).toContain("- `/in/kb` (directory): for the house style");
		expect(instances[0]?.enrichment?.profile).toMatchObject({
			name: `${PACK}/builder`,
			dir,
			shadows: [packed],
			fields: { readOnly: [packed] },
			sources: expect.arrayContaining([
				{
					path: ["runtime", "model"],
					source: {
						layer: "directory",
						file: join(dir, "profile.yaml"),
						line: 1,
					},
				},
				{ path: ["readOnly"], source: { layer: "workspace" } },
			]),
			files: {
				"profile.yaml": expect.stringMatching(/^sha256:/),
				"kb/style.md": expect.stringMatching(/^sha256:/),
			},
		});
	});
});

describe("profileAttached", () => {
	test("a profile attachment is a directory when its path, followed through a symlink, is one, and a file otherwise or when missing", async () => {
		const dir = profile(
			"kinds",
			"runtime: { harness: stub, model: none }\nattachments: { style: { path: style.md, hint: for the style } }\n",
			{ "style.md": "terse\n", "kb/style.md": "terse\n" },
		);
		symlinkSync(join(dir, "kb"), join(dir, "linked"));
		const resolved = await resolveProfile(
			"kinds",
			setupOf(configOf(toyTarget())),
		);
		const hint = "h";

		expect(
			profileAttached({
				...resolved,
				fields: {
					...resolved.fields,
					attachments: {
						...resolved.fields.attachments,
						linked: { path: join(dir, "linked"), hint },
						gone: { path: join(dir, "gone"), hint },
					},
				},
			}),
		).toEqual([
			["style", "for the style", "file"],
			["linked", hint, "directory"],
			["gone", hint, "file"],
		]);
	});
});

describe("agent probe", () => {
	test("a probe starts the profile as a concert would: its binds and attachments read-only, its PATH, its framed instructions, no outputs and an empty lane", async () => {
		const dir = profile(
			"probed",
			"runtime: { harness: stub, model: none }\ninstructions: own.md\nattachments: { kb: { path: kb, hint: for the house style } }\n",
			{ "own.md": "Be terse.\n", "kb/style.md": "terse\n" },
		);
		const [shared, bin] = [tmp("shared"), tmp("bin")];
		const base = setupOf(configOf(toyTarget()));
		const setup = {
			...base,
			config: { ...base.config, sandbox: { readOnly: [shared], path: [bin] } },
		};
		const req = probeRequest(
			await resolveProfile("probed", setup),
			setup,
			tmp("scratch"),
		);
		let seen: HarnessRequest | undefined;
		const observed = await probe(
			stubHarness((r) => {
				seen = r;
				return [{ emit: { type: "environment", tools: ["sh"] } }];
			}),
			req,
		);

		expect(observed).toEqual({ observed: { tools: ["sh"] } });
		expect(seen?.readOnly).toContainEqual({ src: shared });
		expect(seen?.readOnly).toContainEqual({ src: bin });
		expect(seen?.readOnly).toContainEqual({
			src: join(dir, "kb"),
			dst: "/in/kb",
		});
		expect(seen?.env?.PATH).toStartWith(`${bin}:`);
		const instructions = readFileSync(seen?.instructions ?? "", "utf8");
		expect(instructions).toStartWith("Be terse.\n\n");
		expect(instructions).toContain(
			"- `/in/kb` (directory): for the house style",
		);
		expect(seen?.outputs).toEqual([]);
		expect(readdirSync(seen?.lane ?? "")).toEqual([]);
	});
});

describe("agent partial work", () => {
	const edit = (content: string): StubStep => ({
		write: "a.txt",
		content,
	});

	/** Runs the lone agent on `steps`, resuming concert `resume` when given. */
	async function attempt(
		steps: (n: number) => StubStep[],
		config: ReturnType<typeof configOf>,
		resume?: string,
	) {
		const { host, requests } = stubHost(() => steps(requests.length));
		const done = await performed(host, lone(host), config, { resume });
		return { ...done, requests };
	}

	const partialOf = (instances: { enrichment?: Record<string, unknown> }[]) =>
		instances[0]?.enrichment?.partial;

	const patchesOf = (dir: unknown) =>
		readdirSync(String(dir))
			.filter((f) => f.endsWith(".patch"))
			.map((f) => readFileSync(join(String(dir), f), "utf8"))
			.join("");

	test.each([
		["a harness failure", [edit("lost\n"), fault(false)]],
		[
			"a blocked reply",
			[edit("lost\n"), reply({ blocked: "no", report: DONE })],
		],
	])(
		"%s keeps the lane's changes as a changeset outside the lane chain",
		async (_, steps) => {
			const config = configOf(toyTarget());
			const { result, instances, id } = await attempt(() => steps, config);
			expect(result).toMatchObject({ outcome: "failed" });
			const partial = partialOf(instances);
			expect(isAbsolute(String(partial))).toBe(true);
			expect(String(partial)).toContain(setupOf(config).store);
			expect(readFileSync(join(String(partial), "base"), "utf8")).toMatch(
				/^[0-9a-f]{40}\n$/,
			);
			expect(existsSync(join(String(partial), "message"))).toBe(false);
			expect(patchesOf(partial)).toContain("+lost");
			expect(instances[0]?.outputs?.lane).toBeUndefined();
			const store = setupOf(config).store;
			const used = await concertUsage(store, id);
			rmSync(String(partial), { recursive: true });
			expect(await concertUsage(store, id)).toBeLessThan(used);
		},
	);

	test("a cancel keeps the changes made so far", async () => {
		const config = configOf(toyTarget());
		const { host, requests } = stubHost(() => [edit("lost\n"), { hang: true }]);
		const { concert, recordPath } = await start(host, lone(host), config);
		const { openRecord } = await import("@maestro/core/perform");
		const partial = () => {
			const record = openRecord(recordPath);
			const found = record.instances(concert.id)[0]?.enrichment?.partial;
			record.close();
			return found;
		};
		while (!requests.length) await Bun.sleep(20);
		while (!sandboxed().length) await Bun.sleep(20);
		await Bun.sleep(300);
		await concert.cancel();
		expect(await concert.done).toMatchObject({ outcome: "failed" });
		expect(patchesOf(partial())).toContain("+lost");
	});

	test("an unchanged lane keeps nothing, and neither does an ok agent or a read one", async () => {
		const config = configOf(toyTarget());
		const failed = await attempt(() => [fault(false)], config);
		expect(partialOf(failed.instances)).toBeUndefined();
		const ok = await attempt(() => [edit("kept\n"), OK], configOf(toyTarget()));
		expect(ok.result).toMatchObject({ outcome: "ok" });
		expect(partialOf(ok.instances)).toBeUndefined();

		const { host, requests } = stubHost(() =>
			requests.length === 1
				? [edit("kept\n"), OK]
				: [edit("lost\n"), fault(false)],
		);
		const ir = irOf(
			host,
			[
				{
					id: "build",
					kind: "agent",
					config: agentOn({ mode: "fresh" }),
					literals: { prompt: "go" },
				},
				{
					id: "look",
					kind: "agent",
					config: agentOn({ mode: "read" }),
					literals: { prompt: "look" },
					lane: "build",
				},
			],
			"look",
		);
		const read = await performed(host, ir, configOf(toyTarget()));
		const look = read.instances.filter((i) => i.node === "look");
		expect(look[0]?.status).toBe("failed");
		expect(partialOf(look)).toBeUndefined();
	});

	test("a re-run starts from its input and leaves the partial, a later failed run replaces it, and prune removes it", async () => {
		const config = configOf(toyTarget());
		const first = await attempt(() => [edit("first\n"), fault(false)], config);
		const partial = String(partialOf(first.instances));
		const again = await attempt(
			(n) =>
				n === 1
					? [
							{ sh: "! grep -q first /lane/a.txt || touch /lane/leaked" },
							fault(false),
						]
					: [OK],
			config,
			first.id,
		);
		expect(again.result).toMatchObject({ outcome: "failed" });
		expect(patchesOf(partial)).toContain("+first");
		expect(patchesOf(partial)).not.toContain("leaked");
		const second = await attempt(
			() => [edit("second\n"), fault(false)],
			config,
			first.id,
		);
		expect(partialOf(second.instances)).toBe(partial);
		expect(patchesOf(partial)).toContain("+second");
		expect(patchesOf(partial)).not.toContain("+first");
		await releaseConcert(setupOf(config).store, first.id);
		expect(existsSync(partial)).toBe(false);
	});
});

describe("agent limits", () => {
	const edit: StubStep = { write: "a.txt", content: "lost\n" };
	const hang: StubStep = { hang: true };
	const prose: StubStep = { emit: { type: "text", text: "not json" } };

	async function limited(limits: Limits, steps: (n: number) => StubStep[]) {
		const { host, requests } = stubHost(() => steps(requests.length));
		const done = await performed(
			host,
			lone(host, limits),
			configOf(toyTarget()),
		);
		return { ...done, requests };
	}

	const partialOf = (instances: { enrichment?: Record<string, unknown> }[]) =>
		String(instances[0]?.enrichment?.partial);

	test("a token limit ends the agent failed with its reason and keeps the partial", async () => {
		const { result, instances } = await limited({ tokens: 50 }, () => [
			edit,
			usage(100),
			hang,
		]);
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "passed its token limit of 50 (101 spent)",
		});
		const patches = readdirSync(partialOf(instances))
			.filter((f) => f.endsWith(".patch"))
			.map((f) => readFileSync(join(partialOf(instances), f), "utf8"))
			.join("");
		expect(patches).toContain("+lost");
	});

	test("a timeout ends the agent failed with its reason and keeps the partial", async () => {
		const { result, instances } = await limited({ timeout: "1s" }, () => [
			edit,
			hang,
		]);
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "passed its timeout of 1s",
		});
		expect(existsSync(partialOf(instances))).toBe(true);
	});

	test("tokens count across a correction", async () => {
		const { result, requests } = await limited({ tokens: 50 }, (n) =>
			n === 1 ? [usage(30), prose] : [usage(30), hang],
		);
		expect(requests).toHaveLength(2);
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "passed its token limit of 50 (62 spent)",
		});
	});

	test("tokens count across a transient retry", async () => {
		const { result, requests } = await limited({ tokens: 50 }, (n) =>
			n === 1 ? [usage(30), fault(true)] : [usage(30), hang],
		);
		expect(requests).toHaveLength(2);
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "passed its token limit of 50 (62 spent)",
		});
	});

	test("the timeout counts a retry wait", async () => {
		held = [];
		const { host, requests } = stubHost(() => [fault(true)]);
		const { concert } = await start(
			host,
			lone(host, { timeout: "300ms" }),
			configOf(toyTarget()),
		);
		expect(await concert.done).toMatchObject({
			outcome: "failed",
			reason: "passed its timeout of 300ms",
		});
		expect(requests).toHaveLength(1);
	});

	test("an agent within its limits settles as before", async () => {
		const { result, metrics } = await run(() => [usage(5), OK]);
		expect(result).toMatchObject({ outcome: "ok" });
		const within = await limited({ tokens: 1000, timeout: "60s" }, () => [
			usage(5),
			OK,
		]);
		expect(within.result).toMatchObject({ outcome: "ok" });
		expect(within.instances[0]?.metrics).toEqual(metrics);
	});

	test("a concert cancel under limits names no limit", async () => {
		const { host, requests } = stubHost(() => [hang]);
		const { concert, recordPath } = await start(
			host,
			lone(host, { timeout: "60s", tokens: 5 }),
			configOf(toyTarget()),
		);
		while (!requests.length) await Bun.sleep(20);
		await concert.cancel();
		await concert.done;
		const { openRecord } = await import("@maestro/core/perform");
		const record = openRecord(recordPath);
		const [settled] = record.instances(concert.id);
		expect(settled?.status).toBe("failed");
		expect(settled?.reason).not.toContain("passed its");
		record.close();
	});
});

describe("agent context", () => {
	const RUNTIME = "runtime: { harness: stub, model: none }\n";
	profile(
		"handoff-tokens",
		`${RUNTIME}context: { strategy: handoff, at: 100, max: 1 }\n`,
	);
	profile(
		"handoff-percent",
		`${RUNTIME}context: { strategy: handoff, at: "25%", max: 1 }\n`,
	);
	profile(
		"handoff-limited",
		`${RUNTIME}context: { strategy: handoff, at: 100, max: 1 }\nlimits: { tokens: 50 }\n`,
	);
	profile(
		"compact-capped",
		`${RUNTIME}context: { strategy: compact, at: 100, max: 1 }\n`,
	);
	const full = (used = 100): StubStep => ({
		emit: { type: "context", used },
	});
	const STUB = { harness: "stub", model: "none" };
	const note: StubStep = {
		write: "/session/handoff.md",
		content: "half done\n",
	};
	const hang: StubStep = { hang: true };
	const HANDOFF_TURN = `Your context budget is spent, so this session ends after this turn. Write a handoff note to /session/handoff.md for the session that continues your task in this working copy. It reads your note as claims and checks them against the working copy, so state:
- what is done, and how you verified it;
- what remains, in the order you would do it;
- what you tried that failed, and why;
- what you learnt that the code does not show.
Change no other file. Your reply is not read.`;

	/** Steps by turn: a fresh session's first turn, the handoff turn, and a session opened by a handoff. */
	type Script = { first: StubStep[]; handoff?: StubStep[]; next?: StubStep[] };
	const scripted =
		({ first, handoff = [note], next = [OK] }: Script) =>
		(req: HarnessRequest) =>
			req.prompt === HANDOFF_TURN
				? handoff
				: req.prompt.startsWith("# Handoff")
					? next
					: first;

	/** Runs profile `name` on `script`, with `window` kept for the stub's model when given. */
	async function handed(name: string, script: Script, window?: number) {
		const { host, requests } = stubHost(scripted(script));
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: agentOn({ mode: "fresh" }, name),
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const config = configOf(toyTarget());
		const { store } = setupOf(config);
		if (window !== undefined) keepWindow(store, STUB, window);
		const { concert, dir, recordPath } = await start(host, ir, config);
		const result = await concert.done;
		const { concertDirs, openRecord } = await import("@maestro/core/perform");
		const record = openRecord(recordPath);
		const [instance] = record.instances(concert.id);
		const progress = record
			.events(concert.id)
			.flatMap((e) => (e.type === "progress" ? [e.event] : []));
		record.close();
		const staged = (file: string) => {
			const ref = instance?.outputs?.staged as { path: string };
			const at = join(concertDirs(dir, concert.id).artifacts, ref.path, file);
			return readFileSync(at, "utf8");
		};
		return {
			id: concert.id,
			result,
			instance,
			progress,
			requests,
			staged,
			store,
		};
	}

	test.each<[string, string, number, number | undefined]>([
		["a token trigger", "handoff-tokens", 100, undefined],
		["a percentage trigger of the window kept", "handoff-percent", 50, 200],
	])(
		"%s hands the task to a fresh session through a note",
		async (_, name, used, window) => {
			const { id, result, instance, progress, requests, staged } = await handed(
				name,
				{ first: [full(used), hang], handoff: [full(1000), note] },
				window,
			);
			expect(result).toMatchObject({ outcome: "ok" });
			const [first, handoff, fresh] = requests;
			expect(requests).toHaveLength(3);
			expect(handoff?.prompt).toBe(HANDOFF_TURN);
			expect(handoff?.session).toEqual(first?.session);
			expect(
				readFileSync(join(first?.session.dir ?? "", "handoff.md"), "utf8"),
			).toBe("half done\n");
			expect(fresh?.session.id).not.toBe(first?.session.id);
			expect(fresh?.prompt).toBe(`# Handoff

You are session 2 of up to 2 on this task. The previous session ran out of context and left the note below. Its claims are unverified, and your working copy holds its uncommitted changes: check them with \`git status\` and \`git diff\` before you build on them.

<handoff-note>
half done
</handoff-note>

# Task

go`);
			expect(staged("session-2.md")).toBe(fresh?.prompt ?? "");
			expect(staged("instructions.md")).toContain(
				"This task allows up to 2 sessions.",
			);
			const session = `${id}.x#2`;
			expect(instance?.outputs?.session).toBe(session);
			expect(instance?.enrichment?.sessionDir).toBe(fresh?.session.dir);
			expect(
				existsSync(join(fresh?.session.dir ?? "", "..", "turn.json")),
			).toBe(true);
			expect(progress).toContainEqual({ kind: "context", used });
			expect(progress.filter((e) => e.kind === "session")).toEqual([
				{ kind: "session", id: `${id}.x`, index: 1, ended: "handoff" },
				{ kind: "session", id: session, index: 2, ended: "settled" },
			]);
		},
	);

	test("an agent continuing a handed-off session continues the latest one, and counts its own handoffs", async () => {
		const { host, requests } = stubHost(scripted({ first: [full(), hang] }));
		const ir = irOf(
			host,
			["w", "r"].map((id) => ({
				id,
				kind: "agent" as const,
				config: agentOn({ mode: "fresh" }, "handoff-tokens"),
				literals: { prompt: "go" },
				...(id === "r" && { session: "w" }),
			})),
			"r",
		);
		const { id, result, instances } = await performed(
			host,
			ir,
			configOf(toyTarget()),
		);
		expect(result).toMatchObject({ outcome: "ok" });
		const continuing = requests[3];
		expect(continuing?.session).toEqual(requests[2]?.session);
		expect(continuing?.prompt).toStartWith(
			"# Since your last turn\n\n- Task: unchanged.",
		);
		expect(instances.find((i) => i.node === "r")?.outputs?.session).toBe(
			`${id}.r#2`,
		);
	});

	test("an encore of an agent that handed off continues its latest session", async () => {
		const script = scripted({ first: [full(), hang] });
		const { host, requests } = stubHost((req) =>
			req.prompt.startsWith("# Since your last turn") ? [OK] : script(req),
		);
		const ir = irOf(
			host,
			[
				{
					id: "w",
					kind: "agent",
					config: agentOn({ mode: "fresh" }, "handoff-tokens"),
					literals: { prompt: "go" },
				},
			],
			"w",
		);
		const config = configOf(toyTarget());
		const first = await performed(host, ir, config);
		const again = { ...config, values: { ...config.values, concurrency: 2 } };
		const encore = await performed(host, ir, again, { encore: first.id });
		expect(encore.result).toMatchObject({ outcome: "ok" });
		expect(encore.instances[0]?.outputs?.session).toBe(`${first.id}.w#2`);
		expect(requests).toHaveLength(4);
		expect(requests[3]?.session).toEqual(requests[2]?.session);
	});

	test("a context below its trigger runs on in its session, given the window kept, and the window the run reports is kept", async () => {
		const reported = { emit: { type: "environment", window: 400 } };
		const { result, requests, store } = await handed(
			"handoff-percent",
			{ first: [full(49), reported, OK] },
			200,
		);
		expect(result).toMatchObject({ outcome: "ok" });
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			context: { strategy: "handoff", at: 50, max: 1 },
			window: 200,
		});
		expect(windowOf(store, STUB)).toBe(400);
	});

	test("an agent whose trigger is not below the window an earlier run kept fails before it runs", async () => {
		profile("windowed", RUNTIME);
		const { host, requests } = stubHost(() => [
			{ emit: { type: "environment", window: 100 } },
			OK,
		]);
		const ir = irOf(
			host,
			["w", "r"].map((id) => ({
				id,
				kind: "agent" as const,
				config: agentOn(
					{ mode: "fresh" },
					id === "w" ? "windowed" : "handoff-tokens",
				),
				literals: { prompt: "go" },
				...(id === "r" && { session: "w" }),
			})),
			"r",
		);
		const { result } = await performed(host, ir, configOf(toyTarget()));
		expect(result).toMatchObject({
			outcome: "failed",
			reason: expect.stringContaining(
				"profiles.handoff-tokens.context.at: at 100 tokens is at or past the stub model 'none' window of 100 tokens. Set at below 100",
			),
		});
		expect(requests).toHaveLength(1);
	});

	test("a turn that settles before its trigger cuts it keeps its result, past the cap or not", async () => {
		const settles: StubStep[] = [OK, { emit: { type: "settled" } }, full()];
		const { id, result, instance, requests } = await handed("handoff-tokens", {
			first: [full(), hang],
			next: settles,
		});
		expect(result).toMatchObject({ outcome: "ok" });
		expect(requests).toHaveLength(3);
		expect(instance?.outputs?.session).toBe(`${id}.x#2`);
	});

	const NO_NOTE =
		"context: no handoff note from session 1. Check the profile's model writes /session/handoff.md when asked";
	test.each([
		[
			"a handoff turn that writes no note",
			"handoff-tokens",
			{ first: [full(), hang], handoff: [] },
			NO_NOTE,
			2,
		],
		[
			"a note left before the handoff turn",
			"handoff-tokens",
			{ first: [note, full(), hang], handoff: [] },
			NO_NOTE,
			2,
		],
		[
			"a handoff note that links elsewhere",
			"handoff-tokens",
			{
				first: [full(), hang],
				handoff: [
					{ write: "notes.md", content: "half done\n" },
					{ sh: "ln -s /lane/notes.md /session/handoff.md" },
				],
			},
			NO_NOTE,
			2,
		],
		[
			"a handoff turn that fails",
			"handoff-tokens",
			{ first: [full(), hang], handoff: [note, fault(false)] },
			"context: handoff turn failed: 529 overloaded",
			2,
		],
		[
			"one handoff past the cap",
			"handoff-tokens",
			{ first: [full(), hang], next: [full(), hang] },
			"context: session 2 filled, past profiles.handoff-tokens.context.max of 1 handoffs. Raise profiles.handoff-tokens.context.max, or split the task",
			3,
		],
		[
			"a token limit passed over two sessions",
			"handoff-limited",
			{ first: [usage(30), full(), hang], next: [usage(30), hang] },
			"passed its token limit of 50 (62 spent)",
			3,
		],
		[
			"a token limit passed by the call that fills the context",
			"handoff-limited",
			{ first: [usage(60), full(), hang] },
			"passed its token limit of 50 (61 spent)",
			1,
		],
		[
			"a compaction past a compact cap",
			"compact-capped",
			{
				first: [
					{ emit: { type: "compaction" } },
					{ emit: { type: "compaction" } },
					hang,
				],
			},
			"context: compacted 2 times, past profiles.compact-capped.context.max of 1. Raise profiles.compact-capped.context.max, or split the task",
			1,
		],
	] as [string, string, Script, string, number][])(
		"%s fails the agent",
		async (_, name, script, reason, turns) => {
			const { result, requests } = await handed(name, script);
			expect(result).toMatchObject({ outcome: "failed", reason });
			expect(requests).toHaveLength(turns);
		},
	);

	test("a compaction under a handoff policy is recorded as a fault and the agent runs on", async () => {
		const { result, progress } = await handed("handoff-tokens", {
			first: [{ emit: { type: "compaction" } }, OK],
		});
		expect(result).toMatchObject({ outcome: "ok" });
		expect(progress).toContainEqual({
			kind: "fault",
			reason:
				"context: the harness compacted the session before its handoff. Lower profiles.handoff-tokens.context.at below its compaction point",
		});
	});
});
