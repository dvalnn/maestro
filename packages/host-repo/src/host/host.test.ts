import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { compose } from "@maestro/core/compose";
import { CORE_CONFIG, valuesLayer } from "@maestro/core/config";
import type { Host } from "@maestro/core/host";
import { openRecord } from "@maestro/core/perform";
import { type Ir, indexGraph } from "@maestro/ir";
import { type HarnessRequest, OUTBOX, type StubStep } from "../harness/index";
import { openSession, openTarget } from "./store";
import {
	APPROVED,
	agentOn,
	changed,
	cleanup,
	commitTo,
	configOf,
	DONE,
	fresh,
	irOf,
	type NodeSpec,
	noCode,
	OK,
	performed,
	profile,
	ROOTS,
	reply,
	sandboxed,
	setupOf,
	snapshot,
	start,
	stubHost,
	tmp,
	toyTarget,
} from "./test-support";

afterEach(cleanup);

const TRIED = { summary: "tried" };

/** Seat `builder` at the top level of composition `toy`, then in scope `gate` of composition `repair`, extending it. */
const scoped = (host: Host) =>
	irOf(
		host,
		[
			{
				id: "a",
				kind: "agent",
				config: agentOn(fresh),
				literals: { prompt: "go" },
			},
			{
				id: "gate/b",
				kind: "agent",
				config: agentOn({ mode: "extend" }),
				literals: { prompt: "go" },
				lane: "a",
			},
		],
		"gate/b",
		undefined,
		[{ id: "gate", composition: "repair", ports: {} }],
	);

/** Waits until the lane directory `lane` is gone. */
async function dropped(lane: string) {
	for (let i = 0; i < 100 && existsSync(lane); i++) await Bun.sleep(20);
}

