import {
	artifactsAsRefs,
	type JsonSchema,
	type Ports,
	registerMaestroType,
} from "@maestro/ir";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { messageOf } from "./shared";

export type Validator = Ajv2020;

/** A fresh schema validator. `format` is an annotation only: neither compose nor perform validates it. */
export const validator = (): Validator =>
	registerMaestroType(
		new Ajv2020({
			allErrors: true,
			strictTypes: false,
			strictTuples: false,
			validateFormats: false,
		}),
	);

const unescapePointer = (s: string) =>
	s.replaceAll("~1", "/").replaceAll("~0", "~");

/** One message per way `data` violates `schema`, each led by `subject` of the offending position's path segments. */
export function violations(
	ajv: Validator,
	schema: JsonSchema,
	data: unknown,
	subject: (segments: string[]) => string,
): string[] {
	let validate: ValidateFunction;
	try {
		validate = ajv.compile(schema);
	} catch (error) {
		return [
			`${subject([])} has a schema that does not compile: ${messageOf(error)}`,
		];
	}
	if (validate(data)) return [];
	return (validate.errors ?? []).map((e) => {
		const segments = e.instancePath.split("/").slice(1).map(unescapePointer);
		const extra = e.params.additionalProperty;
		const detail = typeof extra === "string" ? ` ('${extra}')` : "";
		return `${subject(segments)} ${e.message}${detail}`;
	});
}

/** Checks values by port name against `ports`. Returns the first mismatch as a sentence, or `undefined`. */
export type PortCheck = (
	ports: Ports | undefined,
	values: Readonly<Record<string, unknown>>,
	side: "input" | "output",
) => string | undefined;

/**
 * A `PortCheck` over `ajv` that checks a copy of each value, so no default is written into it. An artifact is checked
 * as its `ArtifactRef`, not its content (ADR 0007).
 */
export function portCheck(ajv: Validator): PortCheck {
	const compiled = new Map<JsonSchema, ValidateFunction>();
	const compile = (schema: JsonSchema) => {
		const known = compiled.get(schema);
		if (known) return known;
		const validate = ajv.compile(artifactsAsRefs(schema));
		compiled.set(schema, validate);
		return validate;
	};
	return (ports, values, side) => {
		for (const [port, schema] of Object.entries(ports ?? {})) {
			const where = `${side} '${port}'`;
			const mismatch = checkValue(compile, schema, values[port], where);
			if (mismatch) return mismatch;
		}
	};
}

function checkValue(
	compile: (schema: JsonSchema) => ValidateFunction,
	schema: JsonSchema,
	value: unknown,
	where: string,
): string | undefined {
	if (value === undefined) return `${where} has no value`;
	let validate: ValidateFunction;
	try {
		validate = compile(schema);
	} catch (error) {
		return `${where} has a schema that does not compile: ${messageOf(error)}`;
	}
	if (validate(structuredClone(value))) return undefined;
	const error = validate.errors?.[0];
	const at = error?.instancePath ? ` at ${error.instancePath}` : "";
	return `${where}${at} ${error?.message ?? "does not match its schema"}`;
}
