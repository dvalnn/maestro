import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import minimal from "../fixtures/minimal.json";
import { IR_VERSION, type Ir, parseIr, shareSchemas } from "./index";

const fixturesDir = `${import.meta.dir}/../fixtures`;

// Seams: shareSchemas's shared form, and parseIr's loaded IR and refusals.
const loaded = (value: unknown): Ir => {
	const result = parseIr(value);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ir;
};

/** The minimal fixture with `out` as its node's outputs. */
const withOut = (out: Record<string, unknown>) =>
	loaded({ ...minimal, nodes: [{ ...minimal.nodes[0], out }] });

test.each(readdirSync(fixturesDir).filter((f) => f.endsWith(".json")))(
	"golden fixture %s shared loads back as itself at the current version, every group kind's ports included",
	async (file) => {
		const ir = loaded(await Bun.file(`${fixturesDir}/${file}`).json());
		const shared = shareSchemas(ir);
		const ports = [
			...shared.nodes.flatMap((n) => [
				n.in,
				n.out,
				"inner" in n ? n.inner : {},
			]),
			...shared.scopes.map((s) => s.ports),
		].flatMap((map) => Object.values(map ?? {}));
		expect(ports.length).toBeGreaterThan(0);
		expect(ports.filter((port) => typeof port !== "string")).toEqual([]);
		expect(loaded(shared)).toEqual({ ...ir, irVersion: IR_VERSION });
	},
);

test("boolean schemas share an entry and stay booleans", () => {
	const shared = shareSchemas(withOut({ a: true, b: true, c: false }));
	expect(shared.nodes[0]?.out?.a).toBe(shared.nodes[0]?.out?.b);
	const entries = Object.values(shared.schemas);
	expect(entries).toHaveLength(3);
	expect(entries).toEqual(expect.arrayContaining([true, false]));
});

test("schemas that differ in array order keep their own entries", () => {
	const shared = shareSchemas(
		withOut({
			a: { enum: ["x", "y"] },
			b: { enum: ["y", "x"] },
			c: { required: ["x"], type: "object" },
			d: { type: "object", required: ["x"] },
		}),
	);
	const out = shared.nodes[0]?.out ?? {};
	expect(out.a).not.toBe(out.b);
	expect(out.c).toBe(out.d);
	expect(Object.keys(shared.schemas)).toHaveLength(4);
});

test("the same IR shares to the same keys", () => {
	const ir = withOut({ a: { type: "number" }, b: true });
	expect(shareSchemas(ir)).toEqual(shareSchemas(structuredClone(ir)));
});

test("a key with no schemas table is refused with IR.ref at its port", () => {
	const result = parseIr({
		...minimal,
		irVersion: "1.3",
		nodes: [{ ...minimal.nodes[0], out: { text: "text" } }],
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.diagnostics).toMatchObject([
		{ code: "IR.ref", path: "/nodes/0/out/text", node: "greet" },
	]);
});

test("every unknown key in one document is refused", () => {
	const result = parseIr({
		...minimal,
		irVersion: "1.3",
		schemas: { text: { type: "string" } },
		nodes: [{ ...minimal.nodes[0], in: { name: "one" }, out: { text: "two" } }],
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.diagnostics.map((d) => d.path)).toEqual([
		"/nodes/0/in/name",
		"/nodes/0/out/text",
	]);
});

test("a port that is neither a schema nor a key is refused by shape", () => {
	const result = parseIr({
		...minimal,
		irVersion: "1.3",
		nodes: [{ ...minimal.nodes[0], out: { text: 3 } }],
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.diagnostics[0]).toMatchObject({
		code: "IR.schema",
		path: "/nodes/0/out/text",
	});
});

test("an IR of an older version shares as the current version", () => {
	const older = { ...withOut({ text: { type: "string" } }), irVersion: "1.2" };
	expect(shareSchemas(older).irVersion).toBe(IR_VERSION);
});

test("a key that names an inherited property, not a table entry, is refused", () => {
	const result = parseIr({
		...minimal,
		irVersion: "1.3",
		schemas: {},
		nodes: [{ ...minimal.nodes[0], out: { text: "toString" } }],
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.diagnostics).toMatchObject([
		{ code: "IR.ref", path: "/nodes/0/out/text" },
	]);
});
