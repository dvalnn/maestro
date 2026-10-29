import { addNode, type Common, checkPlain, type Result } from "./graph";
import { type NoOutputs, typed } from "./nodes";

import { schemas, type Types } from "./types";

export type HostNodeOptions<O extends Types> = Common & {
	in?: Record<string, unknown>;
	out?: O;
	/** Kind-specific configuration, a plain value. */
	config?: Record<string, unknown>;
};

/** A node of a host kind, `<host>.<kind>`, with ports and a plain config. */
export function hostNode<O extends Types = NoOutputs>(
	kind: `${string}.${string}`,
	opts: HostNodeOptions<O> = {},
): Result<O> {
	if (opts.config !== undefined) checkPlain(opts.config, `config of '${kind}'`);
	return typed(
		addNode(
			{
				kind,
				label: kind.slice(kind.indexOf(".") + 1),
				inputs: opts.in ?? {},
				out: schemas(opts.out),
				fields: { config: opts.config },
			},
			opts,
		),
	);
}
