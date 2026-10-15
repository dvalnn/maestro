import {
	type Cardinality,
	type GroupNode,
	type IrNode,
	type JsonSchema,
	OUTCOMES,
	type Ports,
	registerMaestroType,
	type Settled,
} from "@maestro/ir";
import Ajv2020 from "ajv/dist/2020";
import type { Outputs } from "../worker";

export const isGroup = (n: IrNode | undefined): n is GroupNode =>
	n?.kind === "map" || n?.kind === "seq" || n?.kind === "repeat";

export const boundOf = (c: Cardinality) => ("exact" in c ? c.exact : c.upTo);

export const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** The outputs every node has beside its declared ones. */
export const IMPLICIT: Ports = {
	outcome: { type: "string", enum: [...OUTCOMES] },
	ok: { type: "boolean" },
	reason: { type: "string" },
};

/** A port value compose knows. */
export type Known = { value: unknown };

/** The value of output `port` of a settled node instance, implicit outputs included, when it holds one. */
export function outputValue(
	settled: Settled<Outputs>,
	port: string,
): Known | undefined {
	const implicit: Record<string, unknown> = {
		outcome: settled.outcome,
		ok: settled.outcome === "ok",
		reason: "reason" in settled ? settled.reason : undefined,
	};
	const values = Object.hasOwn(IMPLICIT, port) ? implicit : settled.value;
	const value = values?.[port];
	return value === undefined ? undefined : { value };
}

export type Validator = Ajv2020;

/**
 * A fresh schema validator that writes defaults into what it checks. `format` is an annotation only: neither compose
 * nor perform validates it.
 */
export const validator = (): Validator =>
	registerMaestroType(
		new Ajv2020({
			allErrors: true,
			strictTypes: false,
			validateFormats: false,
			useDefaults: true,
		}),
	);

const unescapePointer = (s: string) =>
	s.replaceAll("~1", "/").replaceAll("~0", "~");

/**
 * One message per way `data` violates `schema`, each led by `subject` of the offending position's path segments.
 * Defaults are written into `data`.
 */
export function violations(
	ajv: Validator,
	schema: JsonSchema,
	data: unknown,
	subject: (segments: string[]) => string,
): string[] {
	let validate: ReturnType<Validator["compile"]>;
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
