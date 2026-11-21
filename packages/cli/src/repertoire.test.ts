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
async function staffed(text = STAFFED) {
	const w = await world();
	const source = join(await scratch(), "staffed.ts");
	await Bun.write(source, text);
	const dir = join(w.env.XDG_DATA_HOME, "maestro/packs/staffed");
	await mkdir(dir, { recursive: true });
	await packOf(source, dir, { id: "staffed" });
	return { ...w, staffed: dir };
}

describe("repertoire", () => {
	// Seam: repertoire's terminal, piped and JSON output for pack and composition selections.
	test("repertoire cuts listing descriptions on a terminal and leaves them whole in a pipe and JSON", async () => {
		const doc =
			"A detailed description of this composition explains its purpose and the steps it takes for every reader without losing the ending.";
		const w = await staffed(
			STAFFED.replace("Drafts a page.\\nThen leaves it for review.", doc),
		);
		const terminal = () => ({ columns: 80, rows: 24 });
		const env = { HOME: w.root, NO_COLOR: "1" };
		for (const args of [["repertoire"], ["repertoire", "staffed"]]) {
			const on = await w.call(args, { terminal, env });
			expect(on.code).toBe(0);
			const row =
				on.out.split("\n").find((line) => line.includes("draft")) ?? "";
			expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
			expect(row).toContain("draft");
			expect(row).toContain("…");
			expect((await w.call(args, { env })).out).toContain(doc);
			const data = json(await w.call([...args, "--json"], { terminal, env }));
			expect(
				data.packs.find((p: { id: string }) => p.id === "staffed")
					.compositions[0].doc,
			).toBe(doc);
		}
	});

	test("repertoire wraps a composition doc and its params under their columns on a terminal and leaves them whole in a pipe and JSON", async () => {
		const doc =
			"A detailed description of this composition explains its purpose and the steps it takes for every reader without losing the ending.";
		const second =
			"Then a second line long enough to wrap again on an eighty column terminal for sure.";
		const topic =
			"What the page is about, said at length so that it wraps under its column on a narrow terminal";
		const w = await staffed(
			STAFFED.replace(
				"Drafts a page.\\nThen leaves it for review.",
				`${doc}\\n${second}`,
			).replace("What the page is about", topic),
		);
		const terminal = () => ({ columns: 80, rows: 24 });
		const env = { HOME: w.root, NO_COLOR: "1" };
		const args = ["repertoire", "staffed.draft"];
		const on = await w.call(args, { terminal, env });
		expect(on.code).toBe(0);
		const lines = on.out.split("\n");
		expect(lines.every((line) => Bun.stringWidth(line) <= 80)).toBe(true);
		// Every doc line after the first sits under the doc's column, past the id and its gap.
		const docLines = lines.slice(0, lines.indexOf("Params"));
		const under = " ".repeat("staffed.draft  ".length);
		expect(docLines.slice(1).every((line) => line.startsWith(under))).toBe(
			true,
		);
		expect(docLines.join(" ").replace(/\s+/g, " ")).toContain(
			`${doc} ${second}`,
		);
		expect(lines.join(" ").replace(/\s+/g, " ")).toContain(topic);
		const piped = (await w.call(args, { env })).out;
		expect(piped).toContain(doc);
		expect(piped).toContain(topic);
		expect(
			json(await w.call([...args, "--json"], { terminal, env })).packs[0]
				.compositions[0].doc,
		).toBe(`${doc}\n${second}`);
	});

	test("repertoire wraps a composition doc with an overlong word and cuts a pack header to the terminal", async () => {
		const word = "x".repeat(90);
		const w = await staffed(
			STAFFED.replace("Drafts a page.\\nThen leaves it for review.", word),
		);
		const terminal = () => ({ columns: 80, rows: 24 });
		const env = { HOME: w.root, NO_COLOR: "1" };
		const doc = await w.call(["repertoire", "staffed.draft"], {
			terminal,
			env,
		});
		const lines = doc.out.split("\n");
		expect(lines.every((line) => Bun.stringWidth(line) <= 80)).toBe(true);
		expect(lines.join("").replaceAll(" ", "")).toContain(word);
		const list = await w.call(["repertoire", "staffed"], { terminal, env });
		const [head = "", ...rows] = list.out.split("\n");
		expect(head.startsWith("staffed")).toBe(true);
		expect(rows.join("\n")).toContain("maestro repertoire staffed --json");
		const narrow = () => ({ columns: 20, rows: 24 });
		const cut = await w.call(["repertoire", "staffed"], {
			terminal: narrow,
			env,
		});
		expect(Bun.stringWidth(cut.out.split("\n")[0] ?? "")).toBeLessThanOrEqual(
			20,
		);
	});

	test("repertoire keeps blank doc lines and survives a wide character in a narrow row on a terminal", async () => {
		const w = await staffed(
			STAFFED.replace(
				"Drafts a page.\\nThen leaves it for review.",
				"hello\\n\\n漢字",
			),
		);
		const env = { HOME: w.root, NO_COLOR: "1" };
		const at = (columns: number) =>
			w.call(["repertoire", "staffed.draft"], {
				terminal: () => ({ columns, rows: 24 }),
				env,
			});
		const doc = (await at(80)).out.split("\n");
		expect(doc.slice(0, 3).map((line) => line.trim())).toEqual([
			expect.stringContaining("hello"),
			"",
			"漢字",
		]);
		expect((await at(2)).code).toBe(0);
	});

	test("repertoire cuts a pack header after its id, which stays whole, and points to the full listing", async () => {
		const w = await staffed();
		const env = { HOME: "/nonexistent", NO_COLOR: "1" };
		const on = await w.call(["repertoire", "staffed"], {
			terminal: () => ({ columns: 50, rows: 24 }),
			env,
		});
		const [head = "", ...rest] = on.out.split("\n");
		expect(head.startsWith("staffed ")).toBe(true);
		expect(head.endsWith("…")).toBe(true);
		expect(Bun.stringWidth(head)).toBeLessThanOrEqual(50);
		expect(rest.join("\n")).toContain("maestro repertoire staffed --json");
		const piped = await w.call(["repertoire", "staffed"], { env });
		expect(piped.out).toContain(w.root);
		expect(piped.out).not.toContain("--json");
		// The listed demo pack, at each width from the narrowest that fits its id, version and two lone `…`.
		const listed = { HOME: w.root, NO_COLOR: "1" };
		const whole = (await w.call(["repertoire", "demo"], { env: listed })).out;
		expect(whole).toContain("listed in");
		const lead = Bun.stringWidth(whole.split("  ", 1)[0] ?? "");
		for (let columns = lead + 6; columns <= 40; columns++) {
			const at = await w.call(["repertoire", "demo"], {
				terminal: () => ({ columns, rows: 24 }),
				env: listed,
			});
			const header = at.out.split("\n")[0] ?? "";
			expect(Bun.stringWidth(header)).toBeLessThanOrEqual(columns);
		}
	});

	// Seam: repertoire's terminal and piped stdout for packs.
	test("pack listings distinguish ids, versions, home paths and composition names on a terminal", async () => {
		const w = await staffed();
		const terminal = () => ({ columns: 200, rows: 24 });
		const env = { HOME: w.root, TERM: "xterm" };
		for (const args of [["repertoire"], ["repertoire", "staffed"]]) {
			const on = await w.call([...args, "--color"], { terminal, env });
			expect(on.code).toBe(0);
			expect(on.out).toContain("\u001b[1mstaffed\u001b[22m");
			expect(on.out).toContain(
				"\u001b[2m1.0.0\u001b[22m  \u001b[2m~/data/maestro/packs/staffed\u001b[22m",
			);
			expect(on.out).toContain("\u001b[36mdraft\u001b[39m");
			const piped = await w.call(args, { env });
			expect(piped.out).toContain(
				`staffed 1.0.0  ${w.staffed}\n  draft  Drafts a page.`,
			);
			expect(piped.out).not.toContain("\u001b[");
		}
	});

	test("a composition's name, Params heading and flags are colored on a terminal", async () => {
		const w = await staffed();
		const args = ["repertoire", "staffed.draft"];
		const terminal = () => ({ columns: 200, rows: 24 });
		const on = await w.call([...args, "--color"], { terminal, hosts: [needy] });
		expect(on.code).toBe(0);
		expect(on.out).toContain("\u001b[1mstaffed.draft\u001b[22m");
		expect(on.out).toContain("\u001b[1mParams\u001b[22m");
		expect(on.out).toContain("\u001b[36m--topic <text>\u001b[39m");
	});

	test("a listed pack's config file is under ~ on a terminal", async () => {
		const w = await staffed();
		const terminal = () => ({ columns: 200, rows: 24 });
		const env = { HOME: w.root, TERM: "xterm" };
		const on = await w.call(["repertoire", "--no-color"], { terminal, env });
		expect(on.out).toContain("listed in ~/ws/.maestro/config.yaml");
	});

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
