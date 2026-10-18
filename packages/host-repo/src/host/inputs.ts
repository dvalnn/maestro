import type { HostContext } from "@maestro/core/host";
import type { Inputs } from "@maestro/core/node";
import type { ArtifactRef } from "@maestro/ir";

/**
 * The text at input port `port`.
 * @throws Error when it is not text.
 */
export function textInput(inputs: Inputs, port: string): string {
	const value = inputs[port];
	if (typeof value !== "string")
		throw new Error(
			`input '${port}' is not text. Wire '${port}' from a text output`,
		);
	return value;
}

/** The absolute path of the artifact at artifact input port `port`, which core checked is an `ArtifactRef`. */
export const artifactInput = (
	inputs: Inputs,
	context: HostContext,
	port: string,
): string => context.path(inputs[port] as ArtifactRef);
