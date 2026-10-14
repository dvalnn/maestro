import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import {
	CORE_TYPES,
	findMarked,
	type JsonSchema,
	MAESTRO_TYPE,
	type Marked,
	registerMaestroType,
	unreachableMarkers,
} from "./index";

const strictAjv = () => registerMaestroType(new Ajv2020({ strict: true }));

test.each(["fake.handle", ...Object.values(CORE_TYPES)])(
	"a strict Ajv with the keyword compiles a schema marked %p",
	(name) => {
		const validate = strictAjv().compile({
			type: "object",
			properties: { h: { [MAESTRO_TYPE]: name, type: "string" } },
		});
		expect(validate({ h: "x" })).toBe(true);
	},
);

test.each(["handle", "Fake.handle", "fake.", "fake.handle.extra"])(
	"a type name %p fails to compile",
	(name) => {
		expect(() => strictAjv().compile({ [MAESTRO_TYPE]: name })).toThrow(
			/x-maestro-type/,
		);
	},
);

const handle = { [MAESTRO_TYPE]: "fake.handle", type: "string" };

test.each<[string, JsonSchema, unknown, Marked[]]>([
	[
		"a marker at the top level",
		handle,
		"h0",
		[{ type: "fake.handle", schema: handle, pointer: "", value: "h0" }],
	],
	[
		"a marker under properties",
		{ type: "object", properties: { a: handle, b: { type: "string" } } },
		{ a: "h0", b: "x" },
		[{ type: "fake.handle", schema: handle, pointer: "/a", value: "h0" }],
	],
	[
		"a marker under items",
		{ type: "array", items: handle },
		["h0", "h1"],
		[
			{ type: "fake.handle", schema: handle, pointer: "/0", value: "h0" },
			{ type: "fake.handle", schema: handle, pointer: "/1", value: "h1" },
		],
	],
	[
		"a marker under prefixItems, with items after the prefix",
		{ type: "array", prefixItems: [{ type: "string" }, handle], items: handle },
		["x", "h1", "h2"],
		[
			{ type: "fake.handle", schema: handle, pointer: "/1", value: "h1" },
			{ type: "fake.handle", schema: handle, pointer: "/2", value: "h2" },
		],
	],
	[
		"a marker under additionalProperties, skipping keys properties and patternProperties claim",
		{
			type: "object",
			properties: { a: { type: "string" } },
			patternProperties: { "^p": { type: "string" } },
			additionalProperties: handle,
		},
		{ a: "x", px: "y", z: "h0" },
		[{ type: "fake.handle", schema: handle, pointer: "/z", value: "h0" }],
	],
	[
		"a marker behind a local $ref",
		{
			type: "object",
			properties: { a: { $ref: "#/$defs/h" } },
			$defs: { h: handle },
		},
		{ a: "h0" },
		[{ type: "fake.handle", schema: handle, pointer: "/a", value: "h0" }],
	],
	[
		"a marker whose value is absent",
		{ type: "object", properties: { a: handle } },
		{},
		[],
	],
	["an undefined value", handle, undefined, []],
	[
		"a $ref to the root",
		{ type: "object", properties: { self: { $ref: "#" }, h: handle } },
		{ self: { h: "h1" }, h: "h0" },
		[
			{ type: "fake.handle", schema: handle, pointer: "/self/h", value: "h1" },
			{ type: "fake.handle", schema: handle, pointer: "/h", value: "h0" },
		],
	],
	[
		"a $ref with ~0 and ~1 escaped segments",
		{ $ref: "#/$defs/a~0b~1c", $defs: { "a~b/c": handle } },
		"h0",
		[{ type: "fake.handle", schema: handle, pointer: "", value: "h0" }],
	],
	[
		"pointer segments escaping ~ and /",
		{ type: "object", additionalProperties: handle },
		{ "a~b/c": "h0" },
		[{ type: "fake.handle", schema: handle, pointer: "/a~0b~1c", value: "h0" }],
	],
])("findMarked: %s", (_, schema, value, expected) => {
	expect(findMarked(schema, value)).toEqual(expected);
});

test("findMarked does not descend into a marked subschema's content schema", () => {
	const file = {
		[MAESTRO_TYPE]: CORE_TYPES.jsonFile,
		type: "object",
		properties: { a: handle },
	};
	// A reference that the content schema would match, so a descent would surface "/0/a".
	const ref = { a: "r0" };
	expect(findMarked({ type: "array", items: file }, [ref])).toEqual([
		{ type: CORE_TYPES.jsonFile, schema: file, pointer: "/0", value: ref },
	]);
});

test.each(["#/$defs/missing", "#/$defs/%ZZ", "#h", "other.json#/$defs/h"])(
	"findMarked does not follow the $ref %p",
	(ref) => {
		const schema = { $ref: ref, $defs: { h: { ...handle, $anchor: "h" } } };
		expect(findMarked(schema, "h0")).toEqual([]);
	},
);

test("registering the keyword twice on one Ajv is a no-op", () => {
	const ajv = registerMaestroType(strictAjv());
	expect(ajv.compile(handle)("h0")).toBe(true);
});

const UNWALKED_KEYWORDS: [string, JsonSchema, string][] = [
	...["allOf", "anyOf", "oneOf"].map((k): [string, JsonSchema, string] => [
		k,
		{ [k]: [handle] },
		`/${k}/0`,
	]),
	...["patternProperties", "dependentSchemas"].map(
		(k): [string, JsonSchema, string] => [
			k,
			{ [k]: { "a/b": handle } },
			`/${k}/a~1b`,
		],
	),
	...[
		"not",
		"if",
		"then",
		"else",
		"contains",
		"propertyNames",
		"unevaluatedItems",
		"unevaluatedProperties",
	].map((k): [string, JsonSchema, string] => [k, { [k]: handle }, `/${k}`]),
];

test.each(UNWALKED_KEYWORDS)(
	"unreachableMarkers finds a marker under %s",
	(_, schema, pointer) => {
		expect(unreachableMarkers(schema)).toEqual([pointer]);
	},
);

test.each<[string, JsonSchema, string[]]>([
	[
		"none when every marker is walked",
		{
			type: "object",
			properties: {
				a: handle,
				b: { type: "array", prefixItems: [handle], items: handle },
				c: { additionalProperties: handle },
				d: { $ref: "#/$defs/h" },
			},
			$defs: { h: handle },
		},
		[],
	],
	[
		"a marker inside a marked subschema",
		{ [MAESTRO_TYPE]: CORE_TYPES.jsonFile, properties: { a: handle } },
		["/properties/a"],
	],
	[
		"a $defs marker a followed $ref reaches from a combinator",
		{ anyOf: [{ $ref: "#/$defs/h" }], $defs: { h: handle } },
		["/$defs/h"],
	],
	[
		"a $defs marker behind an anchor $ref",
		{
			properties: { a: { $ref: "#h" } },
			$defs: { h: { ...handle, $anchor: "h" } },
		},
		["/$defs/h"],
	],
	["nothing for an unreferenced $defs marker", { $defs: { h: handle } }, []],
	[
		"a marker under a combinator in a recursive schema",
		{ properties: { next: { $ref: "#" }, any: { anyOf: [handle] } } },
		["/properties/any/anyOf/0"],
	],
])("unreachableMarkers: %s", (_, schema, pointers) => {
	expect(unreachableMarkers(schema)).toEqual(pointers);
});
