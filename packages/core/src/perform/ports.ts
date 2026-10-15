import {
	artifactRefSchema,
	type JsonSchema,
	MAESTRO_TYPE,
	type Ports,
	registerMaestroType,
} from "@maestro/ir";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { ARTIFACT_TYPES } from "./artifacts";
import { isRecord, messageOf } from "./ts-worker";

/** Checks values by port name against `ports`. Returns the first mismatch as a sentence, or `undefined`. */
export type PortCheck = (
	ports: Ports | undefined,
	values: Readonly<Record<string, unknown>>,
	side: "input" | "output",
) => string | undefined;

/** A `PortCheck` with its own compiled schemas. An artifact is checked as its `ArtifactRef`, not its content (ADR 0007). */
export function portCheck(): PortCheck {
	// `format` stays an annotation, as JSON Schema 2020-12 has it by default.
	const ajv = registerMaestroType(
		new Ajv2020({
			strictTypes: false,
			strictTuples: false,
			validateFormats: false,
		}),
	);
	const compiled = new Map<JsonSchema, ValidateFunction>();
	const validator = (schema: JsonSchema) => {
		const known = compiled.get(schema);
		if (known) return known;
		const validate = ajv.compile(asReferences(schema));
		compiled.set(schema, validate);
		return validate;
	};
	return (ports, values, side) => {
		for (const [port, schema] of Object.entries(ports ?? {})) {
			const where = `${side} '${port}'`;
			const mismatch = checkValue(validator, schema, values[port], where);
			if (mismatch) return mismatch;
		}
	};
}

function checkValue(
	validator: (schema: JsonSchema) => ValidateFunction,
	schema: JsonSchema,
	value: unknown,
	where: string,
): string | undefined {
	if (value === undefined) return `${where} has no value`;
	let validate: ValidateFunction;
	try {
		validate = validator(schema);
	} catch (error) {
		return `${where} has a schema that does not compile: ${messageOf(error)}`;
	}
	if (validate(value)) return undefined;
	const error = validate.errors?.[0];
	const at = error?.instancePath ? ` at ${error.instancePath}` : "";
	return `${where}${at} ${error?.message ?? "does not match its schema"}`;
}

/** `schema` with each artifact subschema replaced by `artifactRefSchema`, the shape of an artifact's runtime value. */
function asReferences(schema: JsonSchema): JsonSchema {
	if (typeof schema === "boolean") return schema;
	const type = schema[MAESTRO_TYPE];
	if (typeof type === "string" && ARTIFACT_TYPES.has(type))
		return artifactRefSchema;
	return Object.fromEntries(
		Object.entries(schema).map(([key, sub]) => [key, referencesIn(sub)]),
	);
}

const referencesIn = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(referencesIn);
	return isRecord(value) ? asReferences(value) : value;
};