describe("compose", () => {
	test("a double extension and a session crossing harnesses are HOST errors, with no harness run", async () => {
		const target = toyTarget();
		const { host, requests } = stubHost(() => [OK]);
		const prompt = { prompt: "go" };
		const ir = irOf(
			host,
			[
				{
					id: "a",
					kind: "agent",
					config: agentOn(fresh),
					literals: prompt,
				},
				{
					id: "b",
					kind: "agent",
					config: agentOn({ mode: "extend" }),
					literals: prompt,
					lane: "a",
				},
				{
					id: "c",
					kind: "agent",
					config: agentOn({ mode: "extend" }, "other"),
					literals: prompt,
					lane: "a",
					session: "a",
				},
				{ id: "m", kind: "commits", config: { revs: "main^!" } },
				{
					id: "f",
					kind: "agent",
					config: agentOn({ mode: "extend" }),
					literals: prompt,
					lane: "m",
				},
			],
			"c",
		);
		const composed = await compose({
			ir,
			config: configOf(target),
			roots: ROOTS,
			core: CORE_CONFIG,
			packs: {},
			hosts: [host],
			loadCode: noCode,
			caps: {},
		});
		expect(composed.ok).toBe(false);
		const found = composed.ok
			? []
			: composed.diagnostics.map((d) => [d.code, d.node, d.message]);
		expect(found).toEqual([
			[
				"HOST.lane",
				"c",
				"'c' extends 'a.lane', which 'b' extends too; a version is extended at most once",
			],
			[
				"HOST.lane",
				"f",
				"'f' extends 'm.lane', a version of target commits, which only a fork or a read can take",
			],
			[
				"HOST.session",
				"c",
				"'c' runs profile other on harness 'other' and continues the session of 'a', profile builder on harness 'stub'; a session runs on one harness",
			],
		]);
		expect(requests).toEqual([]);
	});

	test("a profile name in config that is neither bare nor <pack id>/<name> is refused at compose", async () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "a",
					kind: "agent",
					config: { profile: "builder", seat: "builder", lane: fresh },
					literals: { prompt: "go" },
				},
			],
			"a",
		);
		const profiles = { Foo: {}, "a/b/c": {}, "classics/builder": {} };
		const composed = await compose({
			ir,
			config: configOf(toyTarget(), { profiles }),
			roots: ROOTS,
			core: CORE_CONFIG,
			packs: {},
			hosts: [host],
			loadCode: noCode,
			caps: {},
		});
		expect(
			composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.message]),
		).toEqual([
			["CFG.schema", "config 'profiles.Foo' is not an allowed name"],
			["CFG.schema", "config 'profiles.a/b/c' is not an allowed name"],
		]);
	});

	test("seats binds a seat by its innermost composition's id, at pre-flight: a profile no root holds and a seat a composition here lacks are refused", async () => {
		const { host } = stubHost(() => [OK]);
		const seats = {
			"toy/builder": "nope",
			"repair/biulder": "builder",
			"elsewhere/builder": "builder",
		};
		const composed = await compose({
			ir: scoped(host),
			config: configOf(toyTarget(), { seats }),
			roots: ROOTS,
			core: CORE_CONFIG,
			packs: {},
			hosts: [host],
			loadCode: noCode,
			caps: {},
		});
		expect(
			composed.ok
				? []
				: composed.diagnostics.map((d) => [d.code, d.message, d.hint]),
		).toEqual([
			[
				"HOST.profile",
				"profile nope is in no profile root",
				expect.stringContaining("name another profile"),
			],
			[
				"HOST.seat",
				"config key 'seats.repair/biulder' is claimed by no seat of composition 'repair'",
				"Did you mean 'seats.repair/builder'? Rename 'seats.repair/biulder' to 'seats.repair/builder'",
			],
		]);
	});

	test("needs names each check a node names, and nothing for an agent's profile", () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "a",
					kind: "agent",
					config: {
						profile: "builder",
						seat: "builder",
						lane: { mode: "fresh" },
						checks: ["lint"],
					},
					literals: { prompt: "go" },
				},
				{
					id: "k",
					kind: "check",
					config: { lane: { mode: "extend" }, check: "hello" },
					lane: "a",
				},
			],
			"k",
		);
		expect(host.needs?.(indexGraph(ir))).toEqual([
			["target", "checks", "lint"],
			["target", "checks", "hello"],
		]);
	});

	const task = { prompt: "go" };
	const writer: NodeSpec = {
		id: "w",
		kind: "agent",
		config: agentOn(fresh),
		literals: task,
	};
	/** An agent of profile `name` that continues the session out of `from`, in a fresh lane. */
	const continuer = (id: string, from: string, name = "builder"): NodeSpec => ({
		id,
		kind: "agent",
		config: agentOn(fresh, name),
		literals: task,
		session: from,
	});
	/** A row: the nodes after `root`, the result node, where the loop `lp` starts if any, and the messages. */
	type Row = [string, NodeSpec[], string, string | undefined, string[]];
	test.each([
		[
			"two agents continue one session",
			[continuer("a", "root"), continuer("b", "root")],
			"b",
			undefined,
			[
				"'b' continues the session of 'root', which 'a' continues too, neither after the other; a session has one runner at a time",
			],
		],
		[
			"a chain continues one session, each from the one before",
			[continuer("a", "root"), continuer("b", "a")],
			"b",
			undefined,
			[],
		],
		[
			"a loop's step continues a session from outside the loop, once per iteration in order",
			[writer, continuer("lp/step", "root")],
			"lp",
			"w",
			[],
		],
		[
			"an agent on another harness continues the session of a loop's step",
			[writer, continuer("lp/step", "root"), continuer("r", "lp", "other")],
			"r",
			"w",
			[
				"'r' runs profile other on harness 'other' and continues the session of 'lp/step', profile builder on harness 'stub'; a session runs on one harness",
			],
		],
	] as Row[])(
		"when %s, compose rules on the session",
		async (_, nodes, result, start, messages) => {
			const { host } = stubHost(() => [OK]);
			const specs: NodeSpec[] = [
				{
					id: "root",
					kind: "agent",
					config: agentOn(fresh),
					literals: task,
				},
				...nodes,
			];
			const composed = await compose({
				ir: irOf(host, specs, result, start ? { id: "lp", start } : undefined),
				config: configOf(toyTarget()),
				roots: ROOTS,
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.message]),
			).toEqual(messages.map((m) => ["HOST.session", m]));
		},
	);

	/** An agent that extends the version out of `from`. */
	const extender = (id: string, from: string): NodeSpec => ({
		id,
		kind: "agent",
		config: agentOn({ mode: "extend" }),
		literals: task,
		lane: from,
	});
	const innerCheck: NodeSpec = {
		id: "lp/chk",
		kind: "check",
		config: { lane: { mode: "extend" }, check: "hello" },
		lane: "lp",
	};
	test.each([
		[
			"a step and a node after the loop extend its lane",
			[writer, extender("lp/step", "lp"), extender("r", "lp")],
			[],
		],
		[
			"two nodes after the loop extend its lane",
			[
				writer,
				extender("lp/step", "lp"),
				extender("r", "lp"),
				extender("s", "lp"),
			],
			[
				"'s' extends 'lp.lane', which 'r' extends too; a version is extended at most once",
			],
		],
		[
			"two nodes in the loop extend its state",
			[writer, extender("lp/step", "lp"), innerCheck],
			[
				"'lp/chk' extends 'lp.lane', which 'lp/step' extends too; a version is extended at most once",
			],
		],
	] as [string, NodeSpec[], string[]][])(
		"when %s, compose refuses only a double extension of one side",
		async (_, nodes, messages) => {
			const { host } = stubHost(() => [OK]);
			const specs: NodeSpec[] = [
				{
					id: "root",
					kind: "agent",
					config: { profile: "builder", seat: "builder", lane: fresh },
					literals: task,
				},
				...nodes,
			];
			const result = nodes.some((n) => n.id === "r") ? "r" : "lp";
			const composed = await compose({
				ir: irOf(host, specs, result, { id: "lp", start: "w" }),
				config: configOf(toyTarget()),
				roots: ROOTS,
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => d.message),
			).toEqual(messages);
		},
	);

	test("a context window refusal of a value -c set names its key once and ends with the flag, keeping its fix", async () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: agentOn(fresh, "shared"),
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const set = { profiles: { shared: { context: { at: "30%" } } } };
		const base = configOf(toyTarget());
		const composed = await compose({
			ir,
			config: {
				...base,
				layers: [
					...base.layers,
					valuesLayer(set, {
						layer: "flag",
						flag: "-c 'profiles.shared.context.at=30%'",
						key: "profiles.shared.context.at",
						fix: "Set that key, or !delete it, with -c on the resume",
					}),
				],
			},
			roots: ROOTS,
			core: CORE_CONFIG,
			packs: {},
			hosts: [host],
			loadCode: noCode,
			caps: {},
		});
		expect(
			composed.ok ? [] : composed.diagnostics.map((d) => [d.message, d.hint]),
		).toEqual([
			[
				"profiles.shared.context.at: no context window is known for other model 'none' (from -c profiles.shared.context.at)",
				"Set that key, or !delete it, with -c on the resume",
			],
		]);
	});

	profile("gone", "runtime: { harness: gone, model: none }\n");
	profile("modelless", "runtime: { harness: other }\n");
	profile("deep", "runtime: { harness: other, model: none, thinking: max }\n");
	profile(
		"shared",
		'runtime: { harness: other, model: none }\ncontext: { strategy: handoff, at: "25%", max: 2 }\n',
	);
	profile(
		"capped",
		"runtime: { harness: other, model: none }\ncontext: { strategy: compact, at: 150000, max: 3 }\n",
	);
	profile(
		"naming",
		"runtime: { harness: other, model: none }\ncontext: { strategy: handoff, at: 777, max: 1 }\n",
	);
	profile(
		"bound",
		"runtime: { harness: stub, model: none }\nreadOnly: [/etc]\n",
	);
	profile(
		"clash",
		"runtime: { harness: stub, model: none }\nattachments: { prompt: { path: kb, hint: x } }\n",
		{ "kb/a.md": "a\n" },
	);
	profile(
		"nested",
		"runtime: { harness: stub, model: none }\nattachments: { previous: { path: kb, hint: x } }\n",
		{ "kb/a.md": "a\n" },
	);
	profile(
		"stub-extras",
		"runtime: { harness: stub, model: none }\nharnessExtras: extras\n",
		{ "extras/models.json": "{}\n" },
	);
	profile(
		"kit-clash",
		"runtime: { harness: kit, model: none }\nharnessExtras: extras\n",
		{ "extras/settings.json": "{}\n", "extras/models.json": "{}\n" },
	);
	test.each([
		[
			"a profile no root holds",
			agentOn(fresh, "nobody"),
			"HOST.profile",
			expect.stringMatching(
				/^Create \/.+\/profiles\/nobody\/profile\.yaml, or name another profile$/,
			),
			toyTarget,
		],
		[
			"a profile on a harness not loaded",
			agentOn(fresh, "gone"),
			"HOST.harness",
			"Set 'profiles.gone.runtime.harness' to one of: 'stub', 'other', 'kit'",
			toyTarget,
			{},
			"profile gone runs on harness 'gone', which is not loaded",
		],
		[
			"a profile with no model",
			agentOn(fresh, "modelless"),
			"HOST.profile",
			"Set profiles.modelless.runtime.model",
			toyTarget,
		],
		[
			"a profile its harness cannot honour",
			agentOn(fresh, "deep"),
			"HOST.runtime",
			"Use one of: low",
			toyTarget,
			{},
			"profiles.deep.runtime.thinking: other has no thinking level 'max'",
		],
		[
			"a context trigger in percent of a model whose window is not known",
			agentOn(fresh, "shared"),
			"HOST.runtime",
			"Run maestro agent probe shared, or write at in tokens",
			toyTarget,
			{},
			"profiles.shared.context.at: no context window is known for other model 'none'",
		],
		[
			"a problem whose fix names the profile",
			agentOn(fresh, "naming"),
			"HOST.runtime",
			"Run maestro agent show naming",
			toyTarget,
			{},
			"profiles.naming.context.at: other takes no such at",
		],
		[
			"a capped compaction on a harness that reports none",
			agentOn(fresh, "capped"),
			"HOST.runtime",
			"Drop context.max, or use strategy handoff",
			toyTarget,
			{},
			"profiles.capped.context.max: other reports no compaction, so it cannot be capped",
		],
		[
			"a profile whose file binds host paths",
			agentOn(fresh, "bound"),
			"HOST.profile",
			expect.stringMatching(
				/and set it in config under 'profiles\.bound\.readOnly'$/,
			),
			toyTarget,
		],
		[
			"a profile attachment named after the agent's own port",
			agentOn(fresh, "clash"),
			"HOST.attachment",
			"Rename attachment 'prompt' in profile clash",
			toyTarget,
		],
		[
			"a profile attachment named after the directory of earlier copies",
			agentOn(fresh, "nested"),
			"HOST.attachment",
			"Rename attachment 'previous' in profile nested",
			toyTarget,
			{},
			"profile nested attaches 'previous', which 'x' reserves",
		],
		[
			"harness extras on a harness without an extras check",
			agentOn(fresh, "stub-extras"),
			"HOST.runtime",
			"Drop harnessExtras from profile stub-extras, or run it on a harness that takes them",
			toyTarget,
			{},
			"profiles.stub-extras.harnessExtras: stub takes no harness extras",
		],
		[
			"an extras entry named like a file its harness writes itself",
			agentOn(fresh, "kit-clash"),
			"HOST.runtime",
			"Rename or drop settings.json in the extras directory",
			toyTarget,
			{},
			"profiles.kit-clash.harnessExtras: extras entry settings.json is a file kit writes itself",
		],
		[
			"a missing read-only bind of its profile",
			agentOn(fresh),
			"HOST.bind",
			"Create it, or drop the bind",
			toyTarget,
			{ profiles: { builder: { readOnly: ["/no/such/path"] } } },
			"profile builder read-only bind",
		],
		[
			"a profile attachment config points at a missing path",
			agentOn(fresh),
			"HOST.bind",
			"Create it, or drop the bind",
			toyTarget,
			{
				profiles: {
					builder: { attachments: { kb: { path: "/no/such/kb", hint: "x" } } },
				},
			},
			"profiles.builder.attachments.kb.path '/no/such/kb' does not exist",
		],
		[
			"a profile config tunes that no root holds",
			agentOn(fresh),
			"HOST.profile",
			"Did you mean 'builder'?",
			toyTarget,
			{ profiles: { buildr: {} } },
			"config 'profiles.buildr' tunes profile 'buildr', which no profile root holds",
		],
		[
			"config roles, which profiles replace",
			agentOn(fresh),
			"HOST.roles",
			"Move each role's fields under 'profiles.<profile>.runtime', and drop 'roles'",
			toyTarget,
			{ roles: { builder: { harness: "stub", model: "none" } } },
		],
		[
			"a relative sandbox.path directory",
			agentOn(fresh),
			"HOST.bind",
			"Give an absolute path",
			toyTarget,
			{ sandbox: { path: ["tools"] } },
			"sandbox.path",
		],
		[
			"a target that is no git repository",
			agentOn(fresh),
			"HOST.target",
			"Point 'target.repo' at a git repository",
			() => tmp("plain"),
		],
		[
			"a check with no hint",
			{ ...agentOn(fresh), checks: ["hello"] },
			"HOST.check",
			"Add target.checks.hello.hint, in the inline form { run, hint }",
			toyTarget,
			{},
			"x: check 'hello' has no hint, and an agent cannot use a check without one",
		],
		[
			"a target that does not exist",
			agentOn(fresh),
			"HOST.target",
			"Set 'target.repo' relative to the file's workspace root, or the user config's directory",
			() => join(tmp("gone"), "missing"),
		],
	] as [
		string,
		Record<string, unknown>,
		string,
		unknown,
		() => string,
		Record<string, unknown>?,
		string?,
	][])(
		"an agent naming %s is a HOST error",
		async (_, config, code, hint, target, extra = {}, named = "") => {
			const { host } = stubHost(() => [OK]);
			const ir = irOf(
				host,
				[{ id: "x", kind: "agent", config, literals: { prompt: "go" } }],
				"x",
			);
			const composed = await compose({
				ir,
				config: configOf(target(), extra),
				roots: ROOTS,
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.hint]),
			).toEqual([[code, hint as string]]);
			expect(composed.ok ? "" : composed.diagnostics[0]?.message).toContain(
				named,
			);
		},
	);

	test("an extras directory inside the lanes is a HOST error, as a read-only bind there is", async () => {
		const { host } = stubHost(() => [OK]);
		const dataRoot = tmp("data");
		const extras = join(dataRoot, "hosts/repo/lanes/extras");
		mkdirSync(extras, { recursive: true });
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: agentOn(fresh, "kit-clash"),
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const composed = await compose({
			ir,
			config: configOf(toyTarget(), {
				dataRoot,
				profiles: { "kit-clash": { harnessExtras: extras } },
			}),
			roots: ROOTS,
			core: CORE_CONFIG,
			packs: {},
			hosts: [host],
			loadCode: noCode,
			caps: {},
		});
		expect(
			composed.ok
				? []
				: composed.diagnostics.map((d) => [d.code, d.message, d.hint]),
		).toEqual([
			[
				"HOST.bind",
				`profiles.kit-clash.harnessExtras '${extras}' is inside a lane`,
				"Bind a path outside the lanes",
			],
		]);
	});

	profile("stub-modelless", "runtime: { harness: stub }\n");
	profile(
		"stub-shared",
		'runtime: { harness: stub }\ncontext: { strategy: handoff, at: "25%", max: 2 }\n',
	);
	test.each([
		["with no model", "stub-modelless"],
		["with a context trigger in percent and no window known", "stub-shared"],
	])("an agent naming a stub profile %s composes", async (_, name) => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: agentOn(fresh, name),
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const composed = await compose({
			ir,
			config: configOf(toyTarget()),
			roots: ROOTS,
			core: CORE_CONFIG,
			packs: {},
			hosts: [host],
			loadCode: noCode,
			caps: {},
		});
		expect(composed.ok ? [] : composed.diagnostics).toEqual([]);
	});

	profile(
		"noted",
		"runtime: { harness: stub, model: none }\nattachments: { notes: { path: kb, hint: x } }\n",
		{ "kb/a.md": "a\n" },
	);
	const noting: NodeSpec = {
		id: "w",
		kind: "agent",
		config: {
			...agentOn(fresh),
			out: { notes: { file: "n.md", format: "markdown" } },
		},
		literals: { prompt: "go" },
	};
	test.each([
		[
			"a profile attachment named after a graph attachment",
			{
				id: "x",
				kind: "agent",
				config: {
					...agentOn(fresh, "noted"),
					attachments: { notes: { hint: "y", type: "core.markdown" } },
				},
				literals: { prompt: "go" },
				wires: { notes: "w.notes" },
			},
			"HOST.attachment",
			"profile noted attaches 'notes', which 'x' takes from the graph",
			undefined,
		],
		[
			"one seat name holding two profiles",
			{
				id: "x",
				kind: "agent",
				config: { ...agentOn(fresh, "other"), seat: "builder" },
				literals: { prompt: "go" },
			},
			"HOST.seat",
			"'w' and 'x' sit in two seats 'toy/builder'",
			undefined,
		],
		[
			"a 1.0 agent node, built before profiles",
			{
				id: "x",
				kind: "agent",
				config: agentOn(fresh),
				literals: { prompt: "go" },
			},
			"HOST.legacy",
			"agent node 'x' names a role: it was built before profiles replaced roles",
			(ir: Ir) => {
				const node = ir.nodes.find((n) => n.id === "x");
				Object.assign(ir, { irVersion: "1.0" });
				Object.assign(node ?? {}, {
					config: { role: { name: "builder" }, lane: fresh },
				});
			},
		],
	] as [string, NodeSpec, string, string, ((ir: Ir) => void)?][])(
		"a graph with %s is a HOST error",
		async (_, spec, code, message, edit) => {
			const { host } = stubHost(() => [OK]);
			const ir = irOf(host, [noting, spec], "x");
			edit?.(ir);
			const composed = await compose({
				ir,
				config: configOf(toyTarget()),
				roots: ROOTS,
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.message]),
			).toEqual([[code, message]]);
		},
	);

	test.each([
		[
			"a check node",
			{ id: "x", kind: "check", config: { lane: fresh, check: "lint" } },
			"Use one of: 'hello', 'red', 'missing'",
		],
		[
			"an agent allowed to run it",
			{
				id: "x",
				kind: "agent",
				config: {
					profile: "builder",
					seat: "builder",
					lane: fresh,
					checks: ["lint"],
				},
				literals: { prompt: "go" },
			},
			"Add it under 'target.checks'",
		],
	] as [string, NodeSpec, string][])(
		"%s naming a check config lacks is a HOST error with the fix",
		async (_, spec, hint) => {
			const { host } = stubHost(() => [OK]);
			const ir = irOf(host, [spec], "x");
			const composed = await compose({
				ir,
				config: configOf(toyTarget()),
				roots: ROOTS,
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(
				composed.ok ? [] : composed.diagnostics.map((d) => [d.code, d.hint]),
			).toEqual([["HOST.check", hint]]);
		},
	);

	test("agents naming a check config lacks are one HOST error naming each of them", async () => {
		const { host } = stubHost(() => [OK]);
		const agent = (id: string, checks: string[]): NodeSpec => ({
			id,
			kind: "agent",
			config: { profile: "builder", seat: id, lane: fresh, checks },
			literals: { prompt: "go" },
		});
		const ir = irOf(
			host,
			[agent("a", ["lint"]), agent("b", ["lint"]), agent("c", ["lint"])],
			"c",
		);
		const composed = await compose({
			ir,
			config: configOf(toyTarget()),
			roots: ROOTS,
			core: CORE_CONFIG,
			packs: {},
			hosts: [host],
			loadCode: noCode,
			caps: {},
		});
		expect(
			composed.ok
				? []
				: composed.diagnostics
						.filter((d) => d.code === "HOST.check")
						.map((d) => [d.node, d.message, d.unset]),
		).toEqual([
			[
				"a",
				"'a', 'b' and 'c' may run check 'lint', which config 'target.checks' does not have",
				[[["target", "checks", "lint"]]],
			],
		]);
	});
});

