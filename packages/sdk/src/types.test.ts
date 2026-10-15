import { describe, expect, test } from "bun:test";
import { CORE_TYPES, MAESTRO_TYPE, settledSchema } from "@maestro/ir";
import {
	Bool,
	Dir,
	Enum,
	File,
	Float,
	Int,
	Json,
	JsonFile,
	List,
	Markdown,
	Record,
	Settled,
	Text,
} from "./index";

describe("type vocabulary", () => {
	test.each([
		["Text", Text(), { type: "string" }],
		["Bool", Bool(), { type: "boolean" }],
		["Int", Int(), { type: "integer" }],
		["Float", Float(), { type: "number" }],
		["Json", Json({ type: "object" }), { type: "object" }],
		["List", List(Int()), { type: "array", items: { type: "integer" } }],
		["Enum", Enum(["a", "b"]), { type: "string", enum: ["a", "b"] }],
		[
			"Record",
			Record({ n: Int(), s: Text() }),
			{
				type: "object",
				properties: { n: { type: "integer" }, s: { type: "string" } },
				required: ["n", "s"],
				additionalProperties: false,
			},
		],
		["Settled", Settled(Text()), settledSchema({ type: "string" })],
	])("%s serializes to JSON Schema", (_name, type, schema) => {
		expect(type.schema).toEqual(schema);
	});

	test.each([
		["File", File(), CORE_TYPES.file, {}],
		["Dir", Dir(), CORE_TYPES.dir, {}],
		["Markdown", Markdown(), CORE_TYPES.markdown, {}],
		[
			"JsonFile",
			JsonFile({ type: "array" }),
			CORE_TYPES.jsonFile,
			{ type: "array" },
		],
	])("%s is marked with its core type", (_name, type, marker, content) => {
		expect(type.schema).toEqual({ ...content, [MAESTRO_TYPE]: marker });
	});

	test("hints become standard annotations", () => {
		expect(Int({ default: 2, description: "tries" }).schema).toEqual({
			type: "integer",
			default: 2,
			description: "tries",
		});
	});
});
