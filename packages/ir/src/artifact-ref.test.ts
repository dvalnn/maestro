import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { type ArtifactRef, artifactRefSchema } from "./index";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type RequiredKeys<T> = {
	[K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];
type Producer = NonNullable<ArtifactRef["producer"]>;
type Schema = typeof artifactRefSchema;
type ProducerSchema = Schema["properties"]["producer"];
type TypeOf<S> = S extends { type: "string" } ? string : never;

// Fails to compile when the type and the schema disagree on a field's name, value type or whether it is required.
const typeMatchesSchema: [
	Same<keyof ArtifactRef, keyof Schema["properties"]>,
	Same<RequiredKeys<ArtifactRef>, Schema["required"][number]>,
	Same<keyof Producer, keyof ProducerSchema["properties"]>,
	Same<RequiredKeys<Producer>, ProducerSchema["required"][number]>,
	Same<ArtifactRef["path"], TypeOf<Schema["properties"]["path"]>>,
	Same<ArtifactRef["contentHash"], TypeOf<Schema["properties"]["contentHash"]>>,
	Same<Producer["node"], TypeOf<ProducerSchema["properties"]["node"]>>,
	Same<
		Producer["expansion"],
		TypeOf<ProducerSchema["properties"]["expansion"]>
	>,
] = [true, true, true, true, true, true, true, true];

test("ArtifactRef and its schema agree on fields", () => {
	expect(typeMatchesSchema.every((agrees) => agrees)).toBe(true);
});

const validate = new Ajv2020({ strict: true }).compile(artifactRefSchema);
const hash = `sha256:${"0123456789abcdef".repeat(4)}`;
const producer = { node: "g/n", expansion: "[risk][2]" };

test.each<[string, ArtifactRef]>([
	[
		"a file with a producer",
		{ path: "out/report.md", contentHash: hash, producer },
	],
	["a file without a producer", { path: "params/brief.md", contentHash: hash }],
	[
		"a producer outside groups",
		{ path: "a", contentHash: hash, producer: { node: "n", expansion: "" } },
	],
	["a directory path", { path: "out/reports", contentHash: hash, producer }],
	[
		"dot names that are not . or ..",
		{ path: ".config/...", contentHash: hash },
	],
	["segments that start with dots", { path: ".a/..b/a..", contentHash: hash }],
])("artifactRefSchema accepts %s", (_, ref) => {
	expect(validate(ref)).toBe(true);
});

test.each<[string, unknown]>([
	["an absolute path", { path: "/out/report.md", contentHash: hash }],
	["a .. segment", { path: "out/../report.md", contentHash: hash }],
	["a leading .. segment", { path: "../report.md", contentHash: hash }],
	["a . segment", { path: "./report.md", contentHash: hash }],
	["an empty segment", { path: "out//report.md", contentHash: hash }],
	["a trailing slash", { path: "out/", contentHash: hash }],
	["an empty path", { path: "", contentHash: hash }],
	["a backslash", { path: "out\\report.md", contentHash: hash }],
	["a NUL after ..", { path: "out/..\u0000", contentHash: hash }],
	["a newline", { path: "out\nreport.md", contentHash: hash }],
	[
		"a hash without the sha256: prefix",
		{ path: "a", contentHash: hash.slice(7) },
	],
	[
		"a hash of another algorithm",
		{ path: "a", contentHash: `sha512:${hash.slice(7)}` },
	],
	[
		"uppercase hex",
		{ path: "a", contentHash: hash.toUpperCase().replace("SHA", "sha") },
	],
	["63 hex digits", { path: "a", contentHash: hash.slice(0, -1) }],
	["65 hex digits", { path: "a", contentHash: `${hash}0` }],
	["a missing path", { contentHash: hash }],
	["a missing contentHash", { path: "a" }],
	[
		"a producer without expansion",
		{ path: "a", contentHash: hash, producer: { node: "n" } },
	],
	[
		"a producer with a bad node id",
		{ path: "a", contentHash: hash, producer: { ...producer, node: "a b" } },
	],
	[
		"a producer expansion without brackets",
		{ path: "a", contentHash: hash, producer: { ...producer, expansion: "x" } },
	],
	[
		"a producer expansion with an unsanitized key",
		{
			path: "a",
			contentHash: hash,
			producer: { ...producer, expansion: "[a/b]" },
		},
	],
	["an extra field", { path: "a", contentHash: hash, size: 1 }],
	[
		"an extra producer field",
		{ path: "a", contentHash: hash, producer: { ...producer, at: 1 } },
	],
])("artifactRefSchema rejects %s", (_, ref) => {
	expect(validate(ref)).toBe(false);
});
