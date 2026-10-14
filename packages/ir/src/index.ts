import Ajv2020 from "ajv/dist/2020";
import irSchema from "../ir.schema.json";
import { checkGraph } from "./graph";
import type { Ir, IrDiagnostic } from "./types";

export type * from "./types";
/** The published IR JSON Schema (draft 2020-12). Also at packages/ir/ir.schema.json. */
export { irSchema };

export type ParseResult =
	| { ok: true; ir: Ir }
	| { ok: false; diagnostics: IrDiagnostic[] };

// strictTypes off: the if/then sub-schemas apply only inside already-typed objects.
const validateShape = new Ajv2020({
	allErrors: true,
	strictTypes: false,
}).compile(irSchema);

/** The IR version this package emits and reads. See README.md for the compatibility policy. */
export const IR_VERSION = "1.0";
const [MAJOR, MINOR] = IR_VERSION.split(".").map(Number) as [number, number];

/** Checked before the shape, so IR of another major gets this error and not a pile of schema errors. */
function checkVersion(value: unknown): IrDiagnostic | undefined {
	const v = (value as { irVersion?: unknown } | null)?.irVersion;
	const match = typeof v === "string" ? /^(\d+)\.(\d+)$/.exec(v) : null;
	const fail = (message: string, hint: string) => ({
		code: "IR.version",
		path: "/irVersion",
		message,
		hint,
	});
	if (!match) {
		return fail(
			`irVersion must be a "<major>.<minor>" string, got ${JSON.stringify(v)}`,
			`Declare "irVersion": "${IR_VERSION}" at the top level of the IR`,
		);
	}
	const major = Number(match[1]);
	if (major !== MAJOR) {
		return fail(
			`IR version ${v} has major version ${major}, and this reader supports major version ${MAJOR} only`,
			`Re-emit the IR with an emitter that targets IR ${MAJOR}.x, or use a maestro that reads IR ${major}.x`,
		);
	}
	if (Number(match[2]) > MINOR) {
		return fail(
			`IR version ${v} is newer than this maestro reads (${IR_VERSION}). It was emitted by a newer SDK, for example one bundled in a pack (D-30)`,
			`Upgrade maestro to a version that reads IR ${v}, or re-emit the IR with an SDK that targets IR ${IR_VERSION}`,
		);
	}
}

/** Validates an already JSON-parsed value as IR. Never throws on bad input. */
export function parseIr(value: unknown): ParseResult {
	const versionError = checkVersion(value);
	if (versionError) return { ok: false, diagnostics: [versionError] };
	if (!validateShape(value))
		return { ok: false, diagnostics: shapeDiagnostics() };
	const diagnostics = checkGraph(value as Ir);
	return diagnostics.length
		? { ok: false, diagnostics }
		: { ok: true, ir: value as Ir };
}

function shapeDiagnostics(): IrDiagnostic[] {
	// An "if" error only repeats its "then" branch's more precise error.
	const errors = (validateShape.errors ?? []).filter((e) => e.keyword !== "if");
	const isExtra = (e: (typeof errors)[number]) =>
		e.keyword === "unevaluatedProperties" ||
		e.keyword === "additionalProperties";
	// A failed branch drops the properties it evaluated, so extra-property errors are only
	// trustworthy on a path that has no other error.
	const pathsWithOtherErrors = new Set(
		errors.filter((e) => !isExtra(e)).map((e) => e.instancePath),
	);
	const messages = new Set<string>();
	const diagnostics: IrDiagnostic[] = [];
	for (const e of errors) {
		if (isExtra(e) && pathsWithOtherErrors.has(e.instancePath)) continue;
		const extra = e.params.unevaluatedProperty ?? e.params.additionalProperty;
		const message = isExtra(e)
			? `must NOT have property '${extra}'`
			: (e.message ?? "violates the IR schema");
		const path = e.instancePath || "/";
		if (messages.has(path + message)) continue;
		messages.add(path + message);
		diagnostics.push({ code: "IR.schema", path, message });
	}
	return diagnostics;
}
