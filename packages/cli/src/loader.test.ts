import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { ComposeInput } from "@maestro/core/compose";
import type { HostInstance, HostNodeResult } from "@maestro/core/host";
import { openRecord, perform } from "@maestro/core/perform";
import { type Ir, parseIr, type WorkerRef } from "@maestro/ir";
import { composeIr, fakeHost } from "@maestro/testkit";
import {
	cleanup,
	DEMO,
	demoSource,
	FIXTURES,
	packOf,
	scratch,
} from "./fixtures/packs";
import {
	claimsOf,
	codeHashOf,
	type Loader,
	moduleLoader,
	openFile,
	openPack,
	rewriteModules,
	withCurrentHashes,
} from "./loader";
import { type CliError, EXIT } from "./output";

const GOLDEN = join(FIXTURES, "../../../ir/fixtures");
const SHA256 = /^sha256:[0-9a-f]{64}$/;

afterEach(cleanup);

function built(
	result: ReturnType<Awaited<ReturnType<typeof openPack>>["build"]>,
): Ir {
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ir;
}

const composed = (ir: Ir, loader: Loader, over: Partial<ComposeInput> = {}) =>
	composeIr(ir, { loadCode: loader.loadCode, ...over });

const demoPack = async () =>
	openPack({ dir: await packOf(join(DEMO, "index.ts"), await scratch()) });

const golden = async (name: string) => {
	const parsed = parseIr(await Bun.file(join(GOLDEN, name)).json());
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
	return parsed.ir;
};

/** Every worker reference in `ir`: each code node's worker and each `parMap` or `parFind` key function. */
const refsOf = (ir: Ir): WorkerRef[] =>
	ir.nodes.flatMap((n) => {
		if (n.kind === "code") return [n.worker];
		return (n.kind === "parMap" || n.kind === "parFind") && n.key
			? [n.key]
			: [];
	});

const workerOf = (ir: Ir, id: string) => {
	const node = ir.nodes.find((n) => n.id === id);
	if (node?.kind !== "code") throw new Error(`no code node '${id}'`);
	return node.worker;
};

describe("a pack", () => {
	test("builds through its bundle, names its functions by identity, and composes", async () => {
		const pack = await demoPack();
		expect(pack.pack).toEqual({ id: "demo", version: "1.0.0" });
		expect(claimsOf([pack])).toEqual({
			demo: { echo: ["times"], greet: ["name", "loud"], ticket: ["handle"] },
		});
		const ir = built(pack.build("greet", { name: "x" }));
		const hash = await Bun.file(join(pack.dir, "index.js")).bytes();
		const expected = `sha256:${new Bun.CryptoHasher("sha256").update(hash).digest("hex")}`;
		expect(workerOf(ir, "helpers_exclaim")).toEqual({
			runtime: "ts",
			module: "index.js",
			export: "helpers.exclaim",
			codeHash: expected,
		});
		expect(workerOf(ir, "shape").export).toBe("shape");
		expect((await composed(ir, pack)).ok).toBe(true);
	});

	test.each<
		[string, Record<string, unknown>, string, { at?: string; sdk?: string }?]
	>([
		[
			"a missing directory",
			{},
			"pack directory '<dir>/nope' does not exist",
			{ at: "nope" },
		],
		["a missing manifest", {}, "Give the pack a JSON manifest", { at: ".." }],
		[
			"a manifest off its schema",
			{ sdk: undefined },
			"maestro-pack.json: manifest must have required property 'sdk'",
		],
		[
			"an SDK out of range",
			{ sdk: "^99.0.0" },
			"pack 'demo' at <dir> needs SDK ^99.0.0, and this maestro has",
		],
		[
			"a manifest naming hosts",
			{ hosts: { fake: "^1.0.0" } },
			"maestro-pack.json: manifest must NOT have additional properties",
		],
		[
			"an entry outside the pack",
			{ entry: "../index.js" },
			"pack 'demo' at <dir> has entry '../index.js' outside its directory",
		],
		[
			"an entry that links outside the pack",
			{ entry: "link.js" },
			"pack 'demo' at <dir> has entry 'link.js' outside its directory",
		],
		[
			"an entry that does not import",
			{ entry: "broken.js" },
			"pack 'demo' at <dir>: cannot load its entry 'broken.js'",
		],
		[
			"an entry without the SDK's glue",
			{ entry: "plain.js" },
			"pack 'demo' at <dir>: its entry exports no describe() and build()",
		],
		[
			"an entry whose describe() is off shape",
			{ entry: "odd.js" },
			"pack 'demo' at <dir>: describe().0 must have required property 'name'",
		],
	])("refuses %s, naming the pack", async (_, over, message, how = {}) => {
		const dir = await packOf(
			join(DEMO, "index.ts"),
			join(await scratch(), "pack"),
			over,
		);
		await Bun.write(join(dir, "broken.js"), "export const = ;");
		await Bun.write(join(dir, "plain.js"), "export const x = 1;");
		await Bun.write(
			join(dir, "odd.js"),
			"export const describe = () => [{}];\nexport const build = () => '';",
		);
		await Bun.write(join(dir, "../index.js"), "");
		await symlink(join(dir, "../index.js"), join(dir, "link.js"));
		const error = await openPack(
			{ dir: join(dir, how.at ?? ".") },
			how.sdk,
		).catch((e: Error) => e.message);
		expect(String(error).replaceAll(dir, "<dir>")).toContain(message);
	});

	test("refuses two packs that share an id, naming both", async () => {
		const one = await demoPack();
		const two = await demoPack();
		expect(() => claimsOf([one, two])).toThrow(
			`pack id 'demo' is taken twice, by ${one.dir} and by ${two.dir}`,
		);
	});
});

