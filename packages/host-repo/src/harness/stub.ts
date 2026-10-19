import { bubblewrap, type SandboxBackend } from "../sandbox/index";
import {
	isObject,
	type JsonObject,
	type SubprocessAdapter,
	subprocessHarness,
} from "./subprocess";
import {
	type Harness,
	type HarnessEvent,
	type HarnessRequest,
	METRIC,
	OUTBOX,
} from "./types";

/** The text of every placeholder string and Markdown file. */
const PLACEHOLDER_TEXT = "stub";

/** Emitted objects are written as JSON lines on stdout, like a real harness's event stream. */
export type StubStep =
	| { emit: Record<string, unknown>; delayMs?: number }
	/** `write` is a lane-relative path, or absolute (`OUTBOX`, `SESSION_DIR`). */
	| { write: string; content: string }
	/** A shell line run in the sandbox, its output discarded. */
	| { sh: string }
	/** Never settles. */
	| { hang: true };

export const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function shell(s: StubStep): string[] {
	if ("hang" in s) return ["sleep 300"];
	if ("sh" in s) return [`(${s.sh}) >/dev/null 2>&1`];
	if ("emit" in s)
		return [
			`printf '%s\\n' ${shellQuote(JSON.stringify(s.emit))}`,
			...(s.delayMs ? [`sleep ${s.delayMs / 1000}`] : []),
		];
	const path = shellQuote(
		s.write.startsWith("/") ? s.write : `/lane/${s.write}`,
	);
	return [
		`mkdir -p "$(dirname ${path})"`,
		`printf '%s' ${shellQuote(s.content)} > ${path}`,
	];
}

function script(steps: StubStep[]) {
	return [
		// stdin to a file outside the lane (the lane is the changeset), then report what arrived
		"cat > /tmp/prompt",
		`printf '{"type":"prompt","bytes":%s,"sha256":"%s"}\\n' "$(wc -c < /tmp/prompt)" "$(sha256sum < /tmp/prompt | cut -d' ' -f1)"`,
		...steps.flatMap(shell),
		`printf '{"type":"settled"}\\n'`,
	].join("\n");
}

const parse = (e: JsonObject): HarnessEvent[] => [eventOf(e)];

function eventOf(e: JsonObject): HarnessEvent {
	switch (e.type) {
		case "text":
			return { kind: "text", text: String(e.text) };
		case "tool":
			return { kind: "tool", name: String(e.name), input: e.input };
		case "settled":
			return { kind: "settled" };
		case "fault":
			return { kind: "fault", reason: String(e.reason) };
		case "usage":
			return {
				kind: "usage",
				metrics: {
					[METRIC.tokensIn]: Number(e.tokens_in ?? 0),
					[METRIC.tokensOut]: Number(e.tokens_out ?? 0),
				},
			};
		default:
			return { kind: "raw", data: e };
	}
}

/**
 * Replays `steps`, or the steps it gives for a request, inside the real sandbox, then emits `{"type":"settled"}`. The
 * prompt is read from stdin and reported as a `prompt` event carrying its byte count and sha256.
 */
export function stubHarness(
	steps: StubStep[] | ((req: HarnessRequest) => StubStep[]),
	backend?: SandboxBackend,
): Harness {
	const adapter: SubprocessAdapter = {
		name: "stub",
		spec: (req) => ({
			argv: [
				"sh",
				"-c",
				script(typeof steps === "function" ? steps(req) : steps),
			],
			stdin: req.prompt,
		}),
		parser: () => parse,
	};
	return subprocessHarness(adapter, backend ?? bubblewrap);
}

const minimum = (bound: unknown) => (typeof bound === "number" ? bound : 0);

function ofType(type: unknown, schema: JsonObject): unknown {
	switch (type) {
		case "object": {
			const properties = isObject(schema.properties) ? schema.properties : {};
			const required = Array.isArray(schema.required) ? schema.required : [];
			return Object.fromEntries(
				required.map((name) => [name, placeholder(properties[name])]),
			);
		}
		case "array":
			return Array.from({ length: minimum(schema.minItems) }, () =>
				placeholder(schema.items),
			);
		case "string":
			return PLACEHOLDER_TEXT.padEnd(minimum(schema.minLength), "_");
		case "integer":
		case "number":
			return minimum(schema.minimum);
		case "boolean":
			return false;
		case "null":
			return null;
		default:
			return PLACEHOLDER_TEXT;
	}
}

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A branch laid over the keywords beside its combinator, their `required` joined and their `properties` merged. */
function merged(rest: JsonObject, branch: unknown): JsonObject {
	const b = isObject(branch) ? branch : {};
	return {
		...rest,
		...b,
		required: [...listOf(rest.required), ...listOf(b.required)],
		properties: {
			...(isObject(rest.properties) ? rest.properties : {}),
			...(isObject(b.properties) ? b.properties : {}),
		},
	};
}

/**
 * The smallest value that satisfies the keywords of `schema` it reads, not every schema:
 * - `const`, else the first `enum` member, else the first `anyOf` or `oneOf` branch merged with its sibling keywords;
 * - an object with its `required` properties filled;
 * - an array with `minItems` items;
 * - a string of `minLength`, `"stub"` at least, and a number of `minimum`, else 0.
 */
export function placeholder(schema: unknown): unknown {
	const s = isObject(schema) ? schema : {};
	if ("const" in s) return s.const;
	if (Array.isArray(s.enum)) return s.enum[0];
	const { anyOf, oneOf, ...rest } = s;
	const branches = [anyOf, oneOf].find(Array.isArray);
	if (branches) return placeholder(merged(rest, branches[0]));
	return ofType(Array.isArray(s.type) ? s.type[0] : s.type, s);
}

/** Steps that write each output `req` declares in the outbox, a placeholder of its schema's keywords that `placeholder` reads. */
export const placeholderOutputs = (req: HarnessRequest): StubStep[] =>
	req.outputs.map((o) => ({
		write: `${OUTBOX}/${o.file}`,
		content:
			o.format === "json"
				? JSON.stringify(placeholder(o.schema))
				: `${PLACEHOLDER_TEXT}\n`,
	}));
