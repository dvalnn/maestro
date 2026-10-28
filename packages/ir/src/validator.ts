import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { registerMaestroType } from "./maestro-type";
import type { JsonSchema } from "./types";

/** The message of a thrown value, an `Error` or not. */
export const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export type Validator = Ajv2020;

/**
 * The one schema validator of the process, as each instance compiles the draft 2020-12 meta-schema anew. It caches
 * each schema it compiles, and registers none by `$id`, so two schemas with one `$id` do not clash. `format` is an
 * annotation only: neither compose nor perform validates it.
 */
const shared = registerMaestroType(
	new Ajv2020({
		allErrors: true,
		strictTypes: false,
		strictTuples: false,
		validateFormats: false,
		addUsedSchema: false,
	}),
);

/** The process's schema validator. */
export const validator = (): Validator => shared;

const unescapePointer = (s: string) =>
	s.replaceAll("~1", "/").replaceAll("~0", "~");

/**
 * One message per way `data` violates `schema`, each led by `subject` of the offending position's path segments. A key
 * off its `propertyNames` is named by its own path, once.
 */
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
	return (validate.errors ?? [])
		.filter((e) => e.propertyName === undefined)
		.map((e) => {
			const segments = e.instancePath.split("/").slice(1).map(unescapePointer);
			const { additionalProperty: extra, propertyName: key } = e.params;
			if (typeof key === "string")
				return `${subject([...segments, key])} is not an allowed name`;
			const detail = typeof extra === "string" ? ` ('${extra}')` : "";
			return `${subject(segments)} ${e.message}${detail}`;
		});
}