describe("perform", () => {
	profile(
		"careful",
		"runtime: { harness: stub, model: none }\ninstructions: instructions.md\n",
		{ "instructions.md": "You are careful." },
	);
	test("environment gives code nodes the target, its base, the revision it names, its sparse patterns, null when unset, and a digest of the profiles", async () => {
		const { host } = stubHost(() => []);
		const environment = (repo: string, extra: Record<string, unknown>) => {
			const config = configOf(repo);
			const target = { ...config.values.target, ...extra };
			return host.environment({ ...setupOf(config), config: { target } });
		};
		expect(await environment("/repo", { sparse: ["src"] })).toEqual({
			target: "/repo",
			base: "main",
			revision: null,
			sparse: ["src"],
			profiles: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
		});
		expect(await environment("/repo", {})).toMatchObject({ sparse: null });
		const repo = toyTarget();
		const head = Bun.spawnSync(["git", "rev-parse", "main"], { cwd: repo });
		expect(await environment(repo, {})).toMatchObject({
			revision: head.stdout.toString().trim(),
		});
	});

	test("fresh, agent, read check, then an agent extending its version continues the first agent's session", async () => {
		const target = toyTarget();
		const before = snapshot(target);
		const { host, requests } = stubHost((req) =>
			req.prompt.startsWith("first")
				? [
						{ write: "hello.txt", content: "hi" },
						{ write: `${OUTBOX}/notes.json`, content: '{"n":1}' },
						{ emit: { type: "usage", tokens_in: 7, tokens_out: 2 } },
						OK,
					]
				: [{ write: "world.txt", content: "w" }, OK],
		);
		const notes = {
			file: "notes.json",
			format: "json",
			schema: { type: "object", required: ["n"] },
		};
		const ir = irOf(
			host,
			[
				{
					id: "first",
					kind: "agent",
					config: { ...agentOn({ mode: "fresh" }, "careful"), out: { notes } },
					literals: { prompt: "first task" },
				},
				{
					id: "look",
					kind: "check",
					config: { lane: { mode: "read" }, check: "hello" },
					lane: "first",
				},
				{
					id: "second",
					kind: "agent",
					config: agentOn({ mode: "extend" }),
					literals: { prompt: "second task" },
					lane: "first",
					session: "first",
				},
			],
			"second",
		);
		const config = configOf(target);
		const { id, result, instances, artifact } = await performed(
			host,
			ir,
			config,
		);

		expect(result).toMatchObject({ outcome: "ok", node: "second" });
		expect(instances.find((i) => i.node === "look")?.status).toBe("ok");
		const [first, second] = requests;
		expect(second?.session).toEqual(
			first?.session as HarnessRequest["session"],
		);
		const sessionOf = (node: string) =>
			instances.find((i) => i.node === node)?.outputs?.session;
		expect(sessionOf("first")).toBe(`${id}.first`);
		expect(sessionOf("second")).toBe(`${id}.first`);
		expect(second?.prompt).toBe(
			[
				"# Since your last turn",
				"- Task: changed, the new text below.\n- Attachments: unchanged.\n- Working copy: unchanged.\n- Contract: changed.",
				"# Task",
				"second task",
			].join("\n\n"),
		);
		const series = await changed(config, target, `${id}.second`);
		expect(series).toContain("hello.txt");
		expect(series).toContain("world.txt");
		expect(series).not.toContain("from-check.txt");
		expect(
			JSON.parse(readFileSync(artifact("first", "notes"), "utf8")),
		).toEqual({ n: 1 });
		const staged = artifact("first", "staged");
		const instructions = readFileSync(join(staged, "instructions.md"), "utf8");
		expect(instructions).toStartWith("You are careful.\n\n# Your run\n");
		expect(instructions).toContain(`${OUTBOX}/notes.json`);
		expect(first?.instructions).toEndWith("/staged/instructions.md");
		expect(readFileSync(join(staged, "prompt.md"), "utf8")).toBe("first task");
		expect(first?.prompt).toBe("first task");
		expect(instances.find((i) => i.node === "first")?.metrics).toEqual({
			tokens_in: 7,
			tokens_out: 2,
		});
		expect(snapshot(target)).toEqual(before);
	});

	const kitted = profile(
		"kitted",
		"runtime: { harness: kit, model: none }\nharnessExtras: extras\n",
		{ "extras/models.json": "{}\n" },
	);
	profile(
		"rekitted",
		"runtime: { harness: kit, model: none }\nharnessExtras: other\n",
		{ "other/models.json": "{}\n" },
	);
	test("a minted session records its profile's extras path, and an agent continuing it is given that path, not its own profile's", async () => {
		const { host, requests } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "first",
					kind: "agent",
					config: agentOn(fresh, "kitted"),
					literals: { prompt: "go" },
				},
				{
					id: "second",
					kind: "agent",
					config: agentOn({ mode: "extend" }, "rekitted"),
					literals: { prompt: "go on" },
					lane: "first",
					session: "first",
				},
			],
			"second",
		);
		const config = configOf(toyTarget());
		const { id, result } = await performed(host, ir, config);

		expect(result).toMatchObject({ outcome: "ok" });
		const extras = join(kitted, "extras");
		expect(requests.map((r) => r.extras)).toEqual([extras, extras]);
		const { root } = openTarget(
			setupOf(config).store,
			config.values.target.repo,
		);
		expect(openSession(root, `${id}.first`).extras).toBe(extras);
	});

	profile("kit-bare", "runtime: { harness: kit, model: none }\n");
	test("an agent whose profile sets extras, continuing a session recorded with none, is given no extras", async () => {
		const { host, requests } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "first",
					kind: "agent",
					config: agentOn(fresh, "kit-bare"),
					literals: { prompt: "go" },
				},
				{
					id: "second",
					kind: "agent",
					config: agentOn({ mode: "extend" }, "kitted"),
					literals: { prompt: "go on" },
					lane: "first",
					session: "first",
				},
			],
			"second",
		);
		const config = configOf(toyTarget());
		const { id, result } = await performed(host, ir, config);

		expect(result).toMatchObject({ outcome: "ok" });
		expect(requests).toHaveLength(2);
		expect(requests.map((r) => r.extras)).toEqual([undefined, undefined]);
		const { root } = openTarget(
			setupOf(config).store,
			config.values.target.repo,
		);
		expect(openSession(root, `${id}.first`)).not.toHaveProperty("extras");
	});

	test("a session record without an extras path loads as a session with no extras", () => {
		const root = tmp("store");
		const home = join(root, "sessions", encodeURIComponent("c.x"));
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "session.json"),
			JSON.stringify({ harness: "stub", concert: "c", harnessId: "h" }),
		);
		const session = openSession(root, "c.x");
		expect(session.harnessId).toBe("h");
		expect(session).not.toHaveProperty("extras");
	});

	test.each([
		[1, "ok"],
		[3, "failed"],
	])(
		"%i malformed envelopes end %s, corrected in the same session",
		async (bad, outcome) => {
			const { host, requests } = stubHost(() =>
				requests.length <= bad
					? [{ emit: { type: "text", text: "done!" } }]
					: [OK],
			);
			const ir = irOf(
				host,
				[
					{
						id: "x",
						kind: "agent",
						config: {
							profile: "builder",
							seat: "builder",
							lane: { mode: "fresh" },
						},
						literals: { prompt: "go" },
					},
				],
				"x",
			);
			const { result } = await performed(host, ir, configOf(toyTarget()));
			expect(result).toMatchObject({ outcome });
			expect(requests).toHaveLength(Math.min(bad + 1, 3));
			expect(new Set(requests.map((r) => r.session.id)).size).toBe(1);
			expect(requests[1]?.prompt).toStartWith(
				"Your final reply is not the JSON object asked for: it is not a JSON object.",
			);
		},
	);

	test.each([
		["red", "rejected", "check 'red' line 2 exited 1"],
		[
			"missing",
			"failed",
			/check 'missing' line 1 exited 127: sh: .*no-such-command: .*not found$/,
		],
		[
			undefined,
			"failed",
			/check 'hello' line 1 exited 1; check 'red' line 2 exited 1; check 'missing' line 1 exited 127: sh: .*no-such-command: .*not found$/,
		],
		[
			{ run: "sleep 5", timeout: "1s" },
			"failed",
			"check 'inline' line 1 exited 124",
		],
		[{ run: "exit 137" }, "failed", "check 'inline' line 1 exited 137"],
		[
			{
				run: ["true", "echo warn >&2; echo bad news; printf '\\n\\n'; exit 1"],
			},
			"rejected",
			"check 'inline' line 2 exited 1: bad news",
		],
		[
			{ run: "echo summary; echo warn >&2; exit 1" },
			"rejected",
			"check 'inline' line 1 exited 1: warn",
		],
		[
			{ run: "printf '\\033[31mred\\033[0m\\tx\\033]0;title\\007\\n'; exit 1" },
			"rejected",
			"check 'inline' line 1 exited 1: red x",
		],
		[
			{ run: "printf '%0250d' 0; exit 1" },
			"rejected",
			`check 'inline' line 1 exited 1: ${"0".repeat(200)}`,
		],
	])("check %j ends %s, naming the line", async (check, outcome, reason) => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "check",
					config: { lane: { mode: "fresh" }, ...(check && { check }) },
				},
			],
			"x",
		);
		const { result, artifact } = await performed(
			host,
			ir,
			configOf(toyTarget()),
		);
		expect(result).toMatchObject({ outcome });
		const got = result.outcome === "ok" ? "" : result.reason;
		// The shell's not-found wording differs between bash and dash.
		if (typeof reason === "string") expect(got).toEndWith(reason);
		else expect(got).toMatch(reason);
		expect(readFileSync(artifact("x", "logs"), "utf8")).toContain("$ ");
	});

	/** An IR of one agent `x` that may be a verdict agent and may declare the Markdown output `notes`. */
	const lone = (
		host: Parameters<typeof irOf>[0],
		{ verdict = false, notes = false } = {},
	) =>
		irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: {
						profile: "builder",
						seat: "builder",
						lane: { mode: "fresh" },
						...(verdict && { verdict }),
						...(notes && {
							out: { notes: { file: "notes.md", format: "markdown" } },
						}),
					},
					literals: { prompt: "go" },
				},
			],
			"x",
		);

	test.each([
		["one composition's seat of the name", { "repair/builder": "rebound" }],
		["both seats of the name", { "toy/builder": "x", "repair/builder": "x" }],
	] as [string, Record<string, string>][])(
		"seats rebinding %s never clashes it with another composition's",
		async (_, seats) => {
			profile("rebound", "runtime: { harness: stub, model: rebound }\n");
			profile("x", "runtime: { harness: stub, model: x }\n");
			const { host } = stubHost(() => [OK]);
			const composed = await compose({
				ir: scoped(host),
				config: configOf(toyTarget(), { seats }),
				roots: ROOTS,
				core: CORE_CONFIG,
				packs: {},
				hosts: [host],
				loadCode: noCode,
				caps: {},
			});
			expect(composed.ok ? [] : composed.diagnostics).toEqual([]);
		},
	);

	test("an agent runs the profile seats binds its seat to, keyed by the composition of its scope", async () => {
		profile("rebound", "runtime: { harness: stub, model: rebound }\n");
		const { host, requests } = stubHost(() => [OK]);
		const seats = { "repair/builder": "rebound" };
		const config = configOf(toyTarget(), { seats });
		const { result } = await performed(host, scoped(host), config);
		expect(result.outcome).toBe("ok");
		expect(requests.map((r) => r.runtime.model)).toEqual(["none", "rebound"]);
	});

	test("a verdict agent that rejects is rejected with its reason and outputs", async () => {
		const { host } = stubHost(() => [
			reply({ outcome: "rejected", reason: "not doable", report: TRIED }),
		]);
		const ir = lone(host, { verdict: true });
		const { result } = await performed(host, ir, configOf(toyTarget()));
		expect(result).toMatchObject({
			outcome: "rejected",
			reason: "not doable",
			outputs: { report: TRIED },
		});
	});

	test.each([
		[
			"a verdict agent that rejects",
			true,
			{ outcome: "rejected", reason: "not doable", report: TRIED },
			{ outcome: "rejected", reason: "not doable" },
		],
		[
			"a blocked agent",
			false,
			{
				blocked: "no network",
				report: { ...TRIED, gaps: [], obstacles: ["no network"] },
			},
			{ outcome: "failed", reason: "blocked: no network" },
		],
		[
			"a blocked verdict agent",
			true,
			{ blocked: "no network", report: TRIED },
			{ outcome: "failed", reason: "blocked: no network" },
		],
	])(
		"%s that misses a declared output ends at once as it said, with no outputs and its report recorded",
		async (_, verdict, envelope, ended) => {
			const { host, requests } = stubHost(() => [reply(envelope)]);
			const ir = lone(host, { verdict, notes: true });
			const { result, instances } = await performed(
				host,
				ir,
				configOf(toyTarget()),
			);
			expect(requests).toHaveLength(1);
			expect(result).toMatchObject(ended);
			expect("outputs" in result).toBe(false);
			const { gaps: _gaps, ...kept } = envelope.report as { gaps?: unknown };
			expect(instances[0]?.enrichment?.report).toEqual(kept);
		},
	);

	test.each([
		[
			"a work agent's outcome",
			false,
			{ outcome: "ok", report: DONE },
			"reply must NOT have additional properties ('outcome')",
			'- Add `"blocked": "<the cause>"` only when you cannot proceed',
			'"outcome"',
		],
		[
			"a verdict agent's missing outcome",
			true,
			{ report: DONE },
			"reply.outcome is required unless reply.blocked is set",
			"- `outcome`: `ok` when the work passes your ruling",
			"- Add `",
		],
		[
			"a verdict agent's blocked beside its verdict",
			true,
			{ blocked: "no network", outcome: "rejected", reason: "x", report: DONE },
			"reply.blocked excludes reply.outcome and reply.reason",
			"- `outcome`: `ok` when the work passes your ruling",
			"- Add `",
		],
		[
			"a report as text",
			false,
			{ report: "done" },
			"reply.report must be object",
			"- Most reports are the summary alone: give a list only for an item that clears its bar.",
			'"outcome"',
		],
	])(
		"%s is corrected, and the contract and the correction state only its kind's fields",
		async (_, verdict, envelope, problem, line, absent) => {
			const { host, requests } = stubHost(() =>
				requests.length <= 1 ? [reply(envelope)] : [verdict ? APPROVED : OK],
			);
			const ir = lone(host, { verdict });
			const { result, artifact } = await performed(
				host,
				ir,
				configOf(toyTarget()),
			);
			expect(result).toMatchObject({ outcome: "ok" });
			expect(requests).toHaveLength(2);
			const second = requests[1];
			const contract = readFileSync(
				join(artifact("x", "staged"), "instructions.md"),
				"utf8",
			);
			expect(second?.prompt).toStartWith(
				`Your final reply is not the JSON object asked for: ${problem}.\n`,
			);
			for (const text of [contract, second?.prompt]) {
				expect(text).toContain(line);
				expect(text).toContain("nothing later in this run will change it");
				expect(text).not.toContain(absent);
			}
		},
	);

	test.each([
		["missing", [OK], "output 'notes': the agent wrote no /out/notes.json"],
		[
			"off its schema",
			[{ write: `${OUTBOX}/notes.json`, content: "{}" }, OK],
			"output 'notes': /out/notes.json must have required property 'n'",
		],
		[
			"a link",
			[{ sh: `ln -s /etc/hostname ${OUTBOX}/notes.json` }, OK],
			"output 'notes': /out/notes.json is not a regular file",
		],
	])("a declared output %s fails the agent", async (_, steps, reason) => {
		const { host } = stubHost(() => steps);
		const notes = {
			file: "notes.json",
			format: "json",
			schema: { type: "object", required: ["n"] },
		};
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: {
						profile: "builder",
						seat: "builder",
						lane: { mode: "fresh" },
						out: { notes },
					},
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const { result } = await performed(host, ir, configOf(toyTarget()));
		expect(result).toMatchObject({ outcome: "failed", reason });
	});

	test("cancelling mid-agent kills its processes and records the concert failed", async () => {
		const { host, requests } = stubHost(() => [{ hang: true }]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: {
						profile: "builder",
						seat: "builder",
						lane: { mode: "fresh" },
					},
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const { concert, recordPath } = await start(
			host,
			ir,
			configOf(toyTarget()),
		);
		while (!requests.length) await Bun.sleep(20);
		let pids: number[] = [];
		while (!pids.length) {
			await Bun.sleep(20);
			pids = sandboxed();
		}
		await concert.cancel();
		const result = await concert.done;
		expect(result).toMatchObject({
			outcome: "failed",
			reason: "the concert was cancelled",
		});
		expect(sandboxed().filter((p) => pids.includes(p))).toEqual([]);
		const record = openRecord(recordPath);
		expect(record.find(concert.id)?.status).toBe("failed");
		expect(record.instances(concert.id).map((i) => [i.node, i.status])).toEqual(
			[["x", "failed"]],
		);
		record.close();
	});

	const watched = {
		file: "w.json",
		format: "json",
		schema: { type: "object" },
	};
	test.each([
		["fresh", "fails"],
		["fork", "fails"],
		["extend", "fails"],
		["fresh", "is cancelled"],
		["fork", "is cancelled"],
		["extend", "is cancelled"],
	])(
		"an agent on a %s lane that %s mid-run resumes to ok in a clean lane",
		async (mode, how) => {
			let attempt = 0;
			const { host, requests } = stubHost(() => {
				attempt++;
				// A failing agent gets its two corrections before it fails.
				if (attempt > (how === "fails" ? 3 : 1))
					return [
						{ write: "done.txt", content: "d" },
						{ write: `${OUTBOX}/w.json`, content: "{}" },
						OK,
					];
				const stale: StubStep = { write: "stale.txt", content: "s" };
				return how === "fails" ? [stale, OK] : [stale, { hang: true }];
			});
			const base = {
				id: "base",
				kind: "check" as const,
				config: { lane: fresh, check: { run: "touch base.txt" } },
			};
			const agent = {
				id: "x",
				kind: "agent" as const,
				config: {
					profile: "builder",
					seat: "builder",
					lane: { mode },
					out: { watched },
				},
				literals: { prompt: "go" },
				...(mode !== "fresh" && { lane: "base" }),
			};
			const ir = irOf(host, [base, agent], "x");
			const config = configOf(toyTarget());
			const first = await start(host, ir, config);
			if (how === "is cancelled") {
				while (!requests.length) await Bun.sleep(20);
				while (!sandboxed().length) await Bun.sleep(20);
				await first.concert.cancel();
			}
			expect(await first.concert.done).toMatchObject({ outcome: "failed" });
			const { root } = openTarget(
				setupOf(config).store,
				config.values.target.repo,
			);
			// A cancelled agent keeps its changes as a partial before its lane is dropped.
			const lane = join(root, "lanes", first.concert.id, "x");
			await dropped(lane);
			expect(existsSync(lane)).toBe(false);
			const { result } = await performed(host, ir, config, {
				resume: first.concert.id,
			});
			expect(result).toMatchObject({ outcome: "ok", node: "x" });
			const series = await changed(
				config,
				config.values.target.repo,
				`${first.concert.id}.x`,
			);
			expect(series).toContain("done.txt");
			expect(series).not.toContain("stale.txt");
			expect(series.includes("base.txt")).toBe(mode !== "fresh");
		},
	);

	test("a rejected check that sealed its version runs again on resume", async () => {
		const flags = tmp("flags");
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "check",
					config: {
						lane: fresh,
						check: { run: [`touch seen.txt`, `test -f ${flags}/go`] },
					},
				},
			],
			"x",
		);
		const config = configOf(toyTarget(), { sandbox: { readOnly: [flags] } });
		const first = await performed(host, ir, config);
		expect(first.result).toMatchObject({ outcome: "rejected" });
		writeFileSync(join(flags, "go"), "");
		const again = await performed(host, ir, config, { resume: first.id });
		expect(again.result).toMatchObject({ outcome: "ok" });
		expect(
			await changed(config, config.values.target.repo, `${first.id}.x`),
		).toContain("seen.txt");
	});

	test("a check line killed by a signal fails, naming the signal and the line", async () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "check",
					config: { lane: fresh, check: { run: "sleep 300" } },
				},
			],
			"x",
		);
		const done = performed(host, ir, configOf(toyTarget()));
		let pids: number[] = [];
		while (!pids.length) {
			await Bun.sleep(20);
			pids = sandboxed();
		}
		for (const pid of pids) process.kill(pid, "SIGKILL");
		expect((await done).result).toMatchObject({
			outcome: "failed",
			reason: "check 'inline' line 1 was killed by signal SIGKILL",
		});
	});

	test("usage counts a concert's lanes and sessions, and release frees them", async () => {
		const { host } = stubHost(() => [
			{ write: "big.txt", content: "x".repeat(64 * 1024) },
			OK,
		]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: {
						profile: "builder",
						seat: "builder",
						lane: { mode: "fresh" },
					},
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const config = configOf(toyTarget());
		const { id, result } = await performed(host, ir, config);
		expect(result.outcome).toBe("ok");
		const setup = setupOf(config);
		expect(await host.resources?.usage(id, setup)).toBeGreaterThan(64 * 1024);
		await host.resources?.release(id, setup);
		expect(await host.resources?.usage(id, setup)).toBe(0);
		const root = openTarget(setup.store, config.values.target.repo).root;
		expect(readdirSync(join(root, "sessions"))).toEqual([]);
		expect(() => openSession(root, `${id}.x`)).toThrow(
			`session ${id}.x of node 'x' is not in the store: its concert was pruned. Perform the composition anew`,
		);
	});
	test("a malformed session record and an older store's session files are released with their concert", async () => {
		const { host } = stubHost(() => [OK]);
		const ir = irOf(
			host,
			[
				{
					id: "x",
					kind: "agent",
					config: { profile: "builder", seat: "builder", lane: fresh },
					literals: { prompt: "go" },
				},
			],
			"x",
		);
		const config = configOf(toyTarget());
		const { id, result } = await performed(host, ir, config);
		expect(result.outcome).toBe("ok");
		const setup = setupOf(config);
		const root = openTarget(setup.store, config.values.target.repo).root;
		const sessions = join(root, "sessions");
		const [session = ""] = readdirSync(sessions);
		writeFileSync(join(sessions, session, "session.json"), "{not json");
		const before = (await host.resources?.usage(id, setup)) ?? 0;
		/** An older store's session `uuid` with an unreadable record, and its file naming version `v`. */
		const legacy = (v: string, uuid: string) => {
			mkdirSync(join(sessions, uuid), { recursive: true });
			writeFileSync(join(sessions, uuid, "session.json"), "x".repeat(1024));
			mkdirSync(join(sessions, "written"), { recursive: true });
			writeFileSync(join(sessions, "written", encodeURIComponent(v)), uuid);
		};
		legacy(`${id}.x`, "old");
		legacy("another.y", "foreign");
		expect(await host.resources?.usage(id, setup)).toBeGreaterThan(
			before + 1024,
		);
		await host.resources?.release(id, setup);
		expect(await host.resources?.usage(id, setup)).toBe(0);
		expect(readdirSync(sessions).sort()).toEqual(["foreign", "written"]);
		expect(readdirSync(join(sessions, "written"))).toEqual(["another.y"]);
		expect(existsSync(join(root, "lanes", id))).toBe(false);
	});
});

