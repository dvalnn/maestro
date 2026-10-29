import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { GraphIndex } from "@maestro/ir";
import { fakeHost } from "@maestro/testkit";
import { cleanup, DEMO, packOf, scratch } from "./fixtures/packs";
import { json, world } from "./fixtures/world";

afterEach(cleanup);

/** A composition of one host node with a config. */
const STAFFED = `import { composition, Optional, Text } from "@maestro/sdk";
import { hostNode } from "@maestro/sdk/host";

export const draft = composition(
	"draft",
	{
		doc: "Drafts a page.\\nThen leaves it for review.",
		params: {
			topic: Text({ description: "What the page is about" }),
			tags: Text({ default: "a" }),
			note: Optional(Text()),
		},
		examples: [{ topic: "x" }],
	},
	() => hostNode("fake.task", { label: "write", config: { seat: "writer" } }),
);
`;

/** A host that names the config its nodes read: a key per node twice, and a check. */
const needy = {
	...fakeHost(),
	needs: (graph: GraphIndex) => [
		...[...graph.nodes.keys()].flatMap((id) => [
			["seats", id],
			["seats", id],
		]),
		["target", "checks", "test"],
	],
};

/** A world with the `staffed` pack installed in its data home's packs directory, which no config lists. */
async function staffed() {
	const w = await world();
	const source = join(await scratch(), "staffed.ts");
	await Bun.write(source, STAFFED);
	const dir = join(w.env.XDG_DATA_HOME, "maestro/packs/staffed");
	await mkdir(dir, { recursive: true });
	await packOf(source, dir, { id: "staffed" });
	return { ...w, staffed: dir };
}

describe("repertoire", () => {
	test("lists each pack, a listed one with its config file, and each composition with its doc's first line", async () => {
		const w = await staffed();
		const listed = await w.call(["rep"]);
		expect(listed.code).toBe(0);
		const config = join(w.cwd, ".maestro/config.yaml");
		expect(listed.out.split("\n")).toEqual([
			`demo 1.0.0  ${w.pack}  listed in ${config}`,
			"  echo",
			"  greet   Greets someone, then echoes the greeting.",
			"  ticket",
			`staffed 1.0.0  ${w.staffed}`,
			"  draft  Drafts a page.",
		]);
		expect((await w.call(["repertoire", "staffed"])).out).toBe(
			`staffed 1.0.0  ${w.staffed}\n  draft  Drafts a page.`,
		);
	});

	test("with no pack installed, says where to put one", async () => {
		const w = await world();
		expect(await w.call(["rep"], { cwd: w.root })).toMatchObject({
			code: 0,
			out: "",
			err: `no packs are installed\nExtract one into ${join(w.env.XDG_DATA_HOME, "maestro/packs")}, or list its directory under packs in the config`,
		});
	});

	test("shows one composition: its doc, params as flags, config entries and a perform line", async () => {
		const w = await staffed();
		expect(
			await w.call(["rep", "staffed.draft"], { hosts: [needy] }),
		).toMatchObject({
			code: 0,
			err: "",
			out: [
				"staffed.draft  Drafts a page.",
				"Then leaves it for review.",
				"Params",
				"  --topic <text>  required  What the page is about",
				"  --tags <text>   a",
				"  --note <text>   optional",
				"Config  seats.write, target.checks.test",
				"",
				"  maestro perform staffed.draft --topic <text>",
			].join("\n"),
		});
	});

	test("--json prints the same entries as one document", async () => {
		const w = await staffed();
		expect(
			json(
				await w.call(["rep", "staffed.draft", "--json"], { hosts: [needy] }),
			),
		).toEqual({
			packs: [
				{
					id: "staffed",
					version: "1.0.0",
					path: w.staffed,
					compositions: [
						{
							id: "staffed.draft",
							name: "draft",
							doc: "Drafts a page.\nThen leaves it for review.",
							params: [
								{
									name: "topic",
									flag: "--topic",
									type: "text",
									required: true,
									description: "What the page is about",
								},
								{
									name: "tags",
									flag: "--tags",
									type: "text",
									required: false,
									default: "a",
								},
								{
									name: "note",
									flag: "--note",
									type: "text",
									required: false,
								},
							],
							config: ["seats.write", "target.checks.test"],
							perform: "maestro perform staffed.draft --topic <text>",
						},
					],
				},
			],
		});
		const all = json(await w.call(["rep", "--json"]));
		expect(all.packs.map((p: { id: string }) => p.id)).toEqual([
			"demo",
			"staffed",
		]);
	});

	test("a broken pack: rep names it with its fix on stderr, lists the rest and exits 1; compose fails on it", async () => {
		const w = await world();
		const broken = join(w.env.XDG_DATA_HOME, "maestro/packs/broken");
		await mkdir(broken, { recursive: true });
		const listed = await w.call(["rep"]);
		expect(listed.code).toBe(1);
		expect(listed.err).toBe(
			`cannot read ${join(broken, "maestro-pack.json")}: ENOENT: no such file or directory, open '${join(broken, "maestro-pack.json")}'\nGive the pack a JSON manifest, or remove ${broken}`,
		);
		expect(listed.out).toStartWith("demo 1.0.0");
		expect(await w.call(["rep", "broken"])).toMatchObject({
			code: 1,
			out: "",
			err: listed.err,
		});
		const composed = await w.call(["compose", "demo.greet", "--name", "x"]);
		expect(composed.code).toBe(1);
		expect(composed.err).toContain(broken);
	});

	test("a broken pack the config lists is to be removed from the file that lists it", async () => {
		const w = await world();
		const config = join(w.cwd, ".maestro/config.yaml");
		const broken = join(w.root, "broken");
		await mkdir(broken);
		await Bun.write(config, `packs:\n  - ${w.pack}\n  - ${broken}\n`);
		expect((await w.call(["rep"])).err).toEndWith(
			`\nGive the pack a JSON manifest, or remove '${broken}' from packs in ${config}`,
		);
	});

	test("a listed pack wins over an installed copy of its id, and two installed copies are refused", async () => {
		const w = await world();
		const copy = join(w.env.XDG_DATA_HOME, "maestro/packs/copy");
		await mkdir(copy, { recursive: true });
		await packOf(join(DEMO, "index.ts"), copy);
		expect((await w.call(["rep"])).code).toBe(0);
		const other = join(w.env.XDG_DATA_HOME, "maestro/packs/other");
		await mkdir(other, { recursive: true });
		await packOf(join(DEMO, "index.ts"), other);
		await Bun.write(join(w.cwd, ".maestro/config.yaml"), "packs: []\n");
		const twice = await w.call(["rep"]);
		expect(twice.code).toBe(1);
		expect(twice.err).toStartWith(
			`pack id 'demo' is taken twice, by ${copy} and by ${other}\n`,
		);
	});
});