describe("a bare file", () => {
	test("builds from its own entry, bundled in memory, and composes", async () => {
		const file = await openFile(join(FIXTURES, "hello.ts"));
		expect(file.pack).toEqual({ id: "hello", version: "0.0.0" });
		const ir = built(file.build("hello", {}));
		expect(workerOf(ir, "exclaim")).toMatchObject({
			module: "hello.ts",
			export: "exclaim",
		});
		expect(workerOf(ir, "exclaim").codeHash).toMatch(SHA256);
		expect((await composed(ir, file)).ok).toBe(true);
	});

	test("keeps the text it bundled, which its codeHash names", async () => {
		const file = await openFile(join(FIXTURES, "hello.ts"));
		const ir = built(file.build("hello", {}));
		expect(file.text).toBeDefined();
		expect(workerOf(ir, "exclaim").codeHash).toBe(codeHashOf(file.text ?? ""));
	});

	test("hashes its imports, so a changed helper changes its codeHash", async () => {
		const dir = await scratch();
		await cp(FIXTURES, dir, { recursive: true, verbatimSymlinks: true });
		const hash = async () =>
			workerOf(
				built((await openFile(join(dir, "hello.ts"))).build("hello", {})),
				"exclaim",
			).codeHash;
		const before = await hash();
		await Bun.write(
			join(dir, "demo/helpers.ts"),
			"export const exclaim = () => ({ text: '?' });",
		);
		expect(await hash()).not.toBe(before);
	});

	test("inlines a Markdown text import into the IR", async () => {
		const dir = await scratch();
		await Bun.write(join(dir, "prompt.md"), "# Task\n\nMarkdown marker.\n");
		const file = join(dir, "texted.ts");
		await Bun.write(
			file,
			`import { code, composition, Text } from "@maestro/sdk";
import TEXT from "./prompt.md" with { type: "text" };
export const same = (i: { text: string }) => i;
export const texted = composition("texted", { examples: [{}] }, () =>
	code(same, { in: { text: TEXT }, out: { text: Text() } }),
);
`,
		);
		const ir = built((await openFile(file)).build("texted", {}));
		expect(JSON.stringify(ir)).toContain("# Task\\n\\nMarkdown marker.");
	});

	test("refuses a file whose import does not resolve, naming the import and where it sits", async () => {
		const file = join(await scratch(), "lost.ts");
		await Bun.write(file, 'import x from "./nope";\nexport const y = x;\n');
		const error = (await openFile(file).catch((e: CliError) => e)) as CliError;
		expect(error.message).toBe(
			`cannot bundle ${file}: ${file}:1:15: Could not resolve: "./nope"\nFix the file or its imports`,
		);
		expect(error.exit).toBe(EXIT.failed);
	});

	test("fails a function exported under two names, naming both, with no location inside its bundle", async () => {
		const file = await openFile(join(FIXTURES, "twice.ts"));
		const result = file.build("twice", {});
		expect(result.ok ? [] : result.diagnostics).toEqual([
			{
				code: "SCOPE.export",
				severity: "error",
				message:
					"function 'exclaim' is exported under two names, 'again.exclaim' and 'exclaim'",
				hint: expect.any(String),
			},
		]);
	});
});