test("a commits version reads, forks and makes a changeset, and keeps its commits after the branch moves", async () => {
	const { host } = stubHost(() => [OK]);
	const target = toyTarget();
	commitTo(target, { "b.txt": "b\n" });
	const ir = irOf(
		host,
		[
			{ id: "commits", kind: "commits", config: { revs: "main^!" } },
			...["read", "fork"].map((mode) => ({
				id: mode,
				kind: "agent" as const,
				config: { profile: "builder", seat: "builder", lane: { mode } },
				literals: { prompt: "go" },
				lane: "commits",
			})),
			{ id: "patches", kind: "changeset", config: {}, lane: "commits" },
		],
		"patches",
	);
	const config = configOf(target);
	const { id, result, artifact } = await performed(host, ir, config);
	expect(result).toMatchObject({ outcome: "ok" });
	const patches = artifact("patches", "changeset");
	expect(readdirSync(patches).sort()).toEqual(["0001.patch", "base"]);
	expect(readFileSync(join(patches, "0001.patch"), "utf8")).toContain("b.txt");
	expect(await changed(config, target, `${id}.fork`)).toContain("b.txt");
	commitTo(target, { "c.txt": "c\n" });
	const pinned = await changed(config, target, `${id}.commits`);
	expect(pinned).toContain("b.txt");
	expect(pinned).not.toContain("c.txt");
});

test("param reads a lane ref and refuses other text", () => {
	const { host } = stubHost(() => []);
	expect(host.param?.("repo.lane", "c1.lens[risk]/skeptic")).toEqual({
		value: "c1.lens[risk]/skeptic",
	});
	expect(host.param?.("repo.lane", "nodot")).toMatchObject({
		diagnostics: [{ code: "HOST.param" }],
	});
});
