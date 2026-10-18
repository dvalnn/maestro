import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { registerMaestroType } from "./maestro-type";
import type { JsonSchema } from "./types";

/** The message of a thrown value, an `Error` or not. */
export const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

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