describe("an IR file", () => {
	test("loads its modules relative to its directory, checked against codeHash, and composes", async () => {
		const result = await composed(
			await golden("minimal.json"),
			moduleLoader(GOLDEN),
		);
		expect(result.ok).toBe(true);
	});

	test.each([
		[
			"a module whose bytes differ from its codeHash",
			(text: string) => `${text}\n`,
			false,
			/: module 'greet.ts' has codeHash sha256:\w+, not the sha256:54d8\w+ the IR names$/,
			"Rebuild the pack, or recompute the IR's codeHash",
		],
		[
			"a module that imports a file its codeHash does not cover",
			(text: string) => `import "./helper";\n${text}`,
			true,
			/: module 'greet.ts' imports '.\/helper', which its codeHash does not cover$/,
			"Bundle it, e.g. through `maestro compose --out`",
		],
		[
			"a module that imports the SDK's loader subpath",
			(text: string) => `import "@maestro/sdk/loader";\n${text}`,
			true,
			/: module 'greet.ts' imports '@maestro\/sdk\/loader', which its codeHash does not cover$/,
			"Bundle it, e.g. through `maestro compose --out`",
		],
		[
			"a missing module",
			undefined,
			false,
			/: module \S+\/greet.ts not found$/,
			"Restore it, or fix the module the IR names",
		],
	])(
		"refuses %s before any node starts",
		async (_, edit, rehash, message, hint) => {
			const dir = await scratch();
			const file = join(dir, "greet.ts");
			if (edit)
				await Bun.write(
					file,
					edit(await Bun.file(join(GOLDEN, "greet.ts")).text()),
				);
			await Bun.write(join(dir, "helper.ts"), "");
			const loader = moduleLoader(dir);
			const ir = await golden("minimal.json");
			const result = await composed(
				rehash ? await withCurrentHashes(ir, loader.codeHash) : ir,
				loader,
			);
			expect(
				result.ok
					? []
					: result.diagnostics.map((d) => [d.code, d.message, d.hint]),
			).toEqual([["SCOPE.export", expect.stringMatching(message), hint]]);
		},
	);

	test("resolves maestro:stdlib to the engine's stdlib, and an export it lacks is a compose error", async () => {
		const ir = await golden("fanout-fanin-loop.json");
		expect((await composed(ir, moduleLoader(GOLDEN))).ok).toBe(true);
		const lacking = {
			...ir,
			nodes: ir.nodes.map((n) =>
				n.kind === "code" && n.worker.export === "get"
					? { ...n, worker: { ...n.worker, export: "nope" } }
					: n,
			),
		};
		const result = await composed(lacking, moduleLoader(GOLDEN));
		expect(result.ok ? [] : result.diagnostics.map((d) => d.message)).toEqual([
			expect.stringContaining(
				": maestro's stdlib has no exported function 'nope'",
			),
		]);
	});

	test.each([
		[
			"a pack built",
			async () => {
				const pack = await demoPack();
				return {
					ir: built(pack.build("greet", { name: "x" })),
					from: pack.dir,
				};
			},
		],
		[
			"a file naming the stdlib",
			async () => ({
				ir: await golden("fanout-fanin-loop.json"),
				from: GOLDEN,
			}),
		],
		[
			"a file naming a group's key function",
			async () => ({
				ir: await golden("guards-and-escalation.json"),
				from: GOLDEN,
			}),
		],
	])(
		"IR %s, with its modules rewritten relative to another directory, loads from there",
		async (_, source) => {
			const { ir, from } = await source();
			const out = join(await scratch(), "saved");
			await mkdir(out);
			const rewritten = rewriteModules(ir, from, out);
			const loader = moduleLoader(out);
			for (const ref of refsOf(rewritten))
				expect(typeof (await loader.loadCode(ref))).toBe("function");
			expect(
				refsOf(rewritten).map((r) => r.module === "maestro:stdlib"),
			).toEqual(refsOf(ir).map((r) => r.module === "maestro:stdlib"));
		},
	);
});

describe("resume", () => {
	test("a changed bundle reruns its code node, and not an unchanged host node", async () => {
		const dir = await scratch();
		const packDir = join(dir, "pack");
		await mkdir(packDir);
		await packOf(join(await demoSource(), "index.ts"), packDir);
		const first = await openPack({ dir: packDir });
		const record = openRecord(join(dir, "record.db"));
		const started: string[] = [];
		const attempts = new Map<string, number>();
		const step = (instance: HostInstance): HostNodeResult => {
			const id = instance.node.id;
			started.push(id);
			attempts.set(id, (attempts.get(id) ?? 0) + 1);
			if (id === "echo/echo" && attempts.get(id) === 1)
				return { outcome: "failed", reason: "flaky" };
			return { outcome: "ok", outputs: { text: id } };
		};
		const hosts = [fakeHost({ steps: { first: step, "echo/echo": step } })];
		const options = {
			hosts,
			config: { values: { dataRoot: dir }, sources: [], layers: [] },
			roots: { user: join(dir, "roots"), packs: {} },
			recordPath: join(dir, "record.db"),
			dir,
			concurrency: 4,
		};
		const ir = built(first.build("greet", { name: "x" }));
		const failed = await perform({
			...options,
			ir,
			loadCode: first.loadCode,
		});
		expect((await failed.done).outcome).toBe("failed");

		await packOf(
			join(await demoSource((t) => t.replace('"v1"', '"v2"')), "index.ts"),
			packDir,
		);
		const second = await openPack({ dir: packDir });
		const stored = record.find(failed.id)?.ir;
		if (!stored) throw new Error("the failed concert is not recorded");
		expect((await composed(stored, second)).ok).toBe(false);
		const rehashed = await withCurrentHashes(stored, second.codeHash);
		expect((await composed(rehashed, second)).ok).toBe(true);
		const resumed = await perform({
			...options,
			ir: rehashed,
			resume: failed.id,
			loadCode: second.loadCode,
		});
		expect(await resumed.done).toMatchObject({
			outcome: "ok",
			outputs: { text: "echo/echo" },
		});
		expect(started).toEqual(["first", "echo/echo", "echo/echo"]);
		const shape = record
			.instances(failed.id)
			.filter((i) => i.node === "shape" && !i.stale);
		expect(shape.map((i) => i.outputs)).toEqual([{ text: "first v2" }]);
		record.close();
	});
});
