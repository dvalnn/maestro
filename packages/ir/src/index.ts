import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import irSchema from "../ir.schema.json";
import { checkGraph, irError } from "./graph";
import type { Diagnostic, Ir } from "./types";

export { type ArtifactRef, artifactRefSchema } from "./artifact-ref";
export { canonicalJson, isPlainObject } from "./canonical-json";
export {
	type CodeContext,
	type Context,
	type Facts,
	type Rejection,
	reject,
	TS_RUNTIME,
} from "./code-function";
export { DURATION_EXAMPLE, durationMs, MS_PER_UNIT } from "./duration";
export type {
	ConcertEvent,
	Enrichment,
	EventBody,
	HostEvent,
	NodeInstance,
} from "./events";
export {
	firstDuplicate,
	formatExpansion,
	formatInstance,
	itemKey,
	parseExpansion,
} from "./expansion";
export {
	boundOf,
	collects,
	FOLD_STATE,
	type GraphIndex,
	IMPLICIT_OUT,
	indexGraph,
	isGroup,
	LOOP_STATE,
	mapWorkers,
	outputValue,
	tolerates,
	upstreamIn,
} from "./graph";
export {
	ARTIFACT_TYPES,
	artifactsAsRefs,
	CORE_TYPES,
	findMarked,
	MAESTRO_TYPE,
	type Marked,
	registerMaestroType,
	replaceAt,
	schemaMarkers,
	unreachableMarkers,
} from "./maestro-type";
export {
	OUTCOMES,
	type Outcome,
	type Settled,
	settledSchema,
	worstOutcome,
} from "./outcome";
export type { Expansion, Plan, PlanBounds } from "./plan";
export type * from "./types";
/** The published IR JSON Schema (draft 2020-12). Also at packages/ir/ir.schema.json. */
export { irSchema };

export type ParseResult =
	| { ok: true; ir: Ir }
	| { ok: false; diagnostics: Diagnostic[] };

// strictTypes off: the if/then sub-schemas apply only inside already-typed objects.
const validateShape = new Ajv2020({
	allErrors: true,
	strictTypes: false,
}).compile(irSchema);

/** The IR version this package emits and reads. See README.md for the compatibility policy. */
export const IR_VERSION = "1.0";
const [MAJOR, MINOR] = IR_VERSION.split(".").map(Number) as [number, number];

/** The longest code-node `timeout` in milliseconds: the largest delay a JavaScript timer holds. */
export const MAX_TIMEOUT = 2_147_483_647;

/** Checked before the shape, so IR of another major gets this error and not a pile of schema errors. */
function checkVersion(value: unknown): Diagnostic | undefined {
	const v = (value as { irVersion?: unknown } | null)?.irVersion;
	const match = typeof v === "string" ? /^(\d+)\.(\d+)$/.exec(v) : null;
	const fail = (message: string, hint: string): Diagnostic => ({
		code: "IR.version",
		severity: "error",
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
			`IR version ${v} is newer than this maestro reads (${IR_VERSION}). It was emitted by a newer SDK, for example one bundled in a pack`,
			`Upgrade maestro to a version that reads IR ${v}, or re-emit the IR with an SDK that targets IR ${IR_VERSION}`,
		);
	}
}

/** Validates an already JSON-parsed value as IR. Never throws on bad input. */
export function parseIr(value: unknown): ParseResult {
	const versionError = checkVersion(value);
	if (versionError) return { ok: false, diagnostics: [versionError] };
	if (!validateShape(value))
		return { ok: false, diagnostics: shapeDiagnostics(value) };
	const diagnostics = checkGraph(value as Ir);
	return diagnostics.length
		? { ok: false, diagnostics }
		: { ok: true, ir: value as Ir };
}

const quote = (v: unknown) => JSON.stringify(v);

/** Plain-words rewrites of Ajv messages, keyed by Ajv keyword. Other keywords keep Ajv's message. */
const SHAPE_MESSAGES: Record<string, (p: ErrorObject["params"]) => string> = {
	enum: (p) => `must be one of ${p.allowedValues.map(quote).join(", ")}`,
	const: (p) => `must be ${quote(p.allowedValue)}`,
	oneOf: () => "must match exactly one of the allowed shapes",
	anyOf: () => "must match at least one of the allowed shapes",
	additionalProperties: (p) =>
		`has unexpected property '${p.additionalProperty}'`,
	unevaluatedProperties: (p) =>
		`has unexpected property '${p.unevaluatedProperty}'`,
	required: (p) => `is missing required property '${p.missingProperty}'`,
	pattern: (p) => `must match the pattern '${p.pattern}'`,
	type: (p) => `must be of type ${[p.type].flat().join(" or ")}`,
};

type Hint = (p: ErrorObject["params"], path: string) => string;

const removeExtra: Hint = (p, path) =>
	`Remove '${p.additionalProperty ?? p.unevaluatedProperty}' from ${path}, or correct its spelling`;

/** The next step for an Ajv keyword. Other keywords get `schemaHint`. */
const SHAPE_HINTS: Record<string, Hint> = {
	enum: (p, path) =>
		`Set ${path} to one of ${p.allowedValues.map(quote).join(", ")}`,
	const: (p, path) => `Set ${path} to ${quote(p.allowedValue)}`,
	additionalProperties: removeExtra,
	unevaluatedProperties: removeExtra,
	required: (p, path) => `Add '${p.missingProperty}' to ${path}`,
	pattern: (p, path) => `Change ${path} to match '${p.pattern}'`,
	type: (p, path) => `Set ${path} to a ${[p.type].flat().join(" or ")}`,
};

const schemaHint = (path: string) =>
	`Change ${path} to match ir.schema.json, which packages/ir/README.md describes`;

function shapeDiagnostics(value: unknown): Diagnostic[] {
	// An "if" error only repeats its "then" branch's more precise error.
	const errors = (validateShape.errors ?? []).filter((e) => e.keyword !== "if");
	const isExtra = (e: (typeof errors)[number]) =>
		e.keyword === "unevaluatedProperties" ||
		e.keyword === "additionalProperties";
	// A failed branch drops the properties it evaluated, so an extra-property error is dropped when
	// another error sits on its own path. An unevaluatedProperties error is also dropped when any
	// error, an extra-property one included, sits beneath its path. The extra property shows on
	// the next parse.
	const paths = errors.map((e) => e.instancePath);
	const otherPaths = errors
		.filter((e) => !isExtra(e))
		.map((e) => e.instancePath);
	const isUntrusted = (e: (typeof errors)[number]) =>
		otherPaths.includes(e.instancePath) ||
		(e.keyword === "unevaluatedProperties" &&
			paths.some((p) => p.startsWith(`${e.instancePath}/`)));
	const messages = new Set<string>();
	const diagnostics: Diagnostic[] = [];
	for (const e of errors) {
		if (isExtra(e) && isUntrusted(e)) continue;
		const message =
			SHAPE_MESSAGES[e.keyword]?.(e.params) ??
			e.message ??
			"violates the IR schema";
		const path = e.instancePath || "/";
		if (messages.has(path + message)) continue;
		messages.add(path + message);
		const hint = SHAPE_HINTS[e.keyword]?.(e.params, path) ?? schemaHint(path);
		diagnostics.push(irError(value, "IR.schema", path, message, hint));
	}
	return diagnostics;
}
