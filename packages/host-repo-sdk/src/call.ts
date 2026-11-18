import {
	ARTIFACT_TYPES,
	CORE_TYPES,
	type JsonSchema,
	MAESTRO_TYPE,
	schemaMarkers,
} from "@maestro/ir";

/** The input ports an agent has of its own, which no attachment may take. */
export const AGENT_IN_PORTS = ["prompt", "lane", "session"];

/** The output ports an agent has of its own, which no declared output may take. */
export const AGENT_OUT_PORTS = ["lane", "report", "staged", "session"];

/** The keys of an agent's envelope, which no typed reply field takes beside the agent's output ports. */
export const ENVELOPE_KEYS = ["report", "blocked", "outcome"];

/** The attachment directory holding a continuing agent's earlier copies of its changed attachments. */
export const PREVIOUS = "previous";

/** The names no attachment takes: the agent's own ports, and `PREVIOUS`. */
export const RESERVED_ATTACHMENTS = [...AGENT_IN_PORTS, PREVIOUS];

/** The four fields of an agent node's config that a seat call fills, as the IR carries them. */
export type CallConfig = {
	attachments?: Record<string, unknown>;
	relay?: readonly { name: string; schema: JsonSchema }[];
	out?: Record<string, unknown>;
	reply?: Record<string, JsonSchema>;
};

/** One way a seat call breaks the rules on what it may name and type. */
export type CallProblem = { name: string; message: string; hint: string } & (
	| { rule: "name"; field: "attachment" | "relay" | "output" | "reply" }
	| { rule: "type"; field: "relay" | "reply" }
);

type Field = Extract<CallProblem, { rule: "name" }>["field"];

const TAKERS: Record<Field, string> = {
	attachment: "an attachment",
	relay: "a relay",
	output: "an output",
	reply: "a reply field",
};

const OWN = "an agent's own port";

const holdsArtifact = (schema: JsonSchema) =>
	schemaMarkers(schema).some((m) => ARTIFACT_TYPES.has(m.type));

const isMarkdown = (schema: JsonSchema) =>
	typeof schema === "object" && schema[MAESTRO_TYPE] === CORE_TYPES.markdown;

/** The names `field` may not take, each with what holds it. */
function barred(
	field: Field,
	config: CallConfig,
	earlier: readonly string[],
): [names: readonly string[], holder: string][] {
	switch (field) {
		case "attachment":
			return [
				[AGENT_IN_PORTS, OWN],
				[
					[PREVIOUS],
					"the directory of a continuing agent's earlier attachments",
				],
			];
		case "relay":
			return [
				[AGENT_IN_PORTS, OWN],
				[Object.keys(config.attachments ?? {}), "an attachment"],
				[earlier, "another relay's name"],
			];
		case "output":
			return [[AGENT_OUT_PORTS, OWN]];
		case "reply":
			return [
				[AGENT_OUT_PORTS, OWN],
				[ENVELOPE_KEYS, "an envelope key"],
				[Object.keys(config.out ?? {}), "a declared output"],
			];
	}
}

function nameProblem(
	field: Field,
	name: string,
	config: CallConfig,
	earlier: readonly string[] = [],
): CallProblem[] {
	const hit = barred(field, config, earlier).find(([names]) =>
		names.includes(name),
	);
	if (!hit) return [];
	const [names, holder] = hit;
	return [
		{
			rule: "name",
			field,
			name,
			message: `'${name}' is ${holder}, so ${TAKERS[field]} cannot take it`,
			hint: `Rename '${name}'; ${TAKERS[field]} may not take ${names.join(", ")}`,
		},
	];
}

function relayProblems(config: CallConfig) {
	const relay = config.relay ?? [];
	return relay.flatMap(({ name, schema }, i): CallProblem[] => {
		const named = nameProblem(
			"relay",
			name,
			config,
			relay.slice(0, i).map((r) => r.name),
		);
		if (named.length || isMarkdown(schema) || !holdsArtifact(schema))
			return named;
		return [
			{
				rule: "type",
				field: "relay",
				name,
				message: `relay '${name}' is or holds an artifact that is not a Markdown output, which no relay can inline`,
				hint: `Attach '${name}' under attachments with a hint, or relay a typed value or a Markdown output`,
			},
		];
	});
}

function replyProblems(config: CallConfig) {
	return Object.entries(config.reply ?? {}).flatMap(
		([name, schema]): CallProblem[] => {
			const named = nameProblem("reply", name, config);
			if (named.length || !holdsArtifact(schema)) return named;
			return [
				{
					rule: "type",
					field: "reply",
					name,
					message: `reply field '${name}' holds an artifact, which no reply field can`,
					hint: `Declare '${name}' as an output, JsonOut or MarkdownOut, or give the field a JSON value type`,
				},
			];
		},
	);
}

/**
 * Every rule a seat call's names and types break, in declaration order: attachments, then relays, then outputs, then
 * reply fields, one problem at most per entry with its name rules before its type rule. A caller that throws takes the
 * first, so the order is part of the interface.
 */
export function callProblems(config: CallConfig): CallProblem[] {
	return [
		...Object.keys(config.attachments ?? {}).flatMap((n) =>
			nameProblem("attachment", n, config),
		),
		...relayProblems(config),
		...Object.keys(config.out ?? {}).flatMap((n) =>
			nameProblem("output", n, config),
		),
		...replyProblems(config),
	];
}
